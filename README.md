# Topsoil Price Comparator

Standalone export of the topsoil comparison product.

## What it includes

- Flask app for `/`, `/api/suppliers*`, `/api/calculate`, `/api/geocode`, `/api/pending-updates*`, `/docs`, and `/_debug_rendered_html`
- local supplier/product JSON database
- review-first price scraping via `scrape_prices.py`
- the comparator UI template and its supporting static assets

## Setup

```powershell
pip install -r requirements.txt
flask --app app run --debug
```

Open `http://127.0.0.1:5000/`.

## Data files

- `database/suppliers.json` – seeded from the current catalogue
- `database/scrape_targets.json` – seeded scraping configuration
- `database/pending_updates.json` – fresh empty review queue seed
- `database/geocode_cache.json` – fresh empty cache seed
- `database/import_history.json` – fresh empty import log seed

## Review-first scraping

```powershell
python scrape_prices.py collect
python scrape_prices.py apply <update-id>
```

Use `collect` for staging only. Review every queued update before applying it.
