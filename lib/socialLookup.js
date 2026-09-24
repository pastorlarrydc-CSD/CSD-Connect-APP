// Shared social-media AI lookup logic -- the model prompt, source-text
// builder, and response normalizer used by the overnight Social Batch API
// job (app/api/admin/social-batch/*). Mirrors lib/athleticsLookup.js's
// shape exactly (reuses searchWeb() and parseModelJson() from
// lib/coachInfoLookup.js rather than duplicating them), just picking a
// coach's Twitter/X handle and Facebook page instead of a school's
// athletics site.
//
// What this does NOT do: fetch or read any web page's actual content --
// same as Athletics discovery, the input here is just search-engine
// results (title/link/snippet) for two separate searches, one per
// platform, and the model's job is picking which result (if any) on each
// platform genuinely belongs to THIS school's head football coach -- not
// the school's own program/athletics account, not a different coach, and
// not a same-named coach at a different school.
//
// Unlike Athletics discovery, a useful search here needs a coach's name
// (see app/api/schools/[id]/discover-social, which requires one) -- so
// this batch job's candidate pool is schools that already have a head
// coach name on file but are missing a Twitter/X and/or Facebook handle,
// not schools missing a name.

export const MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001";
export const MAX_TOKENS = 300;
export const SEARCH_RESULT_COUNT = 6;

export const SYSTEM_PROMPT = `You are helping a college football recruiting staff find a specific high school football coach's own Twitter/X and Facebook accounts. You will be given the school's name, city, and state, the head coach's name, and two separate numbered lists of search-engine results -- one for Twitter/X, one for Facebook.

Your job: for EACH platform independently, decide which ONE result (if any) is genuinely that coach's own personal account -- not the school's or program's general athletics/football account, not a different coach, not a fan account, and not a same-named coach at a different school in a different city or state.

Rules:
- Only pick a result if you're confident it belongs to THIS coach at THIS school -- check the name and city/state match carefully, since many coaches share a common name.
- A personal account that mentions the coach's name, the school, or the team in its bio, handle, or recent posts is a good sign. A bare school or program account (e.g. "@LincolnHSFootball" with no coach name anywhere) is NOT a personal match for either platform -- leave it out rather than guessing it belongs to the coach.
- If NONE of a platform's results look like a good personal match, set that platform's url to null rather than guessing -- a wrong link here is worse than no link.
- Set confidence "high" only when the account is unambiguously this coach's own (name and school both clearly tied to it). Use "medium" for a real but not-fully-certain match. Use "low" if you're only picking the least-bad option among weak candidates. Use "none" when neither platform has a usable match.
- Respond with ONLY a single JSON object, no other text, in exactly this shape:
{"twitter_url": "https://x.com/handle", "facebook_url": "https://facebook.com/page", "confidence": "high", "reasoning": "one sentence explaining the picks, or why one or both were left null"}
Use null (not an empty string) for either url field when nothing usable was found for that platform.`;

// Builds the single user-message text for one school -- what the batch item
// saves as source_text ahead of submission.
export function buildSocialSourceText({ school, twitterResults, facebookResults }) {
  const coachName = [school.hc_first_name, school.hc_last_name].filter(Boolean).join(" ");
  const formatBlock = (results) =>
    results && results.length > 0
      ? results.map((r, i) => `${i + 1}. ${r.title} (${r.link})\n   ${r.snippet || ""}`).join("\n")
      : "(no search results found)";
  return `School: ${school.name}, ${school.city || ""}, ${school.state || ""}\nHead coach on file: ${coachName || "none"}\nCurrent Twitter/X on file: ${
    school.hc_twitter || "none"
  }\nCurrent Facebook on file: ${school.hc_facebook || "none"}\n\n--- Twitter/X search results ---\n${formatBlock(twitterResults)}\n\n--- Facebook search results ---\n${formatBlock(
    facebookResults
  )}`;
}

// Normalizes a raw parsed model response into the exact shape saved on a
// batch item's `suggestion` column and shown on the review page.
export function normalizeSocialSuggestion(parsed) {
  const twitterUrl = (parsed.twitter_url || "").toString().trim();
  const facebookUrl = (parsed.facebook_url || "").toString().trim();
  return {
    twitter_url: twitterUrl || null,
    facebook_url: facebookUrl || null,
    confidence: ["high", "medium", "low", "none"].includes(parsed.confidence) ? parsed.confidence : twitterUrl || facebookUrl ? "low" : "none",
    reasoning: (parsed.reasoning || "").toString().trim(),
  };
}

// States where Social's own priority-state candidate pool gets narrowed to
// the bigger classification tiers only -- built after checking real hit
// rates by classification (Sept 24, 2026): the smallest tiers in these
// states were still running 40%+ (not a dead loss), but they're the bulk
// of what's left to search, so trimming them buys back a meaningful chunk
// of search/AI spend for a modest drop in expected finds. Deliberately
// scoped to just these five, not every priority state -- Florida's
// classification data wasn't part of that analysis and Larry didn't ask
// for it to be included, so FL (and any future priority state) stays
// unfiltered by classification.
export const CLASSIFICATION_FILTERED_STATES = new Set(["TX", "GA", "IN", "CA", "OH"]);

// classification is a free-text field and the *scheme* it uses is not the
// same everywhere: Texas/Georgia/Indiana use "1A"..."8A" where a HIGHER
// number is the bigger school. California/Ohio use "Division 1".."Division
// N" (also written "DIV 1", "D1", etc.) where, the other way around, a
// LOWER number is the bigger school -- Division 1 is the state's biggest
// classification, not its smallest. A single numeric cutoff would get this
// backwards for half these states, so the two schemes are checked
// separately.
//
// CA is a special case within itself: most CA schools carry a "DIV n"
// classification, but a real minority carry an "nA" value instead (a
// different section's naming, same underlying idea). Those are treated
// with the same "keep 3A and up" rule as the XA states rather than being
// silently dropped -- a judgment call, since Larry's "Division 3 and up"
// instruction was phrased around the DIV half of CA's data specifically.
// Worth revisiting if that turns out wrong for CA's actual mix of schools.
//
// Unparseable or missing classification (blank, "(none)", a stray value
// that matches neither pattern) is treated as NOT a big-tier school here --
// conservative on purpose, since the whole point of this filter is only
// searching schools we can actually confirm are in a top tier.
const XA_PATTERN = /^(\d+)\s*A\b/i;
const DIV_PATTERN = /^D(?:IV)?\.?\s*(\d+)/i;

export function isEligibleSocialClassification(state, classification) {
  if (!CLASSIFICATION_FILTERED_STATES.has(state)) return true;

  const value = (classification || "").trim();
  if (!value) return false;

  if (["CA", "OH"].includes(state)) {
    const divMatch = value.match(DIV_PATTERN);
    if (divMatch) return Number(divMatch[1]) <= 3;
    const xaMatch = value.match(XA_PATTERN);
    if (xaMatch) return Number(xaMatch[1]) >= 3;
    return false;
  }

  // TX / GA / IN
  const xaMatch = value.match(XA_PATTERN);
  if (xaMatch) return Number(xaMatch[1]) >= 3;
  return false;
}
