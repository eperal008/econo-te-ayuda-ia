#!/usr/bin/env node
/**
 * Econo Te Ayuda IA — data ingestion
 * Loads the customer's location master workbook into PostgreSQL.
 *
 *   node scripts/ingest.js --dry-run     # parse + validate only, no DB
 *   node scripts/ingest.js               # apply schema + load into DATABASE_URL
 *   node scripts/ingest.js --file <path> # override workbook path
 *
 * Sheets:  01_Ubicaciones -> zones | 02_Catalogo -> products | 03_Alias_Busqueda -> search_aliases
 */
const fs = require("fs");
const path = require("path");
const XLSX = require("xlsx");
require("dotenv").config();

const DRY = process.argv.includes("--dry-run");
const fileArg = (() => {
  const i = process.argv.indexOf("--file");
  return i > -1 ? process.argv[i + 1] : null;
})();
const DEFAULT_STORE_ID = process.env.DEFAULT_STORE_ID || "ECONO-SIERRA-BAYAMON";
const WORKBOOK =
  fileArg ||
  path.join(__dirname, "..", "..", "data",
    "Econo_Sierra_Bayamon_App_Location_Master_v5_Developer_Guide.xlsx");

// ---- helpers ---------------------------------------------------------------
const norm = (s) =>
  (s == null ? "" : String(s))
    .normalize("NFD").replace(/[̀-ͯ]/g, "") // strip accents
    .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

const clean = (v) => {
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
};
const toInt = (v) => {
  const n = parseInt(clean(v), 10);
  return Number.isFinite(n) ? n : null;
};

/** Read a sheet as array-of-arrays and return {header, rows, colIndex(name)}. */
function readSheet(wb, sheetName) {
  const ws = wb.Sheets[sheetName];
  if (!ws) throw new Error(`Sheet not found: ${sheetName}`);
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: null, blankrows: false });
  const header = (aoa[0] || []).map((h) => (h == null ? "" : String(h)));
  const normHeader = header.map(norm);
  const rows = aoa.slice(1);
  const colIndex = (name) => {
    const target = norm(name);
    let i = normHeader.indexOf(target);
    if (i === -1) i = normHeader.findIndex((h) => h === target);
    return i;
  };
  return { header, rows, colIndex };
}

/** Build a field getter for a row, mapping desired keys -> column names. */
function mapper(sheet, spec) {
  const idx = {};
  for (const [key, colName] of Object.entries(spec)) idx[key] = sheet.colIndex(colName);
  const missing = Object.entries(idx).filter(([, i]) => i === -1).map(([k]) => k);
  return {
    idx,
    missing,
    get(row) {
      const o = {};
      for (const [key, i] of Object.entries(idx)) o[key] = i === -1 ? null : clean(row[i]);
      return o;
    },
  };
}

// ---- parse -----------------------------------------------------------------
function parse() {
  if (!fs.existsSync(WORKBOOK)) throw new Error(`Workbook not found: ${WORKBOOK}`);
  const wb = XLSX.readFile(WORKBOOK);

  // 01_Ubicaciones -> zones
  const uSheet = readSheet(wb, "01_Ubicaciones");
  const uMap = mapper(uSheet, {
    zone_id: "Zone_ID", store_id: "Store_ID", departamento: "Departamento",
    macro_area: "Macro_Área", pasillo: "Pasillo", lado: "Lado", tramo: "Tramo",
    fixture: "Fixture", referencia: "Referencia", orden_zona: "Orden_Zona",
  });
  const zones = uSheet.rows
    .map((r) => uMap.get(r))
    .filter((z) => z.zone_id)
    .map((z) => ({ ...z, store_id: z.store_id || DEFAULT_STORE_ID, orden_zona: toInt(z.orden_zona) }));

  // 02_Catalogo -> products
  const cSheet = readSheet(wb, "02_Catalogo");
  const cMap = mapper(cSheet, {
    store_id: "Store_ID", zone_id: "Zone_ID",
    departamento: "Departamento", departamento_en: "Departamento_EN",
    categoria: "Categoría", categoria_en: "Categoría_EN",
    producto: "Producto_Término", producto_en: "Producto_EN", marca: "Marca",
    macro_area: "Macro_Área", macro_area_en: "Macro_Área_EN",
    pasillo: "Pasillo", pasillo_en: "Pasillo_EN",
    lado: "Lado", lado_en: "Lado_EN", tramo: "Tramo", tramo_en: "Tramo_EN",
    fixture: "Fixture", fixture_en: "Fixture_EN",
    alias_es: "Alias_ES", alias_en: "Alias_EN",
    orden_fisico: "Orden_Físico", confianza: "Confianza", notas: "Notas",
    search_key: "Search_Key", respuesta_app: "Respuesta_App",
  });
  const products = cSheet.rows
    .map((r) => cMap.get(r))
    .filter((p) => p.producto && p.zone_id)
    .map((p) => ({ ...p, store_id: p.store_id || DEFAULT_STORE_ID, orden_fisico: toInt(p.orden_fisico) }));

  // 03_Alias_Busqueda -> search_aliases (no Store_ID column -> default store)
  const aSheet = readSheet(wb, "03_Alias_Busqueda");
  const aMap = mapper(aSheet, {
    alias_normalized: "Alias_Normalizado", termino_canonico: "Término_Canónico",
    tipo: "Tipo", zone_id: "Zone_ID",
  });
  const aliases = aSheet.rows
    .map((r) => aMap.get(r))
    .filter((a) => a.alias_normalized && a.zone_id)
    .map((a) => ({ ...a, store_id: DEFAULT_STORE_ID }));

  // Enrich zones with EN fields derived from the catalog (Ubicaciones is ES-only).
  const enByZone = new Map();
  for (const p of products) {
    if (!enByZone.has(p.zone_id)) {
      enByZone.set(p.zone_id, {
        departamento_en: p.departamento_en, macro_area_en: p.macro_area_en,
        pasillo_en: p.pasillo_en, lado_en: p.lado_en, tramo_en: p.tramo_en, fixture_en: p.fixture_en,
      });
    }
  }
  for (const z of zones) Object.assign(z, enByZone.get(z.zone_id) || {});

  return { zones, products, aliases, maps: { uMap, cMap, aMap } };
}

// ---- validation report -----------------------------------------------------
function report({ zones, products, aliases, maps }) {
  const line = "─".repeat(70);
  console.log(line);
  console.log("ECONO INGESTION — PARSE REPORT" + (DRY ? "  (dry run)" : ""));
  console.log(line);

  for (const [name, m] of Object.entries(maps)) {
    if (m.missing.length) console.log(`⚠  ${name}: unmapped columns -> ${m.missing.join(", ")}`);
  }

  const zoneIds = new Set(zones.map((z) => z.zone_id));
  const stores = new Set([...zones, ...products].map((x) => x.store_id));

  console.log(`Stores:            ${[...stores].join(", ")}`);
  console.log(`Zones:             ${zones.length}`);
  console.log(`Products:          ${products.length}`);
  console.log(`Aliases:           ${aliases.length}`);

  // orphans: product/alias zone_ids not present in the zones sheet
  const prodOrphans = [...new Set(products.filter((p) => !zoneIds.has(p.zone_id)).map((p) => p.zone_id))];
  const aliasOrphans = [...new Set(aliases.filter((a) => !zoneIds.has(a.zone_id)).map((a) => a.zone_id))];
  console.log(`Product zone_ids not in zones: ${prodOrphans.length}${prodOrphans.length ? " -> " + prodOrphans.slice(0, 10).join(", ") : ""}`);
  console.log(`Alias  zone_ids not in zones: ${aliasOrphans.length}${aliasOrphans.length ? " -> " + aliasOrphans.slice(0, 10).join(", ") : ""}`);

  // data-quality counts
  const noRespuesta = products.filter((p) => !p.respuesta_app).length;
  const noSearchKey = products.filter((p) => !p.search_key).length;
  const withBrand = products.filter((p) => p.marca).length;
  const withProdEn = products.filter((p) => p.producto_en).length;
  console.log(`Products w/ brand: ${withBrand}  |  w/ producto_en: ${withProdEn}`);
  console.log(`Products missing respuesta_app: ${noRespuesta}  |  missing search_key: ${noSearchKey}`);

  // duplicate (zone_id, normalized producto) pairs
  const seen = new Map();
  let dups = 0;
  for (const p of products) {
    const k = p.zone_id + "|" + norm(p.producto);
    seen.set(k, (seen.get(k) || 0) + 1);
  }
  for (const c of seen.values()) if (c > 1) dups += c - 1;
  console.log(`Duplicate (zone, product) rows: ${dups}`);

  // departments & special-zone sanity
  const depts = [...new Set(zones.map((z) => z.departamento).filter(Boolean))];
  console.log(`Departments (${depts.length}): ${depts.join(" | ")}`);
  const special = zones.filter((z) => norm(z.pasillo) === norm("SIN PASILLO"));
  console.log(`Special (no-aisle) zones: ${special.length}  e.g. ${special.slice(0, 4).map((z) => z.zone_id).join(", ")}`);

  // samples
  console.log(line);
  console.log("SAMPLE ZONE:", JSON.stringify(zones.find((z) => z.zone_id === "DAIRY-R-MID") || zones[0], null, 0));
  console.log("SAMPLE PRODUCT:", JSON.stringify(
    (({ store_id, zone_id, producto, producto_en, pasillo, lado, respuesta_app }) =>
      ({ store_id, zone_id, producto, producto_en, pasillo, lado, respuesta_app }))(products[0]), null, 0));
  console.log("SAMPLE ALIAS:", JSON.stringify(aliases[0], null, 0));
  console.log(line);
}

// ---- load ------------------------------------------------------------------
async function load(data) {
  const { Pool } = require("pg");
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set (see backend/.env)");
  const ssl = String(process.env.PGSSL).toLowerCase() === "true" ? { rejectUnauthorized: false } : false;
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl });
  const client = await pool.connect();
  try {
    console.log("Applying schema…");
    await client.query(fs.readFileSync(path.join(__dirname, "..", "db", "schema.sql"), "utf8"));

    const storeId = DEFAULT_STORE_ID;
    await client.query("BEGIN");
    // idempotent reload for this store
    await client.query("DELETE FROM search_aliases WHERE store_id=$1", [storeId]);
    await client.query("DELETE FROM products WHERE store_id=$1", [storeId]);
    await client.query("DELETE FROM zones WHERE store_id=$1", [storeId]);
    await client.query(
      `INSERT INTO stores(store_id,name) VALUES($1,$2)
       ON CONFLICT(store_id) DO UPDATE SET name=EXCLUDED.name, updated_at=now()`,
      [storeId, "Econo Sierra Bayamón"]
    );

    for (const z of data.zones) {
      await client.query(
        `INSERT INTO zones(store_id,zone_id,departamento,departamento_en,macro_area,macro_area_en,
           pasillo,pasillo_en,lado,lado_en,tramo,tramo_en,fixture,fixture_en,referencia,orden_zona)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [z.store_id, z.zone_id, z.departamento, z.departamento_en, z.macro_area, z.macro_area_en,
         z.pasillo, z.pasillo_en, z.lado, z.lado_en, z.tramo, z.tramo_en, z.fixture, z.fixture_en,
         z.referencia, z.orden_zona]
      );
    }
    for (const p of data.products) {
      await client.query(
        `INSERT INTO products(store_id,zone_id,departamento,departamento_en,categoria,categoria_en,
           producto,producto_en,marca,macro_area,macro_area_en,pasillo,pasillo_en,lado,lado_en,
           tramo,tramo_en,fixture,fixture_en,alias_es,alias_en,orden_fisico,confianza,notas,
           search_key,respuesta_app)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)`,
        [p.store_id, p.zone_id, p.departamento, p.departamento_en, p.categoria, p.categoria_en,
         p.producto, p.producto_en, p.marca, p.macro_area, p.macro_area_en, p.pasillo, p.pasillo_en,
         p.lado, p.lado_en, p.tramo, p.tramo_en, p.fixture, p.fixture_en, p.alias_es, p.alias_en,
         p.orden_fisico, p.confianza, p.notas, p.search_key, p.respuesta_app]
      );
    }
    for (const a of data.aliases) {
      await client.query(
        `INSERT INTO search_aliases(store_id,alias_normalized,termino_canonico,tipo,zone_id)
         VALUES($1,$2,$3,$4,$5)`,
        [a.store_id, a.alias_normalized, a.termino_canonico, a.tipo, a.zone_id]
      );
    }
    await client.query("COMMIT");

    const counts = await client.query(
      `SELECT (SELECT count(*) FROM zones WHERE store_id=$1) zones,
              (SELECT count(*) FROM products WHERE store_id=$1) products,
              (SELECT count(*) FROM search_aliases WHERE store_id=$1) aliases`, [storeId]);
    console.log("Loaded into DB:", counts.rows[0]);
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
    await pool.end();
  }
}

// ---- main ------------------------------------------------------------------
(async () => {
  try {
    const data = parse();
    report(data);
    if (!DRY) {
      await load(data);
      console.log("✔ Ingestion complete.");
    } else {
      console.log("✔ Dry run complete (no database writes).");
    }
  } catch (e) {
    console.error("[x] Ingestion failed:", e.message);
    process.exit(1);
  }
})();
