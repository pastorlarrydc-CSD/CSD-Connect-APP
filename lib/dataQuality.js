// Data-quality checks for the schools table (Session 16).
//
// Flags records that are missing outreach-critical info or look
// malformed, so Verification Staff get a prioritized queue instead of
// stumbling onto bad records one at a time while browsing.
//
// Important design note: this is a freshly bulk-imported database (see
// Admin > Data Provenance), so verification_status is "not_verified" on
// nearly every row -- almost 14,600 of 14,621 schools at the time this was
// written. Treating "never verified" as an actionable queue item would
// mean the queue is just... the entire database, which isn't useful. So
// "never verified" and "missing map coordinates" are tracked as
// background/informational counts (shown as summary stats) but do NOT put
// a school in the actionable review queue on their own -- only real data
// problems (no way to reach the school, malformed contact info, contact
// info with no name attached) do that.

const PHONE_MIN_DIGITS = 7; // fewer than this isn't a usable phone number
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isBlank(v) {
  return v == null || String(v).trim() === "";
}

export function isValidEmail(email) {
  if (isBlank(email)) return true; // absence is a different issue, not a format issue
  return EMAIL_RE.test(String(email).trim());
}

export function isValidPhone(phone) {
  if (isBlank(phone)) return true;
  const digits = String(phone).replace(/\D/g, "");
  return digits.length >= PHONE_MIN_DIGITS && digits.length <= 11;
}

const SEVERITY = { critical: 3, high: 2, medium: 1, info: 0 };

// Returns { issues: [{code,label,severity,actionable}], score, actionable }
export function classifySchool(school) {
  const hasEmail = !isBlank(school.hc_email);
  const hasCell = !isBlank(school.hc_cell);
  const hasOffice = !isBlank(school.hc_office);
  const hasAnyContact = hasEmail || hasCell || hasOffice;
  const hasName = !isBlank(school.hc_first_name) || !isBlank(school.hc_last_name);

  const issues = [];

  if (!hasAnyContact) {
    issues.push({ code: "no_contact", label: "No email, cell, or office on file", severity: "critical", actionable: true });
  }
  if (hasEmail && !isValidEmail(school.hc_email)) {
    issues.push({ code: "bad_email", label: `Malformed email: "${school.hc_email}"`, severity: "high", actionable: true });
  }
  if (hasCell && !isValidPhone(school.hc_cell)) {
    issues.push({ code: "bad_cell", label: `Malformed cell: "${school.hc_cell}"`, severity: "high", actionable: true });
  }
  if (hasOffice && !isValidPhone(school.hc_office)) {
    issues.push({ code: "bad_office", label: `Malformed office phone: "${school.hc_office}"`, severity: "high", actionable: true });
  }
  if (hasAnyContact && !hasName) {
    issues.push({ code: "no_name", label: "Contact info on file but no coach name", severity: "medium", actionable: true });
  }
  if (school.verification_status !== "verified") {
    issues.push({ code: "never_verified", label: "Never verified", severity: "info", actionable: false });
  }
  if (school.lat == null || school.lon == null) {
    issues.push({ code: "missing_coords", label: "No map coordinates (can't be routed on trips)", severity: "info", actionable: false });
  }

  const actionableIssues = issues.filter((iss) => iss.actionable);
  const score = actionableIssues.reduce((max, iss) => Math.max(max, SEVERITY[iss.severity]), -1);

  return { issues, actionableIssues, score, actionable: actionableIssues.length > 0 };
}

// Classifies a full array of schools. `flagged` is the actionable review
// queue (real data problems only); `counts` tallies every issue code,
// including the informational ones, for summary stats.
export function classifySchools(schools) {
  const flagged = [];
  const counts = {};

  for (const school of schools) {
    const result = classifySchool(school);
    result.issues.forEach((iss) => {
      counts[iss.code] = (counts[iss.code] || 0) + 1;
    });
    if (result.actionable) {
      flagged.push({ school, ...result });
    }
  }

  flagged.sort((a, b) => b.score - a.score || (a.school.name || "").localeCompare(b.school.name || ""));

  return { flagged, counts, totalFlagged: flagged.length, totalScanned: schools.length };
}

// Confidence score (0-100): a plain, transparent measure of how much a
// school's coach-contact record can be trusted right now. Every school got
// a starting value at the original bulk import, but that number was never
// touched again -- a Quick Fix that fills in a missing phone, a "Mark
// Coach Change," a bulk CSV upload, or an approved coach-submitted
// correction all used to leave the old score sitting there, stale and
// disconnected from what the record actually looks like now.
//
// This function is the single source of truth for that number going
// forward: call it with the record as it will exist AFTER a write (i.e.
// merge your update onto the current row first) and store the result back
// onto schools.confidence_score in that same write. See
// app/(app)/admin/data-quality/page.js (Quick Fix, Mark Coach Change, CSV
// upload, "Confirm accurate") and app/(app)/admin/page.js (approved
// coach-submitted corrections) for the call sites.
//
// Weights (sum to 100) -- deliberately simple and visible rather than a
// black box, so "why did this number move" always has a one-line answer:
//   Coach name on file                    20
//   Valid email on file                   25
//   Valid phone, cell or office           20
//   A website, MaxPreps, or athletics URL 15
//   Verified by a human (not just a fix)  20
//
// NOTE: this JS copy is NOT the live source of truth -- schools.confidence_score
// is actually recomputed by a Postgres trigger (trg_set_school_confidence_score
// -> compute_school_confidence_score(), a different weighting) on every write.
// This function isn't called anywhere in the app today; kept here in sync with
// the DB formula's field set only so it doesn't silently drift and mislead
// anyone reading the JS side later. See compute_school_confidence_score in the
// database for the formula that actually runs.
export function computeConfidenceScore(school) {
  const hasName = !isBlank(school.hc_first_name) || !isBlank(school.hc_last_name);
  const hasValidEmail = !isBlank(school.hc_email) && isValidEmail(school.hc_email);
  const hasValidPhone = (!isBlank(school.hc_cell) && isValidPhone(school.hc_cell)) || (!isBlank(school.hc_office) && isValidPhone(school.hc_office));
  const hasWebPresence = !isBlank(school.website) || !isBlank(school.maxpreps_url) || !isBlank(school.athletics_url);
  const isVerified = school.verification_status === "verified";

  let score = 0;
  if (hasName) score += 20;
  if (hasValidEmail) score += 25;
  if (hasValidPhone) score += 20;
  if (hasWebPresence) score += 15;
  if (isVerified) score += 20;
  return score;
}

// Shared "is this school's record fully worked" check -- used by the
// Coach-Change Radar report (app/(app)/admin/data-quality/page.js, to
// auto-clear a row and update its live remaining-count) AND by that
// report's daily digest email (app/api/cron/verifier-digest/route.js), so
// the two surfaces can never quietly disagree about what counts as done.
// Deliberately independent of which specific check flagged a school in
// the first place (not found, could not load, no coach on file, etc.) --
// landing in the radar report is treated as a cue to do a full pass on
// the record, not just patch the one field that tripped the flag.
export function hasFullCoachRecord(school) {
  if (!school) return false;
  const hasCoachInfo = !isBlank(school.hc_first_name) && !isBlank(school.hc_last_name) && !isBlank(school.hc_email);
  const hasAthletics = !isBlank(school.athletics_url);
  const hasMaxpreps = !isBlank(school.maxpreps_url);
  const hasSocial = !isBlank(school.hc_twitter) || !isBlank(school.hc_facebook);
  return hasCoachInfo && hasAthletics && hasMaxpreps && hasSocial;
}
