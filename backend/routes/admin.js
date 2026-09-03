// ============================================================================
// Econo Te Ayuda IA — admin API
// Lets store staff manage products (prices/promos/inventory/images), move
// products between aisles, and review unresolved searches to add aliases.
// Auth: POST /login returns the admin token; protected routes require the
// x-api-key header to equal ADMIN_API_KEY.
// ============================================================================
const express = require("express");
const multer = require("multer");
const cloudinary = require("cloudinary").v2;
const { CloudinaryStorage } = require("multer-storage-cloudinary");
const db = require("../lib/db");
const { normalize } = require("../lib/normalize");

const router = express.Router();

// --- Cloudinary image upload ---
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});
const storage = new CloudinaryStorage({
  cloudinary,
  params: { folder: "econo_products", allowed_formats: ["jpg", "jpeg", "png", "gif", "webp"] },
});
const upload = multer({ storage });

// --- auth ---
router.post("/login", (req, res) => {
  const { username, password } = req.body || {};
  if (username === process.env.ADMIN_USERNAME && password === process.env.ADMIN_PASSWORD) {
    return res.json({ token: process.env.ADMIN_API_KEY });
  }
  res.status(401).json({ error: "Invalid username or password" });
});

function requireAdmin(req, res, next) {
  const key = req.headers["x-api-key"];
  if (key && key === process.env.ADMIN_API_KEY) return next();
  res.status(401).json({ error: "Unauthorized" });
}

// --- products: list / search ---
router.get("/products", requireAdmin, async (req, res) => {
  try {
    const q = (req.query.search || "").trim();
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    let rows;
    if (q) {
      const like = `%${q}%`;
      ({ rows } = await db.query(
        `SELECT id, producto, producto_en, marca, categoria, zone_id, pasillo, lado,
                sku, upc, price, promo_text, promo_text_en, promo_price, promo_image_url,
                inventory_status, image_url
           FROM products
          WHERE producto ILIKE $1 OR producto_en ILIKE $1 OR categoria ILIKE $1 OR marca ILIKE $1
          ORDER BY producto LIMIT $2`,
        [like, limit]
      ));
    } else {
      ({ rows } = await db.query(
        `SELECT id, producto, producto_en, marca, categoria, zone_id, pasillo, lado,
                sku, upc, price, promo_text, promo_text_en, promo_price, promo_image_url,
                inventory_status, image_url
           FROM products ORDER BY producto LIMIT $1`,
        [limit]
      ));
    }
    res.json(rows);
  } catch (e) {
    console.error("[admin/products]", e.message);
    res.status(500).json({ error: "Failed to load products" });
  }
});

// --- products: update ---
const EDITABLE = [
  "producto", "producto_en", "marca", "categoria", "categoria_en",
  "sku", "upc", "price", "promo_text", "promo_text_en", "promo_price",
  "promo_image_url", "inventory_status", "image_url",
];
router.patch("/products/:id", requireAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const sets = [];
    const params = [id];
    // Moving a product to a new zone: copy the zone's denormalized location fields
    // so responses stay consistent.
    if (req.body.zone_id) {
      const z = await db.query(
        "SELECT * FROM zones WHERE store_id=(SELECT store_id FROM products WHERE id=$1) AND zone_id=$2",
        [id, req.body.zone_id]
      );
      if (!z.rows.length) return res.status(400).json({ error: "Unknown zone_id" });
      const zn = z.rows[0];
      const copy = {
        zone_id: zn.zone_id, departamento: zn.departamento, departamento_en: zn.departamento_en,
        macro_area: zn.macro_area, macro_area_en: zn.macro_area_en, pasillo: zn.pasillo,
        pasillo_en: zn.pasillo_en, lado: zn.lado, lado_en: zn.lado_en, tramo: zn.tramo,
        tramo_en: zn.tramo_en, fixture: zn.fixture, fixture_en: zn.fixture_en,
      };
      for (const [k, v] of Object.entries(copy)) { params.push(v); sets.push(`${k}=$${params.length}`); }
    }
    for (const col of EDITABLE) {
      if (req.body[col] !== undefined) {
        params.push(req.body[col] === "" ? null : req.body[col]);
        sets.push(`${col}=$${params.length}`);
      }
    }
    if (!sets.length) return res.status(400).json({ error: "No fields to update" });
    sets.push("updated_at=now()");
    const { rows } = await db.query(
      `UPDATE products SET ${sets.join(", ")} WHERE id=$1 RETURNING *`, params
    );
    if (!rows.length) return res.status(404).json({ error: "Product not found" });
    res.json(rows[0]);
  } catch (e) {
    console.error("[admin/products PATCH]", e.message);
    res.status(500).json({ error: "Failed to update product" });
  }
});

// --- image upload -> Cloudinary URL ---
router.post("/upload-image", requireAdmin, upload.single("image"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  res.json({ imageUrl: req.file.path });
});

// --- zones (for aisle reassignment + alias target) ---
router.get("/zones", requireAdmin, async (_req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT zone_id, departamento, macro_area, pasillo, lado, referencia
         FROM zones ORDER BY orden_zona NULLS LAST, zone_id`
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: "Failed to load zones" });
  }
});

// --- search misses (what shoppers asked for and we couldn't resolve) ---
router.get("/misses", requireAdmin, async (_req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT query_norm, min(query_raw) AS example, array_agg(DISTINCT lang) AS langs,
              count(*)::int AS hits, max(created_at) AS last_seen
         FROM search_misses WHERE resolved=false
        GROUP BY query_norm ORDER BY hits DESC, last_seen DESC LIMIT 200`
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: "Failed to load misses" });
  }
});

// --- add an alias (fix a miss) ---
router.post("/aliases", requireAdmin, async (req, res) => {
  const { alias, termino_canonico, zone_id } = req.body || {};
  if (!alias || !zone_id) return res.status(400).json({ error: "alias and zone_id are required" });
  try {
    const storeId = process.env.DEFAULT_STORE_ID || "ECONO-SIERRA-BAYAMON";
    const aliasNorm = normalize(alias);
    await db.query(
      `INSERT INTO search_aliases(store_id, alias_normalized, termino_canonico, tipo, zone_id)
       VALUES($1,$2,$3,'admin',$4)`,
      [storeId, aliasNorm, termino_canonico || alias, zone_id]
    );
    // mark matching misses resolved
    await db.query("UPDATE search_misses SET resolved=true WHERE query_norm=$1", [aliasNorm]);
    res.status(201).json({ ok: true, alias_normalized: aliasNorm });
  } catch (e) {
    console.error("[admin/aliases]", e.message);
    res.status(500).json({ error: "Failed to add alias" });
  }
});

module.exports = { router, requireAdmin };
