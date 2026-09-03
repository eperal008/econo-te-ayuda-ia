// ============================================================================
// Econo Te Ayuda IA — deterministic location engine ("no-AI-first")
//
// Pipeline (stops at the first layer that yields a result):
//   normalize -> exact (product/brand) -> alias -> category -> full-text -> fuzzy
//   -> (nothing) : log the miss and flag aiFallback=true for the Phase 3 AI layer.
//
// The engine NEVER invents a location. It only returns rows that exist in the
// database, and builds the human answer from stored structured fields.
// ============================================================================
const db = require("./db");
const { normalize } = require("./normalize");

const DEFAULT_STORE = process.env.DEFAULT_STORE_ID || "ECONO-SIERRA-BAYAMON";
// Fuzzy is the least-certain deterministic layer. Keep the bar high so weak,
// ambiguous matches (e.g. "white rum" ~ "white rice") fall through to the AI
// layer instead of returning a confident-but-wrong location.
const FUZZY_THRESHOLD = 0.5;
// Semantic (pgvector) recall. Cosine DISTANCE (0 = identical, 2 = opposite);
// only accept reasonably-close meaning matches so unrelated items don't win.
const SEMANTIC_MAX_DISTANCE = 0.5;
const EMBED_MODEL = "text-embedding-3-small";
const CONFIDENCE = { exact: "high", alias: "high", category: "medium", fulltext: "medium", semantic: "medium", fuzzy: "low" };

// Lazy OpenAI client — only created if the semantic layer is actually reached.
let _openai = null;
function getOpenAI() {
  if (_openai === null) {
    if (!process.env.OPENAI_API_KEY) return null;
    const { OpenAI } = require("openai");
    _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return _openai;
}
async function embedQuery(text) {
  const openai = getOpenAI();
  if (!openai) return null;
  const r = await openai.embeddings.create({ model: EMBED_MODEL, input: text });
  return "[" + r.data[0].embedding.join(",") + "]";
}

// SQL snippet: normalize a column the same way normalize() does in JS.
const N = (col) =>
  `btrim(regexp_replace(lower(f_unaccent(coalesce(${col},''))), '[^a-z0-9]+', ' ', 'g'))`;

// Columns every layer selects (product + its zone landmark).
const SELECT_COLS = `
  p.id, p.store_id, p.zone_id, p.departamento, p.departamento_en,
  p.categoria, p.categoria_en, p.producto, p.producto_en, p.marca,
  p.macro_area, p.macro_area_en, p.pasillo, p.pasillo_en, p.lado, p.lado_en,
  p.tramo, p.tramo_en, p.fixture, p.fixture_en, p.respuesta_app,
  p.price, p.promo_text, p.promo_text_en, p.promo_price, p.promo_image_url,
  p.inventory_status, p.image_url, p.orden_fisico,
  z.referencia AS zone_referencia`;
const FROM_JOIN = `
  FROM products p
  LEFT JOIN zones z ON z.store_id = p.store_id AND z.zone_id = p.zone_id`;

// ---- response building -----------------------------------------------------
const isNumberedAisle = (p) => /^\d+$/.test(String(p || "").trim());
const isLiquorCode = (p) => /^[a-z]\d+$/i.test(String(p || "").trim());
const lc = (s) => (s == null ? "" : String(s).toLowerCase());

function buildEs(r) {
  if (r.respuesta_app && r.respuesta_app.trim()) return r.respuesta_app.trim();
  const name = r.producto;
  if (isNumberedAisle(r.pasillo)) return `${name}: Pasillo ${r.pasillo}, lado ${lc(r.lado)}.`;
  if (isLiquorCode(r.pasillo)) return `${name}: Licores, ${r.pasillo}, lado ${lc(r.lado)}.`;
  const parts = [r.macro_area, r.lado ? `lado ${lc(r.lado)}` : null, r.tramo].filter(Boolean);
  let s = `${name}: ${parts.join(", ")}`;
  if (r.zone_referencia) s += ` (${r.zone_referencia})`;
  return s + ".";
}

function buildEn(r) {
  const name = r.producto_en || r.producto;
  const side = lc(r.lado_en);
  if (isNumberedAisle(r.pasillo))
    return `${name}: Aisle ${r.pasillo}${side ? `, ${side} side` : ""}.`;
  if (isLiquorCode(r.pasillo))
    return `${name}: Liquor aisle ${r.pasillo}${side ? `, ${side} side` : ""}.`;
  const parts = [r.macro_area_en, side ? `${side} side` : null, r.tramo_en].filter(Boolean);
  let s = `${name}: ${parts.join(", ")}`;
  if (r.fixture_en) s += ` (${lc(r.fixture_en)})`;
  return s + ".";
}

function shape(row) {
  const response = { es: buildEs(row), en: buildEn(row) };
  return { ...row, response };
}

// Drop duplicate (zone_id, producto) rows the source contains, keep first.
function dedupe(rows) {
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    const k = r.zone_id + "|" + normalize(r.producto);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

// ---- the layers ------------------------------------------------------------
async function layerExact(qn, storeId, limit) {
  const sql = `SELECT ${SELECT_COLS} ${FROM_JOIN}
    WHERE p.store_id = $1
      AND ( ${N("p.producto")} = $2 OR ${N("p.producto_en")} = $2 OR ${N("p.marca")} = $2 )
    ORDER BY p.orden_fisico NULLS LAST LIMIT $3`;
  return (await db.query(sql, [storeId, qn, limit])).rows;
}

async function layerAlias(qn, storeId, limit) {
  // Alias -> canonical term -> the product row in the alias's zone.
  const sql = `SELECT ${SELECT_COLS} ${FROM_JOIN}
    JOIN search_aliases a
      ON a.store_id = p.store_id AND a.zone_id = p.zone_id
     AND ${N("p.producto")} = ${N("a.termino_canonico")}
    WHERE a.store_id = $1 AND a.alias_normalized = $2
    ORDER BY p.orden_fisico NULLS LAST LIMIT $3`;
  return (await db.query(sql, [storeId, qn, limit])).rows;
}

async function layerCategory(qn, storeId, limit) {
  const sql = `SELECT ${SELECT_COLS} ${FROM_JOIN}
    WHERE p.store_id = $1
      AND ( ${N("p.categoria")} = $2 OR ${N("p.categoria_en")} = $2 )
    ORDER BY p.orden_fisico NULLS LAST LIMIT $3`;
  return (await db.query(sql, [storeId, qn, limit])).rows;
}

async function layerFullText(raw, qn, storeId, limit) {
  // Rank so the most canonical match wins: exact-name, then head-of-name match,
  // then shorter (more canonical) names, then text rank. This makes
  // "arroz" -> "Arroz blanco" instead of "Arroz con pollo / comidas con arroz".
  const sql = `SELECT ${SELECT_COLS}, ts_rank(p.search_tsv, plainto_tsquery('simple', f_unaccent($2))) AS rank
    ${FROM_JOIN}
    WHERE p.store_id = $1
      AND p.search_tsv @@ plainto_tsquery('simple', f_unaccent($2))
    ORDER BY
      (${N("p.producto")} = $4 OR ${N("p.producto_en")} = $4) DESC,
      (${N("p.producto")} LIKE $4 || ' %' OR ${N("p.producto_en")} LIKE $4 || ' %') DESC,
      char_length(p.producto) ASC,
      rank DESC,
      p.orden_fisico NULLS LAST
    LIMIT $3`;
  return (await db.query(sql, [storeId, raw, limit, qn])).rows;
}

async function layerFuzzy(qn, storeId, limit) {
  // Explicit similarity threshold (strictly greater) rather than the % operator,
  // so a marginal 0.50 match does not win — it should defer to the AI layer.
  const sql = `SELECT ${SELECT_COLS},
      greatest(similarity(${N("p.producto")}, $2), similarity(${N("p.producto_en")}, $2)) AS sim
    ${FROM_JOIN}
    WHERE p.store_id = $1
      AND greatest(similarity(${N("p.producto")}, $2), similarity(${N("p.producto_en")}, $2)) > $4
    ORDER BY sim DESC, p.orden_fisico NULLS LAST LIMIT $3`;
  return (await db.query(sql, [storeId, qn, limit, FUZZY_THRESHOLD])).rows;
}

async function layerSemantic(raw, storeId, limit) {
  const vec = await embedQuery(raw);
  if (!vec) return []; // no API key -> skip silently
  const sql = `SELECT ${SELECT_COLS}, (p.embedding <=> $2::vector) AS distance
    ${FROM_JOIN}
    WHERE p.store_id = $1 AND p.embedding IS NOT NULL
      AND (p.embedding <=> $2::vector) < $4
    ORDER BY p.embedding <=> $2::vector LIMIT $3`;
  return (await db.query(sql, [storeId, vec, limit, SEMANTIC_MAX_DISTANCE])).rows;
}

async function logMiss(raw, qn, storeId, lang) {
  try {
    await db.query(
      `INSERT INTO search_misses(store_id, query_raw, query_norm, lang) VALUES($1,$2,$3,$4)`,
      [storeId, raw, qn, lang]
    );
  } catch (e) {
    console.error("[locationEngine] miss log failed:", e.message);
  }
}

// ---- public API ------------------------------------------------------------
/**
 * @returns {Promise<{query,normalized,storeId,lang,matched,layer,aiFallback,results,best,answer}>}
 */
async function searchLocation(rawQuery, opts = {}) {
  const { storeId = DEFAULT_STORE, lang = "es", limit = 5, logMisses = true, semantic = true } = opts;
  const raw = (rawQuery || "").trim();
  const qn = normalize(raw);

  const base = { query: raw, normalized: qn, storeId, lang, matched: false, layer: null, confidence: null, aiFallback: false, results: [], best: null, answer: null };
  if (!qn) return base;

  const layers = [
    ["exact", () => layerExact(qn, storeId, limit)],
    ["alias", () => layerAlias(qn, storeId, limit)],
    ["category", () => layerCategory(qn, storeId, limit)],
    ["fulltext", () => layerFullText(raw, qn, storeId, limit)],
    ["fuzzy", () => layerFuzzy(qn, storeId, limit)],
    ...(semantic ? [["semantic", () => layerSemantic(raw, storeId, limit)]] : []), // paid; only if all else misses
  ];

  for (const [name, run] of layers) {
    let rows;
    try {
      rows = dedupe(await run());
    } catch (e) {
      console.error(`[locationEngine] layer ${name} error:`, e.message);
      continue;
    }
    if (rows.length) {
      const results = rows.map(shape);
      const best = results[0];
      return { ...base, matched: true, layer: name, confidence: CONFIDENCE[name], results, best, answer: best.response[lang] || best.response.es };
    }
  }

  if (logMisses) await logMiss(raw, qn, storeId, lang);
  return { ...base, aiFallback: true };
}

module.exports = { searchLocation, buildEs, buildEn, normalize, embedQuery, FUZZY_THRESHOLD };
