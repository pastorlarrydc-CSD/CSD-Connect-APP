// Shared helpers for "cell history" -- reconstructing which coach a phone
// number (or any coach-contact field) belonged to at a past point in time,
// purely from school_change_log rows already being written by every save
// path in the app (Quick Fix, Apply, Mark Coach Change, bulk upload,
// coach-submitted corrections, needs-review confirms). No new schema: this
// derives the answer "based on the information in the schools," per
// Larry's own framing of the request, rather than adding a parallel
// snapshot column that every write site would need to remember to fill in.
// Used by app/(app)/admin/data-quality/page.js (Coach Change History's
// "coach at the time" hint, the Cell Number Lookup reverse search, the
// Duplicate Cell Numbers alert, and their social-handle counterparts,
// Social Handle Lookup and Duplicate Social Handles) and
// app/(app)/schools/[id]/page.js (the per-school Contact History panel).

// Digits-only comparison key for phone numbers, so "615-555-1234",
// "(615) 555-1234", "+1 615 555 1234", and "6155551234" all match each
// other regardless of how any particular record happened to be typed in.
export function phoneDigits(v) {
  if (!v) return "";
  return String(v).replace(/\D/g, "");
}

// Comparison key for a Twitter/X or Facebook handle-or-URL, so
// "https://x.com/CoachSmith", "https://twitter.com/CoachSmith",
// "@CoachSmith", and "coachsmith" all match each other the same way
// phoneDigits() normalizes phone numbers -- strips protocol, the common
// twitter.com/x.com/facebook.com/fb.com hosts (with or without www./m.),
// a leading "@", a trailing slash, and any query string, then lowercases
// what's left. Used by the Social Handle Lookup reverse search and the
// Duplicate Social Handles check, same role phoneDigits plays for their
// cell-number counterparts.
export function socialHandleKey(v) {
  if (!v) return "";
  let s = String(v).trim().toLowerCase();
  s = s.replace(/^https?:\/\//, "");
  s = s.replace(/^(www\.|m\.)/, "");
  s = s.replace(/^(twitter\.com|x\.com|facebook\.com|fb\.com)\//, "");
  s = s.split("?")[0];
  s = s.replace(/\/+$/, "");
  s = s.replace(/^@/, "");
  return s;
}

// Given every school_change_log row for ONE school that touches
// hc_first_name or hc_last_name -- order doesn't matter, this sorts them
// itself -- plus that school's CURRENT hc_first_name/hc_last_name, return
// the head coach's full name as it stood at a given timestamp.
//
// Logic per field: find the latest logged change at or before the target
// timestamp and use its new_value (that's what was live at that instant).
// If nothing was logged at or before the target but a change WAS logged
// after it, the value just before that earliest later change is what was
// live at the target -- use that change's old_value. If the field was
// never logged as changed at all (the common case for a name that's been
// constant for as long as the log covers, e.g. set once at import and
// never touched since), fall back to the school's current live value --
// the best available answer without a change to point to otherwise.
export function resolveCoachNameAt(nameLogRows, targetChangedAt, currentSchool) {
  const targetMs = new Date(targetChangedAt).getTime();

  function valueForField(field) {
    const rows = (nameLogRows || [])
      .filter((r) => r.field_name === field)
      .slice()
      .sort((a, b) => new Date(a.changed_at) - new Date(b.changed_at));

    let atOrBefore = null;
    for (const r of rows) {
      if (new Date(r.changed_at).getTime() <= targetMs) atOrBefore = r;
    }
    if (atOrBefore) return atOrBefore.new_value || "";

    const after = rows.find((r) => new Date(r.changed_at).getTime() > targetMs);
    if (after) return after.old_value || "";

    return currentSchool?.[field] || "";
  }

  const full = [valueForField("hc_first_name"), valueForField("hc_last_name")].filter(Boolean).join(" ").trim();
  return full || null;
}
