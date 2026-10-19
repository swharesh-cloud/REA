import { searchTokens } from "../domain/property.js";
import { appError, createCache, fetchJson } from "./http.js";

export const arcgisString = (value) => `'${String(value).replaceAll("'", "''")}'`;

export const arcgisLike = (column, token) => {
  if (!/^[A-Za-z0-9_]+$/u.test(column) || !/^[A-Z0-9]+$/u.test(token))
    throw appError("bad_request", "Search text could not be encoded safely.");
  return `UPPER(${column}) LIKE '%${token}%'`;
};

export const arcgisNumber = (value) => {
  if (!Number.isFinite(value)) throw appError("bad_request", "Invalid map bounds.");
  const text = value.toFixed(6);
  if (!/^-?\d+\.\d{6}$/u.test(text))
    throw appError("bad_request", "Invalid map bounds.");
  return text;
};

const tokenAnd = (column, tokens) =>
  tokens.map((token) => arcgisLike(column, token)).join(" AND ");

/**
 * Address tokens, optional owner tokens, and an exact parcel clause.
 * The caller owns the parcel clause so each county keeps its own id rules.
 */
export const addressOrOwnerWhere = (
  text,
  { addressColumn, ownerColumn = null, parcelClause = null },
) => {
  const tokens = searchTokens(text);
  const clauses = [];
  if (parcelClause) clauses.push(parcelClause);
  if (tokens.length > 0) clauses.push(`(${tokenAnd(addressColumn, tokens)})`);
  if (ownerColumn && tokens.some((token) => /[A-Z]/u.test(token)))
    clauses.push(`(${tokenAnd(ownerColumn, tokens)})`);
  return clauses.length === 0 ? null : clauses.join(" OR ");
};

export const arcgisQuery = async (
  endpoint,
  params,
  { fetchImpl = globalThis.fetch, cache = createCache() } = {},
) => {
  const url = new URL(endpoint);
  for (const [key, value] of Object.entries({ f: "json", ...params })) {
    if (value != null && value !== "") url.searchParams.set(key, String(value));
  }
  const body = await cache.get(url.toString(), () => fetchJson(url, { fetchImpl }));
  if (body?.error) {
    const details = Array.isArray(body.error.details)
      ? body.error.details.join("; ")
      : "";
    const message = [body.error.message, details].filter(Boolean).join(" ");
    throw appError("upstream", message || "The county map service rejected the query.");
  }
  if (!body || !Array.isArray(body.features))
    throw appError(
      "upstream",
      "The county map service returned an unexpected response.",
    );
  return {
    features: body.features,
    exceeded: body.exceededTransferLimit === true,
  };
};
