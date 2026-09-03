#!/usr/bin/env node
/**
 * Product-image feed — pulls real product photos from Econo's own online store
 * (Econo To Go, powered by Local Express) and matches them to our catalog terms,
 * populating products.image_url so the kiosk result card shows a real photo.
 *
 * Source: POST https://<store>.econotogo.com/product-search  (Yii2, CSRF-guarded)
 *   body: typed=<query>&department=&isShippable=0
 *   -> JSON { content: "<html rows>" }; each .row-link has:
 *        .product-pic  background-image:url('https://cdn.localexpress.io/img/….jpg')
 *        <p aria-label="Name $price">Name, <span>size</span>
 *        href="/category/…#show-product-info-<UPC>"
 *
 * These are Econo's own product images for Econo's own in-store kiosk (customer-
 * authorized, Option A). We hotlink the CDN URL; a later pass can rehost to Cloudinary.
 *
 *   node scripts/fetch_images.js            # crawl + update image_url + write report
 *   node scripts/fetch_images.js --dry      # crawl + report only, no DB writes
 *   node scripts/fetch_images.js --limit 50 # first 50 products (testing)
 *   node scripts/fetch_images.js --store econo-manati
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const db = require("../lib/db");

const args = process.argv.slice(2);
const DRY = args.includes("--dry");
const WEAK = args.includes("--weak"); // second pass: only imageless products, try ALL "/" segments (ES+EN)
const LIMIT = (() => { const i = args.indexOf("--limit"); return i >= 0 ? parseInt(args[i + 1], 10) : 0; })();
const STORE = (() => { const i = args.indexOf("--store"); return i >= 0 ? args[i + 1] : "econo-manati"; })();
const BASE = `https://${STORE.replace(/^econo-/, "")}.econotogo.com`; // premium subdomain, e.g. manati.econotogo.com
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";
const DELAY_MS = 180;
const REPORT = path.join(process.env.TEMP || "/tmp", `econo_images_report${WEAK ? "_weak" : ""}_${STORE}.json`);

// ---------- session (CSRF + cookies) ----------
const jar = {};
function setCookies(arr) { for (const sc of arr || []) { const p = sc.split(";")[0]; const i = p.indexOf("="); if (i > 0) jar[p.slice(0, i).trim()] = p.slice(i + 1).trim(); } }
function cookieHeader() { return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; "); }
let CSRF = null;

async function prime() {
  // A POST without a valid token returns 400 + a full HTML page carrying a fresh
  // csrf-token meta and Set-Cookie; harvest both to build a valid session.
  const r = await fetch(BASE + "/product-search", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Requested-With": "XMLHttpRequest", "User-Agent": UA, ...(cookieHeader() ? { Cookie: cookieHeader() } : {}) },
    body: "typed=arroz",
    redirect: "manual",
  });
  setCookies(r.headers.getSetCookie?.() || []);
  const html = await r.text();
  const m = html.match(/name="csrf-token" content="([^"]+)"/);
  CSRF = m ? m[1] : null;
  if (!CSRF) throw new Error("could not obtain CSRF token from " + BASE);
}

async function search(typed) {
  const doReq = async () => fetch(BASE + "/product-search", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Requested-With": "XMLHttpRequest",
      "X-CSRF-Token": CSRF,
      Cookie: cookieHeader(),
      "User-Agent": UA,
    },
    body: `typed=${encodeURIComponent(typed)}&department=&isShippable=0&_csrf=${encodeURIComponent(CSRF)}`,
    redirect: "manual",
  });
  let r = await doReq();
  if (r.status === 400 || r.status === 403) { await prime(); r = await doReq(); } // token expired -> refresh once
  if (!(r.headers.get("content-type") || "").includes("json")) return [];
  const j = await r.json();
  return parseRows(j.content || "");
}

// ---------- parse the HTML fragment ----------
function parseRows(html) {
  const blocks = html.split(/<a class="row row-link"/).slice(1);
  const out = [];
  for (const b of blocks) {
    const img = (b.match(/background-image:url\('([^']+)'\)/) || [])[1];
    if (!img) continue;
    let name = (b.match(/<p[^>]*aria-label="([^"]*)"/) || [])[1] || "";
    name = name.replace(/\s*\$[0-9].*$/, "").trim(); // drop trailing price in aria-label
    if (!name) name = (b.match(/<p[^>]*>\s*([^,<]+)/) || [])[1]?.trim() || "";
    const upc = (b.match(/#show-product-info-(\w+)/) || [])[1] || null;
    const sale = (b.match(/class="sale-value">\s*([^<]+)/) || [])[1]?.trim() || null;
    const old = (b.match(/class="old-value">\s*([^<]+)/) || [])[1]?.trim() || null;
    out.push({ name, img, upc, sale, old });
  }
  return out;
}

// ---------- matching ----------
const STOP = new Set(["de", "del", "la", "el", "los", "las", "y", "o", "con", "para", "a", "en",
  "canned", "frozen", "enlatado", "enlatados", "enlatada", "enlatadas", "congelado", "congelada",
  "congelados", "grande", "grandes", "pequeno", "mini", "alt", "app"]);
function norm(s) { return (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim(); }
function sigTokens(s) { return norm(s).split(" ").filter((t) => t.length >= 3 && !STOP.has(t)); }

// whole-word match with singular/plural tolerance (carne≈carnes) — NOT substring,
// so "manteca" does not match "mantecado" and "aceite" alone is never enough.
function tokEq(a, b) { return a === b || a === b + "s" || b === a + "s"; }
function bestMatch(queryName, rows) {
  const qt = sigTokens(queryName);
  if (!rows.length || qt.length === 0) return null;
  const head = qt[0], mods = qt.slice(1);
  let best = null, bestScore = -1;
  rows.forEach((row, idx) => {
    const ct = norm(row.name).split(" ").filter(Boolean);
    const has = (t) => ct.some((c) => tokEq(c, t));
    // gate: the head noun must appear AND (if there are modifiers) at least one must too.
    // This rejects generic-word-only hits: "Aceite de coco" won't accept "Aceite de oliva".
    if (!has(head)) return;
    if (mods.length && !mods.some(has)) return;
    const matched = qt.filter(has).length;
    const score = matched * 100 - idx - Math.min(row.name.length, 60) * 0.1;
    if (score > bestScore) { bestScore = score; best = { row, hit: matched, idx }; }
  });
  return best;
}

// ---------- query building ----------
function queriesFor(p) {
  const qs = [];
  const first = (s) => (s || "").split("/")[0].trim();
  if (p.producto) qs.push(first(p.producto));
  if (p.marca && p.marca.trim()) qs.push(p.marca.trim());
  if (p.producto_en) qs.push(first(p.producto_en));
  // de-dupe (case-insensitive), drop empties/too-short
  const seen = new Set();
  return qs.filter((q) => q && q.length >= 2 && !seen.has(q.toLowerCase()) && seen.add(q.toLowerCase()));
}

// second-pass query list: EVERY "/" segment of the ES and EN names (the alternate
// segment is often the findable term — "Mapos / Mops", "Snacks salados / chips"),
// plus the brand. Same strict match gate, so this only ADDS correct matches.
function queriesForWeak(p) {
  const segs = [];
  for (const src of [p.producto, p.producto_en]) (src || "").split("/").forEach((s) => segs.push(s.trim()));
  if (p.marca && p.marca.trim()) segs.push(p.marca.trim());
  const seen = new Set();
  return segs.filter((q) => q && q.length >= 2 && !seen.has(q.toLowerCase()) && seen.add(q.toLowerCase()));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await prime();
  console.log(`[img] session ready on ${BASE} — crawling…`);

  let sql = `SELECT id, producto, producto_en, marca FROM products ${WEAK ? "WHERE image_url IS NULL" : ""} ORDER BY ${args.includes("--random") ? "random()" : "id"}`;
  if (LIMIT) sql += ` LIMIT ${LIMIT}`;
  const { rows: products } = await db.query(sql);
  console.log(`[img] ${products.length} products to process (dry=${DRY})`);

  const report = [];
  let matched = 0, updated = 0, i = 0;
  for (const p of products) {
    i++;
    let picked = null, usedQuery = null;
    for (const q of (WEAK ? queriesForWeak(p) : queriesFor(p))) {
      let rows;
      try { rows = await search(q); } catch (e) { await prime(); rows = await search(q).catch(() => []); }
      await sleep(DELAY_MS);
      const bm = bestMatch(q, rows.length ? rows : []);
      // prefer a match found via the ES name; accept brand/EN fallback only if primary gave nothing
      if (bm) { picked = { ...bm, total: rows.length }; usedQuery = q; break; }
      if (rows.length && !picked) { picked = { row: rows[0], hit: 0, idx: 0, total: rows.length, weak: true }; usedQuery = q; }
    }
    const rec = {
      id: p.id, producto: p.producto, query: usedQuery,
      match: picked?.row?.name || null, image_url: picked?.row?.img || null,
      upc: picked?.row?.upc || null, sale: picked?.row?.sale || null, old: picked?.row?.old || null,
      hits: picked?.hit ?? 0, results: picked?.total ?? 0, weak: !!picked?.weak,
    };
    report.push(rec);
    if (rec.image_url && !rec.weak) matched++;
    if (rec.image_url && !DRY) {
      // only write confident (non-weak) matches to the live column
      if (!rec.weak) { await db.query("UPDATE products SET image_url=$1, updated_at=now() WHERE id=$2", [rec.image_url, p.id]); updated++; }
    }
    if (i % 50 === 0) console.log(`[img] ${i}/${products.length}  matched=${matched} updated=${updated}`);
  }

  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));
  const weak = report.filter((r) => r.weak && r.image_url).length;
  const none = report.filter((r) => !r.image_url).length;
  console.log(`\n[img] DONE. confident=${matched}  weak/uncertain=${weak}  no-result=${none}  (of ${report.length})`);
  console.log(`[img] DB updated: ${updated}${DRY ? " (dry run — none)" : ""}`);
  console.log(`[img] full report: ${REPORT}`);
  await db.pool.end();
})().catch((e) => { console.error("fetch_images failed:", e); process.exit(1); });
