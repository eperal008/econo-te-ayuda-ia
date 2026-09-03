// ============================================================================
// Econo Te Ayuda IA — Google Cloud voice (STT + TTS), multilingual.
// Replaces the interim browser speech with production-grade server-side voice.
// ============================================================================
const { SpeechClient } = require("@google-cloud/speech").v1p1beta1;
const { TextToSpeechClient } = require("@google-cloud/text-to-speech");
const { withRetry } = require("./retry");

let speechClient, ttsClient;
try {
  const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
  speechClient = new SpeechClient({ credentials });
  ttsClient = new TextToSpeechClient({ credentials });
} catch (e) {
  console.error("[voice] Google credentials not configured:", e.message);
}

// app language -> Google BCP-47 + a natural Neural2 voice
const LANG = {
  es: { code: "es-US", voice: "es-US-Neural2-A" },
  en: { code: "en-US", voice: "en-US-Neural2-C" },
  fr: { code: "fr-FR", voice: "fr-FR-Neural2-A" },
  de: { code: "de-DE", voice: "de-DE-Neural2-B" },
};
const pick = (lang) => LANG[lang] || LANG.es;

/** Synthesize speech. @returns {Promise<{audio:string(base64), format:'mp3'}>} */
async function textToSpeech(text, lang) {
  if (!ttsClient) throw new Error("TTS not configured");
  const { code, voice } = pick(lang);
  const [res] = await withRetry(() =>
    ttsClient.synthesizeSpeech({
      input: { text: (text || "").slice(0, 800) },
      voice: { languageCode: code, name: voice },
      audioConfig: { audioEncoding: "MP3" },
    })
  );
  return { audio: res.audioContent.toString("base64"), format: "mp3" };
}

/** Transcribe base64 audio (WEBM/OPUS from MediaRecorder). @returns {Promise<string>} */
async function speechToText(audioBase64, lang) {
  if (!speechClient) throw new Error("STT not configured");
  const { code } = pick(lang);
  const [res] = await withRetry(() =>
    speechClient.recognize({
      audio: { content: audioBase64 },
      config: {
        encoding: "WEBM_OPUS",
        languageCode: code,
        enableAutomaticPunctuation: true,
        model: "latest_short",
        useEnhanced: true,
      },
    })
  );
  const alt = res.results?.[0]?.alternatives?.[0];
  return alt?.transcript?.trim() || "";
}

module.exports = { textToSpeech, speechToText };
