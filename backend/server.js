// ============================================================================
// Econo Te Ayuda IA — backend server (v1)
// Phase 2: deterministic location engine over HTTP.
// (STT/TTS/vision/admin endpoints get ported from the legacy index.js in later
//  phases; index.js is kept as reference and is not run.)
// ============================================================================
const express = require("express");
const cors = require("cors");
require("dotenv").config();

const { searchLocation } = require("./lib/locationEngine");
const db = require("./lib/db");

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: "2mb" }));

// health / readiness
app.get("/health", async (_req, res) => {
  try {
    const { rows } = await db.query(
      "SELECT (SELECT count(*)::int FROM products) products, (SELECT count(*)::int FROM zones) zones"
    );
    res.json({ ok: true, db: rows[0] });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// deterministic product-location search
async function handleSearch(query, lang, storeId, res) {
  if (!query || !String(query).trim()) {
    return res.status(400).json({ error: "Missing 'q' / 'query'." });
  }
  try {
    const r = await searchLocation(query, {
      lang: lang === "en" ? "en" : "es",
      storeId: storeId || undefined,
    });
    res.json({
      query: r.query,
      matched: r.matched,
      layer: r.layer,
      confidence: r.confidence, // high | medium | low
      aiFallback: r.aiFallback, // Phase 3 AI layer handles this when true
      answer: r.answer,
      best: r.best && {
        producto: r.best.producto,
        producto_en: r.best.producto_en,
        zone_id: r.best.zone_id,
        pasillo: r.best.pasillo,
        lado: r.best.lado,
        response: r.best.response,
        price: r.best.price,
        promo_text: r.best.promo_text,
        promo_price: r.best.promo_price,
        image_url: r.best.image_url,
      },
      results: r.results.map((x) => ({
        producto: x.producto,
        producto_en: x.producto_en,
        zone_id: x.zone_id,
        pasillo: x.pasillo,
        response: x.response,
      })),
    });
  } catch (e) {
    console.error("[/api/search]", e.message);
    res.status(500).json({ error: "search failed" });
  }
}

app.get("/api/search", (req, res) =>
  handleSearch(req.query.q, req.query.lang, req.query.store, res)
);
app.post("/api/search", (req, res) =>
  handleSearch(req.body.query, req.body.lang, req.body.storeId, res)
);

app.listen(PORT, () => console.log(`Econo backend listening on :${PORT}`));
