# Topsoil Price Comparator

A standalone documentation set for the Topsoil Price Comparator.

## What this app does

- compares bagged and bulk topsoil listings on a like-for-like £/L and £/kg basis
- estimates whole-pack purchase cost for a required volume
- applies configured delivery zones or base delivery pricing
- keeps supplier edits in `database/suppliers.json`
- stages scraped price changes in `database/pending_updates.json` for manual review
- exposes documentation at `/docs`

## Start here

1. Read [INDEX.md](INDEX.md) for the quick navigation page.
2. Read [FEATURES_SUMMARY.md](FEATURES_SUMMARY.md) for the at-a-glance workflow.
3. Read [FEATURES.md](FEATURES.md) for route, data, and review-queue details.

## Core routes

- `/` – main comparator UI
- `/_debug_rendered_html` – dev-only rendered HTML snapshot
- `/api/suppliers` and related CRUD/import routes
- `/api/calculate`
- `/api/geocode`
- `/api/pending-updates` and apply/reject routes
- `/docs` and `/docs/<filename>`

## Data files

- `database/suppliers.json` – supplier and product catalogue
- `database/scrape_targets.json` – review-first scraping targets
- `database/pending_updates.json` – proposed price updates
- `database/geocode_cache.json` – cached UK geocode lookups
- `database/import_history.json` – supplier import audit log

## Review-first reminder

Scraping never changes live prices directly. Review a queued update, confirm the page still matches the product, and only then apply it.
