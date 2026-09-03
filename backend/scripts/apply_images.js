#!/usr/bin/env node
/**
 * Apply a fetch_images report to a target database WITHOUT re-crawling the store.
 * Use it to push the same image_url matches to production (Railway) after running
 * fetch_images.js locally.
 *
 *   # against whatever DATABASE_URL is in backend/.env (local):
 *   node scripts/apply_images.js
 *
 *   # against a different DB (e.g. Railway), pass the URL inline:
 *   TARGET_DATABASE_URL="postgres://…" node scripts/apply_images.js
 *
 *   --report <path>   report file (default: %TEMP%/econo_images_report_econo-manati.json)
 *   --include-weak    also apply the low-confidence matches (default: confident only)
 *   --dry             show counts, write nothing
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const args = process.argv.slice(2);
const DRY = args.includes("--dry");
const INCLUDE_WEAK = args.includes("--include-weak");
const STORE = (() => { const i = args.indexOf("--store"); return i >= 0 ? args[i + 1] : "econo-manati"; })();
const REPORT = (() => { const i = args.indexOf("--report"); return i >= 0 ? args[i + 1] : path.join(process.env.TEMP || "/tmp", `econo_images_report_${STORE}.json`); })();

const connectionString = process.env.TARGET_DATABASE_URL || process.env.DATABASE_URL;
const ssl = process.env.TARGET_DATABASE_URL
  ? { rejectUnauthorized: false } // external managed DBs (Railway) need SSL
  : (String(process.env.PGSSL).toLowerCase() === "true" ? { rejectUnauthorized: false } : false);

(async () => {
  const rows = JSON.parse(fs.readFileSync(REPORT, "utf8"));
  const apply = rows.filter((r) => r.image_url && (INCLUDE_WEAK || !r.weak));
  console.log(`[apply] report=${path.basename(REPORT)} rows=${rows.length} applicable=${apply.length} (weak included: ${INCLUDE_WEAK})`);
  console.log(`[apply] target=${connectionString.replace(/:[^:@/]+@/, ":****@")} ssl=${!!ssl} dry=${DRY}`);
  if (DRY) return;

  const pool = new Pool({ connectionString, ssl });
  // single bulk UPDATE via unnest — one round-trip (the TCP proxy makes per-row writes slow)
  const ids = apply.map((r) => r.id);
  const urls = apply.map((r) => r.image_url);
  const res = await pool.query(
    `UPDATE products AS p SET image_url = v.url, updated_at = now()
     FROM (SELECT unnest($1::bigint[]) AS id, unnest($2::text[]) AS url) v
     WHERE p.id = v.id`,
    [ids, urls]
  );
  const n = res.rowCount;
  const c = await pool.query("SELECT count(*) FILTER (WHERE image_url IS NOT NULL) img, count(*) total FROM products");
  console.log(`[apply] updated=${n}. now with image: ${c.rows[0].img}/${c.rows[0].total}`);
  await pool.end();
})().catch((e) => { console.error("apply_images failed:", e.message); process.exit(1); });
