// Shared logic for checking whether a school's coaching staff page(s) still
// show the on-file head coach's name. Used by both the on-demand "Check for
// updates" button (app/api/schools/[id]/recheck) and the nightly automated
// sweep (app/api/cron/recheck-schools) -- one source of truth for the
// actual fetch-and-match logic so the two never drift apart.
//
// Check order, and why: athletics site first, then the general school
// website, then MaxPreps as a last resort. A school's general homepage
// almost never lists the head football coach by name -- that's usually a
// couple of clicks deep, under Athletics -> Staff Directory. A dedicated
// athletics site (its own domain, or a subdomain/section run through a
// platform like rSchoolToday or SportsEngine) is far more likely to have a
// coaches list right on the page this checks. Trying it first means a
// school with a good athletics site gets confirmed correctly instead of
// generating a false "not found" flag just because the general homepage
// doesn't mention coaches at all.
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

// Fetches one page and checks it for the coach's last name. Read-only, and
// deliberately generic (no result codes, no DB awareness) -- checkSchoolCoach
// below is the only place that turns this into a result code, so athletics
// site, website, and MaxPreps can all share this same primitive.
async function checkUrlForCoach(url, lastName) {
  const fetched = await fetchPageText(url);
  if (!fetched.ok) {
    return {
      ok: false,
      fetchFailed: true,
      detail: fetched.timedOut ? "took too long to respond" : fetched.httpStatus ? `responded with HTTP ${fetched.httpStatus}` : "could not be reached",
    };
  }
  return fetched.text.includes(lastName.toLowerCase())
    ? { ok: true, fetchFailed: false, detail: "found" }
    : { ok: false, fetchFailed: false, detail: "the name was not found on the page" };
}

// Checks a MaxPreps roster/team page for the coach's last name. Same
// read-only contract as checkUrlForCoach; returns a simple ok/detail pair
// since it's only ever used as the last-resort fallback, not a primary
// result.
async function checkMaxPrepsPage(maxprepsUrl, lastName) {
  const fetched = await fetchPageText(maxprepsUrl);
  if (!fetched.ok) {
    return { ok: false, detail: fetched.timedOut ? "MaxPreps took too long to respond" : fetched.httpStatus ? `MaxPreps responded with HTTP ${fetched.httpStatus}` : "could not reach MaxPreps" };
  }
  return fetched.text.includes(lastName.toLowerCase())
    ? { ok: true, detail: "found on the MaxPreps roster page" }
    : { ok: false, detail: "name not found on the MaxPreps roster page" };
}

// Coach-Change Radar: tries the athletics site (if one's on file), then the
// general school website, then MaxPreps as a last resort -- stopping at
// the first confirmation. If none of them confirm the coach, the result
// code reflects the LAST tier actually attempted (fetch_error if that page
// wouldn't load, not_found if it loaded but the name wasn't on it), same
// two codes the nightly sweep's "N misses in a row" flagging logic has
// always keyed off of -- this only changes which page(s) get checked
// first, not the result vocabulary a caller sees.
export async function checkSchoolCoach(school) {
  const lastName = (school.hc_last_name || "").trim();
  if (!lastName) {
    return { result: "no_coach_on_file", detail: "No head coach on file to check against the website." };
  }

  const athleticsUrl = withProtocol(school.athletics_url);
  const websiteUrl = withProtocol(school.website);
  const maxprepsUrl = withProtocol(school.maxpreps_url);

  if (!athleticsUrl && !websiteUrl) {
    if (maxprepsUrl) {
      const mp = await checkMaxPrepsPage(maxprepsUrl, lastName);
      if (mp.ok) {
        return { result: "confirmed_maxpreps", detail: `No website or athletics site on file, but "${lastName}" was ${mp.detail}.` };
      }
      return { result: "no_website", detail: `No website or athletics site on file for this school. MaxPreps was also checked and ${mp.detail}.` };
    }
    return { result: "no_website", detail: "No website or athletics site on file for this school." };
  }

  let lastAttempt = null;

  if (athleticsUrl) {
    const athletics = await checkUrlForCoach(athleticsUrl, lastName);
    if (athletics.ok) {
      return { result: "confirmed", detail: `"${lastName}" was found on the athletics site (${school.athletics_url}).` };
    }
    lastAttempt = { source: "the athletics site", url: school.athletics_url, ...athletics };
  }

  if (websiteUrl) {
    const website = await checkUrlForCoach(websiteUrl, lastName);
    if (website.ok) {
      return { result: "confirmed", detail: `"${lastName}" was found on ${school.website}.` };
    }
    lastAttempt = { source: "the school website", url: school.website, ...website };
  }

  const primaryResult = lastAttempt.fetchFailed ? "fetch_error" : "not_found";
  const primaryDetail =
    primaryResult === "fetch_error"
      ? `Could not reach ${lastAttempt.source} (${lastAttempt.url}) -- it ${lastAttempt.detail}.`
      : `"${lastName}" was not found on ${lastAttempt.source} (${lastAttempt.url}). Flagged for a verifier to review.`;

  if (maxprepsUrl) {
    const mp = await checkMaxPrepsPage(maxprepsUrl, lastName);
    if (mp.ok) {
      return {
        result: "confirmed_maxpreps",
        detail: `Not confirmed on ${lastAttempt.source} (${primaryDetail}), but "${lastName}" was ${mp.detail}.`,
      };
    }
    return { result: primaryResult, detail: `${primaryDetail} MaxPreps was also checked and ${mp.detail}.` };
  }

  return { result: primaryResult, detail: primaryDetail };
}
