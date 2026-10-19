import { parseRecordDate } from "../domain/property.js";
import {
  NAME_ONLY_CONFIDENCE,
  buildDebtDocument,
  debtRole,
  emptyDebt,
  possibleLenders,
  recorderNameQuery,
} from "../domain/debt.js";
import { appError, createCache } from "./http.js";

const API = "https://publicapi.recorder.maricopa.gov";
const SEARCH_PAGE = 15;
const DETAIL_CAP = 12;
const LOOKBACK_YEARS = 15;

const INSTRUMENT_CODES = ["DT", "MG", "AS", "DR", "PR", "MR"];

const USER_AGENT = "property-comps/0.1 (local research app; public open data)";

const documentUrl = (recordingNumber, suffix) => {
  const rec = String(recordingNumber).replace(/\D/gu, "");
  const suf = String(suffix ?? "").replace(/[^A-Za-z0-9]/gu, "");
  return `https://recorder.maricopa.gov/recdocdata/GetRecDataDetail.aspx?rec=${rec}&suf=${suf}`;
};

export const maricopaRecorderLinks = (property) => [
  {
    name: "Maricopa recorder name index",
    href: "https://recorder.maricopa.gov/recdocdata/",
    note: `Official recorded-document search. Enter owner ${property.owner ?? "(unknown)"}. Parcel ${property.parcelId} is not a search field in this index.`,
  },
  {
    name: "Maricopa full-text search (about two years)",
    href: "https://recorder.maricopa.gov/recording/document-search.html",
    note: "The recorder's newer full-text search covers roughly the last two years and can take a name, address, or legal description. It is a separate page from the public JSON index.",
  },
];

const shiftYears = (iso, years) => {
  const [year, month, day] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(year + years, month - 1, day));
  return date.toISOString().slice(0, 10);
};

const fetchRecorder = async (url, fetchImpl) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: { accept: "application/json, text/plain", "user-agent": USER_AGENT },
    });
    const text = await response.text();
    if (!response.ok)
      throw appError("upstream", `Maricopa recorder returned HTTP ${response.status}.`);
    const trimmed = text.trim();
    if (trimmed.startsWith("<"))
      throw appError("upstream", "Maricopa recorder returned a challenge page instead of the document index.");
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed.replace(/^"|"$/gu, "");
    }
  } catch (error) {
    if (error?.name === "AbortError")
      throw appError("timeout", "Maricopa recorder did not respond in time.");
    throw error;
  } finally {
    clearTimeout(timer);
  }
};

const searchUrl = (nameQuery, code, beginDate, endDate) => {
  const url = new URL("/documents/search", API);
  if (nameQuery.businessNames) url.searchParams.set("businessNames", nameQuery.businessNames);
  if (nameQuery.lastNames) url.searchParams.set("lastNames", nameQuery.lastNames);
  if (nameQuery.firstNames) url.searchParams.set("firstNames", nameQuery.firstNames);
  url.searchParams.set("documentCode", code);
  url.searchParams.set("beginDate", beginDate);
  url.searchParams.set("endDate", endDate);
  url.searchParams.set("pageNumber", "1");
  url.searchParams.set("pageSize", String(SEARCH_PAGE));
  return url;
};

const indexedLimitations = (endDate, ownerNote) => {
  const notes = [
    "Maricopa's public document index returns document type, recording date, recording number, page count, and party names.",
    "Loan amount and maturity date are not indexed. They are printed on the recorded document, which this app does not download.",
    "Party roles are not labeled. A possible lender is another indexed name that looks like a bank or lender, not a role from the recorder.",
    "Match confidence is name only. APN, address, and legal description are not search fields on this index.",
    `Each instrument type returns at most ${SEARCH_PAGE} documents, and at most ${DETAIL_CAP} documents are opened for party names. The recorder also caps a query at 500 hits.`,
    `The index date used for this lookup was ${endDate}. Later recordings are not in the index yet.`,
  ];
  if (ownerNote) notes.push(ownerNote);
  return notes;
};

const toDocument = (row, detail, owner) => {
  const typed = debtRole(
    Array.isArray(detail?.documentCodes) && detail.documentCodes.length > 0
      ? detail.documentCodes.join(", ")
      : row.documentCode,
  );
  if (!typed) return null;
  const parties = Array.isArray(detail?.names)
    ? detail.names.map((name) => String(name).trim()).filter(Boolean)
    : [row.names].filter(Boolean);
  const lenders = possibleLenders(parties, owner);
  return buildDebtDocument({
    role: typed.role,
    documentType: typed.documentType,
    recordedAt: parseRecordDate(detail?.recordingDate ?? row.recordingDate),
    documentNumber: String(detail?.recordingNumber ?? row.recordingNumber),
    pages: Number.isInteger(detail?.pageAmount) ? detail.pageAmount : null,
    parties,
    possibleLenders: lenders,
    loanAmount: null,
    maturityDate: null,
    documentUrl: documentUrl(row.recordingNumber, row.recordingSuffix),
    confidence: "name-only",
    confidenceLabel: NAME_ONLY_CONFIDENCE,
  });
};

export const createMaricopaDebtLookup = ({
  fetchImpl = globalThis.fetch,
  cache = createCache(),
  now = () => new Date(),
} = {}) => {
  const load = async (property) => {
    const nameQuery = recorderNameQuery(property.owner);
    if (!nameQuery) {
      return emptyDebt({
        status: "manual",
        match: {
          method: "none",
          confidence: "unmatched",
          label: "The assessor record has no owner name to search.",
        },
        limitations: [
          "Maricopa's recorder index is searched by name. This parcel has no owner name, and the index does not accept an APN.",
        ],
        links: maricopaRecorderLinks(property),
      });
    }

    const indexValue = await fetchRecorder(`${API}/documents/index`, fetchImpl).catch(() => null);
    const indexedEnd = typeof indexValue === "string" ? parseRecordDate(indexValue) : null;
    const endDate = indexedEnd ?? now().toISOString().slice(0, 10);
    const beginDate = shiftYears(endDate, -LOOKBACK_YEARS);

    const settled = await Promise.all(
      INSTRUMENT_CODES.map(async (code) => {
        try {
          const body = await fetchRecorder(
            searchUrl(nameQuery, code, beginDate, endDate),
            fetchImpl,
          );
          const results = Array.isArray(body?.searchResults) ? body.searchResults : [];
          const total = Number(body?.totalResults);
          return {
            results,
            truncated: results.length > 0 && (results.length < total || total >= 501),
          };
        } catch (error) {
          return { results: [], truncated: false, error: error?.message ?? "Search failed." };
        }
      }),
    );

    const failures = settled.filter((item) => item.error);
    if (failures.length === INSTRUMENT_CODES.length)
      throw appError("upstream", failures[0].error);

    const byNumber = new Map();
    for (const item of settled) {
      for (const row of item.results) {
        if (row?.recordingNumber == null) continue;
        byNumber.set(String(row.recordingNumber), row);
      }
    }
    const rows = [...byNumber.values()].sort((left, right) => {
      const leftDate = parseRecordDate(left.recordingDate) ?? "";
      const rightDate = parseRecordDate(right.recordingDate) ?? "";
      if (leftDate !== rightDate) return rightDate < leftDate ? -1 : 1;
      return String(right.recordingNumber).localeCompare(String(left.recordingNumber));
    });
    const selected = rows.slice(0, DETAIL_CAP);
    const details = await Promise.all(
      selected.map(async (row) => {
        const number = String(row.recordingNumber).replace(/\D/gu, "");
        try {
          const detail = await fetchRecorder(`${API}/documents/${number}`, fetchImpl);
          return { row, detail };
        } catch {
          return { row, detail: null };
        }
      }),
    );
    const documents = details
      .map(({ row, detail }) => toDocument(row, detail, property.owner))
      .filter(Boolean);

    return {
      status: "indexed",
      applies: true,
      match: {
        method: "owner-name",
        confidence: "name-only",
        label: NAME_ONLY_CONFIDENCE,
        searched: nameQuery.searched,
      },
      documents,
      limitations: indexedLimitations(endDate, nameQuery.ownerNote),
      links: maricopaRecorderLinks(property),
      truncated:
        rows.length > selected.length || settled.some((item) => item.truncated) || failures.length > 0,
    };
  };

  return (property) => {
    const nameQuery = recorderNameQuery(property.owner);
    const key = `maricopa-debt:${nameQuery?.searched ?? ""}:${property.parcelId}`;
    return cache.get(key, () => load(property));
  };
};
