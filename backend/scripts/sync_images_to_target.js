#!/usr/bin/env node
/**
 * Mirror products.image_url from the LOCAL db to a target db (Railway), so prod
 * exactly matches local after the full image pipeline (fetch -> weak -> cleanup ->
 * rehost). Copies NULLs too, so cleaned/placeholder rows are cleared in prod.
 *
 *   TARGET_DATABASE_URL="postgres://…" node scripts/sync_images_to_target.js
 *   --dry   show counts only
 */
require("dotenv").config();
const db = require("../lib/db"); // local (source)
const { Pool } = require("pg");

const DRY = process.argv.includes("--dry");
const target = process.env.TARGET_DATABASE_URL;
if (!target) { console.error("set TARGET_DATABASE_URL to the Railway DB url"); process.exit(1); }

(async () => {
  const { rows } = await db.query("SELECT id, image_url FROM products");
  const ids = rows.map((r) => r.id);
  const urls = rows.map((r) => r.image_url); // may be null
  const withImg = urls.filter(Boolean).length;
  console.log(`[sync] source rows=${rows.length} with-image=${withImg} -> target (dry=${DRY})`);
  if (DRY) { await db.pool.end(); return; }

  const pool = new Pool({ connectionString: target, ssl: { rejectUnauthorized: false } });
  const res = await pool.query(
    `UPDATE products AS p SET image_url = v.url, updated_at = now()
     FROM (SELECT unnest($1::bigint[]) AS id, unnest($2::text[]) AS url) v
     WHERE p.id = v.id AND p.image_url IS DISTINCT FROM v.url`,
    [ids, urls]
  );
  const c = await pool.query("SELECT count(*) FILTER (WHERE image_url IS NOT NULL) img, count(*) total FROM products");
  console.log(`[sync] target rows changed=${res.rowCount}. target now with-image: ${c.rows[0].img}/${c.rows[0].total}`);
  await pool.end();
  await db.pool.end();
})().catch((e) => { console.error("sync failed:", e.message); process.exit(1); });
