// Shared athletics-URL AI lookup logic -- the model prompt, source-text
// builder, and response normalizer used by the overnight Athletics Batch
// API job (app/api/admin/athletics-batch/*). Deliberately reuses
// searchWeb() and parseModelJson() from lib/coachInfoLookup.js -- the exact
// same Serper search helper and JSON-parsing safety net already proven out
// by the coach-info batch job -- rather than duplicating them, so the two
// batch pipelines can't quietly drift apart on shared plumbing.
//
// What this does NOT do: fetch or read any web page's actual content. Coach
// -info discovery already has a URL (the athletics site or general
// website) and needs to read WHAT'S ON that page. Athletics-URL discovery
// doesn't have a URL yet -- the whole point is finding one -- so the input
// here is just a school's name/city/state plus a handful of search-engine
// results (title/link/snippet), and the model's job is picking which
// result (if any) is genuinely that specific school's own athletics site.
// That's a much smaller judgment call than reading a page, which is why
// this can run on the same small/cheap model with a much shorter response.

export const MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001";
export const MAX_TOKENS = 200;
export const SEARCH_RESULT_COUNT = 8;

// Same denylist the single-school "Find athletics page" button
// (app/api/schools/[id]/discover-athletics) already filters Serper results
// through -- domains that sometimes rank for these searches but are never
// a school's own athletics site. Filtering these out before the results
// ever reach the model keeps the prompt cleaner and avoids wasting a pick
// on an obviously-wrong candidate.
export const EXCLUDED_HOSTS = ["maxpreps.com", "wikipedia.org", "facebook.com", "twitter.com", "x.com", "instagram.com", "youtube.com"];

export const SYSTEM_PROMPT = `You are helping a college football recruiting staff find the correct athletics-department website for a specific high school. You will be given the school's name, city, and state, plus a numbered list of search-engine results for that school's athletics department.

Your job: decide which ONE result (if any) is genuinely that specific high school's own athletics-department page -- not a rival school's site, not a news article ABOUT the school, not a general school-district homepage (unless that homepage doubles as the athletics hub), not a directory/aggregator listing, and not a page belonging to a different school with a similar or identical name in a different city or state.

Rules:
- Only pick a result if you're confident it belongs to THIS school -- check the city/state match carefully, since many schools share a name (e.g. "Central High School", "Lincoln High School") across different states.
- A school's own domain, a subdomain of it (athletics.schoolname.org), or a well-known athletics-hosting platform (rSchoolToday, SportsEngine, Schoolwires, Finalsite, Blue Star, 8to18, etc.) clearly branded for this specific school are all valid picks.
- If NONE of the results look like a good match, set best_url to null rather than guessing -- a wrong link here is worse than no link, since other tools in this app treat the athletics URL as a trusted source and check it first.
- Set confidence "high" only when the title/URL/snippet make the school match unambiguous. Use "medium" for a real but not-fully-certain match (e.g. the domain looks right but city/state isn't confirmed in the snippet). Use "low" if you're only picking the least-bad option among weak candidates. Use "none" when best_url is null.
- Respond with ONLY a single JSON object, no other text, in exactly this shape:
{"best_url": "https://example.com/athletics", "confidence": "high", "reasoning": "one sentence explaining why this result is the right school's athletics page"}
If nothing is a good match, respond exactly:
{"best_url": null, "confidence": "none", "reasoning": "one sentence explaining why none of the results matched"}`;

// Builds the single user-message text for one school -- what the batch item
// saves as source_text ahead of submission, and what a live single-school
// call (if one's ever added) would send too.
export function buildAthleticsSourceText({ school, searchResults, searchQuery }) {
  const resultsBlock =
    searchResults && searchResults.length > 0
      ? searchResults.map((r, i) => `${i + 1}. ${r.title} (${r.link})\n   ${r.snippet || ""}`).join("\n")
      : "(no search results found)";
  return `School: ${school.name}, ${school.city || ""}, ${school.state || ""}\nCurrent athletics URL on file: ${school.athletics_url || "none"}\n\n--- Web search results for "${searchQuery}" ---\n${resultsBlock}`;
}

// Normalizes a raw parsed model response into the exact shape saved on a
// batch item's `suggestion` column and shown on the review page.
export function normalizeAthleticsSuggestion(parsed) {
  const bestUrl = (parsed.best_url || "").toString().trim();
  return {
    best_url: bestUrl || null,
    confidence: ["high", "medium", "low", "none"].includes(parsed.confidence) ? parsed.confidence : bestUrl ? "low" : "none",
    reasoning: (parsed.reasoning || "").toString().trim(),
  };
}
