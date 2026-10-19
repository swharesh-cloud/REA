import { emptyDebt } from "../domain/debt.js";

const LIMITATIONS = [
  "Pinal County Recorder's public search is the Acclaim website. Requests from this app received HTTP 403, a bot check, and no public JSON or ArcGIS document index was found.",
  "The Acclaim index, when opened in a browser, can show record date, fee number, document type, party names, legal description, and sometimes a parcel number. Loan amount and maturity are on the document image, not in a free field this app can read.",
  "This app does not submit a Pinal search. The links open the official name search and legal-description search. Type the owner shown here. The recorder site did not accept a prefilled owner or parcel from this app.",
  "Recorded images are unofficial watermarked copies. The recorder charges for copies, and images before 1998 may be unavailable online.",
];

export const pinalRecorderLinks = (property) => {
  const owner = property.owner ?? "the assessor owner";
  return [
    {
      name: "Pinal recorder name search",
      href: "https://acclaim.pinalcountyaz.gov/AcclaimWeb/search/SearchTypeName",
      note: `Official party-name search. Enter ${owner}. The page is not prefilled.`,
    },
    {
      name: "Pinal recorder legal search",
      href: "https://acclaim.pinalcountyaz.gov/AcclaimWeb/search/SearchTypeDocLegal",
      note: `Legal-description search. Parcel ${property.parcelId} is an assessor id; the recorder search is not keyed by that id from this app.`,
    },
  ];
};

export const pinalDebtReport = (property) =>
  emptyDebt({
    status: "manual",
    match: {
      method: "none",
      confidence: "unmatched",
      label:
        "No Pinal document was matched. The recorder search has to be opened by hand, and loan terms are not in a public index.",
    },
    limitations: LIMITATIONS,
    links: pinalRecorderLinks(property),
  });

export const createPinalDebtLookup = () => async (property) => pinalDebtReport(property);
