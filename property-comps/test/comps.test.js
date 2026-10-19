import assert from "node:assert/strict";
import test from "node:test";

import { createRegistry } from "../src/adapters/registry.js";
import { createPropertyService } from "../src/application/property-service.js";
import { median, selectComps, summarizeComps } from "../src/domain/comps.js";
import { compsToCsv } from "../src/domain/csv.js";
import { boundingBox, distanceMiles, latToTileY, lonToTileX } from "../src/domain/geo.js";
import { classifyPropertyType, matchesPropertyType, searchTokens } from "../src/domain/property.js";
import { applySaleWindow, parseCompRequest, parseSearchQuery } from "../src/domain/query.js";

const property = (overrides) => ({
  id: "sample:test",
  sourceId: "sample",
  kind: "sample",
  parcelId: "SAMPLE-1",
  address: "1 Test Street",
  owner: "Tester",
  propertyType: "Residential",
  propertyTypeDetail: "SINGLE FAMILY",
  buildingSqft: 1000,
  yearBuilt: 1950,
  assessedValue: 100000,
  assessmentNote: null,
  latitude: 41,
  longitude: -90,
  sales: [{ date: "2024-06-01", price: 200000 }],
  provenance: { kind: "sample", datasets: [], notes: "sample" },
  ...overrides,
});

test("property type classification keeps vacant and storage ahead of residential words", () => {
  assert.equal(classifyPropertyType("VACANT LAND - RESIDENTIAL").propertyType, "Vacant");
  assert.equal(classifyPropertyType("GARAGE - RESIDENTIAL").propertyType, "Other");
  assert.equal(classifyPropertyType("47 CONDO NON-BUSINESS STORAGE").propertyType, "Other");
  assert.equal(classifyPropertyType("01 ONE FAMILY DWELLINGS").propertyType, "Residential");
  assert.equal(classifyPropertyType("APARTMENTS > 4 UNITS").propertyType, "Residential");
  assert.equal(classifyPropertyType("MIXED USE").propertyType, "Mixed");
  assert.equal(classifyPropertyType("COMMERCIAL").propertyType, "Commercial");
  assert.equal(classifyPropertyType("INDUSTRIAL").propertyType, "Industrial");
  assert.equal(classifyPropertyType(null).propertyType, "Unknown");
  assert.equal(matchesPropertyType(property({}), "Residential"), true);
  assert.equal(matchesPropertyType(property({}), "FAMILY"), true);
  assert.equal(matchesPropertyType(property({}), ""), true);
  assert.equal(matchesPropertyType(property({}), "Commercial"), false);
});

test("search tokens drop street suffixes and ordinals", () => {
  assert.deepEqual(searchTokens("19-22 81ST STREET"), ["19", "22", "81"]);
  assert.deepEqual(searchTokens("4023-25 MARKET ST"), ["4023", "25", "MARKET"]);
});

test("comp filters are inclusive and statistics ignore missing area", () => {
  const subject = property({ id: "subject", sales: [] });
  const inside = property({
    id: "inside",
    address: "Inside",
    latitude: 41.001,
    longitude: -90,
    buildingSqft: 1000,
    sales: [
      { date: "2024-01-01", price: 100000 },
      { date: "2024-06-01", price: 300000 },
      { date: "2020-01-01", price: 50000 },
      { date: "2024-07-01", price: 0 },
    ],
  });
  const far = property({
    id: "far",
    address: "Far",
    latitude: 41.05,
    longitude: -90,
  });
  const wrongType = property({
    id: "office",
    address: "Office",
    latitude: 41.001,
    propertyType: "Commercial",
    propertyTypeDetail: "COMMERCIAL",
  });
  const tooSmall = property({
    id: "small",
    address: "Small",
    latitude: 41.001,
    buildingSqft: 500,
  });
  const noArea = property({
    id: "no-area",
    address: "No Area",
    latitude: 41.001,
    buildingSqft: null,
    sales: [{ date: "2024-06-01", price: 250000 }],
  });
  const result = selectComps([subject, inside, far, wrongType, tooSmall, noArea], {
    subjectId: "subject",
    latitude: 41,
    longitude: -90,
    radiusMiles: 1,
    propertyType: "Residential",
    minSqft: 800,
    maxSqft: 1500,
    soldAfter: "2024-01-01",
    soldBefore: "2024-12-31",
  });
  assert.deepEqual(
    result.comps.map((comp) => [comp.property.id, comp.sale.price]),
    [
      ["inside", 300000],
      ["inside", 100000],
    ],
  );
  assert.equal(result.stats.count, 2);
  assert.equal(result.stats.minPrice, 100000);
  assert.equal(result.stats.maxPrice, 300000);
  assert.equal(result.stats.medianPricePerSqft, 200);

  const withUnknownArea = selectComps([noArea], {
    subjectId: "other",
    latitude: 41,
    longitude: -90,
    radiusMiles: 1,
    propertyType: null,
    minSqft: null,
    maxSqft: null,
    soldAfter: "2024-01-01",
    soldBefore: null,
  });
  assert.equal(withUnknownArea.comps[0].pricePerSqft, null);
  assert.equal(withUnknownArea.stats.medianPricePerSqft, null);
  assert.equal(summarizeComps([]).count, 0);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1]), 2.5);
  assert.equal(median([]), null);
});

test("bounding box contains the circle and tile origin is stable", () => {
  const box = boundingBox(41, -90, 0.5);
  assert.ok(box.minLat < 41 && box.maxLat > 41);
  const north = distanceMiles(41, -90, box.maxLat, -90);
  assert.ok(north > 0.5);
  assert.equal(lonToTileX(0, 1), 1);
  assert.equal(latToTileY(0, 1), 1);
});

test("query validation rejects impossible comp filters", () => {
  assert.equal(parseSearchQuery(" ").ok, false);
  assert.equal(parseCompRequest({ subjectId: "sample:maple-100", radiusMiles: "9" }).ok, false);
  assert.equal(
    parseCompRequest({
      subjectId: "sample:maple-100",
      minSqft: "2000",
      maxSqft: "1000",
    }).ok,
    false,
  );
  assert.equal(
    parseCompRequest({
      subjectId: "sample:maple-100",
      soldAfter: "2024-13-01",
    }).ok,
    false,
  );
  const parsed = parseCompRequest({
    subjectId: "sample:maple-100",
    radiusMiles: "0.5",
    soldAfter: "2024-01-01",
    soldBefore: "2024-01-01",
  });
  assert.equal(parsed.ok, true);
  assert.equal(applySaleWindow(parsed.value, new Date("2026-10-19T00:00:00Z")).windowDefaulted, false);
  const open = parseCompRequest({ subjectId: "sample:maple-100" });
  assert.equal(
    applySaleWindow(open.value, new Date("2026-10-19T00:00:00Z")).soldAfter,
    "2023-10-19",
  );
});

test("csv quotes commas and marks sample rows", () => {
  const csv = compsToCsv([
    {
      property: property({ owner: 'Quinn "Q" Sample, Jr.', kind: "sample" }),
      sale: { date: "2024-08-01", price: 340000 },
      distanceMiles: 0.15,
      pricePerSqft: 200,
    },
  ]);
  assert.match(csv, /^address,parcel_id,/u);
  assert.match(csv, /"Quinn ""Q"" Sample, Jr."/u);
  assert.match(csv, /,sample\n$/u);
});

test("sample county comps honor radius, type, size, and dates", async () => {
  const service = createPropertyService(createRegistry(), {
    now: () => new Date("2026-10-19T00:00:00Z"),
  });
  const result = await service.comps("sample", {
    subjectId: "sample:maple-100",
    radiusMiles: "0.5",
    propertyType: "Residential",
    minSqft: "1400",
    maxSqft: "2200",
    soldAfter: "2023-01-01",
    soldBefore: "2026-01-01",
  });
  assert.deepEqual(
    result.comps.map((comp) => comp.property.parcelId).sort(),
    ["SAMPLE-049", "SAMPLE-080", "SAMPLE-120", "SAMPLE-140", "SAMPLE-200"],
  );
  assert.equal(result.stats.count, 5);
  assert.equal(result.stats.minPrice, 280000);
  assert.equal(result.stats.maxPrice, 390000);
  assert.equal(result.stats.medianPricePerSqft, 195.05);
  assert.equal(result.comps[0].property.parcelId, "SAMPLE-120");
  assert.ok(result.comps.every((comp) => comp.distanceMiles <= 0.5));

  const record = await service.getProperty("sample", "sample:maple-100");
  assert.equal(record.property.kind, "sample");
  assert.deepEqual(
    record.property.sales.map((sale) => sale.date),
    ["2024-04-15", "2018-06-01"],
  );

  const open = await service.comps("sample", {
    subjectId: "sample:maple-100",
    radiusMiles: "0.5",
    propertyType: "Residential",
  });
  assert.equal(open.coverage.saleWindowDefaulted, true);
  assert.equal(open.coverage.soldAfter, "2023-10-19");
  const ids = open.comps.map((comp) => comp.property.parcelId);
  assert.ok(ids.includes("SAMPLE-140"));
  assert.ok(!ids.includes("SAMPLE-018"));
  assert.ok(!ids.includes("SAMPLE-010"));

  await assert.rejects(
    () => service.comps("sample", { subjectId: "sample:unmapped-1", radiusMiles: "0.5" }),
    /no coordinates/u,
  );
});
