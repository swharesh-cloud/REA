import { latToTileY, lonToTileX } from "/modules/geo.js";

const TILE = 256;
const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});
const perFoot = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const state = { source: null, sources: [], property: null };

const byId = (id) => document.getElementById(id);

const text = (value) => (value == null || value === "" ? "—" : String(value));

const dollars = (value) => (value == null ? "—" : money.format(value));

const setStatus = (id, message) => {
  byId(id).textContent = message ?? "";
};

const paramsOf = (form) => new URLSearchParams(new FormData(form));

const readJson = async (url) => {
  const response = await fetch(url);
  const body = await response.json();
  if (!response.ok) throw new Error(body?.error?.message ?? "Request failed.");
  return body;
};

const fillSources = (sources) => {
  const select = byId("source");
  select.replaceChildren();
  for (const source of sources) {
    const option = document.createElement("option");
    option.value = source.id;
    option.textContent = source.label;
    select.append(option);
  }
  const types = byId("property-type");
  const current = types.value;
  types.replaceChildren();
  const any = document.createElement("option");
  any.value = "";
  any.textContent = "Any";
  types.append(any);
  for (const type of sources[0]?.propertyTypes ?? []) {
    if (type === "Unknown") continue;
    const option = document.createElement("option");
    option.value = type;
    option.textContent = type;
    types.append(option);
  }
  types.value = current;
};

const showSourceNote = () => {
  const source = state.sources.find((item) => item.id === byId("source").value);
  state.source = source ?? null;
  byId("source-note").textContent = source?.description ?? "";
};

const renderResults = (results) => {
  const list = byId("results");
  list.replaceChildren();
  if (results.length === 0) {
    setStatus("search-status", "No matching properties.");
    return;
  }
  setStatus("search-status", `${results.length} propert${results.length === 1 ? "y" : "ies"}.`);
  for (const property of results) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.append(document.createTextNode(property.address));
    const detail = document.createElement("small");
    detail.textContent = `${property.parcelId} · ${property.propertyType}`;
    button.append(detail);
    button.addEventListener("click", () => loadProperty(property.id));
    item.append(button);
    list.append(item);
  }
};

const fact = (list, label, value) => {
  const term = document.createElement("dt");
  term.textContent = label;
  const definition = document.createElement("dd");
  definition.textContent = value;
  list.append(term, definition);
};

const renderRecord = (property) => {
  state.property = property;
  const root = byId("record");
  root.replaceChildren();
  if (property.kind === "sample") {
    const banner = document.createElement("p");
    banner.className = "banner";
    banner.textContent = property.provenance?.notes ?? "Sample data.";
    root.append(banner);
  }
  const facts = document.createElement("dl");
  fact(facts, "Address", text(property.address));
  fact(facts, "Parcel", text(property.parcelId));
  fact(facts, "Owner", text(property.owner));
  fact(facts, "Use", text(property.propertyTypeDetail ?? property.propertyType));
  fact(facts, "Building", property.buildingSqft == null ? "—" : `${property.buildingSqft.toLocaleString("en-US")} sqft`);
  fact(facts, "Year built", text(property.yearBuilt));
  fact(facts, "Assessed", dollars(property.assessedValue));
  root.append(facts);
  if (property.assessmentNote) {
    const note = document.createElement("p");
    note.className = "note";
    note.textContent = property.assessmentNote;
    root.append(note);
  }
  const table = document.createElement("table");
  table.className = "sales";
  const caption = document.createElement("caption");
  caption.textContent = "Sale history";
  table.append(caption);
  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const label of ["Date", "Price"]) {
    const cell = document.createElement("th");
    cell.textContent = label;
    headRow.append(cell);
  }
  head.append(headRow);
  const body = document.createElement("tbody");
  if (property.sales.length === 0) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 2;
    cell.textContent = "No sale on this record.";
    row.append(cell);
    body.append(row);
  }
  for (const sale of property.sales) {
    const row = document.createElement("tr");
    for (const value of [text(sale.date), sale.price > 0 ? dollars(sale.price) : "Non-market"]) {
      const cell = document.createElement("td");
      cell.textContent = value;
      row.append(cell);
    }
    body.append(row);
  }
  table.append(head, body);
  root.append(table);
  const links = property.provenance?.datasets ?? [];
  if (links.length > 0) {
    const note = document.createElement("p");
    note.className = "note";
    note.append(document.createTextNode("Sources: "));
    links.forEach((link, index) => {
      if (index > 0) note.append(document.createTextNode("; "));
      const anchor = document.createElement("a");
      anchor.href = link.href;
      anchor.textContent = link.name;
      anchor.rel = "noreferrer";
      anchor.target = "_blank";
      note.append(anchor);
    });
    root.append(note);
  }
  byId("comps-button").disabled = property.latitude == null;
  byId("use-type").disabled = false;
};

const chooseZoom = (points) => {
  let zoom = 16;
  while (zoom > 10) {
    const xs = points.map((point) => lonToTileX(point.longitude, zoom));
    const ys = points.map((point) => latToTileY(point.latitude, zoom));
    const spanX = Math.max(...xs) - Math.min(...xs);
    const spanY = Math.max(...ys) - Math.min(...ys);
    if (spanX < 2 && spanY < 1.4 && (Math.ceil(spanX + 1) * Math.ceil(spanY + 1)) <= 12)
      return zoom;
    zoom -= 1;
  }
  return zoom;
};

const renderMap = (subject, comps) => {
  const container = byId("map");
  container.replaceChildren();
  const points = [];
  if (subject.latitude != null)
    points.push({ ...subject, role: "subject" });
  for (const comp of comps) {
    if (comp.property.latitude == null) continue;
    points.push({ ...comp.property, role: "comp" });
  }
  if (points.length === 0) {
    container.textContent = "No coordinates to map.";
    return;
  }
  const zoom = chooseZoom(points);
  const xs = points.map((point) => lonToTileX(point.longitude, zoom));
  const ys = points.map((point) => latToTileY(point.latitude, zoom));
  const minX = Math.min(...xs) - 0.35;
  const maxX = Math.max(...xs) + 0.35;
  const minY = Math.min(...ys) - 0.35;
  const maxY = Math.max(...ys) + 0.35;
  const stage = document.createElement("div");
  stage.className = "map-stage";
  stage.style.width = `${(maxX - minX) * TILE}px`;
  stage.style.height = `${(maxY - minY) * TILE}px`;
  const maxTile = 2 ** zoom;
  for (let x = Math.floor(minX); x <= Math.floor(maxX); x += 1) {
    for (let y = Math.floor(minY); y <= Math.floor(maxY); y += 1) {
      if (y < 0 || y >= maxTile) continue;
      const wrapped = ((x % maxTile) + maxTile) % maxTile;
      const image = document.createElement("img");
      image.alt = "";
      image.src = `https://tile.openstreetmap.org/${zoom}/${wrapped}/${y}.png`;
      image.style.left = `${(x - minX) * TILE}px`;
      image.style.top = `${(y - minY) * TILE}px`;
      stage.append(image);
    }
  }
  for (const point of points) {
    const marker = document.createElement("button");
    marker.type = "button";
    marker.className = point.role === "subject" ? "marker subject" : "marker comp";
    marker.style.left = `${(lonToTileX(point.longitude, zoom) - minX) * TILE}px`;
    marker.style.top = `${(latToTileY(point.latitude, zoom) - minY) * TILE}px`;
    marker.title = point.address;
    marker.setAttribute("aria-label", point.address);
    if (point.role === "comp") {
      marker.addEventListener("click", () => highlight(point.id));
    }
    stage.append(marker);
  }
  container.append(stage);
};

const highlight = (id) => {
  const rows = document.querySelectorAll("#comps-body tr");
  for (const row of rows) row.classList.toggle("active", row.dataset.id === id);
  document.querySelector(`#comps-body tr[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({
    block: "nearest",
  });
};

const renderComps = (payload, exportUrl) => {
  const { subject, comps, stats, coverage } = payload;
  const statsRoot = byId("stats");
  statsRoot.hidden = false;
  statsRoot.replaceChildren();
  const bits = [
    `${stats.count} sale${stats.count === 1 ? "" : "s"}`,
    `median ${stats.medianPricePerSqft == null ? "—" : `${perFoot.format(stats.medianPricePerSqft)}/sqft`}`,
    `price range ${dollars(stats.minPrice)} to ${dollars(stats.maxPrice)}`,
  ];
  for (const bit of bits) {
    const item = document.createElement("div");
    item.textContent = bit;
    statsRoot.append(item);
  }
  const notes = coverage.notes ?? [];
  setStatus("comps-status", notes.join(" "));
  renderMap(subject, comps);
  const body = byId("comps-body");
  body.replaceChildren();
  for (const comp of comps) {
    const row = document.createElement("tr");
    row.dataset.id = comp.property.id;
    const values = [
      comp.property.address,
      comp.property.parcelId,
      comp.property.propertyType,
      comp.property.buildingSqft == null ? "—" : comp.property.buildingSqft.toLocaleString("en-US"),
      text(comp.property.yearBuilt),
      text(comp.sale.date),
      dollars(comp.sale.price),
      comp.pricePerSqft == null ? "—" : perFoot.format(comp.pricePerSqft),
      comp.distanceMiles.toFixed(3),
    ];
    for (const value of values) {
      const cell = document.createElement("td");
      cell.textContent = value;
      row.append(cell);
    }
    row.addEventListener("click", () => highlight(comp.property.id));
    body.append(row);
  }
  if (comps.length === 0) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 9;
    cell.textContent = "No sales matched those filters.";
    row.append(cell);
    body.append(row);
  }
  const exportLink = byId("export");
  exportLink.hidden = false;
  exportLink.href = exportUrl;
};

const loadProperty = async (id) => {
  setStatus("search-status", "Loading record…");
  const body = await readJson(
    `/api/properties?source=${encodeURIComponent(byId("source").value)}&id=${encodeURIComponent(id)}`,
  );
  renderRecord(body.property);
  setStatus("search-status", "");
};

const compQuery = () => {
  const params = paramsOf(byId("comps-form"));
  params.set("source", byId("source").value);
  params.set("subjectId", state.property.id);
  return params;
};

byId("source").addEventListener("change", () => {
  showSourceNote();
  state.property = null;
  byId("results").replaceChildren();
  byId("comps-body").replaceChildren();
  byId("stats").hidden = true;
  byId("export").hidden = true;
  byId("map").replaceChildren();
  byId("comps-button").disabled = true;
  byId("use-type").disabled = true;
  const empty = document.createElement("p");
  empty.className = "empty";
  empty.textContent = "Search, then choose a property.";
  byId("record").replaceChildren(empty);
  setStatus("search-status", "");
  setStatus("comps-status", "");
});

byId("search-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  setStatus("search-status", "Searching…");
  byId("results").replaceChildren();
  try {
    const params = paramsOf(event.currentTarget);
    const body = await readJson(`/api/search?${params.toString()}`);
    renderResults(body.results);
  } catch (error) {
    setStatus("search-status", error.message);
  }
});

byId("use-type").addEventListener("click", () => {
  if (!state.property) return;
  byId("property-type").value = state.property.propertyType;
});

byId("comps-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!state.property) return;
  setStatus("comps-status", "Searching nearby sales…");
  try {
    const params = compQuery();
    const body = await readJson(`/api/comps?${params.toString()}`);
    renderComps(body, `/api/comps.csv?${params.toString()}`);
  } catch (error) {
    setStatus("comps-status", error.message);
  }
});

const boot = async () => {
  const today = new Date();
  const from = new Date(Date.UTC(today.getUTCFullYear() - 3, today.getUTCMonth(), today.getUTCDate()));
  byId("sold-after").value = from.toISOString().slice(0, 10);
  const body = await readJson("/api/sources");
  state.sources = body.sources;
  fillSources(body.sources);
  showSourceNote();
};

const installHint = () => {
  const standalone =
    window.matchMedia("(display-mode: standalone)").matches ||
    window.navigator.standalone === true;
  const phone = window.matchMedia("(max-width: 800px)").matches;
  byId("install-hint").hidden = standalone || !phone;
};

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  const button = byId("install-button");
  button.hidden = false;
  button.addEventListener(
    "click",
    async () => {
      button.hidden = true;
      await event.prompt();
    },
    { once: true },
  );
});

window.addEventListener("appinstalled", () => {
  byId("install-button").hidden = true;
  byId("install-hint").hidden = true;
});

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}

boot()
  .then(installHint)
  .catch((error) => setStatus("search-status", error.message));
