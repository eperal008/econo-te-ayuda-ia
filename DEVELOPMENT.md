# Econo Te Ayuda IA — Development setup

## Overview
- **Frontend** — React (Create React App) in `src/`
- **Backend** — Node/Express in `backend/` (location engine + AI assistant)
- **Admin** — static Tailwind dashboard in `admin-dashboard/`
- **Data** — customer's location master workbook in `data/`, loaded into PostgreSQL

The product data source of truth is the Excel workbook. The ingestion script loads
it into any PostgreSQL, so moving to the customer's production database later is just
running the ingest against their `DATABASE_URL` — no manual migration.

## Local database (development)
We build against a throwaway PostgreSQL run in Docker (no cost, isolated from any
local Postgres install). The image includes `pgvector` for the Phase-2 semantic layer.

```bash
# start (first run pulls the image)
docker run -d --name econo-pg \
  -e POSTGRES_PASSWORD=econo_dev_pw -e POSTGRES_DB=econo_dev \
  -p 5544:5432 pgvector/pgvector:pg16

# after a machine/Docker restart, just:
docker start econo-pg
```

Connection string (already set in `backend/.env`):
```
DATABASE_URL=postgres://postgres:econo_dev_pw@localhost:5544/econo_dev
PGSSL=false
```
> Port **5544** is used on purpose — local Postgres 17/18 already occupy 5432/5433.
> Container data persists until `docker rm econo-pg`; re-ingesting rebuilds it in seconds.

## Load / reload the data
```bash
cd backend
npm install
npm run db:ingest:dry   # parse + validate the workbook, no DB writes
npm run db:ingest       # apply schema.sql + load (idempotent per store)
```
Expected: **45 zones, 1480 products, 1503 aliases** for `ECONO-SIERRA-BAYAMON`.

## Schema
`backend/db/schema.sql` — `stores`, `zones`, `products`, `search_aliases`, `search_misses`.
- `Store_ID` + `Zone_ID` are canonical keys (multi-store ready).
- Location is stored structured + bilingual; `products` also carries the workbook's
  pre-built `search_key` and `respuesta_app`.
- Commerce columns (price, promo, inventory, sku, upc, image) are **nullable** and
  filled later via the admin dashboard — the Excel does not carry them.
- Search indexes: GIN full-text (`search_tsv`, accent-folded via immutable `f_unaccent`)
  and `pg_trgm` for fuzzy/typo matching.

## Production (later, at handover)
The customer provisions their own PostgreSQL under their own account/billing. Point
`DATABASE_URL` at it, set `PGSSL=true` (for Heroku), and run `npm run db:ingest`.
