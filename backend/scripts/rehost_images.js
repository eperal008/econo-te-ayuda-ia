#!/usr/bin/env node
/**
 * Rehost product images from Econo's CDN to the customer's Cloudinary, for
 * durability + ownership (so images survive if Econo changes its online platform).
 * Uploads each DISTINCT cdn.localexpress.io image once (deduped across duplicate
 * rows) with a deterministic public_id (idempotent — safe to re-run), then rewrites
 * products.image_url to the Cloudinary secure_url. Runs against the local DB;
 * afterwards mirror to Railway with sync_images_to_target.js.
 *
 *   node scripts/rehost_images.js            # upload + rewrite local DB
 *   node scripts/rehost_images.js --dry      # list what would upload, no calls
 *   node scripts/rehost_images.js --limit 20 # first 20 distinct images (testing)
 *
 * Writes a src->cloud mapping to %TEMP%/econo_cloudinary_map.json.
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const db = require("../lib/db");
const cloudinary = require("cloudinary").v2;

const args = process.argv.slice(2);
const DRY = args.includes("--dry");
const LIMIT = (() => { const i = args.indexOf("--limit"); return i >= 0 ? parseInt(args[i + 1], 10) : 0; })();
const CONCURRENCY = 6;
const MAP_FILE = path.join(process.env.TEMP || "/tmp", "econo_cloudinary_map.json");
const SRC_HOST = "cdn.localexpress.io";

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const pid = (url) => "le_" + crypto.createHash("md5").update(url).digest("hex").slice(0, 20);

async function uploadOne(src) {
  const res = await cloudinary.uploader.upload(src, {
    folder: "econo_products",
    public_id: pid(src),
    overwrite: false,        // idempotent: same public_id returns the existing asset
    resource_type: "image",
    // keep the source's aspect; do not upscale. Store as delivered.
  });
  return res.secure_url;
}

(async () => {
  const { rows } = await db.query(
    `SELECT DISTINCT image_url FROM products WHERE image_url LIKE '%${SRC_HOST}%'` + (LIMIT ? ` LIMIT ${LIMIT}` : "")
  );
  const srcs = rows.map((r) => r.image_url);
  console.log(`[rehost] ${srcs.length} distinct source images to move to Cloudinary (dry=${DRY})`);
  if (DRY) { console.log("  e.g.", srcs.slice(0, 3).map((s) => `${s.slice(-16)} -> econo_products/${pid(s)}`)); await db.pool.end(); return; }

  const map = fs.existsSync(MAP_FILE) ? JSON.parse(fs.readFileSync(MAP_FILE, "utf8")) : {};
  let done = 0, failed = 0, updated = 0, idx = 0;
  async function worker() {
    while (idx < srcs.length) {
      const src = srcs[idx++];
      if (map[src]) { done++; continue; } // already uploaded in a prior run
      try { map[src] = await uploadOne(src); done++; }
      catch (e) { failed++; console.warn("  upload failed:", src.slice(-18), e.message); }
      if ((done + failed) % 50 === 0) { console.log(`[rehost] uploaded ${done}/${srcs.length} (failed ${failed})`); fs.writeFileSync(MAP_FILE, JSON.stringify(map, null, 0)); }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  fs.writeFileSync(MAP_FILE, JSON.stringify(map, null, 0));
  console.log(`[rehost] uploads done: ${done} ok, ${failed} failed. Rewriting DB…`);

  // bulk rewrite local DB: image_url src -> cloud, via one unnest UPDATE
  const pairs = Object.entries(map);
  const from = pairs.map((p) => p[0]), to = pairs.map((p) => p[1]);
  const res = await db.query(
    `UPDATE products AS p SET image_url = m.cloud, updated_at = now()
     FROM (SELECT unnest($1::text[]) AS src, unnest($2::text[]) AS cloud) m
     WHERE p.image_url = m.src`, [from, to]
  );
  updated = res.rowCount;
  const c = await db.query(`SELECT count(*) FILTER (WHERE image_url LIKE '%res.cloudinary.com%') cloud, count(*) FILTER (WHERE image_url LIKE '%${SRC_HOST}%') remaining FROM products`);
  console.log(`[rehost] DB rows rewritten: ${updated}. cloudinary=${c.rows[0].cloud} still-on-econo=${c.rows[0].remaining}`);
  console.log(`[rehost] mapping saved: ${MAP_FILE}`);
  await db.pool.end();
})().catch((e) => { console.error("rehost_images failed:", e.message); process.exit(1); });
