// Shared by the Needs Review queue API (app/api/admin/needs-review/route.js)
// and its confirm route (.../confirm/route.js).
//
// A school can be queued from the Needs Review page into a Batch Coach-Info
// Discovery run (an AI web-search check of who the head coach is right now).
// When that run is collected, a school whose on-file coach ALREADY matches
// what the AI found leaves nothing to apply -- the batch tool correctly
// writes nothing -- so on its own that result would never clear the school's
// Needs Review flag. compareSuggestion() reads such a result against the
// school's current data and says which kind it is, so the queue can show it
// and offer a one-click "Confirm AI-matched".
//
// Strict on purpose: only a result that names the SAME coach AND the SAME
// email as on file, at high confidence and not a pattern-guessed email, is
// confirmable. Everything else is shown to the reviewer but never bulk-
// confirmed. The confirm route re-runs this on the server, so the button
// can't be used to confirm something the AI did not actually match.

// An AI check only counts while it's recent: coaching staffs turn over, so a
// result from months ago says little about who the coach is today. Older
// results are ignored (the school shows as not AI-checked and can be queued
// again).
export const AI_CHECK_MAX_AGE_DAYS = 60;

// Only results from a "re_verify" run count. That mode uses the open,
// identity-confirming search (it looks for who the coach IS rather than
// checking a name we already hold). Other modes would make a "match"
// meaningless here: "missing_email" runs search for the on-file name
// (anchored, so it tends to agree with itself), and "bounce_recovery" runs
// start from an email that hard-bounced -- an AI result echoing that same
// address must never confirm it.
export const AI_TRUSTED_MODE = "re_verify";

export function isFreshAiCheck(collectedAt) {
  if (!collectedAt) return true; // collected by a path that doesn't stamp collected_at -- trust it
  const t = new Date(collectedAt).getTime();
  if (Number.isNaN(t)) return true;
  return Date.now() - t <= AI_CHECK_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
}

function norm(v) {
  return String(v == null ? "" : v).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function normEmail(v) {
  return String(v == null ? "" : v).trim().toLowerCase();
}

// -> { status, confidence, confirmable, suggestedName, suggestedEmail }
// status: "matches"    same coach name and same email as on file
//         "name_ok"    same coach name, but the email differs / was not found / was guessed
//         "differs"    the AI found a different head coach name
//         "no_result"  the AI returned nothing usable
export function compareSuggestion(school, suggestion) {
  const s = suggestion || null;
  const suggestedName = s ? [s.hc_first_name, s.hc_last_name].filter(Boolean).join(" ") : "";
  const suggestedEmail = s ? String(s.hc_email || "").trim() : "";
  const confidence = s?.confidence || null;
  if (!s || !(s.hc_first_name || s.hc_last_name)) {
    return { status: "no_result", confidence, confirmable: false, suggestedName, suggestedEmail };
  }
  const nameOk = norm(s.hc_first_name) === norm(school.hc_first_name) && norm(s.hc_last_name) === norm(school.hc_last_name);
  if (!nameOk) {
    return { status: "differs", confidence, confirmable: false, suggestedName, suggestedEmail };
  }
  const emailOk = !!suggestedEmail && normEmail(suggestedEmail) === normEmail(school.hc_email) && !s.hc_email_estimated;
  if (!emailOk) {
    return { status: "name_ok", confidence, confirmable: false, suggestedName, suggestedEmail };
  }
  return { status: "matches", confidence, confirmable: confidence === "high", suggestedName, suggestedEmail };
}
