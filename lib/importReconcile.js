// Shared logic for the Import & Reconcile tool (/admin/import-reconcile).
//
// The whole point of this tool is to stop hand-copying a coach-submitted or
// scraped spreadsheet into the database one field at a time. A reviewer
// uploads a CSV, this file maps its columns onto the schools table
// (deterministic alias matching -- same non-AI approach bulk-add-schools
// already uses, not an LLM call, so it's instant and free), matches each
// row to an existing school (or flags it as new), and sorts every row into
// one of five buckets so the reviewer can act on many rows at once instead
// of one at a time:
//
//   exact_match       -- CSV agrees with what's on file. Nothing to do.
//   new_info          -- CSV fills in fields that were blank on file. Safe
//                        to bulk-apply -- nothing already there gets
//                        overwritten.
//   conflict          -- CSV disagrees with a field that already has a
//                        different value on file. Needs a human to pick a
//                        winner per field.
//   needs_verification -- The row's school name matches MORE THAN ONE
//                        school in that state (the exact same-name-school
//                        risk the "Suggest Coach Info (AI)" search hardened
//                        against -- see lib/coachInfoLookup.js). Can't
//                        safely auto-match, so the reviewer either picks the
//                        right school by hand or sends it to the AI/web
//                        search verification queue (Batch Coach-Info
//                        Discovery) to settle it.
//   new_school        -- No school in the database matches this row's name
//                        + state at all. Same duplicate-checked create path
//                        bulk-add-schools already uses.
//
// A sixth bucket, "skipped", covers rows missing a name or state -- nothing
// can be matched or created from those, so they're just reported as errors.

// ---- Column mapping -------------------------------------------------

// Every field this tool can read from a CSV and write to `schools`.
// school_id/name/state/city are used for matching; everything else is
// diffed and (optionally) applied. Kept as [field, label] pairs so the UI
// can show a human label without a second lookup table.
export const MATCH_FIELDS = [
  ["school_id", "CSD school ID"],
  ["name", "School name"],
  ["state", "State"],
];

export const DIFF_FIELDS = [
  ["city", "City"],
  ["school_type", "Type (Public/Private)"],
  ["addr1", "Address line 1"],
  ["addr2", "Address line 2"],
  ["county", "County"],
  ["zip", "Zip"],
  ["classification", "Classification"],
  ["phone", "Main phone"],
  ["website", "Website"],
  ["athletics_url", "Athletics URL"],
  ["maxpreps_url", "MaxPreps URL"],
  ["hc_first_name", "HC first name"],
  ["hc_last_name", "HC last name"],
  ["hc_email", "HC email"],
  ["hc_cell", "HC cell"],
  ["hc_office", "HC office"],
  ["x_twitter", "X (Twitter)"],
  ["ad_name", "AD name"],
  ["ad_email", "AD email"],
];

export const ALL_FIELDS = [...MATCH_FIELDS, ...DIFF_FIELDS];
export const DIFF_FIELD_NAMES = DIFF_FIELDS.map(([f]) => f);

// Same alias-dictionary approach as bulk-add-schools (deterministic, no AI
// call needed for something this mechanical), extended with the coach/AD/
// URL fields that tool didn't need plus a wider set of variants -- the HS
// coach-submitted and scraped sheets this tool exists for have shown at
// least 4 different header conventions in practice.
const HEADER_ALIASES = {
  school_id: ["school id", "csd id", "csd school id", "id", "database id"],
  name: ["school name", "high school", "hs", "hs name", "school", "team", "team name"],
  state: ["state", "st"],
  city: ["city", "town"],
  school_type: ["school type", "type", "public private"],
  addr1: ["address", "address line 1", "address 1", "street", "street address"],
  addr2: ["address line 2", "address 2", "suite"],
  county: ["county"],
  zip: ["zip", "zip code", "postal code"],
  classification: ["classification", "class", "division", "conference"],
  phone: ["phone", "main phone", "school phone", "phone number"],
  website: ["website", "url", "web site", "site", "school website"],
  athletics_url: ["athletics url", "athletics website", "athletic site", "athletics site", "athletic department url", "athletics page"],
  maxpreps_url: ["maxpreps", "maxpreps url", "maxpreps link", "maxpreps page"],
  hc_first_name: ["hc first name", "head coach first name", "coach first name", "first name"],
  hc_last_name: ["hc last name", "head coach last name", "coach last name", "last name"],
  hc_email: ["hc email", "head coach email", "coach email", "email", "coach's email"],
  hc_cell: ["hc cell", "head coach cell", "coach cell", "cell", "phone cell", "coach phone", "mobile", "cell phone"],
  hc_office: ["hc office", "head coach office", "coach office", "office", "office phone"],
  x_twitter: ["x twitter", "x (twitter)", "twitter", "x", "twitter handle"],
  ad_name: ["ad name", "athletic director", "athletic director name", "athletics director", "ad"],
  ad_email: ["ad email", "athletic director email", "athletics director email"],
};

function normalizeHeaderText(v) {
  return String(v || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

const ALIAS_LOOKUP = (() => {
  const map = {};
  Object.entries(HEADER_ALIASES).forEach(([field, aliases]) => {
    map[normalizeHeaderText(field)] = field;
    aliases.forEach((alias) => {
      map[normalizeHeaderText(alias)] = field;
    });
  });
  return map;
})();

// Returns the canonical field name for a raw CSV header, or null if this
// header doesn't match anything this tool knows how to use (it's kept in
// raw_row for the audit trail, but ignored for mapping/diffing).
export function resolveHeader(raw) {
  return ALIAS_LOOKUP[normalizeHeaderText(raw)] || null;
}

export function trimStr(v) {
  return v == null ? "" : String(v).trim();
}

// ---- School-name matching --------------------------------------------
// Identical to bulk-add-schools' normalizeSchoolName -- same normalization
// keeps the two tools' idea of "is this the same school" from drifting
// apart.
const HIGH_SCHOOL_SUFFIXES = [
  "junior senior high school",
  "jr sr high school",
  "senior high school",
  "junior high school",
  "middle high school",
  "high school",
  "senior high",
  "junior high",
  "high",
  "hs",
];

export function normalizeSchoolName(v) {
  let s = String(v || "").toLowerCase().replace(/['’.]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
  for (const suffix of HIGH_SCHOOL_SUFFIXES) {
    if (s === suffix) {
      s = "";
      break;
    }
    if (s.endsWith(" " + suffix)) {
      s = s.slice(0, s.length - suffix.length - 1).trim();
      break;
    }
  }
  return s.replace(/\s+/g, " ").trim();
}

export function matchKey(name, state) {
  return `${normalizeSchoolName(name)}|${trimStr(state).toUpperCase()}`;
}

// ---- CSV row -> canonical fields --------------------------------------

// Turns one Papa.parse row (raw header -> raw value) into { mapped,
// columnMapping } where mapped only has canonical fields this tool knows
// about, trimmed, with blanks as "". columnMapping records raw header ->
// resolved field (or null) for the audit trail saved on import_batches.
export function mapRow(row) {
  const mapped = {};
  const columnMapping = {};
  Object.keys(row).forEach((header) => {
    const field = resolveHeader(header);
    columnMapping[header] = field;
    if (!field) return;
    const val = trimStr(row[header]);
    // First non-blank value wins if two raw headers resolve to the same
    // field (e.g. both "Coach Email" and "Email" present).
    if (val && !mapped[field]) mapped[field] = val;
  });
  return { mapped, columnMapping };
}

// ---- Categorization -----------------------------------------------------

// existingById: Map<number, schoolRow>
// existingByKey: Map<matchKey, schoolRow[]>  (schoolRow has id + every
//   MATCH_FIELDS/DIFF_FIELDS column)
//
// Returns { bucket, match_school_id, match_confidence, diff, candidates,
// skip_reason }. `diff` is an array of { field, label, old, new, kind }
// where kind is "fill" (old was blank) or "overwrite" (old had a different
// value already). `candidates` is only set for needs_verification rows --
// the list of schools this row's name+state could refer to.
export function categorizeRow(mapped, { existingById, existingByKey }) {
  const name = mapped.name || "";
  const state = (mapped.state || "").toUpperCase();

  if (!name || !state) {
    return {
      bucket: "skipped",
      match_school_id: null,
      match_confidence: null,
      diff: null,
      candidates: null,
      skip_reason: !name ? "Missing school name." : "Missing state.",
    };
  }

  // An explicit school_id column, when present and valid, is the most
  // reliable match -- same precedence bulk-update gives it -- and sidesteps
  // name/state ambiguity entirely.
  let school = null;
  if (mapped.school_id && existingById.has(String(mapped.school_id).trim())) {
    school = existingById.get(String(mapped.school_id).trim());
  }

  let candidates = null;
  if (!school) {
    candidates = existingByKey.get(matchKey(name, state)) || [];
    if (candidates.length === 1) {
      school = candidates[0];
    } else if (candidates.length > 1) {
      return {
        bucket: "needs_verification",
        match_school_id: null,
        match_confidence: "ambiguous",
        diff: null,
        candidates: candidates.map((s) => ({ id: s.id, name: s.name, city: s.city, state: s.state })),
        skip_reason: null,
      };
    }
  }

  if (!school) {
    return { bucket: "new_school", match_school_id: null, match_confidence: "none", diff: null, candidates: null, skip_reason: null };
  }

  const diff = [];
  DIFF_FIELDS.forEach(([field, label]) => {
    if (!(field in mapped)) return;
    const newVal = mapped[field];
    if (!newVal) return;
    const oldVal = trimStr(school[field]);
    if (newVal === oldVal) return;
    diff.push({ field, label, old: oldVal, new: newVal, kind: oldVal ? "overwrite" : "fill" });
  });

  const bucket = diff.length === 0 ? "exact_match" : diff.some((d) => d.kind === "overwrite") ? "conflict" : "new_info";

  return {
    bucket,
    match_school_id: school.id,
    match_confidence: mapped.school_id ? "id" : "exact",
    diff: diff.length ? diff : null,
    candidates: null,
    skip_reason: null,
  };
}

// Re-runs categorizeRow against ONE specific school (used when a reviewer
// manually resolves a needs_verification row by picking a candidate) --
// same diffing logic, just skipping the name/state match step.
export function categorizeAgainstSchool(mapped, school) {
  const diff = [];
  DIFF_FIELDS.forEach(([field, label]) => {
    if (!(field in mapped)) return;
    const newVal = mapped[field];
    if (!newVal) return;
    const oldVal = trimStr(school[field]);
    if (newVal === oldVal) return;
    diff.push({ field, label, old: oldVal, new: newVal, kind: oldVal ? "overwrite" : "fill" });
  });
  const bucket = diff.length === 0 ? "exact_match" : diff.some((d) => d.kind === "overwrite") ? "conflict" : "new_info";
  return { bucket, match_school_id: school.id, match_confidence: "manual", diff: diff.length ? diff : null };
}

export const BUCKET_LABELS = {
  exact_match: "Already up to date",
  new_info: "New info (fills blanks)",
  conflict: "Conflicts with data on file",
  needs_verification: "Needs verification",
  new_school: "New school",
  skipped: "Skipped (errors)",
};
