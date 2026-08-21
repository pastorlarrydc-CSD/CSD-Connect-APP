// Shared logic for checking whether a school's own website (and, as a
// fallback, its MaxPreps roster page) still shows the on-file head coach's
// name. Used by both the on-demand "Check for updates" button
// (app/api/schools/[id]/recheck) and the nightly automated sweep
// (app/api/cron/recheck-schools) -- one source of truth for the actual
// fetch-and-match logic so the two never drift apart.
const FETCH_TIMEOUT_MS = 8000;
const MAX_BYTES = 400_000;
const USER_AGENT = "CSD-CoachConnect-Verifier/1.0 (+https://csd-coachconnect)";

export function withProtocol(v) {
  const trimmed = (v || "").trim();
  if (!trimmed) return null;
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

export function stripToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

async function fetchPageText(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: { "User-Agent": USER_AGENT },
    });
    if (!res.ok) {
      return { ok: false, httpStatus: res.status };
    }
    const buf = await res.arrayBuffer();
    const truncated = buf.byteLength > MAX_BYTES ? buf.slice(0, MAX_BYTES) : buf;
    return { ok: true, text: stripToText(Buffer.from(truncated).toString("utf-8")) };
  } catch (fetchErr) {
    return { ok: false, timedOut: fetchErr.name === "AbortError" };
  } finally {
    clearTimeout(timeout);
  }
}

// Fetches the school's own website and checks for the on-file head coach's
// last name. Read-only -- never touches the database itself; callers are
// responsible for logging the result and opening a flag on a miss.
export async function checkSchoolWebsite(school) {
  const lastName = (school.hc_last_name || "").trim();
  if (!lastName) {
    return { result: "no_coach_on_file", detail: "No head coach on file to check against the website." };
  }

  const url = withProtocol(school.website);
  if (!url) {
    return { result: "no_website", detail: "No website on file for this school." };
  }

  const fetched = await fetchPageText(url);
  if (!fetched.ok) {
    return {
      result: "fetch_error",
      detail: fetched.timedOut ? "The site took too long to respond." : fetched.httpStatus ? `Site responded with HTTP ${fetched.httpStatus}.` : "Could not reach this website.",
    };
  }

  if (fetched.text.includes(lastName.toLowerCase())) {
    return { result: "confirmed", detail: `"${lastName}" was found on ${school.website}.` };
  }

  return { result: "not_found", detail: `"${lastName}" was not found on ${school.website}. Flagged for a verifier to review.` };
}

// Checks a MaxPreps roster/team page for the coach's last name. Same
// read-only contract as checkSchoolWebsite; returns a simple ok/detail pair
// rather than a full result code since it's only ever used as a fallback
// source, not the primary result.
async function checkMaxPrepsPage(maxprepsUrl, lastName) {
  const fetched = await fetchPageText(maxprepsUrl);
  if (!fetched.ok) {
    return { ok: false, detail: fetched.timedOut ? "MaxPreps took too long to respond" : fetched.httpStatus ? `MaxPreps responded with HTTP ${fetched.httpStatus}` : "could not reach MaxPreps" };
  }
  return fetched.text.includes(lastName.toLowerCase())
    ? { ok: true, detail: "found on the MaxPreps roster page" }
    : { ok: false, detail: "name not found on the MaxPreps roster page" };
}

// Coach-Change Radar: checks the school's own website first (via
// checkSchoolWebsite, unchanged), and only reaches for the school's MaxPreps
// page -- when one is on file -- if that primary check didn't confirm the
// coach: no website at all, the site didn't load, or the name just wasn't
// found. A MaxPreps confirmation overrides the result so the school isn't
// flagged; a MaxPreps miss (or no MaxPreps URL on file) leaves the original
// result code untouched so the existing "N misses in a row" flagging logic
// in the nightly sweep keeps working exactly as it did before this existed.
export async function checkSchoolCoach(school) {
  const lastName = (school.hc_last_name || "").trim();
  const primary = await checkSchoolWebsite(school);
  if (!lastName) return primary;

  const needsFallback = primary.result === "not_found" || primary.result === "no_website" || primary.result === "fetch_error";
  const maxprepsUrl = withProtocol(school.maxpreps_url);
  if (!needsFallback || !maxprepsUrl) {
    return primary;
  }

  const mp = await checkMaxPrepsPage(maxprepsUrl, lastName);
  if (mp.ok) {
    return {
      result: "confirmed_maxpreps",
      detail: `Not confirmed on the school website (${primary.detail}), but "${lastName}" was ${mp.detail}.`,
    };
  }

  return {
    result: primary.result,
    detail: `${primary.detail} MaxPreps was also checked and ${mp.detail}.`,
  };
}
