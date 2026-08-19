// Shared logic for checking whether a school's own website still shows the
// on-file head coach's name. Used by both the on-demand "Check for updates"
// button (app/api/schools/[id]/recheck) and the nightly automated sweep
// (app/api/cron/recheck-schools) -- one source of truth for the actual
// fetch-and-match logic so the two never drift apart.
const FETCH_TIMEOUT_MS = 8000;
const MAX_BYTES = 400_000;

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

  let text;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: { "User-Agent": "CSD-CoachConnect-Verifier/1.0 (+https://csd-coachconnect)" },
    });
    clearTimeout(timeout);
    if (!res.ok) {
      return { result: "fetch_error", detail: `Site responded with HTTP ${res.status}.` };
    }
    const buf = await res.arrayBuffer();
    const truncated = buf.byteLength > MAX_BYTES ? buf.slice(0, MAX_BYTES) : buf;
    text = stripToText(Buffer.from(truncated).toString("utf-8"));
  } catch (fetchErr) {
    return {
      result: "fetch_error",
      detail: fetchErr.name === "AbortError" ? "The site took too long to respond." : "Could not reach this website.",
    };
  }

  if (text.includes(lastName.toLowerCase())) {
    return { result: "confirmed", detail: `"${lastName}" was found on ${school.website}.` };
  }

  return { result: "not_found", detail: `"${lastName}" was not found on ${school.website}. Flagged for a verifier to review.` };
}
