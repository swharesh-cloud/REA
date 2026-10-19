import assert from "node:assert/strict";
import { once } from "node:events";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createRegistry } from "../src/adapters/registry.js";
import { createPropertyService } from "../src/application/property-service.js";
import { createAppServer, listen } from "../src/server/create-server.js";

const root = dirname(fileURLToPath(import.meta.url));

test("http api searches sample records and exports csv", async () => {
  const service = createPropertyService(createRegistry(), {
    now: () => new Date("2026-10-19T00:00:00Z"),
  });
  const server = createAppServer({
    service,
    publicDir: join(root, "../public"),
  });
  const address = await listen(server, { port: 0, host: "127.0.0.1" });
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /Open Property Comps/u);
    assert.match(html, /manifest\.webmanifest/u);
    assert.match(html, /theme-color/u);
    assert.match(html, /apple-touch-icon/u);
    const manifest = await fetch(`${base}/manifest.webmanifest`);
    assert.equal(manifest.status, 200);
    assert.match(manifest.headers.get("content-type"), /manifest/u);
    const manifestBody = await manifest.json();
    assert.equal(manifestBody.display, "standalone");
    assert.equal(manifestBody.theme_color, "#0f6e56");
    const worker = await fetch(`${base}/sw.js`);
    assert.equal(worker.status, 200);
    const workerText = await worker.text();
    assert.match(workerText, /addEventListener\("fetch"/u);
    assert.match(
      workerText,
      /pathname\.startsWith\("\/api\/"\)[\s\S]*return;[\s\S]*respondWith/u,
    );
    const icon = await fetch(`${base}/icons/icon-192.png`);
    assert.equal(icon.status, 200);
    assert.match(icon.headers.get("content-type"), /image\/png/u);
    const sources = await fetch(`${base}/api/sources`);
    const sourceBody = await sources.json();
    assert.deepEqual(
      sourceBody.sources.map((source) => source.id),
      ["sample", "maricopa", "pinal"],
    );
    const search = await fetch(`${base}/api/search?source=sample&q=maple`);
    const searchBody = await search.json();
    assert.ok(searchBody.results.some((row) => row.id === "sample:maple-100"));
    const comps = await fetch(
      `${base}/api/comps?source=sample&subjectId=sample:maple-100&radiusMiles=0.5&propertyType=Residential&minSqft=1400&maxSqft=2200&soldAfter=2023-01-01`,
    );
    const compsBody = await comps.json();
    assert.equal(compsBody.stats.count, 5);
    const csv = await fetch(
      `${base}/api/comps.csv?source=sample&subjectId=sample:maple-100&radiusMiles=0.5&propertyType=Residential&minSqft=1400&maxSqft=2200&soldAfter=2023-01-01`,
    );
    assert.match(csv.headers.get("content-type"), /text\/csv/u);
    const csvText = await csv.text();
    assert.match(csvText, /"Quinn ""Q"" Sample, Jr."/u);
    assert.match(csvText, /sample/u);
    const missing = await fetch(`${base}/../package.json`);
    assert.equal(missing.status, 404);
    const bad = await fetch(
      `${base}/api/comps?source=sample&subjectId=sample:maple-100&radiusMiles=9`,
    );
    assert.equal(bad.status, 400);
  } finally {
    server.close();
    await once(server, "close");
  }
});
