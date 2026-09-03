# Topsoil Price Comparator – Features Summary

## Comparator at a glance

- volume calculator for planters and beds
- normalized £/L and £/kg comparisons
- whole-pack purchasing estimates
- delivery-aware rankings using postcode zones or base delivery
- supplier map with geocoding and radius filtering
- import/export support for supplier records
- local review queue for scraped price changes
- `/docs` viewer for local markdown guidance

## Supplier data workflow

1. Maintain suppliers and products through the UI or import routes.
2. Store the shared catalogue in `database/suppliers.json`.
3. Create automatic backups in `backups/` before destructive changes.

## Review-first scraping

1. Configure targets in `database/scrape_targets.json`.
2. Run `python scrape_prices.py collect`.
3. Inspect `database/pending_updates.json`.
4. Apply or reject each update from the UI or API.

## Location features

- `/api/geocode` resolves UK addresses and postcodes
- the map can center on a searched address
- delivery matching checks postcode prefixes before base delivery

## Exported repo contents

This split repo intentionally excludes all dog-safe plant functionality, SQLite plant user data, image tooling, and plant documentation.
