#!/usr/bin/env node
/**
 * Seed a few sample deals so the kiosk "Deals & Promotions" tab isn't empty on
 * first look. Uses real product photos already in the catalog (Cloudinary) as the
 * deal images. Idempotent: only inserts when the deals table is empty.
 * Runs on local, and on Railway when RW=<url> is set.
 *
 *   node scripts/seed_sample_deals.js
 *   RW="postgres://…railway…" node scripts/seed_sample_deals.js
 */
require("dotenv").config();
const { Pool } = require("pg");

// each: [imageMatchTerm, title, description(ES), description_en, price, sort]
const DEALS = [
  ["%refresco%", "Oferta de la semana", "Coca-Cola 2 litros", "Coca-Cola 2 liters", "2/$5", 1],
  ["%bustelo%", "Café favorito", "Café Bustelo 10 oz", "Café Bustelo 10 oz", "$4.99", 2],
  ["arroz blanco", "Especial del arroz", "Arroz grano mediano 5 lb", "Medium-grain rice 5 lb", "3/$10", 3],
  ["%detergente%", "Ahorra en limpieza", "Detergente líquido", "Liquid detergent", "$3.99", 4],
];

async function seed(label, cs, ssl) {
  if (!cs) { console.log(label, "-> no url, skipped"); return; }
  const pool = new Pool({ connectionString: cs, ssl });
  const existing = Number((await pool.query("SELECT count(*) c FROM deals")).rows[0].c);
  if (existing > 0) { console.log(label, `-> already has ${existing} deals, skipping`); await pool.end(); return; }
  let n = 0;
  for (const [term, title, desc, descEn, price, sort] of DEALS) {
    const img = (await pool.query(
      "SELECT image_url FROM products WHERE image_url ILIKE '%cloudinary%' AND producto ILIKE $1 AND image_url NOT ILIKE '%placeholder%' LIMIT 1",
      [term]
    )).rows[0]?.image_url || null;
    await pool.query(
      `INSERT INTO deals (title, description, description_en, price, image_url, active, sort_order)
       VALUES ($1,$2,$3,$4,$5,true,$6)`,
      [title, desc, descEn, price, img, sort]
    );
    n++;
    console.log(`   + ${title} (${price}) img:${img ? "yes" : "no"}`);
  }
  console.log(label, `-> inserted ${n} sample deals`);
  await pool.end();
}

(async () => {
  await seed("local", process.env.DATABASE_URL, String(process.env.PGSSL).toLowerCase() === "true" ? { rejectUnauthorized: false } : false);
  await seed("railway", process.env.RW, { rejectUnauthorized: false });
})().catch((e) => { console.error("seed_sample_deals failed:", e.message); process.exit(1); });
