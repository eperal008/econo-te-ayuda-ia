// ============================================================================
// Econo Te Ayuda IA — assistant orchestrator (Phase 3)
//
// Flow:  classify (intent + language + terms)
//        -> gather GROUND TRUTH (locations via the Phase 2 engine; recipes via LLM)
//        -> compose a reply in the user's language, grounded strictly in that data.
//
// Hard rule: the AI never states a product's location or price on its own — those
// come only from the location engine / DB. The AI proposes WHAT; the engine says WHERE.
// ============================================================================
const { classify } = require("./intentRouter");
const { searchLocation } = require("./locationEngine");
const { OpenAI } = require("openai");

const CHAT_MODEL = "gpt-4o-mini";
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const SAFETY = `You are Yoly, the in-store assistant for Supermercados Econo. Stay strictly within supermarket shopping (products, food, recipes, cleaning, household, prices/promotions, store info). Never invent products, brands, prices, promotions, inventory, or aisle/location information — use ONLY the data provided to you. If a product or its location is not in the provided data, say it was not found and suggest asking a store associate or offer a listed alternative. Never give dangerous advice; for cleaners/pesticides/medicines tell the customer to follow the label. Keep replies short, friendly and practical. Plain text only, no markdown. Reply in the language: `;

async function llm(messages, json = false, temperature = 0.4) {
  const res = await openai.chat.completions.create({
    model: CHAT_MODEL,
    messages,
    temperature,
    ...(json ? { response_format: { type: "json_object" } } : {}),
  });
  return res.choices[0].message.content;
}

/** Resolve search terms to real store locations via the deterministic engine. */
async function resolveTerms(terms, { storeId, lang, semantic = true }) {
  const seen = new Set();
  const out = [];
  for (const t of terms) {
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    const r = await searchLocation(t, { storeId, lang, logMisses: false, semantic });
    out.push({
      term: t,
      found: r.matched,
      confidence: r.confidence,
      name: r.best?.producto || null,
      name_en: r.best?.producto_en || null,
      aisle: r.best?.pasillo || null,
      zone_id: r.best?.zone_id || null,
      location: r.best?.response || null,
      price: r.best?.price ?? null,
      promo: r.best?.promo_text || r.best?.promo_price || null,
    });
  }
  return out;
}

/** Collapse duplicate resolved products (same product+zone reached via ES and EN terms). */
function dedupeProducts(list) {
  const seen = new Set();
  return list.filter((r) => {
    const k = (r.zone_id || "") + "|" + (r.name || r.term || "").toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Ground-truth "facts" string handed to the composer. */
function factsBlock(resolved) {
  if (!resolved.length) return "No store items were resolved.";
  return resolved
    .map((r) =>
      r.found
        ? `- "${r.term}" -> ${r.name}${r.name_en ? " / " + r.name_en : ""} | ${r.location?.es || ""} | ${r.location?.en || ""}${r.price != null ? " | price " + r.price : ""}${r.promo ? " | promo " + r.promo : ""}`
        : `- "${r.term}" -> NOT FOUND in this store`
    )
    .join("\n");
}

async function compose({ language, intent, query, facts, extra = "" }) {
  const reply = await llm([
    { role: "system", content: SAFETY + language + "." },
    {
      role: "user",
      content:
        `Customer intent: ${intent}\nCustomer said: "${query}"\n\n` +
        `VERIFIED STORE DATA — the ONLY source of product names, locations and prices:\n${facts}\n${extra}\n\n` +
        `Rules:\n` +
        `- Use ONLY the product names, aisles and prices exactly as written above. Do NOT rename a product, invent a product, or change any aisle/price.\n` +
        `- If an item is NOT FOUND, say it wasn't found and suggest asking an associate — do not guess a location.\n` +
        `- Reply in ${language}, 1-3 short sentences, plain text.`,
    },
  ], false, 0.2);
  return reply.trim();
}

// ---- rich generators -------------------------------------------------------
async function generateRecipe(query, entities, language) {
  const raw = await llm(
    [
      { role: "system", content: SAFETY + language + ". Respond ONLY as JSON." },
      {
        role: "user",
        content:
          `The customer wants a recipe. Message: "${query}". Known dish: "${entities.dish || ""}". ` +
          `Constraints: ${JSON.stringify(entities.constraints || [])}. Ingredients they already have: ${JSON.stringify(entities.ingredients_have || [])}.\n` +
          `Return JSON: {"dish":"","spokenReply":"one friendly sentence in ${language}","ingredients":[{"name_es":"","name_en":"","have":false}],"steps":["short step"]}. ` +
          `Use common supermarket ingredients. name_es/name_en are the store search terms.`,
      },
    ],
    true
  );
  try { return JSON.parse(raw); } catch { return null; }
}

// ---- main ------------------------------------------------------------------
async function ask(query, opts = {}) {
  const { storeId, history = [], lang } = opts;
  if (!query || !query.trim()) {
    return { reply: "", intent: "GREETING", language: lang || "es", products: [], history };
  }

  const router = await classify(query, history);
  const language = lang || router.language || "es";
  const base = { intent: router.intent, language, router, products: [], recipe: null };

  let reply = "";
  let resolved = [];

  if (router.needs_clarification) {
    reply = router.clarification || (language === "es" ? "¿Qué producto buscas?" : "Which product are you looking for?");
  } else {
    switch (router.intent) {
      case "OUT_OF_SCOPE":
        reply = await compose({ language, intent: router.intent, query,
          facts: "N/A — out of scope.",
          extra: "This request is outside supermarket help. Politely decline in one sentence and steer back to products, recipes, or shopping. Do not answer the off-topic request." });
        break;

      case "GREETING":
        reply = await compose({ language, intent: router.intent, query, facts: "N/A",
          extra: "Greet warmly in one short sentence and invite them to ask where a product is or for a recipe." });
        break;

      case "RECIPE":
      case "INGREDIENT_RECIPE": {
        const recipe = await generateRecipe(query, router.entities, language);
        if (recipe?.ingredients?.length) {
          // Resolve ingredients deterministically (no eager semantic guessing) so
          // a real match gets an aisle and anything not carried is marked honestly.
          const terms = recipe.ingredients.flatMap((i) => [i.name_es, i.name_en].filter(Boolean));
          const map = await resolveTerms(terms, { storeId, lang: language, semantic: false });
          recipe.ingredients = recipe.ingredients.map((ing) => {
            const hit = map.find((r) => r.found && [ing.name_es, ing.name_en].map((x) => (x || "").toLowerCase()).includes((r.term || "").toLowerCase()));
            return {
              name_es: ing.name_es, name_en: ing.name_en, have: !!ing.have,
              found: !!hit, aisle: hit?.aisle || null, zone_id: hit?.zone_id || null,
              location: hit?.location || null,
            };
          });
          base.recipe = recipe;
          base.products = recipe.ingredients.filter((i) => i.found).map((i) => ({
            name: i.name_es, name_en: i.name_en, aisle: i.aisle, zone_id: i.zone_id, location: i.location,
          }));
          // Spoken reply = the recipe's own sentence (no LLM-narrated locations);
          // the structured ingredient list carries the accurate aisles for the UI.
          reply = recipe.spokenReply ||
            (language === "es" ? `Aquí tienes una receta para ${recipe.dish}.` : `Here's a recipe for ${recipe.dish}.`);
        } else {
          reply = language === "es" ? "No pude crear una receta ahora mismo." : "I couldn't put together a recipe right now.";
        }
        break;
      }

      case "MEAL_IDEA": {
        const raw = await llm([
          { role: "system", content: SAFETY + language + ". Respond ONLY as JSON." },
          { role: "user", content: `Suggest 3-5 simple meal ideas for: "${query}". Return JSON {"ideas":["dish 1","dish 2"]} in ${language}.` },
        ], true);
        let ideas = [];
        try { ideas = JSON.parse(raw).ideas || []; } catch {}
        base.mealIdeas = ideas;
        reply = await compose({ language, intent: router.intent, query, facts: "N/A",
          extra: `Offer these meal ideas and ask which one to build a shopping list for: ${JSON.stringify(ideas)}.` });
        break;
      }

      default: {
        // PRODUCT_SEARCH, PRODUCT_DISCOVERY, HOUSEHOLD_SOLUTION,
        // PRODUCT_ALTERNATIVE, PRODUCT_COMPARISON, STORE_INFORMATION
        const terms = router.search_terms.length ? router.search_terms
          : [query];
        resolved = dedupeProducts(await resolveTerms(terms, { storeId, lang: language }));
        base.products = resolved.filter((r) => r.found);

        // Fast path: simple product search, EN/ES, found -> use the engine answer directly (no extra LLM).
        const firstFound = resolved.find((r) => r.found);
        if (router.intent === "PRODUCT_SEARCH" && (language === "es" || language === "en") && firstFound && resolved.length === 1) {
          reply = firstFound.location[language] || firstFound.location.es;
        } else {
          reply = await compose({ language, intent: router.intent, query, facts: factsBlock(resolved) });
        }
      }
    }
  }

  const newHistory = [...history, { role: "user", content: query }, { role: "assistant", content: reply }];
  return { ...base, reply, products: base.products, history: newHistory };
}

module.exports = { ask };
