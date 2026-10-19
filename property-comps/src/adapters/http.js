export const appError = (code, message) => {
  const error = new Error(message);
  error.code = code;
  return error;
};

export const fetchJson = async (
  url,
  { fetchImpl = globalThis.fetch, timeoutMs = 20_000 } = {},
) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: {
        accept: "application/json",
        "user-agent":
          "property-comps/0.1 (local research app; public open data)",
      },
    });
    const text = await response.text();
    let body = null;
    if (text.length > 0) {
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
    }
    if (!response.ok) {
      const message =
        body && typeof body === "object" && typeof body.message === "string"
          ? body.message
          : `Public data request failed with HTTP ${response.status}.`;
      throw appError("upstream", message);
    }
    return body;
  } catch (error) {
    if (error?.name === "AbortError")
      throw appError("timeout", "The public data source did not respond in time.");
    throw error;
  } finally {
    clearTimeout(timer);
  }
};

export const createCache = ({ ttlMs = 5 * 60_000, maxEntries = 100 } = {}) => {
  const entries = new Map();
  return {
    async get(key, loader) {
      const now = Date.now();
      const hit = entries.get(key);
      if (hit && hit.expires > now) return hit.value;
      const value = await loader();
      entries.set(key, { expires: now + ttlMs, value });
      if (entries.size > maxEntries) {
        const oldest = entries.keys().next().value;
        entries.delete(oldest);
      }
      return value;
    },
  };
};
