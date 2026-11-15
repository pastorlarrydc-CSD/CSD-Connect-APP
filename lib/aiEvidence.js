// lib/aiEvidence.js
//
// Evidence checks for AI coach-info suggestions. Pure functions -- no imports,
// no network -- so the single-school route, both batch collectors and the
// Needs Review queue can share them and they can be tested with plain Node.
//
// Why this exists (Nov 2026). A suggestion used to be only as trustworthy as
// the model's own say-so. Three things kept going wrong:
//   1. A name or email the page never actually showed (nothing in the code
//      could tell).
//   2. A stale page (a staff list from last season, e.g. Howards Grove still
//      showing a coach who had left) treated like fresh evidence.
//   3. Confidence "high" resting on nothing a reviewer could look at.
//
// The fix is to make the model SHOW ITS WORK and then check the work in code:
//   - evidence_quote       a verbatim line from the sources that names the coach
//   - evidence_url         the source block it came from
//   - evidence_date        the date/season as printed in that source (verbatim)
//   - recency_date         a dated current-season proof-of-life as printed
//                          (score, recap, news item) (verbatim)
//   - email_evidence_quote a verbatim line showing the coach's email
// Each quote is looked up in the exact text that was sent to the model. A quote
// that cannot be found is treated as not shown. Checks only ever LOWER
// confidence (high -> medium) and add a note; they never raise it.

const MONTHS = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3, may: 4, jun: 5, june: 5,
  jul: 6, july: 6, aug: 7, august: 7, sep: 8, sept: 8, september: 8, oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11,
};

function clean(v) {
  return String(v == null ? "" : v).trim();
}

// The message sent to the model also carries a "currently on file" block (old,
// explicitly unverified data). It is not evidence, so every check below ignores
// it: a "quote" lifted from that block must never count as proof.
export function stripOnFileBlock(sourceText) {
  const text = String(sourceText || "");
  const start = text.indexOf("(Not independently verified");
  if (start < 0) return text;
  const end = text.indexOf("\n\n", start);
  return end < 0 ? text.slice(0, start) : text.slice(0, start) + text.slice(end + 2);
}

// Lowercase alphanumeric word tokens. Punctuation, markdown and spacing
// differences between a quote and its source never matter.
export function tokens(s) {
  return clean(s)
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

// -> { verified, coverage }
// A quote is "found" when at least 80% of its word-trigrams occur somewhere in
// the source text (tolerates a dropped comma, an ellipsis or a trimmed word,
// but not an invented sentence). Quotes shorter than 3 words must appear
// exactly (as token sequences).
export function verifyQuote(quote, sourceText) {
  const q = tokens(quote);
  if (q.length === 0) return { verified: false, coverage: 0 };
  const src = tokens(sourceText);
  if (src.length === 0) return { verified: false, coverage: 0 };
  if (q.length < 3) {
    const joined = ` ${src.join(" ")} `;
    const found = joined.includes(` ${q.join(" ")} `);
    return { verified: found, coverage: found ? 1 : 0 };
  }
  const grams = new Set();
  for (let i = 0; i + 2 < src.length; i++) grams.add(`${src[i]} ${src[i + 1]} ${src[i + 2]}`);
  let total = 0;
  let hit = 0;
  for (let i = 0; i + 2 < q.length; i++) {
    total++;
    if (grams.has(`${q[i]} ${q[i + 1]} ${q[i + 2]}`)) hit++;
  }
  const coverage = total ? hit / total : 0;
  return { verified: coverage >= 0.8, coverage: Math.round(coverage * 100) / 100 };
}

// True when the exact email address appears in the source text.
export function emailInSource(email, sourceText) {
  const e = clean(email).toLowerCase();
  if (!e || !e.includes("@")) return false;
  return String(sourceText || "").toLowerCase().includes(e);
}

// Last-name key (generational suffix dropped), same idea as coachEmailFit.
const SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv", "v"]);
function lastKey(name) {
  const t = tokens(name);
  while (t.length > 1 && SUFFIXES.has(t[t.length - 1])) t.pop();
  return t.join("");
}

// Does the quote actually mention the coach it is supposed to be about?
export function quoteNamesCoach(quote, first, last) {
  const lk = lastKey(last);
  if (lk.length < 2) return false;
  const q = tokens(quote).join("");
  return q.includes(lk);
}

// ---- dates and seasons ---------------------------------------------------

// A football season runs fall to the next summer: June 2026 -> May 2027 is the
// "2026" season.
export function currentSeasonYear(now = new Date()) {
  return now.getUTCMonth() >= 5 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
}

function seasonOfDate(d) {
  return d.getUTCMonth() >= 5 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
}

// Pulls the most recent date or season label out of free text as printed.
// -> { date: Date|null, seasonYear: number|null } or null when nothing parses.
export function parseDateText(text) {
  const t = clean(text);
  if (!t) return null;
  let best = null;
  const consider = (d) => {
    if (d && !Number.isNaN(d.getTime()) && (!best || d > best)) best = d;
  };
  let m;
  // 2026-09-10
  const iso = /(20\d\d)-(\d{1,2})-(\d{1,2})/g;
  while ((m = iso.exec(t))) consider(new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])));
  // September 10, 2026 / Sept. 10 2026 / Sep 10, 2026
  const long = /\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(20\d\d)\b/g;
  while ((m = long.exec(t))) {
    const mon = MONTHS[m[1].toLowerCase()];
    if (mon !== undefined) consider(new Date(Date.UTC(+m[3], mon, +m[2])));
  }
  // 10 September 2026
  const dmy = /\b(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(20\d\d)\b/g;
  while ((m = dmy.exec(t))) {
    const mon = MONTHS[m[2].toLowerCase()];
    if (mon !== undefined) consider(new Date(Date.UTC(+m[3], mon, +m[1])));
  }
  // 9/10/2026 or 9/10/26
  const us = /\b(\d{1,2})\/(\d{1,2})\/(20\d\d|\d\d)\b/g;
  while ((m = us.exec(t))) {
    const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    consider(new Date(Date.UTC(y, +m[1] - 1, +m[2])));
  }
  // Season labels: 2026-27, 2026-2027, 2026/27
  let seasonYear = null;
  const season = /\b(20\d\d)\s*[-–/]\s*(20\d\d|\d\d)\b/g;
  while ((m = season.exec(t))) {
    const y = +m[1];
    const end = m[2].length === 2 ? Math.floor(y / 100) * 100 + +m[2] : +m[2];
    if (end === y + 1 && (seasonYear === null || y > seasonYear)) seasonYear = y;
  }
  if (!best && seasonYear === null) return null;
  return { date: best, seasonYear };
}

// "current" | "older" | "stale" | "undated" for one dated piece of evidence.
//   current  this season's staff/scores (or dated in the last 120 days)
//   older    last season's (still within about 15 months)
//   stale    older than that
export function freshnessOf(parsed, now = new Date()) {
  if (!parsed) return "undated";
  const cur = currentSeasonYear(now);
  let season = parsed.seasonYear;
  if (parsed.date) {
    const s = seasonOfDate(parsed.date);
    season = season === null || s > season ? s : season;
    const ageDays = (now.getTime() - parsed.date.getTime()) / 86400000;
    if (ageDays <= 120 && ageDays >= -30) return "current";
    if (ageDays > 460) return season >= cur ? "current" : "stale";
  }
  if (season === null) return "undated";
  if (season >= cur) return "current";
  if (season === cur - 1) return "older";
  return "stale";
}

const RANK = { current: 3, older: 2, stale: 1, undated: 0 };

// ---- the main check ------------------------------------------------------

// Reads the model's evidence fields, checks them against the exact text the
// model was given, and returns { evidence, cap, notesPrefix } where
//   evidence  is stored on the suggestion for the review screens,
//   cap       is "medium" when high confidence is not supported (else null),
//   notesPrefix is a short warning to prepend to the notes (or "").
//
// `parsed` is the raw model JSON. When it carries none of the evidence keys the
// run predates this check (a batch submitted before the prompt change) and the
// result is { evidence: { checked: false } } with no cap, so old runs are not
// penalised retroactively.
export function checkEvidence({ parsed, sourceText: fullSourceText, hc_first_name, hc_last_name, hc_email, hc_email_estimated, now = new Date() }) {
  const sourceText = stripOnFileBlock(fullSourceText);
  const keys = ["evidence_quote", "evidence_url", "evidence_date", "recency_date", "email_evidence_quote"];
  const hasKeys = keys.some((k) => parsed && Object.prototype.hasOwnProperty.call(parsed, k));
  if (!hasKeys || !clean(sourceText)) return { evidence: { checked: false }, cap: null, notesPrefix: "" };

  const hasName = Boolean(clean(hc_first_name) || clean(hc_last_name));
  const quote = clean(parsed.evidence_quote).slice(0, 400);
  const url = clean(parsed.evidence_url).slice(0, 300);
  const dateText = clean(parsed.evidence_date).slice(0, 80);
  const recencyText = clean(parsed.recency_date).slice(0, 80);
  const emailQuote = clean(parsed.email_evidence_quote).slice(0, 400);

  const q = quote ? verifyQuote(quote, sourceText) : { verified: false, coverage: 0 };
  const nameVerified = hasName ? q.verified && quoteNamesCoach(quote, hc_first_name, hc_last_name) : null;
  // A link is only offered to the reviewer when it really appears in the
  // sources the model was given.
  const urlVerified = url ? String(sourceText).includes(url) : null;

  // Dates must be shown verbatim in the sources too; a date that cannot be
  // found counts as no date.
  const dateFound = dateText ? verifyQuote(dateText, sourceText).verified || String(sourceText).toLowerCase().includes(dateText.toLowerCase()) : false;
  const recencyFound = recencyText ? verifyQuote(recencyText, sourceText).verified || String(sourceText).toLowerCase().includes(recencyText.toLowerCase()) : false;
  const fNames = freshnessOf(dateFound ? parseDateText(dateText) : null, now);
  const fRecency = freshnessOf(recencyFound ? parseDateText(recencyText) : null, now);
  const freshness = RANK[fNames] >= RANK[fRecency] ? fNames : fRecency;

  const email = clean(hc_email);
  let emailVerified = null;
  if (email) {
    if (hc_email_estimated) emailVerified = false; // a pattern guess is never "seen"
    else emailVerified = emailInSource(email, sourceText) && (emailQuote ? emailInSource(email, emailQuote) || verifyQuote(emailQuote, sourceText).verified : true);
  }

  const problems = [];
  if (hasName && !nameVerified) {
    problems.push(quote ? "its quote naming the coach could not be found in the sources it was given" : "it gave no quote naming the coach");
  }
  if (email && !hc_email_estimated && emailVerified === false) problems.push("the email address does not appear in the sources it was given");
  if (hasName && freshness !== "current") {
    problems.push(
      freshness === "undated"
        ? "no dated, current-season evidence was shown"
        : freshness === "older"
        ? "the only dated evidence is from last season"
        : "the only dated evidence is more than a season old"
    );
  }

  const cap = problems.length > 0 ? "medium" : null;
  const notesPrefix = problems.length > 0 ? `⚠️ Evidence check: ${problems.join("; ")}. Treat as unconfirmed until you see it on the page. ` : "";

  return {
    evidence: {
      checked: true,
      name_quote: quote,
      name_quote_verified: nameVerified,
      name_quote_coverage: q.coverage,
      source_url: urlVerified === false ? "" : url,
      source_url_verified: urlVerified,
      source_date: dateFound ? dateText : "",
      recency_date: recencyFound ? recencyText : "",
      freshness,
      email_quote: emailQuote,
      email_verified: emailVerified,
      problems,
    },
    cap,
    notesPrefix,
  };
}

// Short label for the review screens.
export function freshnessLabel(f) {
  if (f === "current") return "Current season";
  if (f === "older") return "Last season";
  if (f === "stale") return "Stale";
  return "Undated";
}
