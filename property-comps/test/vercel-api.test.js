import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import comps from "../api/comps.js";
import compsCsv from "../api/comps-csv.js";
import properties from "../api/properties.js";
import search from "../api/search.js";
import sources from "../api/sources.js";

const call = (handler, path) => handler.fetch(new Request(`http://127.0.0.1${path}`));

const pngSize = async (relativePath) => {
  const bytes = await readFile(new URL(relativePath, import.meta.url));
  assert.equal(bytes.subarray(1, 4).toString(), "PNG");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
};

test("vercel functions serve the same sample API as the local server", async () => {
  const sourceResponse = await call(sources, "/api/sources");
  assert.equal(sourceResponse.status, 200);
  const sourceBody = await sourceResponse.json();
  assert.deepEqual(
    sourceBody.sources.map((source) => source.id),
    ["sample", "maricopa", "pinal"],
  );

  const searchResponse = await call(search, "/api/search?source=sample&q=maple");
  const searchBody = await searchResponse.json();
  assert.ok(searchBody.results.some((row) => row.id === "sample:maple-100"));

  const propertyResponse = await call(
    properties,
    "/api/properties?source=sample&id=sample:maple-100",
  );
  const propertyBody = await propertyResponse.json();
  assert.equal(propertyBody.property.parcelId, "SAMPLE-100");

  const query =
    "/api/comps?source=sample&subjectId=sample:maple-100&radiusMiles=0.5&propertyType=Residential&minSqft=1400&maxSqft=2200&soldAfter=2023-01-01";
  const compsResponse = await call(comps, query);
  const compsBody = await compsResponse.json();
  assert.equal(compsBody.stats.count, 5);

  const csvResponse = await call(compsCsv, query.replace("/api/comps?", "/api/comps.csv?"));
  assert.match(csvResponse.headers.get("content-type"), /text\/csv/u);
  assert.match(await csvResponse.text(), /sample/u);

  const rejected = await call(comps, "/api/comps?source=sample&subjectId=sample:maple-100&radiusMiles=9");
  assert.equal(rejected.status, 400);
  const wrongMethod = await sources.fetch(
    new Request("http://127.0.0.1/api/sources", { method: "POST" }),
  );
  assert.equal(wrongMethod.status, 405);
});

test("home-screen icons are real PNGs at the required sizes", async () => {
  assert.deepEqual(await pngSize("../public/icons/icon-192.png"), { width: 192, height: 192 });
  assert.deepEqual(await pngSize("../public/icons/icon-512.png"), { width: 512, height: 512 });
  assert.deepEqual(await pngSize("../public/icons/icon-maskable-512.png"), {
    width: 512,
    height: 512,
  });
  assert.deepEqual(await pngSize("../public/icons/apple-touch-icon.png"), {
    width: 180,
    height: 180,
  });
});
