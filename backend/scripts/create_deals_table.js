#!/usr/bin/env node
/**
 * Migration: the `deals` table backing the kiosk "Deals & Promotions" tab.
 * One-shot deals entered in admin (image + description + price), shown to shoppers.
 * Idempotent. Runs on local, and on Railway when RW=<url> is set.
 *
 *   node scripts/create_deals_table.js
 *   RW="postgres://…railway…" node scripts/create_deals_table.js
 */
require("dotenv").config();
const { Pool } = require("pg");

const DDL = `
CREATE TABLE IF NOT EXISTS deals (
  id             BIGSERIAL PRIMARY KEY,
  title          TEXT,
  description    TEXT NOT NULL,
  description_en TEXT,
  price          TEXT,                 -- free-form: "$2.99", "2/$5", etc.
  image_url      TEXT,
  active         BOOLEAN NOT NULL DEFAULT true,
  sort_order     INTEGER NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS deals_active_idx ON deals(active, sort_order, created_at DESC);`;

(async () => {
  const targets = [
    ["local", process.env.DATABASE_URL, String(process.env.PGSSL).toLowerCase() === "true" ? { rejectUnauthorized: false } : false],
    ["railway", process.env.RW, { rejectUnauthorized: false }],
  ];
  for (const [label, cs, ssl] of targets) {
    if (!cs) { console.log(label, "-> no url, skipped"); continue; }
    const pool = new Pool({ connectionString: cs, ssl });
    await pool.query(DDL);
    const c = await pool.query("SELECT count(*) FROM deals");
    console.log(label, "-> deals table ready (rows:", c.rows[0].count + ")");
    await pool.end();
  }
})().catch((e) => { console.error("migration failed:", e.message); process.exit(1); });
