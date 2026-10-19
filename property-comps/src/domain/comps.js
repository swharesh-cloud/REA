import { distanceMiles } from "./geo.js";
import { matchesPropertyType } from "./property.js";

const compareText = (left, right) => {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
};

export const median = (values) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
};

const matchesSize = (property, query) => {
  if (query.minSqft == null && query.maxSqft == null) return true;
  if (property.buildingSqft == null) return false;
  if (query.minSqft != null && property.buildingSqft < query.minSqft)
    return false;
  if (query.maxSqft != null && property.buildingSqft > query.maxSqft)
    return false;
  return true;
};

const matchesDate = (date, query) => {
  if (!date) return false;
  if (query.soldAfter && date < query.soldAfter) return false;
  if (query.soldBefore && date > query.soldBefore) return false;
  return true;
};

/**
 * Comparable sales are the authority for radius, type, size, and date.
 * Adapters may prefilter with a bounding box, which must be a superset.
 */
export const selectComps = (candidates, query) => {
  const comps = [];
  for (const property of candidates) {
    if (property.id === query.subjectId) continue;
    if (property.latitude == null || property.longitude == null) continue;
    const distance = distanceMiles(
      query.latitude,
      query.longitude,
      property.latitude,
      property.longitude,
    );
    if (distance > query.radiusMiles + 1e-6) continue;
    if (!matchesPropertyType(property, query.propertyType)) continue;
    if (!matchesSize(property, query)) continue;
    for (const sale of property.sales) {
      if (!(sale.price > 0)) continue;
      if (!matchesDate(sale.date, query)) continue;
      comps.push({
        property,
        sale,
        distanceMiles: distance,
        pricePerSqft:
          property.buildingSqft == null
            ? null
            : sale.price / property.buildingSqft,
      });
    }
  }
  comps.sort(
    (left, right) =>
      left.distanceMiles - right.distanceMiles ||
      right.sale.price - left.sale.price ||
      compareText(left.property.address, right.property.address),
  );
  return { comps, stats: summarizeComps(comps) };
};

export const summarizeComps = (comps) => {
  const prices = comps.map((comp) => comp.sale.price);
  const perFoot = comps
    .map((comp) => comp.pricePerSqft)
    .filter((value) => value != null && Number.isFinite(value));
  return {
    count: comps.length,
    medianPricePerSqft: median(perFoot),
    minPrice: prices.length === 0 ? null : Math.min(...prices),
    maxPrice: prices.length === 0 ? null : Math.max(...prices),
  };
};
