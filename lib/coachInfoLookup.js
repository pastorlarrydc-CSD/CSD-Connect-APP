// Shared coach-info AI lookup logic -- the search/fetch helpers, the model
// prompt, and the response parser used by BOTH the one-school-at-a-time
// "Suggest Coach Info (AI)" button (app/api/schools/[id]/discover-coach-info)
// and the overnight Batch API job (app/api/admin/batch-coach-info/*). One
// source of truth so the two never drift apart -- a prompt tweak made here
// improves both the single-school button and every future batch run.

export const FETCH_TIMEOUT_MS = 8000;
export const MAX_BYTES = 400_000;
export const MAX_CHARS_PER_SOURCE = 6000;
export const USER_AGENT = "CSD-CoachConnect-Verifier/1.0 (+https://csd-coachconnect)";
export const MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001";
export const SEARCH_RESULT_COUNT = 8;

export function htmlToText(html) {
  // Deliberately does NOT lowercase the result -- unlike lib/schoolRecheck.js's
  // stripToText (which only needs to substring-match a last name), this text
  // gets handed to the model to read names/emails out of, and preserving
  // original capitalization gives it a much better shot at getting a name's
  // casing right.
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

export async function fetchPageText(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: { "User-Agent": USER_AGENT },
    });
    if (!res.ok) return { ok: false, httpStatus: res.status };
    const buf = await res.arrayBuffer();
    const truncated = buf.byteLength > MAX_BYTES ? buf.slice(0, MAX_BYTES) : buf;
    return { ok: true, text: htmlToText(Buffer.from(truncated).toString("utf-8")) };
  } catch (fetchErr) {
    return { ok: false, timedOut: fetchErr.name === "AbortError" };
  } finally {
    clearTimeout(timeout);
  }
}

// Best-effort: a Serper hiccup here shouldn't sink the whole lookup if a
// school page did fetch successfully, so this returns an empty array on
// failure instead of throwing -- the caller decides whether anything usable
// came back overall.
export async function searchWeb(query, apiKey) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ q: query, num: SEARCH_RESULT_COUNT }),
      signal: controller.signal,
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) return [];
    return (payload.organic || [])
      .filter((item) => item.title && item.link)
      .slice(0, SEARCH_RESULT_COUNT)
      .map((item) => ({ title: item.title, link: item.link, snippet: item.snippet || "" }));
  } catch (_) {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

export const SYSTEM_PROMPT = `You are helping a college football recruiting staff verify high-school program contact information. You will be given search-engine results for the school's football program, and -- when available -- full text read from the school's athletics website and/or general website, plus whatever is currently on file. Find the CURRENT HEAD FOOTBALL COACH's name, email, phone number, Twitter/X handle, and Facebook page/profile, if they appear anywhere in what you're given.

Rules:
- Only extract information about FOOTBALL. Ignore coaches of other sports (basketball, baseball, soccer, track, etc.) even if they're listed right next to the football staff.
- If a source names an Athletic Director or a general athletics-office contact but no specific football head coach, do NOT use that person's name as the coach -- leave the name fields empty rather than guessing. A general office phone/email is still worth returning as a fallback office contact even with no coach named.
- Never invent or guess a name, email, phone number, Twitter/X handle, or Facebook link that isn't actually present in what you were given. Return empty strings for anything not found.
- For hc_twitter, only use a handle that is explicitly tied to this specific coach (their own bio, a byline, a "follow me" link next to their name) -- not the school's or program's general athletics/football account. Format it as "@handle". If only a program or team account is mentioned (not the coach personally), leave hc_twitter empty rather than guessing it belongs to the coach.
- For hc_facebook, the same rule applies: only a link/page clearly belonging to this coach personally, or -- since football coaches often don't keep a separate personal page -- the team's own official Facebook page IS acceptable here as a fallback, but say so in notes (e.g. "team page, not the coach's personal profile") so the reviewer knows which kind of link it is. Give the full URL.
- Search-result snippets are short and sometimes get cut off mid-sentence -- it's fine to use a name from a snippet (e.g. a "names John Smith new head coach" headline) even without the full article, but set confidence no higher than "medium" when you're relying on a snippet alone rather than full page text.
- If a source mentions a recent coaching change ("new head coach", "interim head coach", "as of [date]"), prefer the most current name and say so in notes.
- If different sources disagree on the name, prefer whichever is more recent or more directly tied to the school's own site, and mention the conflict in notes.
- Only fill hc_cell if a number is explicitly labeled as a cell/mobile/direct line for that coach. Otherwise put any phone number found in hc_office.
- Set confidence to "high" only when a name is clearly labeled as the football head coach in full page text (not just a search snippet). Use "medium" for real but ambiguous matches, or a clear match found only in a search snippet. Use "low" if you are only partially confident.
- Respond with ONLY a single JSON object, no other text, in exactly this shape:
{"hc_first_name": "", "hc_last_name": "", "hc_email": "", "hc_office": "", "hc_cell": "", "hc_twitter": "", "hc_facebook": "", "confidence": "high", "source": "web search", "notes": "one sentence describing what was found, or why fields were left empty"}`;

// Builds the Serper search query for a school. When a head coach is
// already on file (e.g. this school came through the batch tool's
// "missing email" targeting mode, or a human re-runs the single-school
// button on a school that already has a name), search for that specific
// person by name instead of the generic "who is the coach" query -- much
// more likely to surface their actual email/phone/social directly, rather
// than just re-confirming a name that's already known. Falls back to the
// original school-only query when no name is on file yet. Shared by both
// callers (same reasoning as everything else in this file) so a search
// strategy improved here helps both the batch job and the live button.
export function buildSearchQuery(school) {
  const knownCoachName = [school.hc_first_name, school.hc_last_name].filter(Boolean).join(" ").trim();
  return knownCoachName
    ? `"${knownCoachName}" ${school.name} football coach email contact`
    : `${school.name} ${school.city || ""} ${school.state || ""} head football coach`;
}

export function parseModelJson(text) {
  const trimmed = (text || "").trim();
  try {
    return JSON.parse(trimmed);
  } catch (_) {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch (_) {
        return null;
      }
    }
    return null;
  }
}

// Normalizes a raw parsed model response into the exact shape both callers
// return to their client -- trimmed strings, a validated confidence value,
// and a fallback source label built from whatever sources were actually
// usable.
export function normalizeSuggestion(parsed, defaultSource) {
  return {
    hc_first_name: (parsed.hc_first_name || "").toString().trim(),
    hc_last_name: (parsed.hc_last_name || "").toString().trim(),
    hc_email: (parsed.hc_email || "").toString().trim(),
    hc_office: (parsed.hc_office || "").toString().trim(),
    hc_cell: (parsed.hc_cell || "").toString().trim(),
    hc_twitter: (parsed.hc_twitter || "").toString().trim(),
    hc_facebook: (parsed.hc_facebook || "").toString().trim(),
    confidence: ["high", "medium", "low"].includes(parsed.confidence) ? parsed.confidence : "low",
    source: (parsed.source || defaultSource || "web search").toString(),
    notes: (parsed.notes || "").toString().trim(),
  };
}

// Builds the combined source text (fetched page(s) + search results) for a
// single school, and the "currently on file" summary block -- shared shape
// used both for the single-school route's live Anthropic call and for a
// batch item's saved source_text ahead of Batch API submission.
export function buildSourceBlocks({ school, athleticsFetch, websiteFetch, searchResults, searchQuery }) {
  const usableBlocks = [];
  if (athleticsFetch?.ok && athleticsFetch.text) usableBlocks.push({ label: "athletics site", url: school.athletics_url, text: athleticsFetch.text });
  if (websiteFetch?.ok && websiteFetch.text) usableBlocks.push({ label: "general website", url: school.website, text: websiteFetch.text });

  const pageTextBlocks = usableBlocks.map((b) => `--- Full text from the ${b.label} (${b.url}) ---\n${b.text.slice(0, MAX_CHARS_PER_SOURCE)}`);
  const searchBlock =
    searchResults && searchResults.length > 0
      ? `--- Web search results for "${searchQuery}" ---\n${searchResults.map((r, i) => `${i + 1}. ${r.title} (${r.link})\n   ${r.snippet}`).join("\n")}`
      : null;
  const textBlocks = [...pageTextBlocks, searchBlock].filter(Boolean).join("\n\n");

  const currentlyOnFile = [
    school.hc_first_name || school.hc_last_name ? `Head coach on file: ${[school.hc_first_name, school.hc_last_name].filter(Boolean).join(" ")}` : "Head coach on file: none",
    school.hc_email ? `Email on file: ${school.hc_email}` : "Email on file: none",
    school.hc_cell ? `Cell on file: ${school.hc_cell}` : null,
    school.hc_office ? `Office phone on file: ${school.hc_office}` : null,
    school.hc_twitter ? `Twitter/X on file: ${school.hc_twitter}` : null,
    school.hc_facebook ? `Facebook on file: ${school.hc_facebook}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  const defaultSource = [...usableBlocks.map((b) => b.label), searchResults && searchResults.length > 0 ? "web search" : null].filter(Boolean).join(" + ");

  return {
    hasUsableContent: usableBlocks.length > 0 || (searchResults && searchResults.length > 0),
    userMessage: `School: ${school.name}, ${school.city || ""}, ${school.state || ""}\n\n${currentlyOnFile}\n\n${textBlocks}`,
    defaultSource,
  };
}
