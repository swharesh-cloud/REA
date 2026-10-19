import {
  PROPERTY_TYPES,
  classifyPropertyType,
  matchesPropertyType,
  parseAmount,
  parseCoordinate,
  parseNumber,
  parseRecordDate,
  propertyId,
} from "../domain/property.js";
import {
  addressOrOwnerWhere,
  arcgisNumber,
  arcgisQuery,
  arcgisString,
} from "./arcgis.js";
import { createCache } from "./http.js";

// The Parcels MapServer answers the same query in several seconds. This
// dynamic layer returns the same fields quickly enough for a serverless limit.
const QUERY =
  "https://gis.mcassessor.maricopa.gov/arcgis/rest/services/MaricopaDynamicQueryService/MapServer/3/query";
const SERVICE =
  "https://gis.mcassessor.maricopa.gov/arcgis/rest/services/MaricopaDynamicQueryService/MapServer/3";
const PORTAL = "https://mcassessor.maricopa.gov/";

const FIELDS = [
  "APN",
  "APN_DASH",
  "OWNER_NAME",
  "PHYSICAL_ADDRESS",
  "PUC",
  "LIVING_SPACE",
  "CONST_YEAR",
  "FCV_CUR",
  "SALE_DATE",
  "SALE_PRICE",
  "LATITUDE",
  "LONGITUDE",
].join(",");

const PUC_LABEL = {
  "00": "Vacant land",
  "01": "Single family residential",
  "02": "Common area",
  "03": "Multiple residential",
  "04": "Hotel",
  "05": "Motel",
  "06": "Resort",
  "07": "Condominium or townhouse",
  "08": "Manufactured home residential",
  "09": "Salvage improvements",
};

const NOTES =
  "The public parcel layer includes the latest recorded sale, not a multi-year deed history. FCV_CUR is the current full cash value used for assessment, not the sale price.";

const PUC_FAMILIES = {
  Commercial: [
    "04", "05", "06", "10", "11", "12", "13", "14", "15", "16", "17", "18",
    "19", "20", "21", "22", "23", "24", "25", "26", "27", "28", "29",
  ],
  Residential: ["01", "03", "07", "08"],
  Industrial: ["30", "31", "32", "33", "34", "35", "36", "37", "38", "39"],
  Vacant: ["00"],
};

/** Assessor use-code constraint. Null means the county query cannot express that type. */
export const maricopaTypeWhere = (propertyType) => {
  const families = PUC_FAMILIES[propertyType];
  if (!families) return null;
  return families.map((family) => `PUC LIKE '${family}%'`).join(" OR ");
};

/** Coarse label for an Arizona Department of Revenue property-use family. */
export const maricopaUseDetail = (code) => {
  const digits = String(code ?? "").trim();
  if (!/^\d{3,4}$/u.test(digits)) return digits.length > 0 ? `PUC ${digits}` : null;
  const family = digits.padStart(4, "0").slice(0, 2);
  const numbered = Number(family);
  let label = PUC_LABEL[family];
  if (!label && numbered >= 30 && numbered <= 39) label = "Industrial";
  if (!label && numbered >= 10 && numbered <= 29) label = "Commercial";
  if (!label) label = "Property use";
  return `${label} (PUC ${digits})`;
};

const collapse = (value) => String(value ?? "").replace(/\s+/gu, " ").trim();

const saleOf = (row) => {
  const date = parseRecordDate(row.SALE_DATE);
  const parsed = parseNumber(row.SALE_PRICE);
  if (!date && (parsed == null || parsed <= 0)) return [];
  return [{ date, price: parsed == null ? 0 : Math.round(parsed) }];
};

export const mapMaricopaFeature = (feature, retrievedAt) => {
  const row = feature?.attributes ?? {};
  const parcelId = collapse(row.APN_DASH) || collapse(row.APN);
  if (!parcelId) return null;
  const classified = classifyPropertyType(maricopaUseDetail(row.PUC));
  return {
    id: propertyId("maricopa", parcelId),
    sourceId: "maricopa",
    kind: "public",
    parcelId,
    address: collapse(row.PHYSICAL_ADDRESS) || parcelId,
    owner: collapse(row.OWNER_NAME) || null,
    propertyType: classified.propertyType,
    propertyTypeDetail: classified.propertyTypeDetail,
    buildingSqft: parseAmount(row.LIVING_SPACE),
    yearBuilt: parseAmount(row.CONST_YEAR),
    assessedValue: parseAmount(row.FCV_CUR),
    assessmentNote:
      "Maricopa County current full cash value (FCV_CUR) from the public parcel layer.",
    latitude: parseCoordinate(row.LATITUDE, 90),
    longitude: parseCoordinate(row.LONGITUDE, 180),
    sales: saleOf(row),
    provenance: {
      retrievedAt,
      kind: "public-open-data",
      publisher: "Maricopa County Assessor",
      datasets: [{ name: "Assessor parcels", href: SERVICE }, { name: "Assessor", href: PORTAL }],
      notes: NOTES,
    },
  };
};

const parcelClause = (text) => {
  const trimmed = text.trim().toUpperCase();
  if (!/^[0-9A-Z-]{5,20}$/u.test(trimmed) || !/\d/u.test(trimmed)) return null;
  const compact = trimmed.replaceAll("-", "");
  return `(APN = ${arcgisString(compact)} OR APN_DASH = ${arcgisString(trimmed)})`;
};

export const maricopaSearchWhere = (text) =>
  addressOrOwnerWhere(text, {
    addressColumn: "PHYSICAL_ADDRESS",
    ownerColumn: "OWNER_NAME",
    parcelClause: parcelClause(text),
  });

export const maricopaCandidateWhere = (box) =>
  [
    `LATITUDE >= ${arcgisNumber(box.minLat)}`,
    `LATITUDE <= ${arcgisNumber(box.maxLat)}`,
    `LONGITUDE >= ${arcgisNumber(box.minLng)}`,
    `LONGITUDE <= ${arcgisNumber(box.maxLng)}`,
    "CAST(SALE_PRICE AS FLOAT) > 0",
  ].join(" AND ");

const limitOf = (value) => Math.max(1, Math.min(1000, Math.trunc(value)));

export const createMaricopaSource = ({
  fetchImpl = globalThis.fetch,
  cache = createCache(),
} = {}) => {
  const query = (params) =>
    arcgisQuery(QUERY, params, { fetchImpl, cache });

  const mapFeatures = (features) => {
    const retrievedAt = new Date().toISOString();
    return features
      .map((feature) => mapMaricopaFeature(feature, retrievedAt))
      .filter((record) => record != null);
  };

  return {
    id: "maricopa",
    label: "Maricopa County",
    kind: "public",
    description:
      "Maricopa County Assessor public parcel layer. Includes owner, use code, living area, year built, full cash value, and the latest sale. Commercial records also check the recorder's public document index for deeds of trust and related filings.",
    propertyTypes: PROPERTY_TYPES,
    async search(text, filters = {}) {
      const where = maricopaSearchWhere(text);
      if (!where) return [];
      const typeWhere = maricopaTypeWhere(filters.propertyType);
      const result = await query({
        where: typeWhere ? `(${where}) AND (${typeWhere})` : where,
        outFields: FIELDS,
        returnGeometry: "false",
        resultRecordCount: "15",
      });
      const records = mapFeatures(result.features);
      if (!filters.propertyType) return records;
      return records.filter((record) => matchesPropertyType(record, filters.propertyType));
    },
    async getProperty(id) {
      const local = id.startsWith("maricopa:") ? id.slice("maricopa:".length) : "";
      const where = parcelClause(local);
      if (!where) return null;
      const result = await query({
        where,
        outFields: FIELDS,
        returnGeometry: "false",
        resultRecordCount: "5",
      });
      return mapFeatures(result.features)[0] ?? null;
    },
    async findCandidates(queryOptions) {
      const limit = limitOf(queryOptions.limit);
      const run = (where) =>
        query({
          where,
          outFields: FIELDS,
          returnGeometry: "false",
          resultRecordCount: String(limit),
        });
      let result;
      try {
        result = await run(maricopaCandidateWhere(queryOptions.box));
      } catch (error) {
        if (error?.code !== "upstream") throw error;
        const box = queryOptions.box;
        result = await run(
          [
            `LATITUDE >= ${arcgisNumber(box.minLat)}`,
            `LATITUDE <= ${arcgisNumber(box.maxLat)}`,
            `LONGITUDE >= ${arcgisNumber(box.minLng)}`,
            `LONGITUDE <= ${arcgisNumber(box.maxLng)}`,
            "SALE_PRICE IS NOT NULL",
          ].join(" AND "),
        );
      }
      const records = mapFeatures(result.features);
      return {
        records,
        truncated: result.exceeded || records.length >= limit,
        limit,
        notes: [],
      };
    },
  };
};
