import assert from "node:assert/strict";
import test from "node:test";

import { createCache } from "../src/adapters/http.js";
import {
  createMaricopaSource,
  mapMaricopaFeature,
  maricopaCandidateWhere,
  maricopaSearchWhere,
  maricopaUseDetail,
} from "../src/adapters/maricopa-source.js";
import {
  createPinalSource,
  mapPinalFeature,
  pinalCandidateWhere,
  pinalSearchWhere,
} from "../src/adapters/pinal-source.js";
import { createSampleSource } from "../src/adapters/sample-source.js";
import { parseRecordDate } from "../src/domain/property.js";

const jsonResponse = (body, status = 200) => ({
  ok: status < 400,
  status,
  async text() {
    return JSON.stringify(body);
  },
});

const maricopaFeature = {
  attributes: {
    APN: "10223642",
    APN_DASH: "102-23-642",
    OWNER_NAME: "GARCIA MELISSA",
    PHYSICAL_ADDRESS: "3113 N 89TH DR   PHOENIX  85037",
    PUC: "0131",
    LIVING_SPACE: "   1,467",
    CONST_YEAR: "1979",
    FCV_CUR: "     279,700",
    SALE_DATE: "07/01/2018",
    SALE_PRICE: "160850",
    LATITUDE: 33.48459543779971,
    LONGITUDE: -112.2514409821997,
  },
};

const pinalFeature = {
  attributes: {
    Parcel_Identification_Number: "51180012V",
    Site_Address: "12432 S RACHEL LN CASA GRANDE, AZ 85193",
    First_Owner_Name: "KINNEY RANDI L",
    Second_Owner_Name: null,
    Assessing_Use_Description: "Residential",
    Property_Class: "Owner Occupied Residential",
    Residential_Floor_Area: 2224,
    Building_Area: 2224,
    Residential_Year_Built: 2008,
    Current_Assessed_Value: 300820,
    Sale_Date: "2024-02-15",
    Sale_Price: 340000,
  },
  centroid: { x: -111.75855, y: 32.767 },
};

test("sample search stays inside fictional Arizona records", async () => {
  const source = createSampleSource();
  const byStreet = await source.search("maple");
  assert.ok(byStreet.some((record) => record.address.includes("Sampleton, AZ")));
  const byParcel = await source.search("SAMPLE-100");
  assert.equal(byParcel.length, 1);
  assert.equal(byParcel[0].kind, "sample");
  assert.match(byParcel[0].provenance.notes, /SAMPLE DATA/u);
  assert.ok(byParcel[0].latitude > 31 && byParcel[0].latitude < 37);
  assert.ok(byParcel[0].longitude < -109 && byParcel[0].longitude > -115);
});

test("record dates accept Arizona assessor formats", () => {
  assert.equal(parseRecordDate("07/01/2018"), "2018-07-01");
  assert.equal(parseRecordDate("2024-02-15"), "2024-02-15");
  assert.equal(parseRecordDate("02/31/2018"), null);
  assert.equal(parseRecordDate(1_704_067_200_000), "2024-01-01");
});

test("Maricopa mapper and where clauses stay on the public parcel fields", () => {
  const record = mapMaricopaFeature(maricopaFeature, "2026-10-19T00:00:00.000Z");
  assert.equal(record.id, "maricopa:102-23-642");
  assert.equal(record.address, "3113 N 89TH DR PHOENIX 85037");
  assert.equal(record.owner, "GARCIA MELISSA");
  assert.equal(record.propertyType, "Residential");
  assert.equal(maricopaUseDetail("0131"), "Single family residential (PUC 0131)");
  assert.equal(record.buildingSqft, 1467);
  assert.equal(record.yearBuilt, 1979);
  assert.equal(record.assessedValue, 279700);
  assert.deepEqual(record.sales, [{ date: "2018-07-01", price: 160850 }]);
  assert.equal(record.kind, "public");
  assert.equal(record.latitude, 33.48459543779971);

  const searchWhere = maricopaSearchWhere("102-23-642' OR 1=1");
  assert.doesNotMatch(searchWhere, /1=1/u);
  assert.match(searchWhere, /LIKE '%102%'/u);
  assert.match(searchWhere, /LIKE '%OR%'/u);
  const candidateWhere = maricopaCandidateWhere({
    minLat: 33.4,
    maxLat: 33.5,
    minLng: -112.3,
    maxLng: -112.2,
  });
  assert.match(candidateWhere, /LATITUDE >= 33\.400000/u);
  assert.match(candidateWhere, /CAST\(SALE_PRICE AS FLOAT\) > 0/u);
});

test("Maricopa source reads a parcel and reports map-service errors", async () => {
  const source = createMaricopaSource({
    cache: createCache(),
    fetchImpl: async (url) => {
      const where = new URL(url).searchParams.get("where") ?? "";
      if (where.includes("10223642"))
        return jsonResponse({ features: [maricopaFeature] });
      return jsonResponse({ error: { message: "layer unavailable" } });
    },
  });
  const property = await source.getProperty("maricopa:102-23-642");
  assert.equal(property.parcelId, "102-23-642");
  await assert.rejects(() => source.search("washington"), /layer unavailable/u);
});

test("Pinal mapper uses the assessor fields and centroid", () => {
  const record = mapPinalFeature(pinalFeature, "2026-10-19T00:00:00.000Z");
  assert.equal(record.id, "pinal:51180012V");
  assert.equal(record.owner, "KINNEY RANDI L");
  assert.equal(record.propertyType, "Residential");
  assert.equal(record.buildingSqft, 2224);
  assert.equal(record.yearBuilt, 2008);
  assert.equal(record.assessedValue, 300820);
  assert.deepEqual(record.sales, [{ date: "2024-02-15", price: 340000 }]);
  assert.equal(record.latitude, 32.767);
  assert.equal(record.longitude, -111.75855);
  assert.equal(record.kind, "public");

  const where = pinalCandidateWhere({
    soldAfter: "2024-01-01",
    soldBefore: "2024-12-31",
  });
  assert.match(where, /Sale_Price > 0/u);
  assert.match(where, /Sale_Date >= '2024-01-01'/u);
  assert.match(where, /Sale_Date < '2025-01-01'/u);
  const searchWhere = pinalSearchWhere("51180012V' OR 1=1");
  assert.doesNotMatch(searchWhere, /1=1/u);
});

test("Pinal source sends an envelope and keeps the centroid", async () => {
  let seen = "";
  const source = createPinalSource({
    cache: createCache(),
    fetchImpl: async (url) => {
      seen = String(url);
      return jsonResponse({ features: [pinalFeature] });
    },
  });
  const found = await source.findCandidates({
    box: { minLat: 32.75, maxLat: 32.78, minLng: -111.77, maxLng: -111.74 },
    soldAfter: "2024-01-01",
    soldBefore: null,
    limit: 25,
  });
  assert.equal(found.records[0].parcelId, "51180012V");
  assert.equal(found.records[0].latitude, 32.767);
  const decoded = decodeURIComponent(seen);
  assert.match(decoded, /esriGeometryEnvelope/u);
  assert.match(decoded, /-111\.770000,32\.750000,-111\.740000,32\.780000/u);
  assert.match(decoded, /returnCentroid=true/u);
});
