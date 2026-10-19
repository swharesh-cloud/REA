/**
 * Recorded-debt facts shared by the sample file and county recorder adapters.
 * Loan amount and maturity stay null unless the source actually publishes them.
 */

const BUSINESS =
  /\b(LLC|L\.L\.C\.|INC|INCORPORATED|CORP|CORPORATION|LP|L\.P\.|LLP|LTD|LIMITED|COMPANY|PLLC|BANK|ASSOCIATION|PARTNERSHIP|TRUST)\b/iu;

const LENDER_HINT = /\b(BANK|MORTGAGE|FUNDING|LENDING|CREDIT UNION|SERVICING|FINANCIAL)\b/iu;

const ROLE_LABEL = {
  "deed-of-trust": "Deed of trust",
  mortgage: "Mortgage",
  assignment: "Assignment",
  release: "Release",
  "partial-release": "Partial release",
};

const CODE_ROLE = [
  ["DEED TRST", "deed-of-trust"],
  ["MORTGAGE", "mortgage"],
  ["PART REL", "partial-release"],
  ["REL D/T", "release"],
  ["REL MTG", "release"],
  ["ASSIGNMNT", "assignment"],
];

export const NAME_ONLY_CONFIDENCE =
  "Name only. The document matched the assessor owner. This index has no parcel number or legal description, so it may be a different property of the same party.";

const collapse = (value) => String(value ?? "").replace(/\s+/gu, " ").trim();

const normalizeParty = (value) =>
  collapse(value)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/gu, " ")
    .trim();

/** Split an assessor owner into the name fields the Maricopa recorder index accepts. */
export const recorderNameQuery = (owner) => {
  const name = collapse(owner);
  if (name.length < 2) return null;
  const segments = name.split(/\s+&\s+/u).map(collapse).filter(Boolean);
  const business = segments.find((segment) => BUSINESS.test(segment));
  if (business) {
    return {
      businessNames: business,
      searched: business,
      ownerNote:
        segments.length > 1
          ? "The assessor lists more than one owner. Only the first business name was searched."
          : null,
    };
  }
  const person = segments[0] ?? name;
  const parts = person.split(" ").filter(Boolean);
  if (parts.length === 0) return null;
  return {
    lastNames: parts[0],
    firstNames: parts[1] ?? "",
    searched: parts.slice(0, 2).join(" "),
    ownerNote:
      segments.length > 1
        ? "The assessor lists more than one owner. Only the first person was searched."
        : null,
  };
};

export const debtRole = (documentType) => {
  const codes = String(documentType ?? "")
    .split(",")
    .map((code) => code.replace(/\+$/u, "").trim().toUpperCase())
    .filter(Boolean);
  for (const [code, role] of CODE_ROLE) {
    if (codes.includes(code)) return { role, documentType: codes.join(", ") };
  }
  return null;
};

export const possibleLenders = (parties, owner) => {
  const ownerKey = normalizeParty(owner);
  return parties.filter((party) => {
    const key = normalizeParty(party);
    if (key.length === 0 || key === ownerKey) return false;
    return LENDER_HINT.test(party);
  });
};

export const buildDebtDocument = (fields) => ({
  role: fields.role,
  roleLabel: ROLE_LABEL[fields.role] ?? fields.role,
  documentType: fields.documentType,
  recordedAt: fields.recordedAt ?? null,
  documentNumber: fields.documentNumber,
  pages: fields.pages ?? null,
  parties: fields.parties ?? [],
  possibleLenders: fields.possibleLenders ?? [],
  loanAmount: fields.loanAmount ?? null,
  maturityDate: fields.maturityDate ?? null,
  documentUrl: fields.documentUrl ?? null,
  confidence: fields.confidence,
  confidenceLabel: fields.confidenceLabel,
});

export const emptyDebt = ({ status, match, limitations, links, truncated = false }) => ({
  status,
  applies: true,
  match,
  documents: [],
  limitations,
  links,
  truncated,
});
