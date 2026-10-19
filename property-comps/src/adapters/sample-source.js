import { SAMPLE_DATASET } from "../../data/sample-county.js";
import { PROPERTY_TYPES, classifyPropertyType, normalizeParcel, propertyId, searchTokens } from "../domain/property.js";

const toRecord = (row) => {
  const classified = classifyPropertyType(row.propertyTypeDetail);
  return {
    id: propertyId("sample", row.localId),
    sourceId: "sample",
    kind: "sample",
    parcelId: row.parcelId,
    address: row.address,
    owner: row.owner,
    propertyType: classified.propertyType,
    propertyTypeDetail: classified.propertyTypeDetail,
    buildingSqft: row.buildingSqft,
    yearBuilt: row.yearBuilt,
    assessedValue: row.assessedValue,
    assessmentNote: "Fictional assessed value in the sample dataset.",
    latitude: row.latitude,
    longitude: row.longitude,
    sales: [...row.sales].sort((left, right) =>
      left.date < right.date ? 1 : left.date > right.date ? -1 : 0,
    ),
    provenance: {
      retrievedAt: null,
      kind: "sample",
      publisher: "property-comps sample dataset",
      datasets: [],
      notes: SAMPLE_DATASET.notice,
    },
  };
};

const RECORDS = SAMPLE_DATASET.properties.map(toRecord);

const haystack = (record) =>
  `${record.address} ${record.owner ?? ""} ${record.parcelId}`.toUpperCase();

const matches = (record, text) => {
  const parcel = normalizeParcel(text);
  if (parcel.length >= 3 && parcel === normalizeParcel(record.parcelId))
    return true;
  const tokens = searchTokens(text);
  if (tokens.length === 0) return false;
  const fields = haystack(record);
  return tokens.every((token) => fields.includes(token));
};

const inBox = (record, box) =>
  record.latitude != null &&
  record.longitude != null &&
  record.latitude >= box.minLat &&
  record.latitude <= box.maxLat &&
  record.longitude >= box.minLng &&
  record.longitude <= box.maxLng;

export const createSampleSource = () => ({
  id: "sample",
  label: SAMPLE_DATASET.label,
  kind: "sample",
  description:
    "Fictional Sample County, Arizona records for offline demonstration. Not a county assessor source.",
  propertyTypes: PROPERTY_TYPES,
  async search(text) {
    return RECORDS.filter((record) => matches(record, text)).slice(0, 15);
  },
  async getProperty(id) {
    return RECORDS.find((record) => record.id === id) ?? null;
  },
  async findCandidates(query) {
    const matched = RECORDS.filter((record) => inBox(record, query.box));
    const limit = query.limit;
    return {
      records: matched.slice(0, limit),
      truncated: matched.length > limit,
      limit,
      notes: [SAMPLE_DATASET.notice],
    };
  },
});
