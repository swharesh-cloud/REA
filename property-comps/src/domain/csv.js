const roundTo = (value, digits) => {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
};

const cell = (value) => {
  const text = value == null ? "" : String(value);
  if (/[",\n\r]/u.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
};

const COLUMNS = [
  ["address", (row) => row.property.address],
  ["parcel_id", (row) => row.property.parcelId],
  ["owner", (row) => row.property.owner],
  ["property_type", (row) => row.property.propertyType],
  ["property_type_detail", (row) => row.property.propertyTypeDetail],
  ["building_sqft", (row) => row.property.buildingSqft],
  ["year_built", (row) => row.property.yearBuilt],
  ["sale_date", (row) => row.sale.date],
  ["sale_price", (row) => row.sale.price],
  [
    "price_per_sqft",
    (row) =>
      row.pricePerSqft == null ? "" : roundTo(row.pricePerSqft, 2),
  ],
  ["distance_miles", (row) => roundTo(row.distanceMiles, 3)],
  ["latitude", (row) => row.property.latitude],
  ["longitude", (row) => row.property.longitude],
  ["source_id", (row) => row.property.sourceId],
  ["data_kind", (row) => row.property.kind],
];

export const compsToCsv = (comps) => {
  const header = COLUMNS.map(([name]) => name).join(",");
  const lines = comps.map((row) =>
    COLUMNS.map(([, read]) => cell(read(row))).join(","),
  );
  return `${header}\n${lines.join("\n")}${lines.length > 0 ? "\n" : ""}`;
};
