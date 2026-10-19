/**
 * County and sample sources share this shape. Comp rules (circle, type,
 * size, sale date, and statistics) live in src/domain/comps.js. A source
 * may prefilter with a bounding box, and that box must contain the circle.
 *
 * search(text, { propertyType }) -> PropertyRecord[]
 * getProperty(id) -> PropertyRecord | null
 * findCandidates({ box, soldAfter, soldBefore, limit }) ->
 *   { records, truncated, limit, notes }
 *
 * PropertyRecord fields:
 * id, sourceId, kind ("public" | "sample"), parcelId, address, owner,
 * propertyType, propertyTypeDetail, buildingSqft, yearBuilt, assessedValue,
 * assessmentNote, latitude, longitude, sales[{date, price}], provenance.
 * Commercial records may include debt: recorded instruments, or a manual
 * recorder link when the county index cannot be queried.
 */

export const describeSource = (source) => ({
  id: source.id,
  label: source.label,
  kind: source.kind,
  description: source.description,
  propertyTypes: source.propertyTypes,
});
