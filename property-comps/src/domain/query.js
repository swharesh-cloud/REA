import { PROPERTY_TYPES } from "./property.js";

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/u;

const fail = (message) => ({ ok: false, message });
const ok = (value) => ({ ok: true, value });

const textParam = (value, max) => {
  if (value == null) return "";
  return String(value).trim().slice(0, max);
};

const validDate = (value) => {
  const match = DATE.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
};

const optionalDate = (value, label) => {
  const text = textParam(value, 10);
  if (text.length === 0) return ok(null);
  if (!validDate(text)) return fail(`${label} must be a real YYYY-MM-DD date.`);
  return ok(text);
};

const optionalSqft = (value, label) => {
  const text = textParam(value, 12);
  if (text.length === 0) return ok(null);
  if (!/^\d+$/u.test(text)) return fail(`${label} must be a whole number of square feet.`);
  const parsed = Number(text);
  if (parsed < 1 || parsed > 2_000_000)
    return fail(`${label} must be between 1 and 2,000,000.`);
  return ok(parsed);
};

export const parsePropertyTypeFilter = (value) => {
  const text = textParam(value, 40);
  if (text.length === 0) return ok(null);
  const match = PROPERTY_TYPES.find((type) => type.toUpperCase() === text.toUpperCase());
  if (!match || match === "Unknown") return fail("Choose a property type from the list.");
  return ok(match);
};

export const parseSearchQuery = (value) => {
  const text = textParam(value, 120);
  if (text.length < 2)
    return fail("Enter at least 2 characters of an address or parcel id.");
  return ok(text);
};

export const parseCompRequest = (params) => {
  const subjectId = textParam(params.subjectId, 80);
  if (subjectId.length === 0)
    return fail("Choose a property before searching for comps.");
  const radiusText =
    params.radiusMiles == null || params.radiusMiles === ""
      ? "0.5"
      : String(params.radiusMiles).trim();
  const radiusMiles = Number(radiusText);
  if (!Number.isFinite(radiusMiles) || radiusMiles < 0.1 || radiusMiles > 5)
    return fail("Radius must be between 0.1 and 5 miles.");
  const minSqft = optionalSqft(params.minSqft, "Minimum size");
  if (!minSqft.ok) return minSqft;
  const maxSqft = optionalSqft(params.maxSqft, "Maximum size");
  if (!maxSqft.ok) return maxSqft;
  if (
    minSqft.value != null &&
    maxSqft.value != null &&
    minSqft.value > maxSqft.value
  )
    return fail("Minimum size cannot exceed maximum size.");
  const soldAfter = optionalDate(params.soldAfter, "Sale start");
  if (!soldAfter.ok) return soldAfter;
  const soldBefore = optionalDate(params.soldBefore, "Sale end");
  if (!soldBefore.ok) return soldBefore;
  if (
    soldAfter.value &&
    soldBefore.value &&
    soldAfter.value > soldBefore.value
  )
    return fail("Sale start date cannot be after the end date.");
  const propertyType = textParam(params.propertyType, 80);
  return ok({
    subjectId,
    radiusMiles,
    minSqft: minSqft.value,
    maxSqft: maxSqft.value,
    soldAfter: soldAfter.value,
    soldBefore: soldBefore.value,
    propertyType: propertyType.length === 0 ? null : propertyType,
  });
};

/** Bound open-ended sale queries so a radius search cannot scan a decade. */
export const applySaleWindow = (query, now) => {
  if (query.soldAfter || query.soldBefore)
    return { ...query, windowDefaulted: false };
  const from = new Date(
    Date.UTC(now.getUTCFullYear() - 3, now.getUTCMonth(), now.getUTCDate()),
  );
  return {
    ...query,
    soldAfter: from.toISOString().slice(0, 10),
    windowDefaulted: true,
  };
};
