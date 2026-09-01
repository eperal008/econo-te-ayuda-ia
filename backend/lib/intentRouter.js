// ============================================================================
// Econo Te Ayuda IA — intent router (the "technical router" the spec mandates).
// One cheap LLM call classifies each message into a controlled intent, detects
// the language, and extracts store search terms + entities. Routing/tool-gating
// then happens in deterministic code (assistant.js). This is the main guardrail
// against pulling the assistant off-domain.
// ============================================================================
const { OpenAI } = require("openai");

const MODEL = "gpt-4o-mini";
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const INTENTS = [
  "PRODUCT_SEARCH",      // where is a specific product / its aisle
  "PRODUCT_DISCOVERY",   // "something for mosquitoes" -> find fitting products
  "HOUSEHOLD_SOLUTION",  // problem -> appropriate supermarket product
  "RECIPE",              // give a recipe + connect ingredients to products
  "MEAL_IDEA",           // "what can I cook today" -> a few options
  "INGREDIENT_RECIPE",   // "I have chicken and rice" -> recipes, have vs need
  "PRODUCT_ALTERNATIVE", // substitutes when something is unavailable
  "PRODUCT_COMPARISON",  // compare appropriate products
  "STORE_INFORMATION",   // hours, bathrooms, services, non-product areas
  "GREETING",            // hi / thanks / bye
  "OUT_OF_SCOPE",        // anything not supermarket-related
];

const SYSTEM = `You are the intent router for the in-store AI assistant of Supermercados Econo (a Puerto Rico supermarket). You do NOT answer the user. You classify their CURRENT message and extract structured data as strict JSON.

DOMAIN: groceries, food, cooking, recipes, beverages, ingredients, cleaning, laundry, household goods, paper products, normal personal care, baby products, pet products, normal pest control, kitchen/storage supplies, basic health & wellness items, product location, prices, promotions, availability, store info. Anything outside this is OUT_OF_SCOPE (politics, news, celebrities, coding, medical/legal/financial advice, adult content, violence, weapons, gambling, general knowledge, etc.).

CONTEXT OVER KEYWORDS: a single word must not trigger refusal. Judge the real intent. Everyday household needs that a supermarket serves are IN scope even if phrased with words like "kill", "get rid of", "remove", "clean", "unclog":
- "what can I use to KILL mosquitoes / roaches / ants" -> HOUSEHOLD_SOLUTION (they sell repellents/insecticides).
- "what removes this stain", "what unclogs a drain", "what kills weeds" -> HOUSEHOLD_SOLUTION.
- "something for my baby's rash", "what helps a cold" -> PRODUCT_DISCOVERY (normal OTC/personal-care items), NOT medical advice.
Only mark OUT_OF_SCOPE when the request genuinely has nothing to do with buying/using supermarket products.

Use the CONVERSATION HISTORY to resolve follow-ups (e.g. "and for kids?", "which brands?") to the underlying subject.

INTENTS: ${INTENTS.join(", ")}.

LANGUAGE: detect the language of the CURRENT message and return its ISO 639-1 code (es, en, fr, de, pt, ...). Follow the user's most recent language.

SEARCH TERMS: for any intent that involves finding items in the store, list the concrete product/category terms to look up, in BOTH the user's language and Spanish when possible (the store data is Spanish-first). Keep them short and literal (e.g. "olive oil", "aceite de oliva"). For RECIPE/MEAL_IDEA/INGREDIENT_RECIPE leave search_terms empty (ingredients are resolved later).

Return ONLY this JSON:
{
  "language": "es",
  "intent": "PRODUCT_SEARCH",
  "search_terms": ["olive oil","aceite de oliva"],
  "entities": {
    "product": [], "category": [], "brand": [],
    "dish": "", "ingredients_have": [], "constraints": []
  },
  "needs_clarification": false,
  "clarification": "",
  "out_of_scope_reason": ""
}`;

/**
 * @param {string} query
 * @param {Array} history  [{role, content}]
 * @returns {Promise<object>} parsed router result
 */
async function classify(query, history = []) {
  const messages = [
    { role: "system", content: SYSTEM },
    {
      role: "user",
      content:
        `CONVERSATION HISTORY:\n${JSON.stringify(history.slice(-6))}\n\nCURRENT MESSAGE:\n"${query}"`,
    },
  ];
  const res = await openai.chat.completions.create({
    model: MODEL,
    messages,
    temperature: 0,
    response_format: { type: "json_object" },
  });
  let parsed;
  try {
    parsed = JSON.parse(res.choices[0].message.content);
  } catch {
    parsed = {};
  }
  // defensive defaults
  return {
    language: parsed.language || "es",
    intent: INTENTS.includes(parsed.intent) ? parsed.intent : "PRODUCT_SEARCH",
    search_terms: Array.isArray(parsed.search_terms) ? parsed.search_terms.filter(Boolean) : [],
    entities: parsed.entities || {},
    needs_clarification: !!parsed.needs_clarification,
    clarification: parsed.clarification || "",
    out_of_scope_reason: parsed.out_of_scope_reason || "",
  };
}

module.exports = { classify, INTENTS };
