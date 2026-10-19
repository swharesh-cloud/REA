import { getService } from "./app-service.js";
import { dispatchApi } from "./dispatch.js";

/**
 * Vercel’s Node runtime sometimes hands the function a path-only URL
 * (`/api/properties?id=...`). `new URL` throws on that unless a base is set.
 * An absolute URL ignores the base.
 */
export const requestUrl = (request) => {
  const raw = typeof request?.url === "string" && request.url.length > 0 ? request.url : "/";
  try {
    return new URL(raw);
  } catch {
    return new URL(raw, "https://vercel.com");
  }
};

const run = async (pathname, request) => {
  const url = requestUrl(request);
  return dispatchApi(getService(), {
    method: request?.method ?? "GET",
    pathname,
    searchParams: url.searchParams,
  });
};

const sendNode = (response, result) => {
  response.statusCode = result.status;
  for (const [name, value] of Object.entries(result.headers)) {
    response.setHeader(name, value);
  }
  response.end(result.body);
};

/**
 * Supports both invocation shapes:
 * - `handler.fetch(request)` → Web `Response` (current Vercel Node functions)
 * - `handler(req, res)` → Node.js `ServerResponse` (older api-directory bridge)
 */
export const apiFunction = (pathname) => {
  const nodeHandler = async (request, response) => {
    const result = await run(pathname, request);
    if (response && typeof response.end === "function" && typeof response.setHeader === "function") {
      sendNode(response, result);
      return;
    }
    return new Response(result.body, {
      status: result.status,
      headers: result.headers,
    });
  };
  nodeHandler.fetch = async (request) => {
    const result = await run(pathname, request);
    return new Response(result.body, {
      status: result.status,
      headers: result.headers,
    });
  };
  return nodeHandler;
};
