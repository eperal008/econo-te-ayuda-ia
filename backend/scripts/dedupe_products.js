#!/usr/bin/env node
/**
 * Remove duplicate product rows: the same product term repeated within the SAME
 * store+zone (a data-entry artifact in the source workbook). Products that appear
 * in MULTIPLE zones are legitimate multi-aisle placements and are kept.
 * For each (store_id, zone_id, producto) group we keep the richest row — one that
 * has an image, then a price, then a promo, then the lowest id — and delete the rest.
 * No FK references products.id, so deletes are safe. Runs on any DB.
 * (Already applied to local + Railway on 2026-09-04, removing 184 rows: 1480 -> 1296.)
 *
 *   node scripts/dedupe_products.js --dry                 # local, count only
 *   node scripts/dedupe_products.js                       # local, delete
 *   TARGET_DATABASE_URL="postgres://…" node scripts/dedupe_products.js   # Railway
 */
require("dotenv").config();
const { Pool } = require("pg");
const DRY = process.argv.includes("--dry");
const cs = process.env.TARGET_DATABASE_URL || process.env.DATABASE_URL;
const ssl = process.env.TARGET_DATABASE_URL ? { rejectUnauthorized: false }
  : (String(process.env.PGSSL).toLowerCase() === "true" ? { rejectUnauthorized: false } : false);

const RANK = `row_number() OVER (
  PARTITION BY store_id, zone_id, producto
  ORDER BY (image_url IS NOT NULL) DESC, (price IS NOT NULL) DESC,
           (promo_price IS NOT NULL) DESC, id ASC)`;

(async () => {
  const pool = new Pool({ connectionString: cs, ssl });
  const before = (await pool.query("SELECT count(*) c FROM products")).rows[0].c;
  const dupes = (await pool.query(`SELECT count(*) c FROM (SELECT id, ${RANK} rn FROM products) x WHERE rn > 1`)).rows[0].c;
  console.log(`[dedupe] target=${cs.replace(/:[^:@/]+@/, ":****@")} rows=${before} duplicates-to-remove=${dupes} (dry=${DRY})`);
  if (DRY || dupes === "0") { await pool.end(); return; }

  const res = await pool.query(
    `DELETE FROM products WHERE id IN (SELECT id FROM (SELECT id, ${RANK} rn FROM products) x WHERE rn > 1)`
  );
  const after = (await pool.query("SELECT count(*) c FROM products")).rows[0].c;
  console.log(`[dedupe] deleted=${res.rowCount}. rows ${before} -> ${after}`);
  await pool.end();
})().catch((e) => { console.error("dedupe failed:", e.message); process.exit(1); });
