import React, { useState, useRef, useCallback, useEffect } from "react";
import {
  FaMicrophone, FaStopCircle, FaSearch, FaCamera, FaTag,
  FaShoppingCart, FaStore, FaPercent, FaQrcode, FaArrowLeft, FaMapMarkerAlt,
} from "react-icons/fa";
import { askAssistant, textToSpeech, speechToText, identifyFromImage } from "./econo/api";
import { SERVICE_URLS } from "./config";
import EconoLogo from "./econo/EconoLogo";
import "./App.css";

// Four supported languages (customer requirement). Each drives UI chrome, the
// assistant reply language, and the voice in/out language.
const LANGS = [
  { code: "es", label: "ES", bcp: "es-US" },
  { code: "en", label: "EN", bcp: "en-US" },
  { code: "fr", label: "FR", bcp: "fr-FR" },
  { code: "de", label: "DE", bcp: "de-DE" },
];

const STRINGS = {
  es: { press: "Presiona y Pregunta", example: 'Ej: "¿En qué pasillo está el arroz?"', typeHere: "¿Qué producto buscas?",
    searchAisle: "Buscar en Góndola", onlineShopper: "Compra en Línea", econoToGo: "Econo To Go", deals: "Ofertas y Promociones",
    listening: "Escuchando…", thinking: "Buscando…", aisle: "Pasillo", back: "Volver", ingredients: "Ingredientes",
    notFound: "No encontrado", tryAgain: "Intenta de nuevo", voiceUnsupported: "El micrófono no está disponible en este navegador.",
    analyzing: "Analizando foto…", noProduct: "No pude identificar el producto. Intenta con otra foto.", identified: "Veo" },
  en: { press: "Press and Ask", example: 'e.g. "Which aisle is the rice in?"', typeHere: "What product are you looking for?",
    searchAisle: "Search in Aisle", onlineShopper: "Online Shopper", econoToGo: "Econo To Go", deals: "Deals & Promotions",
    listening: "Listening…", thinking: "Searching…", aisle: "Aisle", back: "Back", ingredients: "Ingredients",
    notFound: "Not found", tryAgain: "Try again", voiceUnsupported: "Microphone isn't available in this browser.",
    analyzing: "Analyzing photo…", noProduct: "I couldn't identify the product. Try another photo.", identified: "I see" },
  fr: { press: "Appuyez et Demandez", example: 'Ex : "Dans quelle allée est le riz ?"', typeHere: "Quel produit cherchez-vous ?",
    searchAisle: "Chercher en Rayon", onlineShopper: "Achat en Ligne", econoToGo: "Econo To Go", deals: "Offres & Promotions",
    listening: "Écoute…", thinking: "Recherche…", aisle: "Allée", back: "Retour", ingredients: "Ingrédients",
    notFound: "Introuvable", tryAgain: "Réessayez", voiceUnsupported: "Le micro n'est pas disponible dans ce navigateur.",
    analyzing: "Analyse de la photo…", noProduct: "Je n'ai pas pu identifier le produit. Essayez une autre photo.", identified: "Je vois" },
  de: { press: "Drücken und Fragen", example: 'z. B. "In welchem Gang ist der Reis?"', typeHere: "Welches Produkt suchen Sie?",
    searchAisle: "Im Gang suchen", onlineShopper: "Online-Shopper", econoToGo: "Econo To Go", deals: "Angebote & Aktionen",
    listening: "Höre zu…", thinking: "Suche…", aisle: "Gang", back: "Zurück", ingredients: "Zutaten",
    notFound: "Nicht gefunden", tryAgain: "Erneut versuchen", voiceUnsupported: "Mikrofon in diesem Browser nicht verfügbar.",
    analyzing: "Foto wird analysiert…", noProduct: "Produkt nicht erkannt. Bitte anderes Foto versuchen.", identified: "Ich sehe" },
};

const MIME = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"].find(
  (m) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(m)
);
const blobToBase64 = (blob) =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onloadend = () => resolve(String(r.result).split(",")[1]);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });

export default function Kiosk() {
  const [lang, setLang] = useState("es");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [listening, setListening] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const mediaRecorderRef = useRef(null);
  const streamRef = useRef(null);
  const chunksRef = useRef([]);
  const audioRef = useRef(null);
  const fileInputRef = useRef(null);
  const t = STRINGS[lang];

  const stopAudio = useCallback(() => {
    try { audioRef.current?.pause(); } catch {}
    audioRef.current = null;
  }, []);

  // Speak the reply with Google TTS in the reply's actual language.
  const speak = useCallback(async (text, spLang) => {
    stopAudio();
    if (!text) return;
    try {
      const url = await textToSpeech(text, spLang || lang);
      const a = new Audio(url);
      audioRef.current = a;
      a.play().catch(() => {});
    } catch { /* ignore TTS errors */ }
  }, [lang, stopAudio]);

  const runQuery = useCallback(async (text) => {
    const q = (text || "").trim();
    if (!q) return;
    setLoading(true); setError(""); setResult(null);
    try {
      const data = await askAssistant(q, { lang }); // lang = selected button (fallback); backend auto-detects
      setResult(data);
      speak(data.reply, data.language);
    } catch (e) {
      setError(t.tryAgain);
    } finally {
      setLoading(false);
    }
  }, [lang, t, speak]);

  const onSubmit = (e) => { e.preventDefault(); runQuery(query); };

  // Voice input: record (MediaRecorder) -> Google STT -> run the query.
  const toggleMic = useCallback(async () => {
    if (listening) { try { mediaRecorderRef.current?.stop(); } catch {} return; }
    if (typeof MediaRecorder === "undefined" || !MIME || !navigator.mediaDevices?.getUserMedia) {
      setError(t.voiceUnsupported); return;
    }
    stopAudio();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { noiseSuppression: true, echoCancellation: true } });
      streamRef.current = stream;
      const mr = new MediaRecorder(stream, { mimeType: MIME });
      mediaRecorderRef.current = mr;
      chunksRef.current = [];
      mr.ondataavailable = (e) => { if (e.data.size) chunksRef.current.push(e.data); };
      mr.onstop = async () => {
        setListening(false);
        streamRef.current?.getTracks().forEach((tr) => tr.stop());
        streamRef.current = null;
        const blob = new Blob(chunksRef.current, { type: MIME });
        if (!blob.size) return;
        setLoading(true);
        try {
          const transcript = await speechToText(await blobToBase64(blob), lang);
          if (transcript) { setQuery(transcript); await runQuery(transcript); }
          else { setLoading(false); setError(t.tryAgain); }
        } catch { setLoading(false); setError(t.tryAgain); }
      };
      mr.start();
      setListening(true); setError(""); setResult(null);
    } catch { setError(t.voiceUnsupported); }
  }, [listening, lang, t, runQuery, stopAudio]);

  useEffect(() => () => {
    stopAudio();
    try { mediaRecorderRef.current?.stop?.(); } catch {}
    streamRef.current?.getTracks?.().forEach((tr) => tr.stop());
  }, [stopAudio]);

  // Photo search: identify the product in a photo, then locate it.
  const onPhoto = useCallback(async (e) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file
    if (!file) return;
    stopAudio();
    setError(""); setResult(null); setQuery(""); setLoading(true);
    try {
      const b64 = await blobToBase64(file);
      const data = await identifyFromImage(b64, lang);
      if (!data || !data.identified) { setError(t.noProduct); return; }
      const seen = lang === "es" ? data.identified.name_es : data.identified.name_en;
      setQuery(seen || "");
      setResult(data);
      speak(data.reply, data.language);
    } catch { setError(t.tryAgain); }
    finally { setLoading(false); }
  }, [lang, t, speak, stopAudio]);

  const reset = () => { setResult(null); setQuery(""); setError(""); stopAudio(); };
  const pickLang = (code) => { setLang(code); reset(); };

  const hasResult = !!result || loading || listening || error;
  const products = result?.products || [];
  const recipe = result?.recipe || null;
  // Display language = the reply's actual (auto-detected) language, falling back to the button.
  const rlang = result?.language || lang;

  // Badge label: numbered aisle -> "Aisle N"; liquor code -> "area + code";
  // no-aisle special zone -> the department/area name (never "Pasillo SIN PASILLO").
  const badge = (item) => {
    const p = String(item.aisle || "").trim();
    const area = (rlang === "es" ? item.area : item.area_en) || item.area_en || item.area;
    if (/^\d+$/.test(p)) return `${t.aisle} ${p}`;
    if (/^[a-z]\d+$/i.test(p)) return area ? `${area} ${p}` : `${t.aisle} ${p}`;
    return area || t.notFound; // SIN PASILLO
  };
  // Localized product name (uses the translated name for FR/DE).
  const nm = (it) => rlang === "es" ? (it.name || it.name_es || it.name_en)
    : rlang === "en" ? (it.name_en || it.name || it.name_es)
    : (it.name_display || it.name_en || it.name || it.name_es);
  // Shelf position line ("beginning/middle/end of the aisle") — only for the standard tramos.
  const SHELF = {
    Principio: { es: "Al principio del pasillo", en: "Beginning of the aisle", fr: "Au début de l'allée", de: "Am Anfang des Gangs" },
    Medio: { es: "En el medio del pasillo", en: "Middle of the aisle", fr: "Au milieu de l'allée", de: "In der Mitte des Gangs" },
    Final: { es: "Al final del pasillo", en: "End of the aisle", fr: "À la fin de l'allée", de: "Am Ende des Gangs" },
  };
  const shelfText = (it) => { const m = SHELF[it.tramo]; return m ? (m[rlang] || m.en) : null; };
  const money = (v) => "$" + Number(v).toFixed(2);

  return (
    <div className="econo-app">
      <header className="econo-header">
        {hasResult && (
          <button className="econo-back" onClick={reset} aria-label={t.back}><FaArrowLeft /></button>
        )}
        <EconoLogo variant="onRed" />
        <div className="econo-langs" role="group" aria-label="Language">
          {LANGS.map((l) => (
            <button
              key={l.code}
              className={`econo-lang ${lang === l.code ? "active" : ""}`}
              onClick={() => pickLang(l.code)}
              aria-pressed={lang === l.code}
            >{l.label}</button>
          ))}
        </div>
      </header>

      <main className="econo-main">
        <button
          className={`econo-mic ${listening ? "listening" : ""} ${loading ? "busy" : ""}`}
          onClick={toggleMic}
          aria-label={listening ? "Stop" : "Speak"}
        >
          {listening ? <FaStopCircle /> : <FaMicrophone />}
        </button>
        <div className="econo-prompt">
          <strong>{t.press}</strong>
          <span>{t.example}</span>
        </div>

        <form className="econo-search" onSubmit={onSubmit}>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t.typeHere}
            disabled={loading || listening}
          />
          <button type="button" className="econo-cam" onClick={() => fileInputRef.current?.click()} disabled={loading || listening} aria-label="Camera"><FaCamera /></button>
          <input ref={fileInputRef} type="file" accept="image/*" capture="environment" onChange={onPhoto} style={{ display: "none" }} />
          <button type="submit" className="econo-go" disabled={loading || listening || !query.trim()}><FaSearch /></button>
        </form>

        {(loading || listening) && (
          <div className="econo-status">{listening ? t.listening : t.thinking}</div>
        )}
        {error && <div className="econo-status error">{error}</div>}

        {result && !loading && (
          <div className="econo-result">
            {result.reply && <p className="econo-reply">{result.reply}</p>}

            {recipe && recipe.ingredients?.length > 0 && (
              <div className="econo-suggestions">
                <div className="econo-suggestions-head">
                  {t.ingredients}{recipe.dish ? ` — ${recipe.dish}` : ""}
                </div>
                {recipe.ingredients.map((ing, i) => (
                  <div className="econo-item" key={i}>
                    <span className="econo-item-name">{nm(ing)}</span>
                    {ing.found ? (
                      <span className="econo-aisle"><FaMapMarkerAlt /> {badge(ing)}</span>
                    ) : (
                      <span className="econo-aisle muted">{t.notFound}</span>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* Single product -> rich "Result Found" card (matches the mockup) */}
            {!recipe && products.length === 1 && (
              <div className="econo-found">
                <div className="econo-found-head">
                  <span className="econo-found-name"><FaMapMarkerAlt className="pin" /> {nm(products[0])}</span>
                  <span className="econo-aisle big">{badge(products[0])}</span>
                </div>
                {shelfText(products[0]) && (
                  <div className="econo-shelf"><FaMapMarkerAlt /> {shelfText(products[0])}</div>
                )}
                {(products[0].image_url || products[0].promo_price || products[0].promo_text || products[0].price != null) && (
                  <div className="econo-promo-card">
                    {products[0].image_url && <img className="econo-prod-img" src={products[0].image_url} alt="" />}
                    {(products[0].promo_price || products[0].promo_text || products[0].price != null) && (
                      <div className="econo-promo-box">
                        <div className="econo-promo-name">{nm(products[0])}</div>
                        {products[0].price != null && <div className="econo-promo-reg">Reg. {money(products[0].price)}</div>}
                        <div className="econo-promo-price">{products[0].promo_price || products[0].promo_text || money(products[0].price)}</div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Multiple products -> list */}
            {!recipe && products.length > 1 && (
              <div className="econo-suggestions">
                {products.map((p, i) => (
                  <div className="econo-item" key={i}>
                    {p.image_url && <img className="econo-item-thumb" src={p.image_url} alt="" />}
                    <span className="econo-item-name">{nm(p)}</span>
                    <span className="econo-aisle"><FaMapMarkerAlt /> {badge(p)}</span>
                    {(p.promo_price || p.promo_text) && (
                      <span className="econo-promo">{p.promo_price || p.promo_text}</span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="econo-grid">
          <button className="econo-tile" onClick={() => document.querySelector(".econo-search input")?.focus()}>
            <FaTag /><span>{t.searchAisle}</span>
          </button>
          <a className="econo-tile" href={SERVICE_URLS.onlineShopper} target="_blank" rel="noopener noreferrer">
            <FaShoppingCart /><span>{t.onlineShopper}</span>
          </a>
          <a className="econo-tile" href={SERVICE_URLS.econoToGo} target="_blank" rel="noopener noreferrer">
            <FaStore /><span>{t.econoToGo}</span>
          </a>
          <a className="econo-tile" href={SERVICE_URLS.deals} target="_blank" rel="noopener noreferrer">
            <FaPercent /><span>{t.deals}</span>
          </a>
        </div>

        <button className="econo-qr" title="Scan (Phase 6 / TBD)" aria-label="QR scanner"><FaQrcode /></button>
      </main>
    </div>
  );
}
