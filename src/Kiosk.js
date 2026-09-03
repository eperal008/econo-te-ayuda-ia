import React, { useState, useRef, useCallback, useEffect } from "react";
import {
  FaMicrophone, FaStopCircle, FaSearch, FaCamera, FaTag,
  FaShoppingCart, FaStore, FaPercent, FaQrcode, FaArrowLeft, FaMapMarkerAlt,
} from "react-icons/fa";
import { askAssistant } from "./econo/api";
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
    notFound: "No encontrado", tryAgain: "Intenta de nuevo", voiceUnsupported: "El micrófono no está disponible en este navegador." },
  en: { press: "Press and Ask", example: 'e.g. "Which aisle is the rice in?"', typeHere: "What product are you looking for?",
    searchAisle: "Search in Aisle", onlineShopper: "Online Shopper", econoToGo: "Econo To Go", deals: "Deals & Promotions",
    listening: "Listening…", thinking: "Searching…", aisle: "Aisle", back: "Back", ingredients: "Ingredients",
    notFound: "Not found", tryAgain: "Try again", voiceUnsupported: "Microphone isn't available in this browser." },
  fr: { press: "Appuyez et Demandez", example: 'Ex : "Dans quelle allée est le riz ?"', typeHere: "Quel produit cherchez-vous ?",
    searchAisle: "Chercher en Rayon", onlineShopper: "Achat en Ligne", econoToGo: "Econo To Go", deals: "Offres & Promotions",
    listening: "Écoute…", thinking: "Recherche…", aisle: "Allée", back: "Retour", ingredients: "Ingrédients",
    notFound: "Introuvable", tryAgain: "Réessayez", voiceUnsupported: "Le micro n'est pas disponible dans ce navigateur." },
  de: { press: "Drücken und Fragen", example: 'z. B. "In welchem Gang ist der Reis?"', typeHere: "Welches Produkt suchen Sie?",
    searchAisle: "Im Gang suchen", onlineShopper: "Online-Shopper", econoToGo: "Econo To Go", deals: "Angebote & Aktionen",
    listening: "Höre zu…", thinking: "Suche…", aisle: "Gang", back: "Zurück", ingredients: "Zutaten",
    notFound: "Nicht gefunden", tryAgain: "Erneut versuchen", voiceUnsupported: "Mikrofon in diesem Browser nicht verfügbar." },
};

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

function speak(text, bcp) {
  try {
    if (!window.speechSynthesis || !text) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = bcp || "es-US";
    window.speechSynthesis.speak(u);
  } catch { /* ignore */ }
}

export default function Kiosk() {
  const [lang, setLang] = useState("es");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [listening, setListening] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const recognitionRef = useRef(null);
  const t = STRINGS[lang];
  const bcp = LANGS.find((l) => l.code === lang)?.bcp || "es-US";

  const runQuery = useCallback(async (text) => {
    const q = (text || "").trim();
    if (!q) return;
    setLoading(true); setError(""); setResult(null);
    try {
      const data = await askAssistant(q, { lang }); // selected language is authoritative
      setResult(data);
      speak(data.reply, bcp);
    } catch (e) {
      setError(t.tryAgain);
    } finally {
      setLoading(false);
    }
  }, [lang, bcp, t]);

  const onSubmit = (e) => { e.preventDefault(); runQuery(query); };

  const toggleMic = useCallback(() => {
    if (!SpeechRecognition) { setError(t.voiceUnsupported); return; }
    if (listening) { recognitionRef.current?.stop(); return; }
    const rec = new SpeechRecognition();
    rec.lang = bcp;
    rec.interimResults = true;
    rec.continuous = false;
    recognitionRef.current = rec;
    let finalText = "";
    rec.onstart = () => { setListening(true); setError(""); setResult(null); };
    rec.onresult = (ev) => {
      let interim = "";
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const seg = ev.results[i][0].transcript;
        if (ev.results[i].isFinal) finalText += seg; else interim += seg;
      }
      setQuery(finalText || interim);
    };
    rec.onerror = () => { setListening(false); };
    rec.onend = () => { setListening(false); if (finalText.trim()) runQuery(finalText); };
    rec.start();
  }, [listening, bcp, t, runQuery]);

  useEffect(() => () => { window.speechSynthesis?.cancel(); recognitionRef.current?.stop?.(); }, []);

  const reset = () => { setResult(null); setQuery(""); setError(""); window.speechSynthesis?.cancel(); };
  const pickLang = (code) => { setLang(code); reset(); };

  // Badge label: numbered aisle -> "Aisle N"; liquor code -> "area + code";
  // no-aisle special zone -> the department/area name (never "Pasillo SIN PASILLO").
  const badge = (item) => {
    const p = String(item.aisle || "").trim();
    const area = (lang === "es" ? item.area : item.area_en) || item.area_en || item.area;
    if (/^\d+$/.test(p)) return `${t.aisle} ${p}`;
    if (/^[a-z]\d+$/i.test(p)) return area ? `${area} ${p}` : `${t.aisle} ${p}`;
    return area || t.notFound; // SIN PASILLO
  };

  const hasResult = !!result || loading || listening || error;
  const products = result?.products || [];
  const recipe = result?.recipe || null;

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
          <button type="button" className="econo-cam" title="Camera (Phase 6)" aria-label="Camera"><FaCamera /></button>
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
                    <span className="econo-item-name">{lang === "es" ? (ing.name_es || ing.name_en) : lang === "en" ? (ing.name_en || ing.name_es) : (ing.name_display || ing.name_en || ing.name_es)}</span>
                    {ing.found ? (
                      <span className="econo-aisle"><FaMapMarkerAlt /> {badge(ing)}</span>
                    ) : (
                      <span className="econo-aisle muted">{t.notFound}</span>
                    )}
                  </div>
                ))}
              </div>
            )}

            {!recipe && products.length > 0 && (
              <div className="econo-suggestions">
                {products.map((p, i) => (
                  <div className="econo-item" key={i}>
                    <span className="econo-item-name">{lang === "es" ? (p.name || p.name_en) : lang === "en" ? (p.name_en || p.name) : (p.name_display || p.name_en || p.name)}</span>
                    <span className="econo-aisle"><FaMapMarkerAlt /> {badge(p)}</span>
                    {(p.promo || p.promo_price || p.promo_text) && (
                      <span className="econo-promo">{p.promo || p.promo_price || p.promo_text}</span>
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
