#!/usr/bin/env node
/**
 * Econo Te Ayuda IA — generate semantic embeddings for products.
 * Embeds product term + English name + category + brand (NOT location) so
 * meaning-based search works. Idempotent: only fills rows where embedding IS NULL.
 *
 *   node scripts/embed.js            # embed missing rows
 *   node scripts/embed.js --all      # re-embed everything
 */
require("dotenv").config();
const db = require("../lib/db");
const { OpenAI } = require("openai");

const MODEL = "text-embedding-3-small"; // 1536 dims
const BATCH = 200;
const ALL = process.argv.includes("--all");

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const embedText = (r) =>
  [r.producto, r.producto_en, r.categoria, r.marca].filter(Boolean).join(" | ");

(async () => {
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY not set");

  const where = ALL ? "" : "WHERE embedding IS NULL";
  const { rows } = await db.query(
    `SELECT id, producto, producto_en, categoria, marca FROM products ${where} ORDER BY id`
  );
  console.log(`Embedding ${rows.length} products (model ${MODEL}, batch ${BATCH})…`);
  if (!rows.length) { console.log("Nothing to embed."); await db.pool.end(); return; }

  let done = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const input = chunk.map(embedText);
    const res = await openai.embeddings.create({ model: MODEL, input });

    const client = await db.pool.connect();
    try {
      await client.query("BEGIN");
      for (let j = 0; j < chunk.length; j++) {
        const vec = "[" + res.data[j].embedding.join(",") + "]";
        await client.query("UPDATE products SET embedding = $1::vector WHERE id = $2", [vec, chunk[j].id]);
      }
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
    done += chunk.length;
    process.stdout.write(`\r  ${done}/${rows.length}`);
  }
  console.log(`\n✔ Embedded ${done} products.`);
  await db.pool.end();
})().catch((e) => {
  console.error("\nEmbedding failed:", e.message);
  process.exit(1);
});
