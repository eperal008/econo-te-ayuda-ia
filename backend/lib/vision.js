// ============================================================================
// Econo Te Ayuda IA — photo product identification (GPT-4o vision).
// Identifies the main supermarket product in a photo; the caller then resolves
// its location through the normal engine (vision proposes WHAT, engine says WHERE).
// ============================================================================
const { OpenAI } = require("openai");
const { withRetry } = require("./retry");

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * @param {string} imageBase64 - raw base64 (no data: prefix)
 * @returns {Promise<{found:boolean, name_es:string, name_en:string, note:string}>}
 */
async function identifyProduct(imageBase64, lang = "es") {
  const res = await withRetry(() =>
    openai.chat.completions.create({
      model: "gpt-4o",
      temperature: 0,
      response_format: { type: "json_object" },
      max_tokens: 200,
      messages: [
        {
          role: "system",
          content:
            "You identify the single main SUPERMARKET product in a photo, so a store assistant can locate it. " +
            "Reply strictly as JSON: {\"found\":true|false,\"name_es\":\"\",\"name_en\":\"\",\"note\":\"\"}. " +
            "name_es/name_en are short generic product terms (e.g. 'leche' / 'milk', not a full brand sentence). " +
            "If there is no identifiable supermarket product, set found=false.",
        },
        {
          role: "user",
          content: [
            { type: "text", text: "What supermarket product is this?" },
            { type: "image_url", image_url: { url: `data:image/jpeg;base64,${imageBase64}`, detail: "low" } },
          ],
        },
      ],
    })
  );
  try {
    const p = JSON.parse(res.choices[0].message.content);
    return { found: !!p.found, name_es: p.name_es || "", name_en: p.name_en || "", note: p.note || "" };
  } catch {
    return { found: false, name_es: "", name_en: "", note: "" };
  }
}

module.exports = { identifyProduct };
