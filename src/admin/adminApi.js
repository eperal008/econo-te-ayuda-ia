import axios from "axios";
import { API_BASE_URL } from "../config";

const TOKEN_KEY = "econo_admin_token";
export const getToken = () => { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } };
export const setToken = (t) => { try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch {} };

const http = axios.create({ baseURL: `${API_BASE_URL}/api/admin`, timeout: 30000 });
http.interceptors.request.use((cfg) => {
  const t = getToken();
  if (t) cfg.headers["x-api-key"] = t;
  return cfg;
});

export async function login(username, password) {
  const { data } = await http.post("/login", { username, password });
  setToken(data.token);
  return data.token;
}
export const logout = () => setToken(null);

export const listProducts = (search = "") =>
  http.get("/products", { params: { search } }).then((r) => r.data);
export const updateProduct = (id, fields) =>
  http.patch(`/products/${id}`, fields).then((r) => r.data);
export const createProduct = (fields) =>
  http.post("/products", fields).then((r) => r.data);
export const getZones = () => http.get("/zones").then((r) => r.data);
export const getMisses = () => http.get("/misses").then((r) => r.data);
export const addAlias = (alias, termino_canonico, zone_id) =>
  http.post("/aliases", { alias, termino_canonico, zone_id }).then((r) => r.data);
// deals (kiosk "Deals & Promotions" tab)
export const listDeals = () => http.get("/deals").then((r) => r.data);
export const createDeal = (fields) => http.post("/deals", fields).then((r) => r.data);
export const updateDeal = (id, fields) => http.patch(`/deals/${id}`, fields).then((r) => r.data);
export const deleteDeal = (id) => http.delete(`/deals/${id}`).then((r) => r.data);

export const uploadImage = (file) => {
  const fd = new FormData();
  fd.append("image", file);
  return http.post("/upload-image", fd, { headers: { "Content-Type": "multipart/form-data" } }).then((r) => r.data.imageUrl);
};
