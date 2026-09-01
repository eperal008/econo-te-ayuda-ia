-- ============================================================================
-- Econo Te Ayuda IA — PostgreSQL schema (v1)
-- Source of truth: Econo_Sierra_Bayamon_App_Location_Master_v5_Developer_Guide.xlsx
--   01_Ubicaciones   -> zones
--   02_Catalogo      -> products
--   03_Alias_Busqueda-> search_aliases
-- Design: Store_ID + Zone_ID are the canonical keys (never key by display text).
--         Multi-store ready. Location stored structured + bilingual.
--         Commerce fields (price/promo/inventory/image/sku/upc) are nullable and
--         filled later via the admin dashboard — the Excel does not carry them.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pg_trgm;      -- fuzzy / typo-tolerant matching
CREATE EXTENSION IF NOT EXISTS unaccent;     -- accent-insensitive normalization

-- unaccent() is STABLE, so it cannot be used directly in a GENERATED column or
-- an index expression. Wrap it as IMMUTABLE (safe: the dictionary is fixed).
CREATE OR REPLACE FUNCTION f_unaccent(text)
RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT AS
$$ SELECT public.unaccent('public.unaccent'::regdictionary, $1) $$;

-- ---------------------------------------------------------------------------
-- stores
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stores (
    store_id    TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- zones  (physical locations — from 01_Ubicaciones)
-- A zone may have no numbered aisle (produce, meat, dairy, freezers, liquor).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS zones (
    store_id        TEXT NOT NULL REFERENCES stores(store_id) ON DELETE CASCADE,
    zone_id         TEXT NOT NULL,
    departamento    TEXT,
    departamento_en TEXT,
    macro_area      TEXT,
    macro_area_en   TEXT,
    pasillo         TEXT,          -- 'SIN PASILLO' | '1'..'12' | 'L1','L2','E3','L4'
    pasillo_en      TEXT,          -- 'NO AISLE' | 'Aisle 1' ...
    lado            TEXT,
    lado_en         TEXT,
    tramo           TEXT,          -- Principio/Medio/Final | Variable
    tramo_en        TEXT,
    fixture         TEXT,
    fixture_en      TEXT,
    referencia      TEXT,          -- human landmark, e.g. "Frente a lácteos"
    orden_zona      INTEGER,       -- physical walking order in the store
    PRIMARY KEY (store_id, zone_id)
);

-- ---------------------------------------------------------------------------
-- products  (catalog / search entities — from 02_Catalogo)
-- Location is denormalized (bilingual) for single-row, no-join responses.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS products (
    id              BIGSERIAL PRIMARY KEY,
    store_id        TEXT NOT NULL,
    zone_id         TEXT NOT NULL,

    -- entity
    departamento    TEXT,
    departamento_en TEXT,
    categoria       TEXT,
    categoria_en    TEXT,
    producto        TEXT NOT NULL, -- Producto_Término (ES canonical term)
    producto_en     TEXT,
    marca           TEXT,          -- brand; never translated. Often empty (term-level data)

    -- denormalized location (bilingual)
    macro_area      TEXT, macro_area_en TEXT,
    pasillo         TEXT, pasillo_en TEXT,
    lado            TEXT, lado_en TEXT,
    tramo           TEXT, tramo_en TEXT,
    fixture         TEXT, fixture_en TEXT,

    -- search helpers (from the workbook)
    alias_es        TEXT,
    alias_en        TEXT,
    orden_fisico    INTEGER,
    confianza       TEXT,
    notas           TEXT,
    search_key      TEXT,          -- ES+EN+brand+location, precomputed for indexed search
    respuesta_app   TEXT,          -- precomputed answer string (ES)

    -- commerce fields — nullable, admin-entered (NOT in the Excel)
    sku              TEXT,
    upc              TEXT,
    price            NUMERIC(10,2),
    promo_text       TEXT,
    promo_text_en    TEXT,
    promo_price      TEXT,         -- free-form, e.g. "3/$5"
    promo_image_url  TEXT,
    inventory_status TEXT,         -- 'in_stock' | 'low' | 'out' | NULL(unknown)
    image_url        TEXT,

    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

    FOREIGN KEY (store_id, zone_id) REFERENCES zones(store_id, zone_id) ON DELETE CASCADE
);

-- Bilingual full-text search vector (deterministic recall layer).
ALTER TABLE products ADD COLUMN IF NOT EXISTS search_tsv tsvector
    GENERATED ALWAYS AS (
        to_tsvector('simple',
            f_unaccent(coalesce(producto,'')      || ' ' ||
                     coalesce(producto_en,'')   || ' ' ||
                     coalesce(categoria,'')     || ' ' ||
                     coalesce(categoria_en,'')  || ' ' ||
                     coalesce(marca,'')         || ' ' ||
                     coalesce(alias_es,'')      || ' ' ||
                     coalesce(alias_en,'')      || ' ' ||
                     coalesce(search_key,'')))
    ) STORED;

CREATE INDEX IF NOT EXISTS idx_products_tsv        ON products USING GIN (search_tsv);
CREATE INDEX IF NOT EXISTS idx_products_store      ON products (store_id);
CREATE INDEX IF NOT EXISTS idx_products_zone       ON products (store_id, zone_id);
CREATE INDEX IF NOT EXISTS idx_products_prod_trgm  ON products USING GIN (producto gin_trgm_ops, producto_en gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_products_cat        ON products (categoria);

-- ---------------------------------------------------------------------------
-- search_aliases  (synonyms / PR vocabulary — from 03_Alias_Busqueda)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS search_aliases (
    id               BIGSERIAL PRIMARY KEY,
    store_id         TEXT NOT NULL,
    alias_normalized TEXT NOT NULL,
    termino_canonico TEXT,
    tipo             TEXT,          -- 'término' | 'marca' | 'categoría' ...
    zone_id          TEXT NOT NULL,
    FOREIGN KEY (store_id, zone_id) REFERENCES zones(store_id, zone_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_alias_norm      ON search_aliases (store_id, alias_normalized);
CREATE INDEX IF NOT EXISTS idx_alias_norm_trgm ON search_aliases USING GIN (alias_normalized gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- search_misses  (unresolved queries — acceptance criterion #8)
-- Feeds alias maintenance in the admin dashboard.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS search_misses (
    id          BIGSERIAL PRIMARY KEY,
    store_id    TEXT,
    query_raw   TEXT,
    query_norm  TEXT,
    lang        TEXT,
    resolved    BOOLEAN NOT NULL DEFAULT false,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Semantic search (Phase 3) — pgvector embeddings for meaning-based recall.
-- Populated by scripts/embed.js (NOT from the Excel); survives until re-ingest,
-- after which embed.js is re-run for rows where embedding IS NULL.
-- ---------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS vector;
ALTER TABLE products ADD COLUMN IF NOT EXISTS embedding vector(1536);
CREATE INDEX IF NOT EXISTS idx_products_embedding
    ON products USING hnsw (embedding vector_cosine_ops);
