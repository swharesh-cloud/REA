const STREET_WORDS =
  /^(STREET|ST|AVENUE|AVE|ROAD|RD|BOULEVARD|BLVD|PLACE|PL|DRIVE|DR|LANE|LN|COURT|CT|TERRACE|TER|WAY)$/u;

export const PROPERTY_TYPES = [
  "Residential",
  "Commercial",
  "Industrial",
  "Mixed",
  "Vacant",
  "Other",
  "Unknown",
];

export const parseNumber = (value) => {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value == null) return null;
  const text = String(value).replaceAll(",", "").trim();
  if (text.length === 0) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
};

/** Positive dollar or size amounts. Zero means unknown or non-market. */
export const parseAmount = (value) => {
  const parsed = parseNumber(value);
  if (parsed == null || parsed <= 0) return null;
  return Math.round(parsed);
};

export const parseCoordinate = (value, max) => {
  const parsed = parseNumber(value);
  if (parsed == null || Math.abs(parsed) < 0.01 || Math.abs(parsed) > max)
    return null;
  return parsed;
};

export const isoDate = (value) => {
  if (value == null || value === "") return null;
  const match = /^(\d{4}-\d{2}-\d{2})/u.exec(String(value));
  return match ? match[1] : null;
};

const calendarDate = (yearText, monthText, dayText) => {
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  if (!Number.isInteger(year) || month < 1 || month > 12 || day < 1 || day > 31)
    return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  )
    return null;
  return `${yearText}-${monthText}-${dayText}`;
};

/** ISO date, US month/day/year, or ArcGIS epoch milliseconds. */
export const parseRecordDate = (value) => {
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    return date.toISOString().slice(0, 10);
  }
  if (value == null) return null;
  const text = String(value).trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})/u.exec(text);
  if (iso) return calendarDate(iso[1], iso[2], iso[3]);
  const us = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/u.exec(text);
  if (!us) return null;
  return calendarDate(us[3], us[1].padStart(2, "0"), us[2].padStart(2, "0"));
};

export const nextIsoDate = (iso) => {
  const [year, month, day] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
};

const includesAny = (text, needles) =>
  needles.some((needle) => text.includes(needle));

export const classifyPropertyType = (detail) => {
  const raw = detail == null ? "" : String(detail).trim();
  const text = raw.toUpperCase();
  if (text.length === 0)
    return { propertyType: "Unknown", propertyTypeDetail: null };
  let propertyType = "Other";
  if (text.includes("VACANT")) propertyType = "Vacant";
  else if (
    includesAny(text, ["INDUSTRIAL", "WAREHOUSE", "FACTORY", "MANUFACTURING"])
  )
    propertyType = "Industrial";
  else if (text.includes("MIXED")) propertyType = "Mixed";
  else if (
    includesAny(text, ["GARAGE", "PARKING", "STORAGE", "UTILITY", "TRANSPORT"])
  )
    propertyType = "Other";
  else if (
    includesAny(text, [
      "COMMERCIAL",
      "OFFICE",
      "RETAIL",
      "STORE",
      "HOTEL",
      "MOTEL",
      "RESORT",
    ])
  )
    propertyType = "Commercial";
  else if (
    includesAny(text, [
      "FAMILY",
      "RESIDENTIAL",
      "APARTMENT",
      "DWELLING",
      "CONDO",
      "WALKUP",
      "RENTAL",
      "SINGLE",
      "MULTI",
    ])
  )
    propertyType = "Residential";
  return { propertyType, propertyTypeDetail: raw };
};

export const matchesPropertyType = (property, filter) => {
  if (filter == null) return true;
  const wanted = String(filter).trim().toUpperCase();
  if (wanted.length === 0) return true;
  if (property.propertyType.toUpperCase() === wanted) return true;
  return (property.propertyTypeDetail ?? "").toUpperCase().includes(wanted);
};

export const propertyId = (sourceId, localId) => `${sourceId}:${localId}`;

export const localId = (sourceId, id) => {
  const prefix = `${sourceId}:`;
  if (typeof id !== "string" || !id.startsWith(prefix)) return null;
  const value = id.slice(prefix.length);
  return value.length > 0 ? value : null;
};

export const searchTokens = (input) => {
  const stripped = String(input)
    .toUpperCase()
    .replace(/(\d+)(ST|ND|RD|TH)\b/gu, "$1");
  return stripped
    .split(/[^A-Z0-9]+/u)
    .filter((part) => part.length > 0 && !STREET_WORDS.test(part))
    .slice(0, 6);
};

export const normalizeParcel = (value) =>
  String(value)
    .toUpperCase()
    .replace(/[^A-Z0-9]/gu, "");
