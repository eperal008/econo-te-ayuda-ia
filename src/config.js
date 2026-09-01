// Central config for the Econo Te Ayuda IA kiosk frontend.
export const API_BASE_URL =
  process.env.REACT_APP_API_BASE_URL || "http://localhost:3001";

export const STORE_ID =
  process.env.REACT_APP_STORE_ID || "ECONO-SIERRA-BAYAMON";

// External services shown on the home grid.
// TODO(customer): replace the placeholder URLs with Econo's real destinations,
// and define what the QR scanner should do.
export const SERVICE_URLS = {
  onlineShopper: process.env.REACT_APP_URL_ONLINE_SHOPPER || "https://www.econo.com.pr/",
  econoToGo: process.env.REACT_APP_URL_ECONO_TO_GO || "https://www.econo.com.pr/",
  deals: process.env.REACT_APP_URL_DEALS || "https://www.econo.com.pr/especiales/",
};
