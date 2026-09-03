// Thin client for the Econo backend.
import axios from "axios";
import { API_BASE_URL, STORE_ID } from "../config";

const http = axios.create({ baseURL: API_BASE_URL, timeout: 30000 });

// Retry once on a transient failure (network / 5xx) so a momentary blip doesn't
// surface an error to the shopper.
async function withRetry(fn) {
  try {
    return await fn();
  } catch (e) {
    const status = e?.response?.status;
    const retryable = !status || (status >= 500 && status < 600);
    if (!retryable) throw e;
    await new Promise((r) => setTimeout(r, 600));
    return fn();
  }
}

/** Full AI assistant: intent routing + rich features, grounded in the engine. */
export async function askAssistant(query, { lang, history = [] } = {}) {
  const { data } = await withRetry(() =>
    http.post("/api/assistant", {
      query,
      lang: lang || null,
      storeId: STORE_ID,
      conversationHistory: history,
    })
  );
  return data; // { reply, intent, language, products, recipe, mealIdeas, conversationHistory }
}

/** Deterministic location-only search (no AI). */
export async function searchLocation(query, { lang } = {}) {
  const { data } = await http.get("/api/search", {
    params: { q: query, lang, store: STORE_ID },
  });
  return data;
}

/** Google TTS: returns a playable data URL for the spoken reply. */
export async function textToSpeech(text, lang) {
  const { data } = await http.post("/api/tts", { text, lang });
  return `data:audio/${data.format};base64,${data.audio}`;
}

/** Google STT: base64 WEBM/OPUS audio -> transcript. */
export async function speechToText(audioBase64, lang) {
  const { data } = await http.post("/api/stt", { audio: audioBase64, lang });
  return data.transcript || "";
}

/** Photo search: identify the product in an image, then locate it. */
export async function identifyFromImage(imageBase64, lang) {
  const { data } = await http.post("/api/vision", { image: imageBase64, lang });
  return data; // { identified, matched, reply, products, ... }
}
