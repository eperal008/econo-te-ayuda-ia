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
const { searchLocation, embedQuery } = require("./locationEngine");
const db = require("./db");
const { withRetry } = require("./retry");
const { OpenAI } = require("openai");

const CHAT_MODEL = "gpt-4o-mini";
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const SAFETY = `You are Yoly, the in-store assistant for Supermercados Econo. Stay strictly within supermarket shopping (products, food, recipes, cleaning, household, prices/promotions, store info). Never invent products, brands, prices, promotions, inventory, or aisle/location information — use ONLY the data provided to you. If a product or its location is not in the provided data, say it was not found and suggest asking a store associate or offer a listed alternative. Never give dangerous advice; for cleaners/pesticides/medicines tell the customer to follow the label. Keep replies short, friendly and practical. Plain text only, no markdown. Reply in the language: `;

async function llm(messages, json = false, temperature = 0.4) {
  const res = await withRetry(() => openai.chat.completions.create({
    model: CHAT_MODEL,
    messages,
    temperature,
    ...(json ? { response_format: { type: "json_object" } } : {}),
  }));
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
      confidence: r.confidence,     // high | medium | low
      layer: r.layer,               // exact | alias | category | fulltext | fuzzy | semantic
      id: r.best?.id || null,
      name: r.best?.producto || null,
      name_en: r.best?.producto_en || null,
      aisle: r.best?.pasillo || null,          // '6' | 'L2' | 'SIN PASILLO'
      side_en: r.best?.lado_en || null,
      area: r.best?.departamento || null,      // for badge on no-aisle zones
      area_en: r.best?.departamento_en || null,
      zone_id: r.best?.zone_id || null,
      location: r.best?.response || null,
      price: r.best?.price ?? null,
      promo: r.best?.promo_text || r.best?.promo_price || null,
    });
  }
  return out;
}

/** Re-rank candidates by semantic closeness to the query (one embedding call).
 *  Lexical layers can't tell "milk"->Leche from "milk"->Milk-Bone, but the query
 *  embedding is reliably closer to the correct product. Only used when there are
 *  ≥2 candidates, so single known-term lookups stay embedding-free. */
async function rerankBySemantic(query, candidates) {
  const ids = candidates.map((c) => c.id).filter((x) => x != null);
  if (ids.length < 2) return candidates;
  let vec;
  try { vec = await embedQuery(query); } catch { vec = null; }
  if (!vec) return candidates;
  try {
    const { rows } = await db.query(
      `SELECT id, (embedding <=> $1::vector) d FROM products
        WHERE id = ANY($2::bigint[]) AND embedding IS NOT NULL`,
      [vec, ids]
    );
    const dist = new Map(rows.map((r) => [String(r.id), Number(r.d)]));
    return [...candidates].sort(
      (a, b) => (dist.get(String(a.id)) ?? 9) - (dist.get(String(b.id)) ?? 9)
    );
  } catch { return candidates; }
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

/** Ground-truth facts handed to the composer as RAW components (English labels),
 *  so it can build the sentence fully in the target language without copying
 *  English words like "Aisle"/"side". */
function factsBlock(resolved) {
  if (!resolved.length) return "No store items were resolved.";
  return resolved
    .map((r) => {
      if (!r.found) return `- "${r.term}" -> NOT FOUND in this store`;
      const p = String(r.aisle || "").trim();
      const aisleNumber = /^\d+$/.test(p) || /^[a-z]\d+$/i.test(p) ? p : "none";
      const side = (r.side_en || "").toLowerCase() || "none";
      return `- "${r.term}" -> name=${r.name_en || r.name}; aisleNumber=${aisleNumber}; side=${side}; area=${r.area_en || r.area || "none"}` +
        `${r.price != null ? "; price=" + r.price : ""}${r.promo ? "; promo=" + r.promo : ""}`;
    })
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
        `Each item gives raw components: name, aisleNumber, side, area. Build a natural location sentence from them.\n` +
        `Rules:\n` +
        `- Use ONLY these products/aisles/prices. Do NOT invent or rename anything.\n` +
        `- Write EVERYTHING in ${language}. Translate the words for "aisle", "side", "left/right/center", and area/department names into ${language}. ONLY the aisleNumber value itself (e.g. 6, L2) stays verbatim.\n` +
        `- If aisleNumber is "none", give the location using the area (a special zone like produce/dairy/freezer/liquor), not an aisle number.\n` +
        `- If an item is NOT FOUND, say so in ${language} and suggest asking an associate — never guess a location or substitute an unrelated product.\n` +
        `- 1-3 short sentences, plain text, no English words unless they are brand/product names.`,
    },
  ], false, 0.2);
  return reply.trim();
}

// Verify a semantic/fuzzy fallback match for a by-name product search.
// Distances can't separate "coriandre→cilantro" (right) from "ron blanco→arroz"
// (wrong), but a cheap yes/no LLM check can.
async function verifyMatch(query, candidateName) {
  try {
    const raw = await llm([
      { role: "system", content: 'You verify supermarket product-search matches. Reply strictly as JSON {"match": true|false}.' },
      { role: "user", content: `A customer searched for "${query}". The store's closest product is "${candidateName}". Is this the same item (or a clear form/translation of it)? Answer false if it is a different product (e.g. rum vs rice, soap vs soup).` },
    ], true, 0);
    return !!JSON.parse(raw).match;
  } catch { return false; }
}

// Translate product display names into a target language (we only store ES/EN
// names). One batched call; brand names are kept as-is.
async function translateNames(names, language) {
  if (!names.length) return {};
  try {
    const raw = await llm([
      { role: "system", content: `Translate each supermarket product name into ${language}. Keep brand names unchanged. Reply strictly as JSON: {"items":[{"i":0,"t":"..."}]}.` },
      { role: "user", content: JSON.stringify(names.map((name, i) => ({ i, name }))) },
    ], true, 0);
    const map = {};
    (JSON.parse(raw).items || []).forEach((x) => { map[x.i] = x.t; });
    return map;
  } catch { return {}; }
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
              area: hit?.area || null, area_en: hit?.area_en || null, location: hit?.location || null,
            };
          });
          base.recipe = recipe;
          base.products = recipe.ingredients.filter((i) => i.found).map((i) => ({
            name: i.name_es, name_en: i.name_en, aisle: i.aisle, zone_id: i.zone_id,
            area: i.area, area_en: i.area_en, location: i.location,
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
        const LAYER_RANK = { exact: 0, alias: 1, category: 2, fulltext: 3, fuzzy: 4, semantic: 5 };
        const CONFIDENT = new Set(["exact", "alias", "category", "fulltext"]);
        const isProductSearch = router.intent === "PRODUCT_SEARCH";
        const terms = router.search_terms.length ? router.search_terms : [query];
        resolved = dedupeProducts(await resolveTerms(terms, { storeId, lang: language }));
        // Rank all hits by match quality so an exact term (e.g. "leche") beats a
        // mere token match (e.g. "milk" -> "Milk-Bone").
        const found = resolved.filter((r) => r.found)
          .sort((a, b) => (LAYER_RANK[a.layer] ?? 9) - (LAYER_RANK[b.layer] ?? 9));
        // For a by-NAME product search: trust confident matches (exact/alias/
        // category/fulltext) and show only the best tier (so "milk" shows Leche,
        // not also Milk-Bone). If only a semantic/fuzzy near-match exists, verify
        // it with a cheap LLM check — keeps coriandre->cilantro, rejects white
        // rum->white rice. Discovery/household keep all semantic matches.
        let shown;
        if (isProductSearch) {
          let confident = found.filter((r) => CONFIDENT.has(r.layer));
          if (confident.length) {
            // Semantically re-rank the confident set so the right product leads
            // (milk -> Leche, not Milk-Bone), then keep the top plus same-zone
            // variants; drop cross-zone lexical false positives.
            confident = await rerankBySemantic(query, confident);
            const topZone = confident[0].zone_id;
            shown = confident.filter((r, i) => i === 0 || r.zone_id === topZone);
          } else if (found.length && (await verifyMatch(query, found[0].name_en || found[0].name))) {
            shown = [found[0]];
          } else shown = [];
        } else {
          shown = found;
        }
        base.products = shown;

        if (isProductSearch && shown.length === 0) {
          reply = await compose({ language, intent: router.intent, query,
            facts: `- "${query}" -> NOT FOUND in this store`,
            extra: "Tell the customer this item was not found and to ask an associate. Do not guess a location or suggest an unrelated product." });
        } else if (isProductSearch && (language === "es" || language === "en")) {
          // fast path: grounded engine answer, no extra LLM
          reply = shown[0].location[language] || shown[0].location.es;
        } else {
          reply = await compose({ language, intent: router.intent, query, facts: factsBlock(shown) });
        }
      }
    }
  }

  // Localize product/ingredient display names for non-ES/EN languages.
  if (language !== "es" && language !== "en") {
    const targets = [];
    (base.products || []).forEach((p) => targets.push(p.name_en || p.name));
    if (base.recipe) base.recipe.ingredients.forEach((i) => targets.push(i.name_en || i.name_es));
    if (targets.length) {
      const tmap = await translateNames(targets, language);
      let k = 0;
      (base.products || []).forEach((p) => { p.name_display = tmap[k] || p.name_en || p.name; k++; });
      if (base.recipe) base.recipe.ingredients.forEach((i) => { i.name_display = tmap[k] || i.name_en || i.name_es; k++; });
    }
  }

  const newHistory = [...history, { role: "user", content: query }, { role: "assistant", content: reply }];
  return { ...base, reply, products: base.products, history: newHistory };
}

module.exports = { ask };
