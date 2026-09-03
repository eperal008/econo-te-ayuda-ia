#!/usr/bin/env node
/**
 * Demo seeding — plausible prices for every product + promotions on a spread of
 * common items, so the price/promo UI is populated. These are placeholder values
 * (the customer edits real ones in the admin). Idempotent-ish: safe to re-run.
 *   node scripts/seed_prices.js
 */
require("dotenv").config();
const db = require("../lib/db");

(async () => {
  // 1. A plausible price for every product (0.79 – 14.79, ends in .49/.79/.99).
  await db.query(`
    UPDATE products
    SET price = round((0.79 + random()*14)::numeric, 2)
    WHERE price IS NULL`);

  // 2. Promotions on a spread of common items so demo searches surface them.
  const promoTerms = ["arroz","mayonesa","leche","aceite","caf","detergente","cerveza",
    "agua","refresco","pan ","queso","jugo","cereal","galletas","papel","pollo","salsa","habichuela"];
  const promoValues = ["2/$5","3/$5","2/$3","3/$10","2/$7","2/$4","3/$6"];
  let n = 0;
  for (let i = 0; i < promoTerms.length; i++) {
    const pv = promoValues[i % promoValues.length];
    const r = await db.query(
      `UPDATE products SET promo_price=$1, promo_text='Oferta especial', promo_text_en='Special offer'
       WHERE id IN (SELECT id FROM products WHERE producto ILIKE $2 ORDER BY id LIMIT 2)`,
      [pv, "%" + promoTerms[i] + "%"]
    );
    n += r.rowCount;
  }

  const c = await db.query(
    `SELECT count(*) FILTER (WHERE price IS NOT NULL) priced,
            count(*) FILTER (WHERE promo_price IS NOT NULL) promos FROM products`);
  console.log("seeded ->", c.rows[0], "(promo rows touched:", n + ")");
  await db.pool.end();
})().catch((e) => { console.error("seed failed:", e.message); process.exit(1); });
