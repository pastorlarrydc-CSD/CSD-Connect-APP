// Shared logic for "Bulk Paste & Parse" -- the AI-structuring step behind
// Import & Reconcile's "paste research text" upload path (see that page's
// handlePasteParse). Turns a block of a reviewer's OWN already-done
// research -- the same kind of messy "AI research" paste Larry has been
// handing to Claude by hand, one school at a time, all week -- into the
// exact same canonical row shape lib/importReconcile.js's categorizeRow()
// already expects from a CSV row.
//
// Deliberately NOT a web-search/verification step, unlike
// lib/coachInfoLookup.js -- this trusts the human's own research and only
// structures it. That's also why it gets no same-name-school or
// wrong-coach backstop of its own: whatever comes back here is fed straight
// into categorizeRow() by the caller, so it inherits that tool's existing
// safety net for free -- an ambiguous school name+state match still lands
// in "needs_verification" (pick a candidate or send to AI lookup) and a
// changed coach name on an existing school still shows up as a "conflict"
// a human has to approve field-by-field, exactly like a CSV row would.
import { parseModelJson } from "./coachInfoLookup";

// Output budget for the parse call. Bigger than a single-school suggestion
// (RESPONSE_MAX_TOKENS in coachInfoLookup.js, tuned for one school) since a
// paste can cover several schools' worth of fields plus a notes/source
// sentence each.
export const BULK_PARSE_MAX_TOKENS = 4096;

// Rough cap on how much text one parse call accepts. Keeps the call fast,
// and keeps the model from running out of its own output budget partway
// through a long list of schools -- which otherwise looks like a plain JSON
// parse failure below, not a clear "paste less at once" message. Larry can
// just paste in two batches for anything larger than this.
export const BULK_PARSE_MAX_INPUT_CHARS = 20000;

export const BULK_PARSE_FIELDS = [
  "name",
  "state",
  "city",
  "school_type",
  "addr1",
  "addr2",
  "county",
  "zip",
  "classification",
  "phone",
  "website",
  "athletics_url",
  "maxpreps_url",
  "hc_first_name",
  "hc_last_name",
  "hc_email",
  "hc_cell",
  "hc_office",
  "x_twitter",
  "ad_name",
  "ad_email",
];

export const BULK_PARSE_SYSTEM_PROMPT = `You are helping a college recruiting data company structure research a staff member has ALREADY DONE about one or more high school football programs. The text you are given is the staff member's own trusted research (notes, pasted web results, roster pages, etc.) -- your job is only to structure it, never to search for new information, verify it, or add anything that isn't already stated in the text.

Read the whole input, split it into one block per distinct high school, and return ONLY this JSON shape -- no prose before or after it, no markdown code fences:

{ "schools": [ { "name": "", "state": "", "city": "", "school_type": "", "addr1": "", "addr2": "", "county": "", "zip": "", "classification": "", "phone": "", "website": "", "athletics_url": "", "maxpreps_url": "", "hc_first_name": "", "hc_last_name": "", "hc_email": "", "hc_cell": "", "hc_office": "", "x_twitter": "", "ad_name": "", "ad_email": "", "source_excerpt": "", "notes": "" } ] }

Rules:
- One object per distinct school. If the text only covers one school, still return an array with exactly one object.
- "state" must be the 2-letter USPS abbreviation (e.g. "TN", not "Tennessee").
- Leave any field "" (empty string) if the text doesn't clearly state it for THAT school. Never guess, infer from general knowledge, or carry a value over from a different school in the same input -- an empty field the human fills in themselves is always safer than a wrong guess.
- CRITICAL -- do not blend schools together. If two schools in the input share a similar name, city, or mascot, keep every fact strictly with the school block it actually came from. When in doubt which school a fact belongs to, leave it out rather than assign it to the wrong one.
- Only extract the HEAD FOOTBALL COACH into hc_first_name/hc_last_name -- not an athletic director, not a coach of another sport, not a former/past coach unless the text says they're still current. If it's ambiguous which sport or role a name belongs to, leave hc_first_name/hc_last_name blank and say why in "notes".
- "source_excerpt": a short (under 200 characters) verbatim quote from the input that this school's info was drawn from, so a human can quickly spot-check the match.
- "notes": one short sentence flagging anything uncertain -- an ambiguous name, a field you deliberately left blank, or a possible mix-up with another school in the same input. Leave "" if nothing is uncertain.`;

function trimVal(v) {
  return v == null ? "" : String(v).trim();
}

// Normalizes one raw parsed-school object from the model into a clean
// record: trims every field, uppercases/truncates state to 2 letters, and
// keeps ONLY the known BULK_PARSE_FIELDS plus the two review-only metadata
// fields (source_excerpt/notes) -- anything else the model returned is
// dropped, so nothing unexpected ends up in a row's mapped_data (and,
// downstream, in a write to the schools table).
export function normalizeParsedSchool(raw) {
  const out = {};
  BULK_PARSE_FIELDS.forEach((f) => {
    const v = trimVal(raw?.[f]);
    if (!v) return;
    out[f] = f === "state" ? v.toUpperCase().slice(0, 2) : v;
  });
  const sourceExcerpt = trimVal(raw?.source_excerpt);
  const notes = trimVal(raw?.notes);
  if (sourceExcerpt) out.source_excerpt = sourceExcerpt;
  if (notes) out.notes = notes;
  return out;
}

// Parses the model's raw JSON text response into a clean array of school
// records. Returns null (not []) when the response couldn't be parsed at
// all -- distinct from "parsed fine, just found nothing" -- so the caller
// can tell a garbled/truncated response (usually a sign the input was too
// long -- see BULK_PARSE_MAX_INPUT_CHARS) apart from a genuinely empty
// paste. Rows missing a name or state are dropped here, same as
// categorizeRow() would bucket them as "skipped" anyway -- no point
// surfacing them as reviewable rows.
export function parseBulkSchools(rawText) {
  const parsed = parseModelJson(rawText);
  if (!parsed) return null;
  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.schools) ? parsed.schools : null;
  if (!list) return null;
  return list.map(normalizeParsedSchool).filter((s) => s.name && s.state);
}
