"""Local Flask application for comparing topsoil products."""

from __future__ import annotations

import csv
import io
import json
import math
import os
import re
import shutil
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import quote

import requests
from flask import Flask, jsonify, make_response, render_template, request, send_file, url_for

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "database"
BACKUP_DIR = BASE_DIR / "backups"


def data_file(name: str) -> Path:
    return DATA_DIR / name


def migrate_json_data_files() -> None:
    """Move runtime JSON files into database/ once, keeping startup backward-compatible."""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    filenames = (
        "suppliers.json",
        "pending_updates.json",
        "geocode_cache.json",
        "import_history.json",
        "scrape_targets.json",
    )
    for name in filenames:
        legacy = BASE_DIR / name
        target = data_file(name)
        if legacy.exists() and not target.exists():
            legacy.replace(target)


DATABASE_PATH = data_file("suppliers.json")
PENDING_PATH = data_file("pending_updates.json")
GEOCODE_CACHE_PATH = data_file("geocode_cache.json")
IMPORT_HISTORY_PATH = data_file("import_history.json")
SOIL_DENSITY_KG_PER_LITRE = 1.4

db_lock = threading.Lock()
app = Flask(__name__)

migrate_json_data_files()

def load_database() -> dict[str, Any]:
    with DATABASE_PATH.open(encoding="utf-8") as file:
        try:
            return json_loads_strict(file.read(), str(DATABASE_PATH))
        except DuplicateKeyError as exc:
            raise ValueError(f"Invalid JSON in {DATABASE_PATH}: {exc}") from exc


def save_database(database: dict[str, Any]) -> None:
    """Atomically replace the local JSON database."""
    DATABASE_PATH.parent.mkdir(parents=True, exist_ok=True)
    BACKUP_DIR.mkdir(exist_ok=True)
    if DATABASE_PATH.exists():
        backup_path = BACKUP_DIR / f"suppliers-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}.json"
        shutil.copy2(DATABASE_PATH, backup_path)
    temporary_path = DATABASE_PATH.with_suffix(".tmp")
    temporary_path.write_text(json.dumps(database, indent=2) + "\n", encoding="utf-8")
    temporary_path.replace(DATABASE_PATH)


def write_json(path: Path, content: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = path.with_suffix(".tmp")
    temporary_path.write_text(json.dumps(content, indent=2) + "\n", encoding="utf-8")
    temporary_path.replace(path)

class DuplicateKeyError(ValueError):
    """Raised when a JSON payload contains duplicate object keys."""


def json_loads_strict(raw_text: str, source_label: str = "JSON") -> Any:
    """Parse JSON while rejecting silently-overwritten duplicate keys."""
    def reject_duplicates(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in pairs:
            if key in result:
                raise DuplicateKeyError(f"Duplicate key '{key}' found in {source_label}.")
            result[key] = value
        return result

    return json.loads(raw_text, object_pairs_hook=reject_duplicates)

def read_json_or(path: Path, default: dict[str, Any]) -> dict[str, Any]:
    if not path.exists():
        return default
    try:
        return json_loads_strict(path.read_text(encoding="utf-8"), str(path))
    except DuplicateKeyError as exc:
        raise ValueError(f"Invalid JSON in {path}: {exc}") from exc

def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()

def distance_miles(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    radius_miles = 3958.8
    lat1, lon1, lat2, lon2 = map(math.radians, (lat1, lon1, lat2, lon2))
    return radius_miles * 2 * math.asin(math.sqrt(math.sin((lat2-lat1)/2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2-lon1)/2) ** 2))

def delivery_cost(supplier: dict[str, Any], postcode: str) -> float | None:
    """Use the first configured postcode-prefix zone, then the base delivery cost."""
    compact = re.sub(r"\s+", "", postcode.upper())
    for zone in supplier.get("delivery_zones", []):
        if compact.startswith(re.sub(r"\s+", "", str(zone.get("postcode_prefix", "")).upper())):
            return float(zone["cost_gbp"])
    return float(supplier["delivery_base_gbp"]) if supplier.get("delivery_base_gbp") is not None else None

def delivery_pricing_details(supplier: dict[str, Any], postcode: str) -> dict[str, Any]:
    """Return delivery pricing details including basis (zone/base/quote)."""
    compact = re.sub(r"\s+", "", str(postcode).upper())
    for zone in supplier.get("delivery_zones", []):
        prefix = re.sub(r"\s+", "", str(zone.get("postcode_prefix", "")).upper())
        if prefix and compact.startswith(prefix):
            return {
                "delivery_cost_gbp": float(zone["cost_gbp"]),
                "delivery_type": "zone",
                "matched_postcode_prefix": str(zone.get("postcode_prefix", "")).upper().strip(),
            }
    if supplier.get("delivery_base_gbp") is not None:
        return {
            "delivery_cost_gbp": float(supplier["delivery_base_gbp"]),
            "delivery_type": "base",
            "matched_postcode_prefix": None,
        }
    return {
        "delivery_cost_gbp": None,
        "delivery_type": "quote",
        "matched_postcode_prefix": None,
    }

def record_price(product: dict[str, Any], previous_price: float) -> None:
    if float(product["price_gbp"]) != previous_price:
        product.setdefault("price_history", []).append({"price_gbp": previous_price, "recorded_at": now_iso()})
        product["price_history"].append({"price_gbp": float(product["price_gbp"]), "recorded_at": now_iso()})

def as_number(value: Any, field: str, *, allow_zero: bool = False, allow_negative: bool = False) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError) as error:
        raise ValueError(f"{field} must be a number.") from error
    minimum_invalid = number < 0 if allow_zero else number <= 0
    if not math.isfinite(number) or (minimum_invalid and not allow_negative):
        operator = "zero or greater" if allow_zero else "greater than zero"
        raise ValueError(f"{field} must be {operator}.")
    return number


def slugify(value: str) -> str:
    return re.sub(r"(^-|-$)", "", re.sub(r"[^a-z0-9]+", "-", value.lower())).strip() or str(uuid.uuid4())

def normalise_product(product: dict[str, Any]) -> dict[str, Any]:
    """Return a product with comparable per-litre and per-kilogram prices.

    If a listing gives only weight or only volume, the missing measure is inferred
    from the app's 1.4 kg/L density assumption and labelled as inferred.
    """
    result = dict(product)
    price = float(product["price_gbp"])
    volume = float(product.get("volume_litres") or 0)
    weight = float(product.get("weight_kg") or 0)
    package_type = str(product.get("package_type", ""))
    package_class = str(product.get("package_class", "")).strip().lower()
    if not package_class:
        package_class = "bulk" if "bulk" in f"{product.get('name', '')} {package_type}".lower() else "shop"
    volume_match = re.search(r"(\d+(?:\.\d+)?)\s*(?:litre|liter|litres|liters|l)\b", f"{product.get('name', '')} {package_type}", re.I)
    weight_match = re.search(r"(\d+(?:\.\d+)?)\s*(?:kg|kilogram|kilograms)\b", f"{product.get('name', '')} {package_type}", re.I)
    if volume <= 0 and volume_match:
        volume = float(volume_match.group(1))
    if weight <= 0 and weight_match:
        weight = float(weight_match.group(1))
    volume_inferred = False
    weight_inferred = False

    if volume <= 0 and weight > 0:
        volume = weight / SOIL_DENSITY_KG_PER_LITRE
        volume_inferred = True
    if weight <= 0 and volume > 0:
        weight = volume * SOIL_DENSITY_KG_PER_LITRE
        weight_inferred = True

    result["effective_volume_litres"] = round(volume, 2) if volume else None
    result["effective_weight_kg"] = round(weight, 2) if weight else None
    result["volume_inferred"] = volume_inferred
    result["weight_inferred"] = weight_inferred
    result["price_per_litre"] = round(price / volume, 4) if volume else None
    result["price_per_kg"] = round(price / weight, 4) if weight else None
    result["package_class"] = package_class
    return result


def enrich_supplier(supplier: dict[str, Any]) -> dict[str, Any]:
    item = dict(supplier)
    item["supplier_type"] = item.get("supplier_type") or "supplier"
    item["products"] = [normalise_product(product) for product in supplier.get("products", [])]
    return item

def supplier_from_payload(payload: dict[str, Any]) -> dict[str, Any]:
    name = str(payload.get("name", "")).strip()
    if not name:
        raise ValueError("Supplier name is required.")
    supplier_type = str(payload.get("supplier_type", "")).strip().lower() or "supplier"
    if supplier_type not in {"shop", "supplier"}:
        raise ValueError("Supplier type must be shop or supplier.")
    latitude = as_number(payload.get("latitude"), "Latitude", allow_zero=True, allow_negative=True)
    longitude = as_number(payload.get("longitude"), "Longitude", allow_zero=True, allow_negative=True)
    if not -90 <= latitude <= 90:
        raise ValueError("Latitude must be between -90 and 90.")
    if not -180 <= longitude <= 180:
        raise ValueError("Longitude must be between -180 and 180.")
    raw_zones = payload.get("delivery_zones", [])
    if isinstance(raw_zones, str):
        raw_zones = [{"postcode_prefix": line.split(":", 1)[0].strip(), "cost_gbp": line.split(":", 1)[1].strip()} for line in raw_zones.splitlines() if ":" in line]
    delivery_zones = [{"postcode_prefix": str(zone.get("postcode_prefix", "")).strip().upper(), "cost_gbp": as_number(zone.get("cost_gbp"), "Delivery zone cost", allow_zero=True)} for zone in raw_zones if str(zone.get("postcode_prefix", "")).strip()]
    return {
        "id": slugify(name),
        "name": name,
        "supplier_type": supplier_type,
        "address": str(payload.get("address", "")).strip(),
        "latitude": latitude,
        "longitude": longitude,
        "website_url": str(payload.get("website_url", "")).strip(),
        "delivery_options": str(payload.get("delivery_options", "")).strip(),
        "delivery_base_gbp": as_number(payload["delivery_base_gbp"], "Base delivery", allow_zero=True) if payload.get("delivery_base_gbp", "") != "" else None,
        "delivery_zones": delivery_zones,
        "products": [],
    }


def supplier_fields_from_payload(payload: dict[str, Any], existing: dict[str, Any]) -> dict[str, Any]:
    """Update supplier details while retaining its immutable ID and products."""
    updated = supplier_from_payload(payload)
    updated["id"] = existing["id"]
    updated["products"] = existing.get("products", [])
    updated["delivery_zones"] = updated.get("delivery_zones", existing.get("delivery_zones", []))
    return updated

def product_from_payload(payload: dict[str, Any], existing_id: str | None = None) -> dict[str, Any]:
    name = str(payload.get("name", "")).strip()
    package_type = str(payload.get("package_type", "")).strip()
    if not name or not package_type:
        raise ValueError("Product name and package type are required.")
    volume = as_number(payload.get("volume_litres", 0), "Volume", allow_zero=True)
    weight = as_number(payload.get("weight_kg", 0), "Weight", allow_zero=True)
    if volume == 0 and weight == 0:
        raise ValueError("Enter a volume, a weight, or both.")
    tags = payload.get("quality_tags", [])
    if isinstance(tags, str): tags = [tag.strip() for tag in tags.split(",") if tag.strip()]
    return {
        "id": existing_id or slugify(name),
        "name": name,
        "package_type": package_type,
        "package_class": str(payload.get("package_class", "")).strip().lower() or ("bulk" if "bulk" in f"{name} {package_type}".lower() else "shop"),
        "volume_litres": volume,
        "weight_kg": weight,
        "price_gbp": as_number(payload.get("price_gbp"), "Price"),
        "product_url": str(payload.get("product_url", "")).strip(),
        "quality_tags": tags,
    }


def find_supplier(database: dict[str, Any], supplier_id: str) -> dict[str, Any] | None:
    return next((item for item in database["suppliers"] if item["id"] == supplier_id), None)

def supplier_duplicate(existing: dict[str, Any], candidate: dict[str, Any]) -> str | None:
    if existing.get("name", "").strip().casefold() == candidate.get("name", "").strip().casefold():
        return "name"
    if existing.get("website_url", "").strip().rstrip("/").casefold() and existing.get("website_url", "").strip().rstrip("/").casefold() == candidate.get("website_url", "").strip().rstrip("/").casefold():
        return "website"
    if abs(float(existing.get("latitude", 999)) - float(candidate.get("latitude", 0))) < 0.0002 and abs(float(existing.get("longitude", 999)) - float(candidate.get("longitude", 0))) < 0.0002:
        return "coordinates"
    return None


@app.get("/")
def index():
    # Use a clean fixed template to avoid possible cached/compiled-template mismatches in development
    rendered = render_template("index.html", density=SOIL_DENSITY_KG_PER_LITRE)
    # Remove any stray integrity/crossorigin attributes (defence-in-depth)
    rendered = re.sub(r'\s+integrity="[^"]+"', '', rendered)
    rendered = re.sub(r'\s+crossorigin="[^"]*"', '', rendered)
    # Replace CDN css reference with the local file path (ensure map CSS is always available)
    local_leaflet = url_for('static', filename='leaflet.css')
    rendered = rendered.replace('https://unpkg.com/leaflet@1.9.4/dist/leaflet.css', local_leaflet)
    # Collapse unexpected control characters
    rendered = re.sub(r'[\x00-\x08\x0b-\x1f]+', '', rendered)
    response = make_response(rendered)
    response.headers["Cache-Control"] = "no-store"
    return response

# Debug endpoint to inspect the exact HTML the server is sending (helps diagnose cached / proxy issues)
@app.get('/_debug_rendered_html')
def debug_rendered_html():
    rendered = render_template("index.html", density=SOIL_DENSITY_KG_PER_LITRE)
    # Return raw HTML (no caching)
    response = make_response(rendered)
    response.headers['Cache-Control'] = 'no-store'
    response.headers['Content-Type'] = 'text/html; charset=utf-8'
    return response


@app.get("/api/suppliers")
def get_suppliers():
    database = load_database()
    return jsonify({"density_kg_per_litre": SOIL_DENSITY_KG_PER_LITRE, "suppliers": [enrich_supplier(item) for item in database["suppliers"]]})

def import_supplier_rows(file_name: str, content: str) -> list[dict[str, Any]]:
    extension = Path(file_name or "").suffix.lower()
    if extension not in {".csv", ".json", ".txt", ".text"}:
        raise ValueError("Only CSV, JSON, and TXT files are supported.")
    if extension == ".json":
        parsed = json_loads_strict(content, file_name or "supplier import")
        rows = parsed.get("suppliers", parsed) if isinstance(parsed, dict) else parsed
        if not isinstance(rows, list):
            raise ValueError("JSON must contain a suppliers array.")
        return rows
    if extension in {".txt", ".text"}:
        lines = [line for line in content.splitlines() if line.strip() and not line.lstrip().startswith("#")]
        content = "\n".join(lines)
        if lines and "|" not in lines[0] and "," not in lines[0]:
            return [{"name": line.strip()} for line in lines]
        delimiter = "|" if "|" in lines[0] else ","
    else:
        delimiter = ","
    reader = csv.DictReader(io.StringIO(content), delimiter=delimiter)
    if not reader.fieldnames or not any(field.strip().lower() == "name" for field in reader.fieldnames):
        raise ValueError("CSV/TXT must include a name column. Download the template for the expected format.")
    return [dict(row) for row in reader]


@app.post("/api/suppliers/import")
def import_suppliers():
    uploaded = request.files.get("file")
    if not uploaded or not uploaded.filename:
        return jsonify({"error": "Choose a CSV, JSON, or TXT supplier file."}), 400
    try:
        content = uploaded.read().decode("utf-8-sig")
        rows = import_supplier_rows(uploaded.filename, content)
    except (UnicodeDecodeError, DuplicateKeyError, ValueError, TypeError, json.JSONDecodeError) as error:
        return jsonify({"error": f"Could not read import: {error}"}), 400
    if not rows:
        return jsonify({"error": "The import file contains no suppliers."}), 400
    errors = []
    imported = []
    seen_ids = set()
    for row_number, row in enumerate(rows, start=2):
        if not isinstance(row, dict):
            errors.append(f"Row {row_number}: supplier must be an object.")
            continue
        try:
            supplier = supplier_from_payload(row)
            if supplier["id"] in seen_ids:
                raise ValueError("duplicate supplier name in file")
            seen_ids.add(supplier["id"])
            imported.append(supplier)
        except (TypeError, ValueError) as error:
            errors.append(f"Row {row_number}: {error}")
    if errors:
        return jsonify({"error": "Import rejected; no suppliers were changed.", "details": errors}), 400
    with db_lock:
        database = load_database()
        collisions = []
        new_suppliers = []
        for supplier in imported:
            duplicate = next((supplier_duplicate(existing, supplier) for existing in database["suppliers"] + new_suppliers if supplier_duplicate(existing, supplier)), None)
            if duplicate:
                collisions.append({"name": supplier["name"], "reason": duplicate})
            else:
                new_suppliers.append(supplier)
        if not new_suppliers:
            return jsonify({"error": "Import completed with no changes; every supplier was a duplicate.", "skipped": collisions}), 409
        database["suppliers"].extend(new_suppliers)
        save_database(database)
    history = read_json_or(IMPORT_HISTORY_PATH, {"imports": []})
    import_id = uuid.uuid4().hex
    history["imports"].insert(0, {"id": import_id, "created_at": now_iso(), "supplier_ids": [supplier["id"] for supplier in new_suppliers], "names": [supplier["name"] for supplier in new_suppliers], "skipped": collisions})
    write_json(IMPORT_HISTORY_PATH, history)
    return jsonify({"import_id": import_id, "imported": len(new_suppliers), "skipped": collisions, "suppliers": [enrich_supplier(item) for item in new_suppliers]}), 201


@app.get("/api/suppliers/import-history")
def import_history():
    return jsonify(read_json_or(IMPORT_HISTORY_PATH, {"imports": []}))

@app.get("/api/suppliers/backup")
def download_backup():
    BACKUP_DIR.mkdir(exist_ok=True)
    backup_path = BACKUP_DIR / f"suppliers-manual-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}.json"
    shutil.copy2(DATABASE_PATH, backup_path)
    return send_file(backup_path, as_attachment=True, download_name=backup_path.name, mimetype="application/json")


@app.post("/api/suppliers/import-history/<import_id>/undo")
def undo_import(import_id: str):
    history = read_json_or(IMPORT_HISTORY_PATH, {"imports": []})
    record = next((item for item in history["imports"] if item.get("id") == import_id), None)
    if not record:
        return jsonify({"error": "Import record not found."}), 404
    with db_lock:
        database = load_database()
        removed = [item for item in database["suppliers"] if item.get("id") in record.get("supplier_ids", [])]
        if not removed:
            return jsonify({"error": "Nothing from this import remains to undo."}), 409
        database["suppliers"] = [item for item in database["suppliers"] if item.get("id") not in record.get("supplier_ids", [])]
        save_database(database)
    record["undone_at"] = now_iso(); write_json(IMPORT_HISTORY_PATH, history)
    return jsonify({"undone": len(removed), "names": [item["name"] for item in removed]})


@app.post("/api/suppliers")
def create_supplier():
    try:
        supplier = supplier_from_payload(request.get_json(force=True) or {})
        with db_lock:
            database = load_database()
            duplicate = next((supplier_duplicate(existing, supplier) for existing in database["suppliers"] if supplier_duplicate(existing, supplier)), None)
            if duplicate:
                return jsonify({"error": f"A supplier with the same {duplicate} already exists."}), 409
            database["suppliers"].append(supplier)
            save_database(database)
        return jsonify(enrich_supplier(supplier)), 201
    except ValueError as error:
        return jsonify({"error": str(error)}), 400


@app.put("/api/suppliers/<supplier_id>")
def update_supplier(supplier_id: str):
    try:
        with db_lock:
            database = load_database()
            existing = find_supplier(database, supplier_id)
            if not existing:
                return jsonify({"error": "Supplier not found."}), 404
            updated = supplier_fields_from_payload(request.get_json(force=True) or {}, existing)
            index = database["suppliers"].index(existing)
            database["suppliers"][index] = updated
            save_database(database)
        return jsonify(enrich_supplier(updated))
    except ValueError as error:
        return jsonify({"error": str(error)}), 400


@app.post("/api/suppliers/<supplier_id>/products")
def create_product(supplier_id: str):
    try:
        product = product_from_payload(request.get_json(force=True) or {})
        with db_lock:
            database = load_database()
            supplier = find_supplier(database, supplier_id)
            if not supplier:
                return jsonify({"error": "Supplier not found."}), 404
            used_ids = {item["id"] for item in supplier["products"]}
            if product["id"] in used_ids:
                product["id"] = f"{product['id']}-{uuid.uuid4().hex[:6]}"
            supplier["products"].append(product)
            save_database(database)
        return jsonify(normalise_product(product)), 201
    except ValueError as error:
        return jsonify({"error": str(error)}), 400


@app.put("/api/suppliers/<supplier_id>/products/<product_id>")
def update_product(supplier_id: str, product_id: str):
    try:
        with db_lock:
            database = load_database()
            supplier = find_supplier(database, supplier_id)
            if not supplier:
                return jsonify({"error": "Supplier not found."}), 404
            index = next((i for i, item in enumerate(supplier["products"]) if item["id"] == product_id), None)
            if index is None:
                return jsonify({"error": "Product not found."}), 404
            product = product_from_payload(request.get_json(force=True) or {}, existing_id=product_id)
            record_price(product, float(supplier["products"][index]["price_gbp"]))
            supplier["products"][index] = product
            save_database(database)
        return jsonify(normalise_product(product))
    except ValueError as error:
        return jsonify({"error": str(error)}), 400

@app.delete("/api/suppliers/<supplier_id>")
def delete_supplier(supplier_id: str):
    with db_lock:
        database = load_database()
        supplier = find_supplier(database, supplier_id)
        if not supplier:
            return jsonify({"error": "Supplier not found."}), 404
        # Remove the supplier
        database["suppliers"] = [s for s in database["suppliers"] if s.get("id") != supplier_id]
        save_database(database)
        # Clean up any pending updates that reference this supplier
        pending = read_json_or(PENDING_PATH, {"updates": []})
        filtered = [u for u in pending["updates"] if u.get("supplier_id") != supplier_id]
        if len(filtered) != len(pending["updates"]):
            pending["updates"] = filtered
            write_json(PENDING_PATH, pending)
    return jsonify({"deleted": supplier_id})


@app.delete("/api/suppliers/<supplier_id>/products/<product_id>")
def delete_product(supplier_id: str, product_id: str):
    with db_lock:
        database = load_database()
        supplier = find_supplier(database, supplier_id)
        if not supplier:
            return jsonify({"error": "Supplier not found."}), 404
        index = next((i for i, item in enumerate(supplier.get("products", [])) if item.get("id") == product_id), None)
        if index is None:
            return jsonify({"error": "Product not found."}), 404
        # Remove the product
        supplier["products"].pop(index)
        save_database(database)
        # Clean up any pending updates that reference this product
        pending = read_json_or(PENDING_PATH, {"updates": []})
        filtered = [u for u in pending["updates"] if not (u.get("supplier_id") == supplier_id and u.get("product_id") == product_id)]
        if len(filtered) != len(pending["updates"]):
            pending["updates"] = filtered
            write_json(PENDING_PATH, pending)
    return jsonify({"deleted": product_id})


@app.post("/api/calculate")
def calculate():
    """Calculate per-product normalised and whole-pack estimates for a volume."""
    try:
        litres = as_number((request.get_json(force=True) or {}).get("volume_litres"), "Required volume")
        payload = request.get_json(force=True) or {}
        database = load_database()
        user_location = payload.get("location") or {}
        postcode = str(payload.get("postcode", ""))
        offers = []
        for supplier in database["suppliers"]:
            for product in supplier.get("products", []):
                normalised = normalise_product(product)
                per_litre = normalised["price_per_litre"]
                if per_litre is None:
                    continue
                package_volume = normalised["effective_volume_litres"]
                if package_volume is None or package_volume <= 0:
                    continue
                packages = math.ceil(litres / package_volume)
                delivery_details = delivery_pricing_details(supplier, postcode)
                delivery = delivery_details["delivery_cost_gbp"]
                whole_package_cost = round(packages * float(product["price_gbp"]), 2)
                delivered_cost = round(whole_package_cost + delivery, 2) if delivery is not None else None
                coverage_litres = round(packages * package_volume, 2)
                surplus_litres = round(max(coverage_litres - litres, 0), 2)
                distance = None
                if user_location.get("latitude") is not None and user_location.get("longitude") is not None:
                    distance = round(distance_miles(float(user_location["latitude"]), float(user_location["longitude"]), float(supplier["latitude"]), float(supplier["longitude"])), 1)
                offers.append({
                    "supplier_id": supplier["id"], "supplier_name": supplier["name"],
                    "product_id": product["id"], "product_name": product["name"],
                    "package_type": product["package_type"], "price_per_litre": per_litre,
                    "normalised_cost_gbp": round(litres * per_litre, 2),
                    "whole_package_cost_gbp": whole_package_cost,
                    "package_price_gbp": round(float(product["price_gbp"]), 2),
                    "packages_needed": packages,
                    "package_volume_litres": package_volume,
                    "package_weight_kg": normalised["effective_weight_kg"],
                    "coverage_litres": coverage_litres,
                    "surplus_litres": surplus_litres,
                    "delivery_cost_gbp": delivery,
                    "delivery_type": delivery_details["delivery_type"],
                    "matched_postcode_prefix": delivery_details["matched_postcode_prefix"],
                    "delivered_cost_gbp": delivered_cost,
                    "delivered_price_per_litre": round(delivered_cost / litres, 4) if delivered_cost is not None else None,
                    "distance_miles": distance, "quality_tags": product.get("quality_tags", []),
                })
        offers.sort(key=lambda item: item["normalised_cost_gbp"])
        delivered_offers = [offer for offer in offers if offer["delivered_cost_gbp"] is not None]
        delivered_offers.sort(key=lambda item: item["delivered_cost_gbp"])
        return jsonify({
            "volume_litres": litres,
            "weight_kg": round(litres * SOIL_DENSITY_KG_PER_LITRE, 2),
            "offers": offers,
            "cheapest_delivered": delivered_offers[0] if delivered_offers else None,
            "stats": {
                "offer_count": len(offers),
                "delivered_offer_count": len(delivered_offers),
                "quote_only_count": len([offer for offer in offers if offer["delivered_cost_gbp"] is None]),
                "best_normalised_cost_gbp": offers[0]["normalised_cost_gbp"] if offers else None,
                "best_delivered_cost_gbp": delivered_offers[0]["delivered_cost_gbp"] if delivered_offers else None,
            },
        })
    except ValueError as error:
        return jsonify({"error": str(error)}), 400


@app.post("/api/geocode")
def geocode():
    address = str((request.get_json(force=True) or {}).get("address", "")).strip()
    if len(address) < 3:
        return jsonify({"error": "Enter an address or postcode."}), 400

    cache = read_json_or(GEOCODE_CACHE_PATH, {})
    key = address.lower()
    if key in cache:
        return jsonify(cache[key])

    normalised = re.sub(r"\s+", " ", address).strip()
    parts = [part.strip() for part in normalised.split(",") if part.strip()]
    postcode_match = re.search(r"\b([A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})\b", normalised.upper())
    postcode = ""
    if postcode_match:
        compact_postcode = re.sub(r"\s+", "", postcode_match.group(1).upper())
        postcode = f"{compact_postcode[:-3]} {compact_postcode[-3:]}" if len(compact_postcode) > 3 else compact_postcode

    search_queries: list[str] = []
    for query in [normalised, ", ".join(parts), " ".join(parts)]:
        if query and query not in search_queries:
            search_queries.append(query)
    for drop in range(1, min(len(parts), 4)):
        query = ", ".join(parts[drop:])
        if query and query not in search_queries:
            search_queries.append(query)
    if postcode and postcode not in search_queries:
        search_queries.append(postcode)
    if postcode and len(parts) >= 2:
        local_query = f"{parts[-2]}, {postcode}"
        if local_query not in search_queries:
            search_queries.append(local_query)

    selected_match: dict[str, Any] | None = None
    compact_postcode = re.sub(r"\s+", "", postcode) if postcode else ""
    try:
        for query in search_queries[:6]:
            response = requests.get(
                "https://nominatim.openstreetmap.org/search",
                params={
                    "q": query,
                    "format": "jsonv2",
                    "limit": 5,
                    "countrycodes": "gb",
                    "addressdetails": 1,
                },
                headers={"User-Agent": "TopsoilPriceComparator/1.0"},
                timeout=15,
            )
            response.raise_for_status()
            matches = response.json()
            if not matches:
                continue

            def score_match(match: dict[str, Any]) -> float:
                score = float(match.get("importance", 0.0))
                display_name = str(match.get("display_name", "")).upper().replace(" ", "")
                if compact_postcode and compact_postcode in display_name:
                    score += 2.0
                place_class = str(match.get("class", "")).lower()
                if place_class in {"building", "place", "highway"}:
                    score += 0.5
                return score

            best = max(matches, key=score_match)
            if selected_match is None or score_match(best) > score_match(selected_match):
                selected_match = best
            if compact_postcode and compact_postcode in str(best.get("display_name", "")).upper().replace(" ", ""):
                selected_match = best
                break
    except requests.RequestException as error:
        return jsonify({"error": f"Address lookup failed: {error}"}), 502

    # Fallback: postcode centroid from postcodes.io when precise address lookup fails.
    if selected_match is None and postcode:
        try:
            postcode_response = requests.get(
                f"https://api.postcodes.io/postcodes/{quote(postcode)}",
                headers={"User-Agent": "TopsoilPriceComparator/1.0"},
                timeout=10,
            )
            postcode_response.raise_for_status()
            postcode_body = postcode_response.json()
            if postcode_body.get("status") == 200 and postcode_body.get("result"):
                result = postcode_body["result"]
                selected_match = {
                    "lat": result.get("latitude"),
                    "lon": result.get("longitude"),
                    "display_name": f"Approximate location for postcode {postcode}",
                }
        except requests.RequestException:
            selected_match = None

    if not selected_match:
        return jsonify({"error": "No UK location found for that address."}), 404

    payload = {
        "latitude": float(selected_match["lat"]),
        "longitude": float(selected_match["lon"]),
        "display_name": selected_match["display_name"],
    }
    cache[key] = payload
    write_json(GEOCODE_CACHE_PATH, cache)
    return jsonify(payload)


@app.get("/api/pending-updates")
def pending_updates(): return jsonify(read_json_or(PENDING_PATH, {"updates": []}))


@app.post("/api/pending-updates/<update_id>/apply")
def apply_pending_update(update_id: str):
    pending = read_json_or(PENDING_PATH, {"updates": []}); update = next((item for item in pending["updates"] if item.get("id") == update_id), None)
    if not update or update.get("status") != "review": return jsonify({"error": "Review item not found."}), 404
    with db_lock:
        database = load_database(); product = next((product for supplier in database["suppliers"] if supplier["id"] == update["supplier_id"] for product in supplier["products"] if product["id"] == update["product_id"]), None)
        if not product: return jsonify({"error": "Linked product not found."}), 404
        old = float(product["price_gbp"]); product["price_gbp"] = float(update["candidate_price_gbp"]); record_price(product, old); save_database(database)
        update["status"] = "applied"; update["applied_at"] = now_iso(); write_json(PENDING_PATH, pending)
    return jsonify(normalise_product(product))


@app.post("/api/pending-updates/<update_id>/reject")
def reject_pending_update(update_id: str):
    pending = read_json_or(PENDING_PATH, {"updates": []})
    update = next((item for item in pending["updates"] if item.get("id") == update_id), None)
    if not update or update.get("status") != "review": return jsonify({"error": "Review item not found."}), 404
    update["status"] = "rejected"; update["rejected_at"] = now_iso(); write_json(PENDING_PATH, pending)
    return jsonify(update)


@app.errorhandler(404)
def not_found(error):
    return jsonify({"error": "API endpoint not found."}), 404


@app.errorhandler(405)
def method_not_allowed(error):
    return jsonify({"error": "HTTP method not allowed."}), 405


@app.get("/docs")
def serve_docs():
    """Serve documentation index page."""
    docs_dir = BASE_DIR / "docs"
    if not docs_dir.exists():
        return jsonify({"error": "Documentation not found"}), 404
    
    try:
        readme_path = docs_dir / "README.md"
        if readme_path.exists():
            content = readme_path.read_text(encoding='utf-8')
            # Escape content for JavaScript using JSON
            content_json = json.dumps(content)
            return render_template('docs.html', content_json=content_json)
        return jsonify({"error": "Documentation index not found"}), 404
    except Exception as e:
        app.logger.error(f"Error serving docs: {e}")
        return jsonify({"error": "Could not load documentation"}), 500


@app.get("/docs/<filename>")
def serve_doc_file(filename):
    """Serve individual documentation files as HTML."""
    # Security: only allow .md files and prevent directory traversal
    if not filename.endswith('.md') or '..' in filename:
        return jsonify({"error": "Invalid file"}), 400
    
    docs_dir = BASE_DIR / "docs"
    file_path = docs_dir / filename
    
    if not file_path.exists() or not file_path.is_file():
        return jsonify({"error": "Documentation file not found"}), 404
    
    try:
        content = file_path.read_text(encoding='utf-8')
        content_json = json.dumps(content)
        return render_template('docs.html', content_json=content_json, filename=filename)
    except Exception as e:
        app.logger.error(f"Error serving doc file {filename}: {e}")
        return jsonify({"error": "Could not load documentation file"}), 500


@app.errorhandler(500)
def internal_error(error):
    app.logger.error(f"Internal server error: {error}")
    return jsonify({"error": "Internal server error."}), 500


@app.errorhandler(Exception)
def handle_exception(error):
    app.logger.error(f"Unhandled exception: {error}")
    return jsonify({"error": f"An error occurred: {type(error).__name__}"}), 500


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5050))
    debug = os.environ.get("FLASK_DEBUG", "1") == "1"
    app.run(host="0.0.0.0", port=port, debug=debug)

