import { getService } from "./app-service.js";
import { dispatchApi } from "./dispatch.js";

/** Vercel Node function: `{ fetch(request) }` for one public API path. */
export const apiFunction = (pathname) => ({
  async fetch(request) {
    const url = new URL(request.url);
    const result = await dispatchApi(getService(), {
      method: request.method,
      pathname,
      searchParams: url.searchParams,
    });
    return new Response(result.body, {
      status: result.status,
      headers: result.headers,
    });
  },
});
