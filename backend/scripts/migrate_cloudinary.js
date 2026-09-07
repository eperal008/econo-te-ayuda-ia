#!/usr/bin/env node
/**
 * Move all product + deal images from one Cloudinary account to another (e.g. dev
 * -> customer). Re-uploads each DISTINCT image to the NEW account keeping the same
 * public_id, then repoints products.image_url and deals.image_url in the local DB
 * and (if RW is set) Railway. Idempotent. The OLD account is left untouched.
 *
 * Required env: NEW_CN, NEW_KEY, NEW_SECRET (target Cloudinary credentials).
 * Optional env: RW=<railway db url>, OLD_HOST substring to match (default old cloud).
 *
 *   NEW_CN=.. NEW_KEY=.. NEW_SECRET=.. RW="postgres://.." node scripts/migrate_cloudinary.js
 *   ... --dry   (list what would move, upload/write nothing)
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const db = require("../lib/db"); // local
const { Pool } = require("pg");
const cloudinary = require("cloudinary").v2;

const DRY = process.argv.includes("--dry");
const OLD_MATCH = process.env.OLD_HOST || "res.cloudinary.com"; // any cloudinary URL not already on NEW_CN
const NEW_CN = process.env.NEW_CN;
const MAP_FILE = path.join(process.env.TEMP || "/tmp", "econo_cloudinary_migrate_map.json");
const CONCURRENCY = 6;

if (!NEW_CN || !process.env.NEW_KEY || !process.env.NEW_SECRET) {
  console.error("set NEW_CN, NEW_KEY, NEW_SECRET"); process.exit(1);
}
cloudinary.config({ cloud_name: NEW_CN, api_key: process.env.NEW_KEY, api_secret: process.env.NEW_SECRET });

// pull the public_id (incl folder) out of a cloudinary delivery URL
const publicIdOf = (url) => {
  const m = url.match(/\/upload\/(?:v\d+\/)?(.+)\.[a-zA-Z0-9]+$/);
  return m ? m[1] : null;
};

async function collectSources() {
  const set = new Set();
  const p = await db.query("SELECT DISTINCT image_url u FROM products WHERE image_url LIKE $1", ["%" + OLD_MATCH + "%"]);
  const d = await db.query("SELECT DISTINCT image_url u FROM deals WHERE image_url LIKE $1", ["%" + OLD_MATCH + "%"]);
  for (const r of [...p.rows, ...d.rows]) if (r.u && !r.u.includes("/" + NEW_CN + "/")) set.add(r.u);
  return [...set];
}

async function updateDb(pool, label, map) {
  const from = Object.keys(map), to = from.map((k) => map[k]);
  for (const tbl of ["products", "deals"]) {
    const res = await pool.query(
      `UPDATE ${tbl} AS t SET image_url = m.nu, updated_at = now()
       FROM (SELECT unnest($1::text[]) AS ou, unnest($2::text[]) AS nu) m
       WHERE t.image_url = m.ou`, [from, to]
    );
    console.log(`[migrate] ${label}.${tbl}: repointed ${res.rowCount} rows`);
  }
}

(async () => {
  const srcs = await collectSources();
  console.log(`[migrate] ${srcs.length} distinct images to move to Cloudinary '${NEW_CN}' (dry=${DRY})`);
  if (!srcs.length) { console.log("[migrate] nothing to do (already migrated?)"); await db.pool.end(); return; }
  if (DRY) { console.log("  e.g.", srcs.slice(0, 3).map((s) => publicIdOf(s))); await db.pool.end(); return; }

  const map = fs.existsSync(MAP_FILE) ? JSON.parse(fs.readFileSync(MAP_FILE, "utf8")) : {};
  let done = 0, failed = 0, i = 0;
  async function worker() {
    while (i < srcs.length) {
      const src = srcs[i++];
      if (map[src]) { done++; continue; }
      const pid = publicIdOf(src);
      if (!pid) { failed++; console.warn("  bad url:", src.slice(-30)); continue; }
      try {
        const r = await cloudinary.uploader.upload(src, { public_id: pid, overwrite: false, resource_type: "image" });
        map[src] = r.secure_url; done++;
      } catch (e) { failed++; console.warn("  upload failed:", pid, e.message); }
      if ((done + failed) % 50 === 0) { console.log(`[migrate] uploaded ${done}/${srcs.length} (failed ${failed})`); fs.writeFileSync(MAP_FILE, JSON.stringify(map)); }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  fs.writeFileSync(MAP_FILE, JSON.stringify(map));
  console.log(`[migrate] uploads done: ${done} ok, ${failed} failed. Repointing DBs…`);

  await updateDb(db.pool, "local", map);
  if (process.env.RW) {
    const rw = new Pool({ connectionString: process.env.RW, ssl: { rejectUnauthorized: false } });
    await updateDb(rw, "railway", map);
    await rw.end();
  }
  console.log(`[migrate] done. map: ${MAP_FILE}`);
  await db.pool.end();
})().catch((e) => { console.error("migrate failed:", e.message); process.exit(1); });
