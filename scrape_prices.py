"""Fetch supplier prices and create a human-review queue.

Usage:
  python scrape_prices.py collect
  python scrape_prices.py apply UPDATE_ID
"""

from __future__ import annotations

import argparse
import json
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import requests
from bs4 import BeautifulSoup

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "database"
DATA_DIR.mkdir(parents=True, exist_ok=True)
DATABASE_PATH = DATA_DIR / "suppliers.json"
TARGETS_PATH = DATA_DIR / "scrape_targets.json"
PENDING_PATH = DATA_DIR / "pending_updates.json"
HEADERS = {"User-Agent": "TopsoilPriceComparator/1.0 (local price-check tool)"}


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, content: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(content, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def extract_gbp(text: str) -> float | None:
    """Accept common UK display formats such as £72.00 or GBP 72.00."""
    match = re.search(r"(?:GBP\s*|[£\uFFFD])\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)", text, re.I)
    return float(match.group(1).replace(",", "")) if match else None


def lookup_product(database: dict[str, Any], supplier_id: str, product_id: str) -> dict[str, Any] | None:
    supplier = next((entry for entry in database["suppliers"] if entry["id"] == supplier_id), None)
    return next((entry for entry in supplier.get("products", []) if entry["id"] == product_id), None) if supplier else None


def scrape_target(target: dict[str, Any]) -> tuple[float | None, str, str | None]:
    try:
        response = requests.get(target["url"], headers=HEADERS, timeout=20)
        response.raise_for_status()
    except requests.RequestException as error:
        return None, "", f"Fetch failed: {error}"

    page = BeautifulSoup(response.text, "html.parser")
    for selector in target.get("price_selectors", []):
        for node in page.select(selector):
            price_text = node.get("content", "") or node.get_text(" ", strip=True)
            price = extract_gbp(price_text)
            if price is not None:
                return price, price_text, None
    return None, "", "No GBP price found using the configured selectors."


def collect() -> None:
    database = read_json(DATABASE_PATH)
    targets = read_json(TARGETS_PATH)
    threshold = float(targets.get("discrepancy_percent", 10))
    existing = read_json(PENDING_PATH) if PENDING_PATH.exists() else {"updates": []}
    collected_at = datetime.now(timezone.utc).isoformat()
    updates: list[dict[str, Any]] = []

    for target in targets.get("targets", []):
        product = lookup_product(database, target["supplier_id"], target["product_id"])
        if not product:
            updates.append({"id": uuid.uuid4().hex, "status": "error", "target": target, "error": "Supplier or product ID not found.", "checked_at": collected_at})
            continue
        candidate, source_text, error = scrape_target(target)
        if error:
            updates.append({"id": uuid.uuid4().hex, "status": "error", "target": target, "error": error, "checked_at": collected_at})
            continue
        current = float(product["price_gbp"])
        difference = ((candidate - current) / current * 100) if current else None
        updates.append({
            "id": uuid.uuid4().hex,
            "status": "review",  # collection never changes suppliers.json
            "supplier_id": target["supplier_id"], "product_id": target["product_id"],
            "url": target["url"], "old_price_gbp": current, "candidate_price_gbp": candidate,
            "difference_percent": round(difference, 2) if difference is not None else None,
            "discrepancy_flag": abs(difference) >= threshold if difference is not None else True,
            "source_text": source_text, "checked_at": collected_at,
        })

    existing["updates"].extend(updates)
    write_json(PENDING_PATH, existing)
    reviews = sum(item["status"] == "review" for item in updates)
    errors = len(updates) - reviews
    print(f"Queued {reviews} review item(s) and {errors} error(s) in {PENDING_PATH.name}.")


def apply(update_id: str) -> None:
    pending = read_json(PENDING_PATH)
    update = next((item for item in pending.get("updates", []) if item["id"] == update_id), None)
    if not update:
        raise SystemExit(f"No pending update with ID {update_id}.")
    if update.get("status") != "review":
        raise SystemExit("Only items with status 'review' can be applied.")

    database = read_json(DATABASE_PATH)
    product = lookup_product(database, update["supplier_id"], update["product_id"])
    if not product:
        raise SystemExit("The linked product no longer exists.")
    product["price_gbp"] = update["candidate_price_gbp"]
    write_json(DATABASE_PATH, database)
    update["status"] = "applied"
    update["applied_at"] = datetime.now(timezone.utc).isoformat()
    write_json(PENDING_PATH, pending)
    print(f"Applied £{product['price_gbp']:.2f} to {product['name']}.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Review-first topsoil price scraper")
    command = parser.add_subparsers(dest="command", required=True)
    command.add_parser("collect", help="Fetch sources and write price candidates for review")
    apply_parser = command.add_parser("apply", help="Apply one verified pending update")
    apply_parser.add_argument("update_id")
    args = parser.parse_args()
    collect() if args.command == "collect" else apply(args.update_id)
