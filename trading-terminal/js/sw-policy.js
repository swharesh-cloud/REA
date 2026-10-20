/** App-shell files only. Cross-origin market data must never be handled here. */
export const SHELL_PATHS = [
  "/",
  "/index.html",
  "/favicon.svg",
  "/manifest.webmanifest",
  "/css/app.css",
  "/js/aggregate.js",
  "/js/app.js",
  "/js/backtest.js",
  "/js/chart.js",
  "/js/equity.js",
  "/js/format.js",
  "/js/indicators.js",
  "/js/live.js",
  "/js/market.js",
  "/js/store.js",
  "/js/sw-policy.js",
  "/icons/icon-180.png",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];

const SHELL = new Set(SHELL_PATHS);

export function shouldHandleFetch(request, origin) {
  if (!request || request.method !== "GET") return false;
  let url;
  try {
    url = new URL(request.url);
  } catch {
    return false;
  }
  if (url.origin !== origin) return false;
  if (url.search) return false;
  return SHELL.has(url.pathname);
}
