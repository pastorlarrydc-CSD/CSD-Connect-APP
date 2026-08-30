// Shared MaxPreps-URL AI lookup logic -- the model prompt, source-text
// builder, and response normalizer used by the overnight MaxPreps Batch API
// job (app/api/admin/maxpreps-batch/*). Deliberately reuses searchWeb() and
// parseModelJson() from lib/coachInfoLookup.js -- the exact same Serper
// search helper and JSON-parsing safety net already proven out by the
// coach-info batch job -- rather than duplicating them, so the batch
// pipelines can't quietly drift apart on shared plumbing. Modeled directly
// on lib/athleticsLookup.js, the closest sibling to this one: same "pick a
// URL out of a plain web search" shape, since MaxPreps has no public API and
// its Terms of Use prohibit scraping/crawling its own site (see the
// single-school app/api/schools/[id]/discover-maxpreps route for the
// original reasoning).
//
// What this does NOT do: fetch or read any web page's actual content. It
// only sends the model a school's name/city/state plus a handful of
// site:maxpreps.com search-engine results (title/link/snippet), and the
// model's job is picking which result (if any) is genuinely that specific
// school's own football team page -- a much smaller judgment call than
// reading a page, which is why this can run on the same small/cheap model
// with a short response, same as athletics.

export const MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001";
export const MAX_TOKENS = 200;

export const SYSTEM_PROMPT = `You are helping a college football recruiting staff find the correct MaxPreps team page for a specific high school's football program. You will be given the school's name, city, and state, plus a numbered list of maxpreps.com search results for that school.

Your job: decide which ONE result (if any) is genuinely that specific high school's own football team page on MaxPreps -- not a different sport's page for the same school (basketball, baseball, soccer, etc.), not a rival school's page, and not a different school with a similar or identical name in a different city or state.

Rules:
- Only pick a result if you're confident it belongs to THIS school -- check the city/state match carefully, since many schools share a name (e.g. "Central High School", "Lincoln High School") across different states.
- MaxPreps sometimes lists a school under a different public-facing name than what's on file here (e.g. a charter network's own branding vs. the school's legal/CSD name) -- a plausible name variation is fine as long as the location matches.
- Prefer a URL that is clearly the football team's own page (the path or title mentions "football") over the school's generic multi-sport landing page, when both appear in the results.
- If NONE of the results look like a good match, set best_url to null rather than guessing -- a wrong link here is worse than no link.
- Set confidence "high" only when the title/URL/snippet make the school AND sport match unambiguous. Use "medium" for a real but not-fully-certain match (e.g. the school matches but it's not clearly the football-specific page). Use "low" if you're only picking the least-bad option among weak candidates. Use "none" when best_url is null.
- Respond with ONLY a single JSON object, no other text, in exactly this shape:
{"best_url": "https://www.maxpreps.com/...", "confidence": "high", "reasoning": "one sentence explaining why this result is the right school's football page"}
If nothing is a good match, respond exactly:
{"best_url": null, "confidence": "none", "reasoning": "one sentence explaining why none of the results matched"}`;

// Builds the single user-message text for one school -- what the batch item
// saves as source_text ahead of submission.
export function buildMaxPrepsSourceText({ school, searchResults, searchQuery }) {
  const resultsBlock =
    searchResults && searchResults.length > 0
      ? searchResults.map((r, i) => `${i + 1}. ${r.title} (${r.link})\n   ${r.snippet || ""}`).join("\n")
      : "(no search results found)";
  return `School: ${school.name}, ${school.city || ""}, ${school.state || ""}\nCurrent MaxPreps URL on file: ${school.maxpreps_url || "none"}\n\n--- Web search results for "${searchQuery}" ---\n${resultsBlock}`;
}

// Normalizes a raw parsed model response into the exact shape saved on a
// batch item's `suggestion` column and shown on the review page.
export function normalizeMaxPrepsSuggestion(parsed) {
  const bestUrl = (parsed.best_url || "").toString().trim();
  return {
    best_url: bestUrl || null,
    confidence: ["high", "medium", "low", "none"].includes(parsed.confidence) ? parsed.confidence : bestUrl ? "low" : "none",
    reasoning: (parsed.reasoning || "").toString().trim(),
  };
}
