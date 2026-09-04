// Central config for the Econo Te Ayuda IA kiosk frontend.
export const API_BASE_URL =
  process.env.REACT_APP_API_BASE_URL || "http://localhost:3001";

export const STORE_ID =
  process.env.REACT_APP_STORE_ID || "ECONO-SIERRA-BAYAMON";

// External services shown on the home grid (customer-provided destinations).
// "deals" is now an in-kiosk tab backed by the admin Deals manager, not a link.
// TODO(customer): define what the QR scanner should do.
export const SERVICE_URLS = {
  onlineShopper: process.env.REACT_APP_URL_ONLINE_SHOPPER || "https://www.superecono.com/shopper/",
  econoToGo: process.env.REACT_APP_URL_ECONO_TO_GO || "https://sierrabayamon.econotogo.com",
};
