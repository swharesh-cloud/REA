import { createDebtLookups } from "../adapters/debt-lookups.js";
import { maricopaRecorderLinks } from "../adapters/maricopa-recorder.js";
import { pinalDebtReport } from "../adapters/pinal-recorder.js";
import { describeSource } from "../adapters/source.js";
import { selectComps } from "../domain/comps.js";
import { compsToCsv } from "../domain/csv.js";
import { emptyDebt } from "../domain/debt.js";
import { boundingBox } from "../domain/geo.js";
import { applySaleWindow, parseCompRequest, parsePropertyTypeFilter, parseSearchQuery } from "../domain/query.js";
import { appError } from "../adapters/http.js";

const roundTo = (value, digits) => {
  if (value == null || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
};

const presentComp = (row) => ({
  property: { ...row.property, sales: [row.sale] },
  sale: row.sale,
  distanceMiles: roundTo(row.distanceMiles, 3),
  pricePerSqft: roundTo(row.pricePerSqft, 2),
});

const presentStats = (stats) => ({
  count: stats.count,
  medianPricePerSqft: roundTo(stats.medianPricePerSqft, 2),
  minPrice: stats.minPrice,
  maxPrice: stats.maxPrice,
});

const manualDebt = (property, error) => {
  if (property.sourceId === "pinal") return pinalDebtReport(property);
  return emptyDebt({
    status: "manual",
    match: {
      method: "none",
      confidence: "unmatched",
      label: "The recorder index could not be read, so no document was matched.",
    },
    limitations: [
      error?.message || "The recorder request failed.",
      "Open the official recorder search and enter the owner name. Loan amount and maturity are not filled in from a failed lookup.",
    ],
    links: property.sourceId === "maricopa" ? maricopaRecorderLinks(property) : [],
  });
};

export const createPropertyService = (
  sources,
  { now = () => new Date(), debtLookups = createDebtLookups({ now }) } = {},
) => {
  const byId = new Map(sources.map((source) => [source.id, source]));
  const attachDebt = async (property) => {
    if (property.propertyType !== "Commercial") return { ...property, debt: null };
    if (property.debt) return property;
    const lookup = debtLookups[property.sourceId];
    if (!lookup) return { ...property, debt: null };
    try {
      return { ...property, debt: await lookup(property) };
    } catch (error) {
      return { ...property, debt: manualDebt(property, error) };
    }
  };
  const requireSource = (sourceId) => {
    const source = byId.get(sourceId);
    if (!source) throw appError("bad_request", "Choose a data source.");
    return source;
  };

  const runComps = async (sourceId, params) => {
    const source = requireSource(sourceId);
    const parsed = parseCompRequest(params);
    if (!parsed.ok) throw appError("bad_request", parsed.message);
    const subject = await source.getProperty(parsed.value.subjectId);
    if (!subject) throw appError("not_found", "No property matches that id.");
    if (subject.latitude == null || subject.longitude == null)
      throw appError(
        "bad_request",
        "This property has no coordinates, so nearby sales cannot be mapped.",
      );
    const windowed = applySaleWindow(parsed.value, now());
    const box = boundingBox(
      subject.latitude,
      subject.longitude,
      windowed.radiusMiles,
    );
    const found = await source.findCandidates({
      box,
      soldAfter: windowed.soldAfter,
      soldBefore: windowed.soldBefore,
      limit: 1000,
    });
    const selected = selectComps(found.records, {
      ...windowed,
      subjectId: subject.id,
      latitude: subject.latitude,
      longitude: subject.longitude,
    });
    const notes = [...(found.notes ?? [])];
    if (windowed.windowDefaulted)
      notes.push(
        `Sale dates defaulted to on or after ${windowed.soldAfter} because no date range was entered.`,
      );
    if (found.truncated)
      notes.push(
        "The public source returned a capped candidate list. Narrow the radius or sale dates for a tighter set.",
      );
    return {
      subject,
      comps: selected.comps,
      stats: selected.stats,
      coverage: {
        examinedCandidates: found.records.length,
        truncated: found.truncated,
        candidateLimit: found.limit,
        saleWindowDefaulted: windowed.windowDefaulted,
        soldAfter: windowed.soldAfter,
        soldBefore: windowed.soldBefore,
        radiusMiles: windowed.radiusMiles,
        notes,
      },
    };
  };

  return {
    listSources() {
      return sources.map(describeSource);
    },
    async search(sourceId, rawQuery, propertyType) {
      const source = requireSource(sourceId);
      const parsed = parseSearchQuery(rawQuery);
      if (!parsed.ok) throw appError("bad_request", parsed.message);
      const type = parsePropertyTypeFilter(propertyType);
      if (!type.ok) throw appError("bad_request", type.message);
      const results = await source.search(parsed.value, { propertyType: type.value });
      return { source: describeSource(source), results };
    },
    async getProperty(sourceId, id) {
      const source = requireSource(sourceId);
      const property = await source.getProperty(id);
      if (!property) throw appError("not_found", "No property matches that id.");
      return { property: await attachDebt(property) };
    },
    async comps(sourceId, params) {
      const result = await runComps(sourceId, params);
      return {
        subject: result.subject,
        comps: result.comps.map(presentComp),
        stats: presentStats(result.stats),
        coverage: result.coverage,
      };
    },
    async compsCsv(sourceId, params) {
      const result = await runComps(sourceId, params);
      return compsToCsv(result.comps);
    },
  };
};
