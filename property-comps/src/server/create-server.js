import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, normalize } from "node:path";

const STATIC = new Map([
  ["/", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/index.html", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/app.js", { file: "app.js", type: "text/javascript; charset=utf-8" }],
  ["/styles.css", { file: "styles.css", type: "text/css; charset=utf-8" }],
]);

const sendJson = (response, status, body) => {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
};

const statusFor = (error) => {
  if (error?.code === "bad_request") return 400;
  if (error?.code === "not_found") return 404;
  if (error?.code === "timeout") return 504;
  return 502;
};

const queryParams = (url) => Object.fromEntries(url.searchParams.entries());

export const createAppServer = ({ service, publicDir, moduleDir }) =>
  createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method !== "GET") {
        sendJson(response, 405, {
          error: { code: "method", message: "Use GET." },
        });
        return;
      }
      if (url.pathname === "/api/sources") {
        sendJson(response, 200, { sources: service.listSources() });
        return;
      }
      if (url.pathname === "/api/search") {
        const body = await service.search(url.searchParams.get("source"), url.searchParams.get("q"));
        sendJson(response, 200, body);
        return;
      }
      if (url.pathname === "/api/properties") {
        const body = await service.getProperty(
          url.searchParams.get("source"),
          url.searchParams.get("id"),
        );
        sendJson(response, 200, body);
        return;
      }
      if (url.pathname === "/api/comps" || url.pathname === "/api/comps.csv") {
        const params = queryParams(url);
        const source = params.source;
        if (url.pathname === "/api/comps.csv") {
          const csv = await service.compsCsv(source, params);
          response.writeHead(200, {
            "content-type": "text/csv; charset=utf-8",
            "content-disposition": 'attachment; filename="comps.csv"',
            "cache-control": "no-store",
          });
          response.end(csv);
          return;
        }
        sendJson(response, 200, await service.comps(source, params));
        return;
      }
      if (url.pathname === "/modules/geo.js") {
        const file = join(moduleDir, "geo.js");
        const body = await readFile(file);
        response.writeHead(200, {
          "content-type": "text/javascript; charset=utf-8",
          "cache-control": "no-store",
        });
        response.end(body);
        return;
      }
      const asset = STATIC.get(url.pathname);
      if (!asset) {
        sendJson(response, 404, {
          error: { code: "not_found", message: "Not found." },
        });
        return;
      }
      const file = normalize(join(publicDir, asset.file));
      if (!file.startsWith(normalize(publicDir))) {
        sendJson(response, 404, {
          error: { code: "not_found", message: "Not found." },
        });
        return;
      }
      response.writeHead(200, {
        "content-type": asset.type,
        "cache-control": "no-store",
      });
      createReadStream(file)
        .on("error", () => {
          if (!response.headersSent)
            sendJson(response, 404, {
              error: { code: "not_found", message: "Not found." },
            });
          else response.destroy();
        })
        .pipe(response);
    } catch (error) {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      sendJson(response, statusFor(error), {
        error: {
          code: error?.code ?? "upstream",
          message: error?.message ?? "Request failed.",
        },
      });
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
