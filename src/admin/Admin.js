import React, { useState, useEffect, useCallback } from "react";
import { Link } from "react-router-dom";
import * as api from "./adminApi";
import "./Admin.css";

const INV = [
  { v: "", label: "—" },
  { v: "in_stock", label: "In stock" },
  { v: "low", label: "Low" },
  { v: "out", label: "Out of stock" },
];

function Login({ onIn }) {
  const [u, setU] = useState("");
  const [p, setP] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault(); setBusy(true); setErr("");
    try { await api.login(u, p); onIn(); }
    catch { setErr("Invalid username or password"); }
    finally { setBusy(false); }
  };
  return (
    <div className="adm-login">
      <form onSubmit={submit} className="adm-login-card">
        <h1>Econo <span>Admin</span></h1>
        <input placeholder="Username" value={u} onChange={(e) => setU(e.target.value)} autoFocus />
        <input placeholder="Password" type="password" value={p} onChange={(e) => setP(e.target.value)} />
        {err && <div className="adm-err">{err}</div>}
        <button disabled={busy}>{busy ? "…" : "Sign in"}</button>
        <Link to="/" className="adm-back-link">← Back to kiosk</Link>
      </form>
    </div>
  );
}

function Editor({ product, zones, onClose, onSaved }) {
  const isNew = !product.id;
  const [f, setF] = useState(() => ({ ...product }));
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const set = (k, v) => setF((s) => ({ ...s, [k]: v }));

  const save = async () => {
    const payload = {
      producto: f.producto, producto_en: f.producto_en, marca: f.marca,
      categoria: f.categoria, categoria_en: f.categoria_en,
      price: f.price === "" || f.price == null ? null : Number(f.price),
      promo_text: f.promo_text, promo_text_en: f.promo_text_en, promo_price: f.promo_price,
      inventory_status: f.inventory_status || null, image_url: f.image_url, promo_image_url: f.promo_image_url,
      sku: f.sku, upc: f.upc,
    };
    setBusy(true);
    try {
      if (isNew) {
        if (!f.producto || !f.zone_id) { alert("Name (ES) and aisle are required"); setBusy(false); return; }
        payload.zone_id = f.zone_id;
        onSaved(await api.createProduct(payload), true);
      } else {
        if (f.zone_id && f.zone_id !== product.zone_id) payload.zone_id = f.zone_id;
        onSaved(await api.updateProduct(product.id, payload), false);
      }
    } catch (e) {
      alert("Save failed: " + (e?.response?.data?.error || e.message));
    } finally { setBusy(false); }
  };

  const onFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try { const url = await api.uploadImage(file); set("image_url", url); }
    catch { alert("Upload failed"); }
    finally { setUploading(false); }
  };

  return (
    <div className="adm-modal-bg" onClick={onClose}>
      <div className="adm-modal" onClick={(e) => e.stopPropagation()}>
        <div className="adm-modal-head">
          <h3>{isNew ? "New product" : product.producto}</h3>
          <button className="adm-x" onClick={onClose}>×</button>
        </div>
        <div className="adm-grid">
          <label>Name (ES) *<input value={f.producto || ""} onChange={(e) => set("producto", e.target.value)} placeholder="e.g. Leche entera" /></label>
          <label>Name (EN)<input value={f.producto_en || ""} onChange={(e) => set("producto_en", e.target.value)} placeholder="e.g. Whole Milk" /></label>
          <label>Category (ES)<input value={f.categoria || ""} onChange={(e) => set("categoria", e.target.value)} /></label>
          <label>Category (EN)<input value={f.categoria_en || ""} onChange={(e) => set("categoria_en", e.target.value)} /></label>
          <label>Brand<input value={f.marca || ""} onChange={(e) => set("marca", e.target.value)} /></label>
          <label>Aisle / Zone *
            <select value={f.zone_id || ""} onChange={(e) => set("zone_id", e.target.value)}>
              {isNew && <option value="">Select aisle…</option>}
              {zones.map((z) => (
                <option key={z.zone_id} value={z.zone_id}>
                  {z.zone_id} · {z.pasillo === "SIN PASILLO" ? z.departamento : "Pasillo " + z.pasillo}{z.lado ? " (" + z.lado + ")" : ""}
                </option>
              ))}
            </select>
          </label>
          <label>Price<input type="number" step="0.01" value={f.price ?? ""} onChange={(e) => set("price", e.target.value)} /></label>
          <label>Inventory
            <select value={f.inventory_status || ""} onChange={(e) => set("inventory_status", e.target.value)}>
              {INV.map((i) => <option key={i.v} value={i.v}>{i.label}</option>)}
            </select>
          </label>
          <label>Promo (ES)<input value={f.promo_text || ""} onChange={(e) => set("promo_text", e.target.value)} placeholder="e.g. Oferta especial" /></label>
          <label>Promo (EN)<input value={f.promo_text_en || ""} onChange={(e) => set("promo_text_en", e.target.value)} placeholder="e.g. Special offer" /></label>
          <label>Promo price<input value={f.promo_price || ""} onChange={(e) => set("promo_price", e.target.value)} placeholder="e.g. 3/$5" /></label>
          <label>SKU<input value={f.sku || ""} onChange={(e) => set("sku", e.target.value)} /></label>
          <label>UPC<input value={f.upc || ""} onChange={(e) => set("upc", e.target.value)} /></label>
          <label className="adm-img">Product image
            {f.image_url && <img src={f.image_url} alt="" />}
            <input type="file" accept="image/*" onChange={onFile} />
            {uploading && <span className="adm-muted">Uploading…</span>}
          </label>
        </div>
        <div className="adm-modal-foot">
          <button className="adm-ghost" onClick={onClose}>Cancel</button>
          <button className="adm-primary" onClick={save} disabled={busy}>{busy ? "Saving…" : "Save"}</button>
        </div>
      </div>
    </div>
  );
}

function Misses({ zones }) {
  const [misses, setMisses] = useState([]);
  const [forms, setForms] = useState({});
  const load = useCallback(() => api.getMisses().then(setMisses).catch(() => {}), []);
  useEffect(() => { load(); }, [load]);
  const setForm = (k, patch) => setForms((s) => ({ ...s, [k]: { ...s[k], ...patch } }));
  const add = async (m) => {
    const form = forms[m.query_norm] || {};
    if (!form.zone_id) { alert("Pick an aisle for this term"); return; }
    try {
      await api.addAlias(m.example, form.termino || m.example, form.zone_id);
      load();
    } catch { alert("Failed to add alias"); }
  };
  if (!misses.length) return <div className="adm-empty">No unresolved searches. 🎉</div>;
  return (
    <table className="adm-table">
      <thead><tr><th>Shopper searched</th><th>Times</th><th>Map to aisle</th><th></th></tr></thead>
      <tbody>
        {misses.map((m) => (
          <tr key={m.query_norm}>
            <td><b>{m.example}</b> <span className="adm-muted">({(m.langs || []).join(", ")})</span></td>
            <td>{m.hits}</td>
            <td>
              <select value={(forms[m.query_norm] || {}).zone_id || ""} onChange={(e) => setForm(m.query_norm, { zone_id: e.target.value })}>
                <option value="">Select aisle…</option>
                {zones.map((z) => (
                  <option key={z.zone_id} value={z.zone_id}>
                    {z.zone_id} · {z.pasillo === "SIN PASILLO" ? z.departamento : "Pasillo " + z.pasillo}
                  </option>
                ))}
              </select>
            </td>
            <td><button className="adm-primary sm" onClick={() => add(m)}>Add alias</button></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function Admin() {
  const [authed, setAuthed] = useState(!!api.getToken());
  const [tab, setTab] = useState("products");
  const [search, setSearch] = useState("");
  const [products, setProducts] = useState([]);
  const [zones, setZones] = useState([]);
  const [editing, setEditing] = useState(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback((q = "") => {
    setLoading(true);
    api.listProducts(q).then(setProducts).catch((e) => {
      if (e?.response?.status === 401) { api.logout(); setAuthed(false); }
    }).finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!authed) return;
    load();
    api.getZones().then(setZones).catch(() => {});
  }, [authed, load]);

  if (!authed) return <Login onIn={() => setAuthed(true)} />;

  const money = (p) => (p == null ? "—" : "$" + Number(p).toFixed(2));

  return (
    <div className="adm">
      <header className="adm-header">
        <div className="adm-brand">ECONO <span>Admin</span></div>
        <nav>
          <button className={tab === "products" ? "on" : ""} onClick={() => setTab("products")}>Products</button>
          <button className={tab === "misses" ? "on" : ""} onClick={() => setTab("misses")}>Search misses</button>
        </nav>
        <div className="adm-header-right">
          <Link to="/" className="adm-link">View kiosk ↗</Link>
          <button className="adm-ghost" onClick={() => { api.logout(); setAuthed(false); }}>Sign out</button>
        </div>
      </header>

      <main className="adm-main">
        {tab === "products" && (
          <>
            <form className="adm-search" onSubmit={(e) => { e.preventDefault(); load(search); }}>
              <input placeholder="Search products…" value={search} onChange={(e) => setSearch(e.target.value)} />
              <button className="adm-primary">Search</button>
              <button type="button" className="adm-ghost" onClick={() => setEditing({})}>+ Add product</button>
            </form>
            {loading ? <div className="adm-empty">Loading…</div> : (
              <table className="adm-table">
                <thead><tr><th>Product</th><th>Aisle</th><th>Price</th><th>Promo</th><th>Inventory</th><th>Image</th><th></th></tr></thead>
                <tbody>
                  {products.map((p) => (
                    <tr key={p.id}>
                      <td><b>{p.producto}</b>{p.producto_en && p.producto_en !== p.producto ? <span className="adm-muted"> / {p.producto_en}</span> : null}</td>
                      <td>{p.pasillo === "SIN PASILLO" ? <span className="adm-muted">{p.categoria || "special"}</span> : "Pasillo " + p.pasillo}</td>
                      <td>{money(p.price)}</td>
                      <td>{p.promo_price || p.promo_text || <span className="adm-muted">—</span>}</td>
                      <td>{p.inventory_status || <span className="adm-muted">—</span>}</td>
                      <td>{p.image_url ? <img className="adm-thumb" src={p.image_url} alt="" /> : <span className="adm-muted">—</span>}</td>
                      <td><button className="adm-ghost sm" onClick={() => setEditing(p)}>Edit</button></td>
                    </tr>
                  ))}
                  {!products.length && <tr><td colSpan="7" className="adm-empty">No products.</td></tr>}
                </tbody>
              </table>
            )}
          </>
        )}
        {tab === "misses" && <Misses zones={zones} />}
      </main>

      {editing && (
        <Editor
          product={editing}
          zones={zones}
          onClose={() => setEditing(null)}
          onSaved={(rec, isNew) => {
            setProducts((list) => (isNew ? [rec, ...list] : list.map((x) => (x.id === rec.id ? { ...x, ...rec } : x))));
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}
