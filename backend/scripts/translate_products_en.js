#!/usr/bin/env node
/**
 * Fix Spanglish/untranslated English product names (producto_en). Many rows have
 * producto_en left in Spanish (== producto) or half-translated ("Calamares Canned",
 * "Pescado Frozen"). EN mode displays producto_en, and it feeds the full-text
 * search vector, so clean English improves both. Brands/proper nouns/already-English
 * terms are preserved unchanged by the model.
 *
 *   node scripts/translate_products_en.js --dry            # propose, write nothing
 *   node scripts/translate_products_en.js --dry --limit 60 # small sample
 *   node scripts/translate_products_en.js                  # apply to local DB
 *
 * Applies to the LOCAL db and writes a mapping to %TEMP%/econo_producto_en_map.json
 * (sync to Railway afterwards with sync_producto_en_to_target.js).
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const db = require("../lib/db");
const { OpenAI } = require("openai");
const { withRetry } = require("../lib/retry");

const args = process.argv.slice(2);
const DRY = args.includes("--dry");
const LIMIT = (() => { const i = args.indexOf("--limit"); return i >= 0 ? parseInt(args[i + 1], 10) : 0; })();
const MAP_FILE = path.join(process.env.TEMP || "/tmp", "econo_producto_en_map.json");
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = "gpt-4o-mini";
const BATCH = 40;

const SYSTEM = `You translate Puerto-Rico supermarket product TERMS from Spanish to natural English for an in-store finder. You are given items with the Spanish term and the current (often wrong) English. Return the best concise ENGLISH product name for each.
RULES:
- Keep brand names, proper nouns, and terms that are ALREADY correct English unchanged (e.g. "Cheetos", "Oreo", "Café Bustelo"->"Café Bustelo", "Panko", "Pesto", "Cranberry").
- Translate Spanish common nouns to the everyday US-supermarket English term ("Calamares enlatados"->"Canned Squid", "Vinagre grande"->"Large Vinegar", "Pescado congelado"->"Frozen Fish", "Habichuelas rosadas"->"Pink Beans", "Jugo de lima"->"Lime Juice").
- Preserve "/" alternates ("Pepinillos / relish"->"Pickles / Relish").
- Do NOT add brand names, sizes, or words that are not in the source. Keep it short (a product term, not a sentence). Title Case.
Return ONLY a JSON object: {"items":[{"i":<index>,"en":"<English name>"}]} for every input index.`;

async function translateBatch(items) {
  const user = "Translate these:\n" + items.map((it, i) => `${i}. es="${it.producto}" current_en="${it.producto_en || ""}"`).join("\n");
  const res = await withRetry(() => openai.chat.completions.create({
    model: MODEL, temperature: 0, response_format: { type: "json_object" },
    messages: [{ role: "system", content: SYSTEM }, { role: "user", content: user }],
  }));
  let out = {};
  try { out = JSON.parse(res.choices[0].message.content); } catch { out = {}; }
  const map = {};
  for (const r of out.items || []) if (typeof r.i === "number" && r.en) map[r.i] = String(r.en).trim();
  return map;
}

(async () => {
  // distinct terms whose English is missing, untranslated, or obviously Spanglish
  let sql = `SELECT DISTINCT producto, producto_en FROM products
    WHERE producto_en IS NULL
       OR lower(btrim(producto_en)) = lower(btrim(producto))
       OR producto_en ILIKE '% Canned%' OR producto_en ILIKE '% Frozen%' OR producto_en ILIKE '%Frozenr%'
       OR producto_en ILIKE '%enlatad%' OR producto_en ILIKE '%congelad%' OR producto_en ILIKE '%refrigerated%'
    ORDER BY producto`;
  if (LIMIT) sql += ` LIMIT ${LIMIT}`;
  const { rows } = await db.query(sql);
  console.log(`[tr] ${rows.length} distinct terms to review (dry=${DRY})`);

  const map = {}; // producto -> english
  let changed = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const res = await translateBatch(chunk);
    chunk.forEach((it, j) => {
      const en = res[j];
      if (en && en.toLowerCase() !== (it.producto_en || "").toLowerCase()) { map[it.producto] = en; changed++; }
    });
    console.log(`[tr] ${Math.min(i + BATCH, rows.length)}/${rows.length}  proposed changes=${changed}`);
  }

  fs.writeFileSync(MAP_FILE, JSON.stringify(map, null, 0));
  console.log(`[tr] proposed ${changed} term changes. mapping: ${MAP_FILE}`);
  // show a sample for review
  const sample = Object.entries(map).slice(0, 25);
  console.log("--- sample (producto -> new producto_en) ---");
  sample.forEach(([k, v]) => console.log("  " + k.slice(0, 34).padEnd(34) + " -> " + v));

  if (!DRY && changed) {
    const keys = Object.keys(map), vals = keys.map((k) => map[k]);
    const res = await db.query(
      `UPDATE products AS p SET producto_en = m.en, updated_at = now()
       FROM (SELECT unnest($1::text[]) AS producto, unnest($2::text[]) AS en) m
       WHERE p.producto = m.producto`, [keys, vals]
    );
    console.log(`[tr] applied to ${res.rowCount} rows (search_tsv regenerates automatically).`);
  }
  await db.pool.end();
})().catch((e) => { console.error("translate failed:", e.message); process.exit(1); });
