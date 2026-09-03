# Topsoil Price Comparator – Detailed Features

## Main user interface

The home page combines three working areas:

1. a planter calculator that converts entered dimensions into litres and kilograms
2. a supplier map with address lookup and optional radius filtering
3. a current price board with filters for supplier, package type, maximum £/L, and delivery availability

## Supplier and product management

### Supplier routes
- `GET /api/suppliers`
- `POST /api/suppliers`
- `PUT /api/suppliers/<supplier_id>`
- `DELETE /api/suppliers/<supplier_id>`
- `POST /api/suppliers/import`
- `GET /api/suppliers/import-history`
- `POST /api/suppliers/import-history/<import_id>/undo`
- `GET /api/suppliers/backup`

### Product routes
- `POST /api/suppliers/<supplier_id>/products`
- `PUT /api/suppliers/<supplier_id>/products/<product_id>`
- `DELETE /api/suppliers/<supplier_id>/products/<product_id>`

## Calculation and delivery

`POST /api/calculate` ranks offers by normalized cost and also reports delivered totals where delivery data exists. Missing volume or weight values are inferred using the app density assumption of `1.4 kg/L`.

## Review queue and backups

- `GET /api/pending-updates` lists staged scraper findings
- `POST /api/pending-updates/<update_id>/apply` updates a live product price
- `POST /api/pending-updates/<update_id>/reject` keeps the live catalogue unchanged
- supplier JSON backups are written to `backups/` before save, delete, merge, or manual backup download actions

## Documentation routes

- `GET /docs` loads `docs/README.md`
- `GET /docs/<filename>` renders a specific markdown document

## Operational cautions

- geocoding depends on public UK lookup services and should be treated as cacheable convenience data, not a source of truth
- scraped prices can omit VAT, delivery, or product-size nuances
- queue items should always be confirmed against the live source page before being applied
