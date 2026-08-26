// Shared logic for the nightly Coaching-Change News Check
// (app/api/cron/coach-news-check) -- the search/prompt/parse helpers used
// to catch a head football coaching change straight from news coverage,
// instead of waiting for a school's own website to update (which can lag
// an actual hire by weeks or months). Mirrors the shape of
// lib/coachInfoLookup.js and lib/athleticsLookup.js -- same conventions,
// same MODEL default, reuses parseModelJson from lib/coachInfoLookup.js
// rather than duplicating it.

export const MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001";
export const MAX_TOKENS = 300;
export const NEWS_RESULT_COUNT = 8;
export const FETCH_TIMEOUT_MS = 8000;

// Best-effort: a Serper hiccup here just means this school gets treated as
// "no_results" for tonight and comes back up for a check another night --
// same fail-open shape as searchWeb() in lib/coachInfoLookup.js.
export async function searchNews(query, apiKey) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch("https://google.serper.dev/news", {
      method: "POST",
      headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ q: query, num: NEWS_RESULT_COUNT }),
      signal: controller.signal,
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) return [];
    return (payload.news || [])
      .filter((item) => item.title && item.link)
      .slice(0, NEWS_RESULT_COUNT)
      .map((item) => ({ title: item.title, link: item.link, snippet: item.snippet || "", date: item.date || "" }));
  } catch (_) {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

export const SYSTEM_PROMPT = `You are helping a college football recruiting staff catch high-school head-football-coaching changes as early as possible, straight from news coverage instead of waiting for a school's website to update. You will be given a school's name/city/state, whatever head coach is currently on file for them, and a set of Google News search results for that school.

Rules:
- Only report a change for FOOTBALL. Ignore hires/departures for any other sport (basketball, baseball, track, etc.) even if a result is about the same school.
- Match the school carefully by city/state -- many high schools around the country share the same or a similar name. If a result is clearly about a different school in a different city/state, ignore it and do not use it as evidence.
- Only set change_detected to true when a result specifically reports a NEW head football coach being hired, named, or introduced. Do NOT set it true for: a retirement/resignation announcement alone with no successor named, a season preview or game recap mentioning the existing coach, or an assistant/coordinator/other-sport hire.
- Snippets are short and sometimes cut off mid-sentence -- it's fine to extract a name from a headline/snippet alone, but set confidence no higher than "medium" when a headline/snippet is all you have, not full article text.
- If multiple results report the same hire, use the most detailed/most recent one and mention in notes if others corroborate it.
- If a result's date looks old (last season, a past year) relative to today, still report it if it's the best information available, but say so in notes -- the reviewer will judge how current it is themselves.
- Never invent a name that isn't actually present in the results.
- Respond with ONLY a single JSON object, no other text, in exactly this shape:
{"change_detected": false, "new_coach_name": "", "confidence": "high", "article_url": "", "article_date": "", "notes": "one sentence"}`;

export function buildNewsSourceText({ school, searchResults, searchQuery }) {
  const onFile =
    school.hc_first_name || school.hc_last_name
      ? `Head coach currently on file: ${[school.hc_first_name, school.hc_last_name].filter(Boolean).join(" ")}`
      : "Head coach currently on file: none";
  const resultsBlock =
    searchResults && searchResults.length > 0
      ? searchResults.map((r, i) => `${i + 1}. ${r.title} (${r.link})${r.date ? ` [${r.date}]` : ""}\n   ${r.snippet}`).join("\n")
      : "(no news results found)";
  return `School: ${school.name}, ${school.city || ""}, ${school.state || ""}\n${onFile}\n\n--- Google News results for "${searchQuery}" ---\n${resultsBlock}`;
}

export function normalizeNewsCheckResult(parsed) {
  return {
    change_detected: parsed.change_detected === true,
    new_coach_name: (parsed.new_coach_name || "").toString().trim(),
    confidence: ["high", "medium", "low"].includes(parsed.confidence) ? parsed.confidence : "low",
    article_url: (parsed.article_url || "").toString().trim(),
    article_date: (parsed.article_date || "").toString().trim(),
    notes: (parsed.notes || "").toString().trim(),
  };
}
