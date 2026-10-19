import assert from "node:assert/strict";
import test from "node:test";

import { createRegistry } from "../src/adapters/registry.js";
import { createMaricopaSource } from "../src/adapters/maricopa-source.js";
import { createPinalSource } from "../src/adapters/pinal-source.js";
import { createPropertyService } from "../src/application/property-service.js";

const live = process.env.PROPERTY_COMPS_LIVE === "1";

test("live Maricopa assessor parcel", { skip: !live, timeout: 40_000 }, async () => {
  const source = createMaricopaSource();
  const property = await source.getProperty("maricopa:102-23-642");
  assert.ok(property);
  assert.equal(property.parcelId, "102-23-642");
  assert.match(property.address, /89TH/u);
  assert.equal(property.kind, "public");
  assert.equal(property.propertyType, "Residential");
  assert.ok(property.latitude > 33 && property.latitude < 34);
  assert.ok(property.longitude < -112 && property.longitude > -113);
  assert.ok(property.assessedValue > 0);
  assert.ok(property.buildingSqft > 0);
  assert.ok(property.provenance.datasets.some((dataset) => dataset.href.startsWith("https://")));
});

test("live Pinal assessor parcel", { skip: !live, timeout: 40_000 }, async () => {
  const source = createPinalSource();
  const property = await source.getProperty("pinal:51180012V");
  assert.ok(property);
  assert.equal(property.parcelId, "51180012V");
  assert.match(property.address, /RACHEL/u);
  assert.equal(property.kind, "public");
  assert.equal(property.propertyType, "Residential");
  assert.ok(property.latitude > 32 && property.latitude < 33);
  assert.ok(property.longitude < -111 && property.longitude > -112);
  assert.ok(property.assessedValue > 0);
  assert.ok(property.buildingSqft > 0);
  assert.ok(property.sales.some((sale) => sale.price > 0 && sale.date));
});

test("live Arizona comps", { skip: !live, timeout: 90_000 }, async () => {
  const service = createPropertyService(createRegistry(), {
    now: () => new Date("2026-10-19T00:00:00Z"),
  });
  const maricopa = await service.comps("maricopa", {
    subjectId: "maricopa:102-23-642",
    radiusMiles: "0.35",
    propertyType: "Residential",
    soldAfter: "2018-01-01",
  });
  assert.ok(maricopa.stats.count >= 1, "expected at least one Maricopa residential comp");
  assert.ok(maricopa.comps.every((comp) => comp.distanceMiles <= 0.35));
  assert.ok(maricopa.comps.every((comp) => comp.property.propertyType === "Residential"));
  assert.ok(maricopa.stats.minPrice <= maricopa.stats.maxPrice);

  const pinal = await service.comps("pinal", {
    subjectId: "pinal:51180012V",
    radiusMiles: "0.5",
    soldAfter: "2021-01-01",
  });
  assert.ok(pinal.stats.count >= 1, "expected at least one Pinal comp");
  assert.ok(pinal.comps.every((comp) => comp.distanceMiles <= 0.5));
  assert.equal(pinal.subject.kind, "public");
  assert.equal(pinal.subject.propertyType, "Residential");
});
