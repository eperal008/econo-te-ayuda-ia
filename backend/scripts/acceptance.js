#!/usr/bin/env node
/**
 * Econo Te Ayuda IA — acceptance tests for the deterministic location engine.
 * Implements the 8 "Minimum Acceptance Criteria" from the customer's dev guide.
 *   node scripts/acceptance.js
 */
const { searchLocation } = require("../lib/locationEngine");
const db = require("../lib/db");

let pass = 0, fail = 0;
const results = [];

function check(name, cond, detail) {
  (cond ? pass++ : fail++);
  results.push({ ok: !!cond, name, detail });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

(async () => {
  console.log("─".repeat(74));
  console.log("ECONO LOCATION ENGINE — ACCEPTANCE TESTS");
  console.log("─".repeat(74));

  // 1. Spanish exact resolves without AI
  const r1 = await searchLocation("mayonesa", { lang: "es" });
  check("1. Spanish exact (mayonesa) resolves, no AI",
    r1.matched && !r1.aiFallback && r1.best?.pasillo === "1",
    `layer=${r1.layer} → "${r1.answer}"`);

  // 2. English exact resolves without AI
  const r2 = await searchLocation("mayonnaise", { lang: "en" });
  check("2. English exact (mayonnaise) resolves, no AI",
    r2.matched && !r2.aiFallback && r2.best?.pasillo === "1",
    `layer=${r2.layer} → "${r2.answer}"`);

  // 3. Brand search resolves to correct zone
  const r3 = await searchLocation("Dewar's", { lang: "en" });
  check("3. Brand (Dewar's) → liquor L2",
    r3.matched && r3.best?.pasillo === "L2",
    `layer=${r3.layer} → "${r3.answer}"`);

  // 4. Special no-aisle zone returns a landmark, not a fake aisle number
  const r4 = await searchLocation("cilantro", { lang: "es" });
  check("4. Special zone (cilantro) → produce landmark, no fake aisle",
    r4.matched && r4.best?.pasillo === "SIN PASILLO" && /produce|extrema|frente|refriger/i.test(r4.answer || ""),
    `layer=${r4.layer} → "${r4.answer}"`);

  // 5. Back-of-store freezer resolves correctly
  const r5 = await searchLocation("frozen chicken", { lang: "en" });
  const freezerHit = (r5.results || []).some(
    (x) => /freezer|back of store/i.test((x.macro_area_en || "") + " " + (x.fixture_en || "")) || /FREEZER/i.test(x.zone_id));
  check("5. Back-of-store (frozen chicken) → floor freezer / back",
    r5.matched && freezerHit,
    `layer=${r5.layer}, results=${r5.results.length} → "${r5.answer}"`);

  // 6. Bilingual: ice cream / helado resolve to the SAME zone, localized text
  const r6a = await searchLocation("helado", { lang: "es" });
  const r6b = await searchLocation("ice cream", { lang: "en" });
  check("6. Bilingual (helado / ice cream) → same zone, localized",
    r6a.matched && r6b.matched && r6a.best?.zone_id === r6b.best?.zone_id,
    `es="${r6a.answer}" | en="${r6b.answer}"`);

  // 7. Known term does NOT trigger AI fallback
  const r7 = await searchLocation("arroz", { lang: "es" });
  check("7. Known term (arroz) does not call AI",
    r7.matched && r7.aiFallback === false && r7.layer !== null,
    `layer=${r7.layer} → "${r7.answer}"`);

  // 8. Unknown query flags AI fallback AND is logged for alias improvement
  const before = (await db.query("SELECT count(*)::int c FROM search_misses")).rows[0].c;
  const r8 = await searchLocation("qwzxplkj nonsense token", { lang: "en" });
  const after = (await db.query("SELECT count(*)::int c FROM search_misses")).rows[0].c;
  check("8. Unknown query → aiFallback + logged as a miss",
    r8.matched === false && r8.aiFallback === true && after === before + 1,
    `misses ${before}→${after}`);

  console.log("─".repeat(74));
  console.log(`RESULT: ${pass} passed, ${fail} failed`);
  console.log("─".repeat(74));

  await db.pool.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("Acceptance run crashed:", e);
  process.exit(1);
});
