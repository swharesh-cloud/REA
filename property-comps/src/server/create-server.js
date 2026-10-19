import { createReadStream } from "node:fs";
import { createServer } from "node:http";
import { join, normalize, sep } from "node:path";

import { dispatchApi } from "./dispatch.js";

const STATIC = new Map([
  ["/", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/index.html", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/app.js", { file: "app.js", type: "text/javascript; charset=utf-8" }],
  ["/styles.css", { file: "styles.css", type: "text/css; charset=utf-8" }],
  ["/modules/geo.js", { file: "modules/geo.js", type: "text/javascript; charset=utf-8" }],
  ["/sw.js", { file: "sw.js", type: "text/javascript; charset=utf-8" }],
  [
    "/manifest.webmanifest",
    { file: "manifest.webmanifest", type: "application/manifest+json; charset=utf-8" },
  ],
  ["/icons/icon-192.png", { file: "icons/icon-192.png", type: "image/png" }],
  ["/icons/icon-512.png", { file: "icons/icon-512.png", type: "image/png" }],
  ["/icons/icon-maskable-512.png", { file: "icons/icon-maskable-512.png", type: "image/png" }],
  ["/icons/apple-touch-icon.png", { file: "icons/apple-touch-icon.png", type: "image/png" }],
]);

const send = (response, status, headers, body) => {
  response.writeHead(status, headers);
  response.end(body);
};

export const createAppServer = ({ service, publicDir }) =>
  createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname.startsWith("/api/")) {
        const result = await dispatchApi(service, {
          method: request.method ?? "GET",
          pathname: url.pathname,
          searchParams: url.searchParams,
        });
        send(response, result.status, result.headers, result.body);
        return;
      }
      if (request.method !== "GET") {
        send(response, 405, { "content-type": "application/json; charset=utf-8" }, JSON.stringify({
          error: { code: "method", message: "Use GET." },
        }));
        return;
      }
      const asset = STATIC.get(url.pathname);
      if (!asset) {
        send(response, 404, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }, JSON.stringify({
          error: { code: "not_found", message: "Not found." },
        }));
        return;
      }
      const root = normalize(publicDir);
      const file = normalize(join(root, asset.file));
      if (file !== root && !file.startsWith(`${root}${sep}`)) {
        send(response, 404, { "content-type": "application/json; charset=utf-8" }, JSON.stringify({
          error: { code: "not_found", message: "Not found." },
        }));
        return;
      }
      response.writeHead(200, {
        "content-type": asset.type,
        "cache-control": url.pathname === "/sw.js" ? "no-cache" : "no-store",
      });
      createReadStream(file)
        .on("error", () => {
          if (!response.headersSent) {
            send(response, 404, { "content-type": "application/json; charset=utf-8" }, JSON.stringify({
              error: { code: "not_found", message: "Not found." },
            }));
          } else response.destroy();
        })
        .pipe(response);
    } catch (error) {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      const status = error?.code === "bad_request" ? 400 : 502;
      send(response, status, { "content-type": "application/json; charset=utf-8" }, JSON.stringify({
        error: {
          code: error?.code ?? "upstream",
          message: error?.message ?? "Request failed.",
        },
      }));
    }
  });

export const listen = (server, { port, host }) =>
  new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const address = server.address();
      resolve({
        port: typeof address === "object" && address ? address.port : port,
        host,
      });
    });
  });
