import assert from "node:assert/strict";
import test from "node:test";

import { createMaricopaDebtLookup } from "../src/adapters/maricopa-recorder.js";
import { createPinalDebtLookup } from "../src/adapters/pinal-recorder.js";
import { createCache } from "../src/adapters/http.js";
import { createSampleSource } from "../src/adapters/sample-source.js";
import { createPropertyService } from "../src/application/property-service.js";
import { debtRole, possibleLenders, recorderNameQuery } from "../src/domain/debt.js";

const jsonResponse = (body, status = 200) => ({
  ok: status < 400,
  status,
  async text() {
    return typeof body === "string" ? body : JSON.stringify(body);
  },
});

const commercial = {
  id: "maricopa:102-01-260",
  sourceId: "maricopa",
  propertyType: "Commercial",
  parcelId: "102-01-260",
  owner: "YAM WESTGATE LLC",
  address: "9375 W WESTGATE DR GLENDALE",
};

test("recorder names use a business field or the first person", () => {
  assert.deepEqual(recorderNameQuery("YAM WESTGATE LLC"), {
    businessNames: "YAM WESTGATE LLC",
    searched: "YAM WESTGATE LLC",
    ownerNote: null,
  });
  assert.equal(recorderNameQuery("GARCIA MELISSA").lastNames, "GARCIA");
  assert.equal(recorderNameQuery("GARCIA MELISSA").firstNames, "MELISSA");
  const shared = recorderNameQuery("ACME HOLDINGS LLC & SMITH JOHN");
  assert.equal(shared.businessNames, "ACME HOLDINGS LLC");
  assert.match(shared.ownerNote, /first business/u);
  assert.equal(recorderNameQuery(""), null);
});

test("document roles keep a deed of trust when another code is present", () => {
  assert.equal(debtRole("DEED TRST+").role, "deed-of-trust");
  assert.equal(debtRole("DEED TRST, FIN STATE").role, "deed-of-trust");
  assert.equal(debtRole("REL D/T").role, "release");
  assert.equal(debtRole("FIN STATE"), null);
  assert.deepEqual(possibleLenders(["YAM WESTGATE LLC", "JPMORGAN CHASE BANK"], "YAM WESTGATE LLC"), [
    "JPMORGAN CHASE BANK",
  ]);
  assert.deepEqual(possibleLenders(["NEW WESTGATE LLC", "YAM WESTGATE LLC"], "YAM WESTGATE LLC"), []);
});

test("Maricopa debt uses the public index and leaves amount and maturity empty", async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    const href = String(url);
    urls.push(href);
    if (href.endsWith("/documents/index")) return jsonResponse("10/14/2026");
    if (href.includes("/documents/search")) {
      const code = new URL(href).searchParams.get("documentCode");
      if (code !== "DT") return jsonResponse({ searchResults: [], totalResults: 0 });
      return jsonResponse({
        searchResults: [
          {
            names: "YAM WESTGATE LLC",
            recordingNumber: 20230145860,
            recordingSuffix: "",
            recordingDate: "3-23-2023",
            documentCode: "DEED TRST",
          },
        ],
        totalResults: 1,
      });
    }
    return jsonResponse({
      names: ["DV ICE CREAM WESTGATE LLC", "FOOTHILLS BANK", "YAM WESTGATE LLC"],
      documentCodes: ["DEED TRST"],
      recordingDate: "3-23-2023",
      recordingNumber: "20230145860",
      pageAmount: 13,
    });
  };
  const lookup = createMaricopaDebtLookup({
    fetchImpl,
    cache: createCache(),
    now: () => new Date("2026-10-19T00:00:00Z"),
  });
  const debt = await lookup(commercial);
  assert.equal(debt.status, "indexed");
  assert.equal(debt.match.confidence, "name-only");
  assert.equal(debt.documents.length, 1);
  const document = debt.documents[0];
  assert.equal(document.role, "deed-of-trust");
  assert.equal(document.recordedAt, "2023-03-23");
  assert.equal(document.documentNumber, "20230145860");
  assert.equal(document.loanAmount, null);
  assert.equal(document.maturityDate, null);
  assert.deepEqual(document.possibleLenders, ["FOOTHILLS BANK"]);
  assert.match(document.documentUrl, /GetRecDataDetail\.aspx\?rec=20230145860&suf=$/u);
  assert.match(debt.limitations.join(" "), /Loan amount and maturity/u);
  const search = urls.find((href) => href.includes("documentCode=DT"));
  assert.match(search, /businessNames=YAM\+WESTGATE\+LLC/u);
  assert.match(search, /beginDate=2011-10-14/u);
  assert.match(search, /endDate=2026-10-14/u);
  assert.equal(urls.filter((href) => href.includes("/documents/20230145860")).length, 1);
  await lookup(commercial);
  assert.equal(urls.filter((href) => href.includes("/documents/20230145860")).length, 1);
});

test("a capped Maricopa result is marked incomplete", async () => {
  const lookup = createMaricopaDebtLookup({
    cache: createCache(),
    fetchImpl: async (url) => {
      const href = String(url);
      if (href.endsWith("/documents/index")) return jsonResponse("10/14/2026");
      if (href.includes("/documents/search")) {
        return jsonResponse({
          searchResults: [
            {
              names: "YAM WESTGATE LLC",
              recordingNumber: 20230145860,
              recordingDate: "3-23-2023",
              documentCode: "DEED TRST",
            },
          ],
          totalResults: 501,
        });
      }
      return jsonResponse({
        names: ["YAM WESTGATE LLC"],
        documentCodes: ["DEED TRST"],
        recordingDate: "3-23-2023",
        recordingNumber: "20230145860",
        pageAmount: 1,
      });
    },
  });
  const debt = await lookup(commercial);
  assert.equal(debt.truncated, true);
  assert.equal(debt.documents[0].loanAmount, null);
});

test("Maricopa recorder failure becomes a manual search link", async () => {
  const source = {
    id: "maricopa",
    label: "Maricopa",
    kind: "public",
    description: "test",
    propertyTypes: ["Commercial"],
    async search() {
      return [];
    },
    async getProperty() {
      return commercial;
    },
    async findCandidates() {
      return { records: [], truncated: false, limit: 1, notes: [] };
    },
  };
  const service = createPropertyService([source], {
    debtLookups: {
      maricopa: async () => {
        throw new Error("Maricopa recorder returned HTTP 503.");
      },
    },
  });
  const { property } = await service.getProperty("maricopa", commercial.id);
  assert.equal(property.debt.status, "manual");
  assert.equal(property.debt.documents.length, 0);
  assert.match(property.debt.limitations[0], /503/u);
  assert.ok(property.debt.links.some((link) => link.href.includes("recorder.maricopa.gov/recdocdata")));
});

test("residential records do not call the recorder", async () => {
  let calls = 0;
  const source = {
    id: "maricopa",
    label: "Maricopa",
    kind: "public",
    description: "test",
    propertyTypes: ["Residential"],
    async search() {
      return [];
    },
    async getProperty() {
      return { ...commercial, propertyType: "Residential" };
    },
    async findCandidates() {
      return { records: [], truncated: false, limit: 1, notes: [] };
    },
  };
  const service = createPropertyService([source], {
    debtLookups: {
      maricopa: async () => {
        calls += 1;
        throw new Error("should not run");
      },
    },
  });
  const { property } = await service.getProperty("maricopa", commercial.id);
  assert.equal(property.debt, null);
  assert.equal(calls, 0);
});

test("Pinal debt is a manual recorder link and does not fetch", async () => {
  let calls = 0;
  const lookup = createPinalDebtLookup();
  const debt = await lookup({
    owner: "901 NORTH TWEEDY LLC",
    parcelId: "40802008K",
    propertyType: "Commercial",
  });
  assert.equal(calls, 0);
  assert.equal(debt.status, "manual");
  assert.equal(debt.documents.length, 0);
  assert.match(debt.limitations.join(" "), /403/u);
  assert.match(debt.limitations.join(" "), /Loan amount and maturity/u);
  assert.ok(debt.links.some((link) => link.href.includes("SearchTypeName")));
  assert.ok(debt.links.some((link) => link.href.includes("SearchTypeDocLegal")));
  assert.ok(debt.links.every((link) => !link.href.includes("901%20NORTH") && !link.href.includes("40802008K")));
});

test("sample commercial debt is labeled fictional and keeps loan terms", async () => {
  const source = createSampleSource();
  const property = await source.getProperty("sample:commercial-50");
  assert.equal(property.propertyType, "Commercial");
  assert.equal(property.debt.status, "sample");
  assert.equal(property.debt.documents[0].loanAmount, 640000);
  assert.equal(property.debt.documents[0].maturityDate, "2034-06-01");
  assert.equal(property.debt.documents[0].possibleLenders[0], "Sample County Bank");
  assert.match(property.debt.limitations[0], /SAMPLE DATA/u);
  const house = await source.getProperty("sample:maple-100");
  assert.equal(house.debt, undefined);
  const service = createPropertyService([source], { debtLookups: {} });
  const loaded = await service.getProperty("sample", "sample:maple-100");
  assert.equal(loaded.property.debt, null);
  const shop = await service.getProperty("sample", "sample:commercial-50");
  assert.equal(shop.property.debt.documents.length, 3);
  await assert.rejects(
    () => service.search("sample", "shop", "Not A Type"),
    /property type/u,
  );
});
