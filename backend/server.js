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
const { ask } = require("./lib/assistant");
const { textToSpeech, speechToText } = require("./lib/voice");
const { identifyProduct } = require("./lib/vision");
const { router: adminRouter } = require("./routes/admin");
const db = require("./lib/db");

const app = express();
const PORT = process.env.PORT || 3001;

// Restrict CORS to the kiosk frontend(s). Configure extra origins via
// ALLOWED_ORIGINS (comma-separated). Non-browser requests (no Origin) are allowed.
const ALLOWED_ORIGINS = (
  process.env.ALLOWED_ORIGINS ||
  "https://frontend-production-70ca.up.railway.app,http://localhost:3005,http://localhost:3000"
).split(",").map((s) => s.trim()).filter(Boolean);

app.use(cors({
  origin: (origin, cb) =>
    !origin || ALLOWED_ORIGINS.includes(origin)
      ? cb(null, true)
      : cb(new Error("Not allowed by CORS")),
}));
app.use(express.json({ limit: "2mb" }));

// admin dashboard API
app.use("/api/admin", adminRouter);

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

// full AI assistant (intent router + rich features, grounded in the engine)
app.post("/api/assistant", async (req, res) => {
  const { query, lang, storeId, conversationHistory } = req.body || {};
  if (!query || !String(query).trim()) return res.status(400).json({ error: "Missing 'query'." });
  try {
    const r = await ask(query, { lang, storeId, history: conversationHistory || [] });
    res.json({
      reply: r.reply,
      intent: r.intent,
      language: r.language,
      products: r.products,
      recipe: r.recipe || null,
      mealIdeas: r.mealIdeas || null,
      conversationHistory: r.history,
    });
  } catch (e) {
    console.error("[/api/assistant]", e.message);
    res.status(500).json({ error: "assistant failed" });
  }
});

// --- voice: text-to-speech (Google, multilingual) ---
app.post("/api/tts", async (req, res) => {
  const { text, lang } = req.body || {};
  if (!text) return res.status(400).json({ error: "Missing 'text'" });
  try {
    res.json(await textToSpeech(text, lang === "en" ? "en" : lang === "fr" ? "fr" : lang === "de" ? "de" : "es"));
  } catch (e) {
    console.error("[/api/tts]", e.message);
    res.status(500).json({ error: "TTS failed" });
  }
});

// --- voice: speech-to-text (Google) ---
app.post("/api/stt", async (req, res) => {
  const { audio, lang } = req.body || {};
  if (!audio) return res.status(400).json({ error: "Missing 'audio'" });
  try {
    const transcript = await speechToText(audio, lang || "es");
    res.json({ transcript });
  } catch (e) {
    console.error("[/api/stt]", e.message);
    res.status(500).json({ error: "STT failed" });
  }
});

// --- camera / photo search: identify the product, then locate it ---
app.post("/api/vision", async (req, res) => {
  const { image, lang } = req.body || {};
  if (!image) return res.status(400).json({ error: "Missing 'image'" });
  const language = lang === "en" ? "en" : lang === "fr" ? "fr" : lang === "de" ? "de" : "es";
  try {
    const id = await identifyProduct(image, language);
    if (!id.found || !(id.name_es || id.name_en)) {
      return res.json({ identified: null, matched: false, reply: null });
    }
    // Resolve the identified product through the normal assistant pipeline.
    const query = language === "en" ? (id.name_en || id.name_es) : (id.name_es || id.name_en);
    const result = await ask(query, { lang: language });
    res.json({ identified: { name_es: id.name_es, name_en: id.name_en }, ...result });
  } catch (e) {
    console.error("[/api/vision]", e.message);
    res.status(500).json({ error: "vision failed" });
  }
});

app.listen(PORT, () => console.log(`Econo backend listening on :${PORT}`));
