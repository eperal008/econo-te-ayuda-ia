#!/usr/bin/env node
/**
 * Mirror cleaned English text fields (producto_en, departamento_en, fixture_en)
 * from the LOCAL db to a target db (Railway) by id, after the catalog cleanup.
 * search_tsv on the target regenerates automatically. Requires matching ids
 * (true unless the target was deduped differently).
 *
 *   TARGET_DATABASE_URL="postgres://…" node scripts/sync_text_fields_to_target.js [--dry]
 */
require("dotenv").config();
const db = require("../lib/db"); // local source
const { Pool } = require("pg");
const DRY = process.argv.includes("--dry");
const target = process.env.TARGET_DATABASE_URL;
if (!target) { console.error("set TARGET_DATABASE_URL"); process.exit(1); }

(async () => {
  const { rows } = await db.query("SELECT id, producto_en, departamento_en, fixture_en FROM products");
  console.log(`[sync-text] source rows=${rows.length} -> target (dry=${DRY})`);
  if (DRY) { await db.pool.end(); return; }
  const ids = rows.map((r) => r.id);
  const pe = rows.map((r) => r.producto_en);
  const de = rows.map((r) => r.departamento_en);
  const fe = rows.map((r) => r.fixture_en);
  const pool = new Pool({ connectionString: target, ssl: { rejectUnauthorized: false } });
  const res = await pool.query(
    `UPDATE products AS p SET producto_en=v.pe, departamento_en=v.de, fixture_en=v.fe, updated_at=now()
     FROM (SELECT unnest($1::bigint[]) id, unnest($2::text[]) pe, unnest($3::text[]) de, unnest($4::text[]) fe) v
     WHERE p.id = v.id AND (p.producto_en IS DISTINCT FROM v.pe OR p.departamento_en IS DISTINCT FROM v.de OR p.fixture_en IS DISTINCT FROM v.fe)`,
    [ids, pe, de, fe]
  );
  console.log(`[sync-text] target rows changed=${res.rowCount}`);
  await pool.end();
  await db.pool.end();
})().catch((e) => { console.error("sync-text failed:", e.message); process.exit(1); });
