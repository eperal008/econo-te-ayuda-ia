// Shared PostgreSQL connection pool.
const { Pool } = require("pg");
require("dotenv").config();

const ssl =
  String(process.env.PGSSL).toLowerCase() === "true" ? { rejectUnauthorized: false } : false;

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl });

pool.on("error", (err) => console.error("[db] idle client error:", err.message));

module.exports = {
  pool,
  query: (text, params) => pool.query(text, params),
};
