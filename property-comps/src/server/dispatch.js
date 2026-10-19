const json = (status, body) => ({
  status,
  headers: {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  },
  body: JSON.stringify(body),
});

const statusFor = (error) => {
  if (error?.code === "bad_request") return 400;
  if (error?.code === "not_found") return 404;
  if (error?.code === "timeout") return 504;
  return 502;
};

const paramsOf = (searchParams) => Object.fromEntries(searchParams.entries());

const PROBES = [
  ["sample", "sample:maple-100"],
  ["maricopa", "maricopa:102-23-642"],
  ["pinal", "pinal:51180012V"],
];

const probeSource = async (service, sourceId, id) => {
  const started = Date.now();
  try {
    const body = await service.getProperty(sourceId, id);
    const parcelId = body?.property?.parcelId;
    if (!parcelId) {
      return {
        id: sourceId,
        ok: false,
        elapsedMs: Date.now() - started,
        detail: "The source returned no property record.",
      };
    }
    return { id: sourceId, ok: true, elapsedMs: Date.now() - started, detail: parcelId };
  } catch (error) {
    return {
      id: sourceId,
      ok: false,
      elapsedMs: Date.now() - started,
      detail: error?.message ?? "Lookup failed.",
    };
  }
};

/** Each source is checked on its own so one county cannot hide the sample data. */
export const healthReport = (service) =>
  Promise.all(PROBES.map(([sourceId, id]) => probeSource(service, sourceId, id))).then(
    (sources) => ({ ok: sources.every((source) => source.ok), sources }),
  );

/**
 * Shared GET API used by the local Node server and the Vercel functions.
 * `pathname` is the public path (`/api/comps.csv`), not the function file name.
 */
export const dispatchApi = async (service, { method, pathname, searchParams }) => {
  if (method !== "GET")
    return json(405, { error: { code: "method", message: "Use GET." } });
  try {
    if (pathname === "/api/sources")
      return json(200, { sources: service.listSources() });
    if (pathname === "/api/health") return json(200, await healthReport(service));
    if (pathname === "/api/search")
      return json(200, await service.search(searchParams.get("source"), searchParams.get("q")));
    if (pathname === "/api/properties")
      return json(
        200,
        await service.getProperty(searchParams.get("source"), searchParams.get("id")),
      );
    const params = paramsOf(searchParams);
    if (pathname === "/api/comps.csv") {
      const csv = await service.compsCsv(params.source, params);
      return {
        status: 200,
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": 'attachment; filename="comps.csv"',
          "cache-control": "no-store",
        },
        body: csv,
      };
    }
    if (pathname === "/api/comps") return json(200, await service.comps(params.source, params));
    return json(404, { error: { code: "not_found", message: "Not found." } });
  } catch (error) {
    return json(statusFor(error), {
      error: {
        code: error?.code ?? "upstream",
        message: error?.message ?? "Request failed.",
      },
    });
  }
};
