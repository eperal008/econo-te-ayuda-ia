#!/usr/bin/env node
/**
 * Strip placeholder/generic images left by fetch_images.js.
 *
 * Econo's store serves "no photo available" graphics for un-photographed items —
 * both the explicit /static/image-placeholder.png AND several generic .jpg assets
 * reused across unrelated products (the same file appears on Scotch Whisky, Vodka
 * AND Galletas). We detect those as any image_url shared by products with more
 * than one distinct head-noun, and null them so the kiosk shows no photo rather
 * than a wrong/blank one. Runs on whatever DB the connection points to.
 *
 *   node scripts/cleanup_images.js               # local (.env DATABASE_URL)
 *   TARGET_DATABASE_URL="postgres://…" node scripts/cleanup_images.js   # Railway
 *   --dry   report only, write nothing
 */
require("dotenv").config();
const { Pool } = require("pg");

const DRY = process.argv.includes("--dry");
const connectionString = process.env.TARGET_DATABASE_URL || process.env.DATABASE_URL;
const ssl = process.env.TARGET_DATABASE_URL
  ? { rejectUnauthorized: false }
  : (String(process.env.PGSSL).toLowerCase() === "true" ? { rejectUnauthorized: false } : false);

const STOP = new Set(["de", "del", "la", "el", "los", "las", "y", "o", "con", "para", "a", "en",
  "canned", "frozen", "enlatado", "enlatados", "enlatada", "enlatadas", "congelado", "congelada",
  "congelados", "grande", "grandes", "pequeno", "mini", "alt", "app"]);
const norm = (s) => (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
const head = (s) => norm(s).split(" ").filter((t) => t.length >= 3 && !STOP.has(t))[0] || norm(s).split(" ")[0] || "";

(async () => {
  const pool = new Pool({ connectionString, ssl });
  const { rows } = await pool.query("SELECT id, producto, image_url FROM products WHERE image_url IS NOT NULL");
  const byUrl = new Map();
  for (const r of rows) {
    if (!byUrl.has(r.image_url)) byUrl.set(r.image_url, { ids: [], heads: new Set() });
    const e = byUrl.get(r.image_url);
    e.ids.push(r.id); e.heads.add(head(r.producto));
  }
  const badUrls = [];
  for (const [url, e] of byUrl) {
    const isStatic = /image-placeholder|\/static\//.test(url);
    const crossCategory = e.heads.size >= 3; // shared across 3+ distinct head-nouns = generic "no photo" asset
    if (isStatic || crossCategory) badUrls.push({ url, n: e.ids.length, heads: [...e.heads].slice(0, 6), reason: isStatic ? "static" : "cross-category" });
  }
  const totalRows = badUrls.reduce((a, b) => a + b.n, 0);
  console.log(`[cleanup] ${byUrl.size} distinct images; ${badUrls.length} placeholder/generic -> nulling ${totalRows} product rows (dry=${DRY})`);
  badUrls.sort((a, b) => b.n - a.n).slice(0, 12).forEach((b) => console.log(`   x${b.n} [${b.reason}] ${b.heads.join(",")}`));

  if (!DRY && badUrls.length) {
    const urls = badUrls.map((b) => b.url);
    const res = await pool.query("UPDATE products SET image_url=NULL, updated_at=now() WHERE image_url = ANY($1)", [urls]);
    const c = await pool.query("SELECT count(*) FILTER (WHERE image_url IS NOT NULL) img, count(*) total FROM products");
    console.log(`[cleanup] nulled ${res.rowCount}. real images now: ${c.rows[0].img}/${c.rows[0].total}`);
  }
  await pool.end();
})().catch((e) => { console.error("cleanup_images failed:", e.message); process.exit(1); });
