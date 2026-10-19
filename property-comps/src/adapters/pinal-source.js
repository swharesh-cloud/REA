import {
  PROPERTY_TYPES,
  classifyPropertyType,
  nextIsoDate,
  parseAmount,
  parseCoordinate,
  parseNumber,
  parseRecordDate,
  propertyId,
} from "../domain/property.js";
import {
  addressOrOwnerWhere,
  arcgisQuery,
  arcgisString,
} from "./arcgis.js";
import { appError, createCache } from "./http.js";

const QUERY =
  "https://rogue.casagrandeaz.gov/arcgis/rest/services/Pinal_County/Pinal_County_Parcels/FeatureServer/0/query";
const SERVICE =
  "https://rogue.casagrandeaz.gov/arcgis/rest/services/Pinal_County/Pinal_County_Parcels/FeatureServer/0";

const FIELDS = [
  "Parcel_Identification_Number",
  "Site_Address",
  "First_Owner_Name",
  "Second_Owner_Name",
  "Assessing_Use_Description",
  "Property_Class",
  "Residential_Floor_Area",
  "Building_Area",
  "Residential_Year_Built",
  "Current_Assessed_Value",
  "Sale_Date",
  "Sale_Price",
].join(",");

const NOTES =
  "Pinal County Assessor parcel layer, updated nightly and published without a key. Each parcel includes the latest sale, not a deed history. Current assessed value is the assessor's figure, not the sale price.";

const collapse = (value) => String(value ?? "").replace(/\s+/gu, " ").trim();

const saleOf = (row) => {
  const date = parseRecordDate(row.Sale_Date);
  const parsed = parseNumber(row.Sale_Price);
  if (!date && (parsed == null || parsed <= 0)) return [];
  return [{ date, price: parsed == null ? 0 : Math.round(parsed) }];
};

const ownersOf = (row) => {
  const names = [row.First_Owner_Name, row.Second_Owner_Name]
    .map(collapse)
    .filter((name) => name.length > 0);
  return names.length === 0 ? null : names.join("; ");
};

export const mapPinalFeature = (feature, retrievedAt) => {
  const row = feature?.attributes ?? {};
  const parcelId = collapse(row.Parcel_Identification_Number);
  if (!parcelId) return null;
  const detail = collapse(row.Assessing_Use_Description) || collapse(row.Property_Class);
  const classified = classifyPropertyType(detail || null);
  const centroid = feature?.centroid ?? {};
  return {
    id: propertyId("pinal", parcelId),
    sourceId: "pinal",
    kind: "public",
    parcelId,
    address: collapse(row.Site_Address) || parcelId,
    owner: ownersOf(row),
    propertyType: classified.propertyType,
    propertyTypeDetail: classified.propertyTypeDetail,
    buildingSqft: parseAmount(row.Residential_Floor_Area) ?? parseAmount(row.Building_Area),
    yearBuilt: parseAmount(row.Residential_Year_Built),
    assessedValue: parseAmount(row.Current_Assessed_Value),
    assessmentNote:
      "Pinal County current assessed value from the public parcel layer.",
    latitude: parseCoordinate(centroid.y, 90),
    longitude: parseCoordinate(centroid.x, 180),
    sales: saleOf(row),
    provenance: {
      retrievedAt,
      kind: "public-open-data",
      publisher: "Pinal County Assessor",
      datasets: [
        {
          name: "Pinal County parcels",
          href: SERVICE,
        },
      ],
      notes: NOTES,
    },
  };
};

const parcelClause = (text) => {
  const trimmed = text.trim().toUpperCase();
  if (!/^[0-9A-Z-]{5,20}$/u.test(trimmed) || !/\d/u.test(trimmed)) return null;
  const compact = trimmed.replaceAll("-", "");
  if (compact === trimmed)
    return `Parcel_Identification_Number = ${arcgisString(trimmed)}`;
  return `(Parcel_Identification_Number = ${arcgisString(trimmed)} OR Parcel_Identification_Number = ${arcgisString(compact)})`;
};

export const pinalSearchWhere = (text) =>
  addressOrOwnerWhere(text, {
    addressColumn: "Site_Address",
    ownerColumn: "First_Owner_Name",
    parcelClause: parcelClause(text),
  });

const isoLiteral = (iso) => {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(iso))
    throw appError("bad_request", "Invalid sale date.");
  return `'${iso}'`;
};

export const pinalCandidateWhere = (query) => {
  const clauses = ["Sale_Price > 0"];
  if (query.soldAfter) clauses.push(`Sale_Date >= ${isoLiteral(query.soldAfter)}`);
  if (query.soldBefore)
    clauses.push(`Sale_Date < ${isoLiteral(nextIsoDate(query.soldBefore))}`);
  return clauses.join(" AND ");
};

const envelope = (box) =>
  `${box.minLng.toFixed(6)},${box.minLat.toFixed(6)},${box.maxLng.toFixed(6)},${box.maxLat.toFixed(6)}`;

const limitOf = (value) => Math.max(1, Math.min(1000, Math.trunc(value)));

export const createPinalSource = ({
  fetchImpl = globalThis.fetch,
  cache = createCache(),
} = {}) => {
  const query = (params) => arcgisQuery(QUERY, params, { fetchImpl, cache });
  const mapFeatures = (features) => {
    const retrievedAt = new Date().toISOString();
    return features
      .map((feature) => mapPinalFeature(feature, retrievedAt))
      .filter((record) => record != null);
  };

  return {
    id: "pinal",
    label: "Pinal County",
    kind: "public",
    description:
      "Pinal County Assessor parcels published on a public ArcGIS service. Includes owner, use, floor area, year built, assessed value, and the latest sale.",
    propertyTypes: PROPERTY_TYPES,
    async search(text) {
      const where = pinalSearchWhere(text);
      if (!where) return [];
      const result = await query({
        where,
        outFields: FIELDS,
        returnGeometry: "false",
        returnCentroid: "true",
        outSR: "4326",
        resultRecordCount: "15",
      });
      return mapFeatures(result.features);
    },
    async getProperty(id) {
      const local = id.startsWith("pinal:") ? id.slice("pinal:".length) : "";
      const where = parcelClause(local);
      if (!where) return null;
      const result = await query({
        where,
        outFields: FIELDS,
        returnGeometry: "false",
        returnCentroid: "true",
        outSR: "4326",
        resultRecordCount: "5",
      });
      return mapFeatures(result.features)[0] ?? null;
    },
    async findCandidates(queryOptions) {
      const limit = limitOf(queryOptions.limit);
      const result = await query({
        where: pinalCandidateWhere(queryOptions),
        geometry: envelope(queryOptions.box),
        geometryType: "esriGeometryEnvelope",
        inSR: "4326",
        spatialRel: "esriSpatialRelIntersects",
        outFields: FIELDS,
        returnGeometry: "false",
        returnCentroid: "true",
        outSR: "4326",
        resultRecordCount: String(limit),
        orderByFields: "Sale_Date DESC",
      });
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
