// Shared coach-info AI lookup logic -- the search/fetch helpers, the model
// prompt, and the response parser used by BOTH the one-school-at-a-time
// "Suggest Coach Info (AI)" button (app/api/schools/[id]/discover-coach-info)
// and the overnight Batch API job (app/api/admin/batch-coach-info/*). One
// source of truth so the two never drift apart -- a prompt tweak made here
// improves both the single-school button and every future batch run.

// looseSchoolNameKey is Import & Reconcile's own near-duplicate school-name
// fold (see lib/importReconcile.js) -- reused here so findDuplicateNameSchools
// below and that tool's own matching can't drift apart on what counts as
// "basically the same school name."
import { looseSchoolNameKey } from "./importReconcile";
import { NEEDS_REVIEW_CLEAR_FIELDS } from "./needsReview";

export const FETCH_TIMEOUT_MS = 8000;
export const MAX_BYTES = 400_000;
export const MAX_CHARS_PER_SOURCE = 6000;
// A school's staff/faculty directory page is often the ONE source that
// actually names a Head Football Coach AND an Athletic Director together --
// but it's also frequently a long, alphabetical, all-staff listing, so a
// name lower on the page (an AD listed after every teacher, say) used to
// get sliced off by the generic MAX_CHARS_PER_SOURCE cap before the model
// ever saw it. Confirmed directly: the Castleberry HS (TX) directory page
// lists AD Didi Pierce well past the 6,000-character mark, which is exactly
// why a September 2026 side-by-side against a manual web-search tool came
// back with an AD name where this tool came back empty. Directory pages get
// their own, much larger budget for this reason; every other source
// (athletics site, general website, recent-schedule page) keeps the
// standard cap.
export const MAX_CHARS_DIRECTORY_PAGE = 12000;
export const USER_AGENT = "CSD-CoachConnect-Verifier/1.0 (+https://csd-coachconnect)";
export const MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001";
export const SEARCH_RESULT_COUNT = 8;
// Shared response-length budget for every Anthropic call that uses
// SYSTEM_PROMPT below (the live single-school route, the Batch API submit
// route, and the weekly cron's own inline submit) -- centralized here,
// instead of each caller hardcoding its own max_tokens, so the three can't
// quietly drift apart the way they had (all three independently set 400).
// Bumped from 400 to 700: the prompt's notes field now asks for 2-3
// sentences of reasoning/citation instead of one, and there's a new
// maxpreps_url field -- 400 tokens was already tight for one sentence plus
// the rest of the JSON shape.
export const RESPONSE_MAX_TOKENS = 700;

// Two-letter state code -> full name, used in three places below: (1) the
// query builders append the full name alongside the abbreviation, since most
// pages about a small-town school spell out "Michigan" rather than "MI" --
// the abbreviation alone often just never appears anywhere on the page this
// tool is trying to match; (2) serperLocationForState turns a school's state
// into a Serper `location` bias so results skew toward the right part of the
// country before the model ever sees them, not just a keyword competing for
// relevance in the query text; (3) the same-name-school block in
// buildSourceBlocks reads better with a spelled-out state than a bare code.
// US only -- this is a US high-school football database.
const US_STATE_NAMES = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California",
  CO: "Colorado", CT: "Connecticut", DE: "Delaware", DC: "District of Columbia",
  FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois",
  IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana",
  ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota",
  MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada",
  NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York",
  NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon",
  PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota",
  TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia",
  WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
  PR: "Puerto Rico", VI: "Virgin Islands", GU: "Guam", AS: "American Samoa",
  MP: "Northern Mariana Islands",
};

export function stateFullName(stateAbbr) {
  if (!stateAbbr) return null;
  return US_STATE_NAMES[stateAbbr.toString().trim().toUpperCase()] || null;
}

// A Serper `location` value biases the search itself toward that part of the
// country -- distinct from putting the state in the query text (which is
// just one more keyword competing for relevance). Google-style location
// strings are "<region>, United States"; the full state name reads as a
// valid one. Returns null for an unknown/missing state so callers can skip
// sending the field entirely rather than sending a location Serper can't
// resolve.
export function serperLocationForState(stateAbbr) {
  const full = stateFullName(stateAbbr);
  return full ? `${full}, United States` : null;
}

// city + state abbreviation + full state name, space-joined and with blanks
// dropped -- the shared location fragment appended to all three query
// builders below. Broken out once so the three can't drift out of sync with
// each other on how they express a school's location.
function schoolLocationTerms(school) {
  return [school.city, school.state, stateFullName(school.state)].filter(Boolean).join(" ");
}

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

// Shared low-level call to Serper -- both searchWeb and searchWebWithGraph
// below hit the exact same endpoint with the exact same request; the only
// difference is how much of the response each one bothers to unpack. Kept
// private (not exported) so there's exactly one place that knows Serper's
// request shape and one place that knows its raw response shape.
//
// Best-effort: a Serper hiccup here shouldn't sink the whole lookup if a
// school page did fetch successfully, so this returns an empty payload on
// failure instead of throwing -- the caller decides whether anything usable
// came back overall.
//
// `location` (optional, from serperLocationForState) biases the search
// itself toward that part of the country -- Serper/Google use it the same
// way they'd use a real searcher's physical location, so it skews organic
// results toward the target state BEFORE anything comes back, not just
// after the fact via a keyword in `query`. Added September 2026 after a
// same-named-school mix-up (Buchanan HS, MI vs. the much more search-visible
// Buchanan HS in Clovis, CA) showed that a state abbreviation sitting in the
// query text alone isn't a strong enough signal when the wrong-state result
// is otherwise much more prominent online. `gl: "us"` always rides along
// with it since this is a US high-school database.
async function serperSearch(query, apiKey, location) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ q: query, num: SEARCH_RESULT_COUNT, ...(location ? { location, gl: "us" } : {}) }),
      signal: controller.signal,
    });
    const payload = await res.json().catch(() => ({}));
    return res.ok ? payload : {};
  } catch (_) {
    return {};
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeOrganic(payload) {
  return (payload.organic || [])
    .filter((item) => item.title && item.link)
    .slice(0, SEARCH_RESULT_COUNT)
    .map((item) => ({ title: item.title, link: item.link, snippet: item.snippet || "" }));
}

// Organic results only. `location` is optional (see serperSearch's own
// comment) -- every existing caller that doesn't pass one keeps behaving
// exactly as before.
export async function searchWeb(query, apiKey, location) {
  const payload = await serperSearch(query, apiKey, location);
  return normalizeOrganic(payload);
}

// Same search as searchWeb, but also unpacks the two other things Serper
// already hands back in that SAME response and this file used to just
// throw away: knowledgeGraph (Google's own right-hand-panel entity data --
// name, type, description, site, attributes -- when Google recognizes the
// query as referring to a specific person/place/organization) and answerBox
// (Google's featured-snippet/summary box). Both come back on the exact
// request searchWeb already makes, at no extra Serper cost -- this just
// stops discarding them. Only worth the extra unpacking on the PRIMARY
// coach-name/school search (used by all three coach-info callers); the
// staff-directory search in findDirectoryPage stays on plain searchWeb,
// since a "staff directory" query isn't the kind of query Google attaches
// a Knowledge Graph entry or answer box to anyway.
export async function searchWebWithGraph(query, apiKey, location) {
  const payload = await serperSearch(query, apiKey, location);
  return {
    organic: normalizeOrganic(payload),
    knowledgeGraph: payload.knowledgeGraph || null,
    answerBox: payload.answerBox || null,
  };
}

export const SYSTEM_PROMPT = `You are helping a college football recruiting staff verify high-school program contact information. You will be given search-engine results for the school's football program, and -- when available -- full text read from the school's athletics website, general website, and/or staff directory, plus a separate search aimed at the program's current-season schedule/scores, plus whatever is currently on file. Find the CURRENT HEAD FOOTBALL COACH's name, email, phone number, Twitter/X handle, and Facebook page/profile, if they appear anywhere in what you're given. Also find the school's Athletic Director as a fallback contact (see the ad_name/ad_email rule below), and a link to the team's MaxPreps page if one appears (see the maxpreps_url rule below).

Rules:
- Same-name school check -- do this FIRST, before using anything else you were given: you are told the exact school this lookup is for as "School: <name>, <city>, <state>" at the top of what follows. Many school names are reused by unrelated schools in other cities or states (there is more than one "Buchanan High School" in the country, more than one "Arcadia High School," and so on) -- a search built from the school's name can and does surface pages, booster-club sites, and social posts that belong to one of those OTHER same-named schools, not the one you were actually asked about, especially when that other school has a bigger or more search-visible program. Before treating ANY source -- fetched page text, a search snippet, the knowledge graph, the answer box, all of it -- as evidence, check whether that source's own text, address, or domain actually identifies the city/state you were given. If a source clearly belongs to a same-named school in a different city or state, discard it completely: do not use it for the coach name, contact info, the AD, or the MaxPreps link, exactly as if it had never been given to you. If discarding those leaves you with nothing usable for a field, leave that field empty rather than reporting the other school's information as if it were this one's, and say so plainly in notes (e.g. "sources found were for a same-named school in Clovis, CA, not the Buchanan, MI school asked about here -- no usable Michigan-specific source found"). If what follows includes a line telling you this database ALSO contains other specific schools with this exact name at other cities/states, treat that as a confirmed, high-priority list of locations to actively rule out -- it isn't a hypothetical, it's telling you a real collision exists for this exact lookup, so scrutinize any source touching one of those places especially closely. When that line is present, your notes MUST explicitly name the city/state you actually confirmed your evidence was about (e.g. "confirmed via a source describing the program in Columbia, SC," not just a coach's name and mascot with no place attached) -- do not describe the team only by its mascot or a generic "the program," since a collision-prone name can have multiple real schools sharing similar mascots too, and blending details from more than one of them without ever naming which specific place your evidence actually came from is exactly the mistake this rule exists to prevent, even when you never state the WRONG place outright.
- Only extract HEAD FOOTBALL COACH information into the hc_* fields. Ignore coaches of other sports (basketball, baseball, soccer, track, etc.) even if they're listed right next to the football staff.
- Never report the District/school Athletic Director, a general athletics-office contact, or any other non-football-specific staff member as the head football coach -- not even as a best guess when no football-specific name turns up nearby. If a source names an Athletic Director but no specific football head coach, leave the hc_* name fields empty rather than using the AD's name. A general office phone/email is still worth returning as a fallback office contact even with no coach named.
- ad_name / ad_email: whenever an Athletic Director is identified anywhere in what you're given (whether or not a football head coach was also found), fill these in with their name and email. This is a separate fallback contact, captured in addition to the head coach, not instead of them -- never put the AD's own info in the hc_* fields.
- maxpreps_url: if a link to this school's team page on maxpreps.com appears anywhere in what you're given (a search result link, a mention in page text, etc.), report that URL here. You are only ever reporting a link you saw, never fetching or reading MaxPreps' own page content -- none of what you were given comes from actually crawling maxpreps.com. Leave this blank if no maxpreps.com link appears anywhere.
- Never invent or guess a name, phone number, Twitter/X handle, or Facebook link that isn't actually present in what you were given. Return empty strings for anything not found. Email is the one exception -- see the pattern-derivation rule below -- but even there you are deriving from evidence actually in front of you, never inventing a domain or convention out of nothing.
- Email pattern-derivation (use sparingly, and only for hc_email): if the coach's own email is not directly stated anywhere, but you can see at least one OTHER staff member's real email address in what you were given (a principal, superintendent, athletic director, another coach -- anyone at the same school/district) AND you have identified the head coach's name, you may derive an estimated address by applying that same visible naming pattern (e.g. lastnamefirstinitial@domain, firstinitiallastname@domain, firstname.lastname@domain) to the coach's name. When you do this: set hc_email to the derived address, set hc_email_estimated to true, cap confidence at "medium" even if everything else about the suggestion is rock-solid, and say exactly what you did in notes (the pattern you saw, and whose email you saw it on -- e.g. "Email estimated from district pattern lastnamefirstinitial@parkerschapelschool.com, seen on Principal Frizzell's listed address; not confirmed for this coach directly"). If you cannot see any other real staff email to establish a pattern from, or you don't have a coach name to apply it to, leave hc_email blank and hc_email_estimated false rather than guessing a domain or format. Never derive an estimated email for ad_email -- only ever use a directly-stated AD email.
- For hc_twitter, only use a handle that is explicitly tied to this specific coach (their own bio, a byline, a "follow me" link next to their name) -- not the school's or program's general athletics/football account. Format it as "@handle". If only a program or team account is mentioned (not the coach personally), leave hc_twitter empty rather than guessing it belongs to the coach.
- For hc_facebook, the same rule applies: only a link/page clearly belonging to this coach personally, or -- since football coaches often don't keep a separate personal page -- the team's own official Facebook page IS acceptable here as a fallback, but say so in notes (e.g. "team page, not the coach's personal profile") so the reviewer knows which kind of link it is. Give the full URL.
- Search-result snippets are short and sometimes get cut off mid-sentence -- it's fine to use a name from a snippet (e.g. a "names John Smith new head coach" headline) even without the full article, but set confidence no higher than "medium" when you're relying on a snippet alone rather than full page text.
- Confirm this person is the ACTIVE head football coach for the CURRENT season, not a name carried over from a stale page or an old article -- these sources don't always reflect a recent change. If a source mentions a coaching change, transition, resignation, or interim appointment ("new head coach", "interim head coach", "as of [date]"), treat the most recent name as the current one and say so in notes.
- Recency evidence and confidence: when something you were given clearly places the coach in the CURRENT season -- a dated recent news article, a game recap or box score, a season preview, a "Week [n]" reference, or any other explicit current-season signal -- treat that as good evidence they're still actively coaching and eligible for "high" confidence. A "recent schedule/scores search result" block, when present, is specifically there to help with this -- it's a search aimed at the program's current-season schedule and scores, so a dated result there (a final score, a "Week [n]" game, an upcoming-opponent listing for this season) is exactly the kind of proof-of-life evidence this rule is looking for; name it as your recency evidence in notes when you use it (e.g. "confirmed active by a Week 3 score dated Sept 11, 2026"). When nothing you were given carries any date or season signal at all (e.g. only a generic, undated staff/program page with no way to tell if it's this year's roster, and the schedule/scores search turned up nothing dated either), do not assume it's current just because a name is clearly printed there -- say so plainly in notes (e.g. "no dated or current-season source found; page may be out of date") and cap confidence at "medium" even if the name itself is stated unambiguously.
- If different sources disagree on the name, prefer whichever is more recent or more directly tied to the school's own site, and mention the conflict in notes.
- The "currently on file" information below is NOT independently verified -- it may be an old bulk import, a placeholder, or simply wrong, which is often exactly why a human is running this lookup. It is given to you only as context, not as evidence. Do not treat a match between what's on file and something a source happens to say as extra proof of correctness -- judge each name strictly on the actual web/page evidence in front of you, the same way you would if nothing were on file at all. If the evidence points to a DIFFERENT person than what's on file, go with the evidence, say so plainly in notes, and do not default back to the on-file name out of caution.
- Only fill hc_cell if a number is explicitly labeled as a cell/mobile/direct line for that coach. Otherwise put any phone number found in hc_office.
- Set confidence to "high" only when a name is clearly labeled as the football head coach in full page text (not just a search snippet). Use "medium" for real but ambiguous matches, a clear match found only in a search snippet, or any suggestion where hc_email_estimated is true. Use "low" if you are only partially confident.
- Respond with ONLY a single JSON object, no other text, in exactly this shape:
{"hc_first_name": "", "hc_last_name": "", "hc_email": "", "hc_email_estimated": false, "hc_office": "", "hc_cell": "", "hc_twitter": "", "hc_facebook": "", "ad_name": "", "ad_email": "", "maxpreps_url": "", "confidence": "high", "source": "web search", "notes": "2-3 sentences: what was found and where (which specific source), your recency evidence for why this coach is believed still active this season (or why you couldn't confirm that), and any conflict between sources worth flagging -- a reviewer should be able to read notes alone and understand why you landed on this answer, the way they would from reading a short verification writeup themselves"}`;

// Builds the Serper search query used for a school's PRIMARY search -- the
// one that has to establish WHO the current head football coach actually
// is.
//
// Defaults to an open "school + head football coach" query, even when a
// coach name is already on file. It used to quote-search for that on-file
// name instead whenever one existed ('"John Smith" School Name football
// coach email contact') on the theory that a reviewer re-running this on a
// school that already has a confirmed name just wants help finding their
// email/phone. That reasoning only holds when the on-file name is actually
// known-correct -- and this function has no way to tell "confirmed
// correct" apart from "whatever name happened to be in the original
// import, possibly wrong or years stale." Anchoring the search to that
// name created a confirmation-bias loop: a wrong or outdated name could
// never be corrected by this tool, because the search could only ever
// surface pages that already mention that same name, which the model then
// read as agreeing with what's on file. This is exactly what happened at
// Clyde A. Erwin High School (Asheville, NC) in September 2026 -- flagged
// "Double check the HFC," re-run through this tool, and it "confirmed" the
// on-file (wrong) name, Tyler Thackston, instead of surfacing the actual
// current coach, Rodney Pruett -- because the search query itself was
// `"Tyler Thackston" Clyde A. Erwin High School football coach email
// contact`, a query that can only ever turn up more pages about
// Thackston, never about Pruett.
//
// The narrower name-anchored query is still available -- pass
// { contactOnly: true } -- but only for a caller with an independent
// reason to already trust the on-file name. Right now that's just the
// batch tool's "missing_email" candidate mode (both manual and its weekly
// cron), where a human deliberately chose that targeting because the name
// pool was already believed correct and only contact details are missing.
// Every other caller -- the single-school "Suggest Coach Info (AI)" button
// included -- should leave this at its default, so a wrong or stale name
// on file has an actual chance of being caught and corrected instead of
// silently re-confirmed.
export function buildSearchQuery(school, { contactOnly = false } = {}) {
  const knownCoachName = [school.hc_first_name, school.hc_last_name].filter(Boolean).join(" ").trim();
  if (contactOnly && knownCoachName) {
    return `"${knownCoachName}" ${school.name} football coach email contact`;
  }
  // City + state abbreviation + full state name (see schoolLocationTerms) --
  // the full name matters because most page text about a school spells its
  // state out ("Michigan") rather than using the two-letter code ("MI"),
  // which otherwise never actually appears anywhere the search could match
  // it against.
  return `${school.name} ${schoolLocationTerms(school)} head football coach`;
}

// Domains the directory search below never fetches the full page of --
// people-search aggregators (ZoomInfo, LinkedIn, RocketReach, and the
// like) that typically gate a real email behind a paid "reveal contact"
// teaser, so fetching their page itself rarely adds anything a search
// snippet didn't already show. MaxPreps and the social platforms are
// excluded for the same reason the single-school route never fetches
// maxpreps.com directly (see discover-coach-info/route.js) -- MaxPreps'
// Terms of Use prohibit scraping/crawling its own site, and a Twitter/
// Facebook/Instagram/YouTube page isn't where a staff directory would
// live anyway. Every one of these sites still shows up fine as a search-
// result snippet the model can read -- this list only controls which
// result gets its full page fetched.
// Exported (not just used internally) so lib/collegeCoachInfoLookup.js can
// share the exact same block list instead of maintaining its own copy that
// could quietly drift out of sync.
export const LOW_VALUE_DIRECTORY_DOMAINS = [
  "zoominfo.com",
  "linkedin.com",
  "rocketreach.co",
  "spokeo.com",
  "whitepages.com",
  "intelius.com",
  "peoplefinders.com",
  "beenverified.com",
  "fastpeoplesearch.com",
  "truepeoplesearch.com",
  "nuwber.com",
  "radaris.com",
  "mylife.com",
  "maxpreps.com",
  "facebook.com",
  "twitter.com",
  "x.com",
  "instagram.com",
  "youtube.com",
];

export function isLowValueDirectoryDomain(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./i, "").toLowerCase();
    return LOW_VALUE_DIRECTORY_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
  } catch (_) {
    return true; // an unparseable URL isn't worth fetching either way
  }
}

// Tolerant hostname normalizer for a school's own on-file athletics_url/
// website -- unlike a Serper result link, those are saved in the database
// however a human typed them (often with no "https://" at all), so this
// adds one before handing it to URL() rather than assuming it's already a
// full, parseable URL like isLowValueDirectoryDomain above can.
function normalizedHost(rawUrl) {
  if (!rawUrl) return null;
  try {
    const withScheme = /^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`;
    return new URL(withScheme).hostname.replace(/^www\./i, "").toLowerCase();
  } catch (_) {
    return null;
  }
}

// Picks which search result findDirectoryPage/findRecentGameEvidence below
// actually fetch the full page of. Used to just be "the first result whose
// domain isn't in LOW_VALUE_DIRECTORY_DOMAINS" -- that's still the fallback,
// but it had no way to prefer a result that's actually THIS school's own
// site over one that merely isn't an aggregator/social platform. Added
// September 2026 alongside the same-name-school prompt rule: when a result's
// domain matches the school's own on-file athletics_url or website, that's a
// much stronger "this is really the right school" signal than domain-type
// filtering alone, so it's checked first.
function pickCandidate(results, school) {
  const onFileHosts = new Set([normalizedHost(school.athletics_url), normalizedHost(school.website)].filter(Boolean));
  if (onFileHosts.size > 0) {
    const domainMatch = results.find((r) => onFileHosts.has(normalizedHost(r.link)));
    if (domainMatch) return domainMatch;
  }
  return results.find((r) => !isLowValueDirectoryDomain(r.link));
}

// Second, more targeted search aimed at a school/district's own staff or
// faculty directory page -- the kind of page that actually lists a
// coach's real contact info, as distinct from buildSearchQuery's "who is
// the coach" or "coach name + email" query, which tends to surface
// people-search aggregators (see LOW_VALUE_DIRECTORY_DOMAINS above)
// instead of the school's own site.
export function buildDirectorySearchQuery(school) {
  return `${school.name} ${schoolLocationTerms(school)} staff directory`;
}

// Runs the directory-targeted search above and, if a result comes back
// whose domain isn't in LOW_VALUE_DIRECTORY_DOMAINS, fetches that page's
// full text instead of just handing the model its two-line search
// snippet. This closes the specific gap a side-by-side check against an
// outside AI search tool turned up in September 2026: this tool's two
// on-file URLs (athletics site, general website) often don't contain
// staff-specific contact info, and the primary buildSearchQuery search
// tends to surface aggregator sites for a name+role query rather than the
// school's own directory page -- so a coach's contact info that genuinely
// IS findable on the school's own site was going unseen. Always runs
// alongside the primary search rather than only after inspecting its
// results, so a caller can simply await both together in one Promise.all.
export async function findDirectoryPage({ school, serperKey }) {
  const results = await searchWeb(buildDirectorySearchQuery(school), serperKey, serperLocationForState(school.state));
  const candidate = pickCandidate(results, school);
  if (!candidate) return { results, page: null };
  const fetched = await fetchPageText(candidate.link);
  if (!fetched.ok || !fetched.text) return { results, page: null };
  return { results, page: { url: candidate.link, text: fetched.text } };
}

// Third, recency-focused search aimed at the program's CURRENT-SEASON
// schedule and scores -- added September 2026 after a side-by-side against
// a manual web-search verification prompt showed this was the single
// biggest thing this tool was missing. buildSearchQuery and
// buildDirectorySearchQuery both ask "who is the coach" in one form or
// another; neither is aimed at proving a name is still current. This one
// deliberately targets exactly that: a dated final score, a "Week [n]"
// game, an upcoming-opponent listing -- the same kind of proof-of-life
// evidence a person cross-checking "a local newspaper or game recap from
// the last 30 days" (a manual prompt Larry DeVooght uses) would look for by
// hand. Current-season year is hardcoded to keep the query itself dated and
// specific rather than a bare "schedule scores" query that could surface
// any past season -- worth revisiting if this tool is still in use well
// past 2026.
//
// Same fetch-if-not-low-value pattern as findDirectoryPage: MaxPreps and
// the social platforms are the most likely hit for a schedule/scores query
// and are exactly the domains this deliberately never fetches in full (see
// LOW_VALUE_DIRECTORY_DOMAINS and discover-coach-info/route.js's own
// comment on the MaxPreps ToS reasoning) -- their search-result snippet
// alone is still handed to the model, same as it already is for the
// primary and directory searches, and that snippet often already carries a
// dated score line on its own.
export function buildRecencySearchQuery(school) {
  return `${school.name} ${schoolLocationTerms(school)} football schedule scores 2026`;
}

export async function findRecentGameEvidence({ school, serperKey }) {
  const results = await searchWeb(buildRecencySearchQuery(school), serperKey, serperLocationForState(school.state));
  const candidate = pickCandidate(results, school);
  if (!candidate) return { results, page: null };
  const fetched = await fetchPageText(candidate.link);
  if (!fetched.ok || !fetched.text) return { results, page: null };
  return { results, page: { url: candidate.link, text: fetched.text } };
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

// Every US state/territory's full name, alternated into one case-insensitive
// pattern source -- built once from US_STATE_NAMES rather than per-call.
const STATE_FULL_NAMES_SOURCE = Object.values(US_STATE_NAMES)
  .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  .join("|");

// Scans a suggestion's own free text (notes + source) for a state OTHER
// than the school actually being looked up -- a code-level backstop
// underneath the SYSTEM_PROMPT's own same-name-school instruction, added
// after a live case (Saint Edward HS, Lakewood OH vs. Saint Edwards HS,
// Vero Beach FL -- see findDuplicateNameSchools above) where the model's
// OWN notes plainly said "Vero Beach, FL" twice, yet it still reported the
// suggestion as "high confidence" for the Ohio school. The prompt rule asks
// the model to catch this itself; normalizeSuggestion below doesn't trust
// that it always will, and downgrades regardless of what confidence the
// model claimed. Checks both a full state name ("Florida") and the
// "City, XX" comma-abbreviation form a source's own dateline/bio almost
// always uses (exactly the form that case's evidence used). Deliberately
// permissive/noisy: a false trigger just costs one extra "verify before
// applying" flag a human clears with one glance, while a missed one is
// exactly how wrong contact info gets attached to the wrong institution.
// Returns the other state name(s) found, or [] if only the target state
// (or nothing) was mentioned.
function otherStatesMentioned(text, targetStateAbbr) {
  if (!text) return [];
  const target = (targetStateAbbr || "").toUpperCase();
  const targetFull = (stateFullName(target) || "").toLowerCase();
  const found = new Set();

  const fullNamePattern = new RegExp(`\\b(${STATE_FULL_NAMES_SOURCE})\\b`, "gi");
  let m;
  while ((m = fullNamePattern.exec(text))) {
    if (m[1].toLowerCase() !== targetFull) found.add(m[1]);
  }

  const abbrPattern = /,\s*([A-Z]{2})\b/g;
  while ((m = abbrPattern.exec(text))) {
    const abbr = m[1].toUpperCase();
    if (abbr !== target && US_STATE_NAMES[abbr]) found.add(US_STATE_NAMES[abbr]);
  }

  return [...found];
}

// Positive counterpart to otherStatesMentioned above -- added after a live
// case (Columbia High School: Columbia, SC vs. Huntsville, AL, September
// 2026) that the state-mismatch backstop above didn't catch. otherStatesMentioned
// only fires when the model's own notes name a WRONG state outright; this
// case slipped past it because the model's notes never named any state at
// all -- it blended both schools' evidence together and described the team
// only as "Columbia Eagles/Capitals" (both real mascots, mashed into one),
// with a head coach (Sammie Coates) who genuinely exists but coaches the
// OTHER, same-named school. Only meaningful when the target school is
// already known to have a real name collision elsewhere (the same
// condition that makes buildSourceBlocks emit duplicateSchoolsBlock and
// SYSTEM_PROMPT tell the model to name its confirmed city/state) -- a
// school with no name-twins isn't expected to spell out its own location in
// every note, so this is never checked for one. Deliberately mirrors
// otherStatesMentioned's own two patterns -- the target's full state name,
// or a "City, XX" comma-abbreviation form -- and deliberately does NOT
// accept the target city's bare name as confirmation on its own: a first
// draft of this function did, and it failed its own test against the real
// Columbia High School incident text, because that text says "Columbia"
// repeatedly (it's literally the collision school's own name) without ever
// actually confirming which Columbia. A bare city-name match is exactly
// the kind of false confirmation this backstop exists to rule out, so only
// the more specific state-bearing patterns count.
function targetLocationConfirmed(text, city, stateAbbr) {
  if (!text || !stateAbbr) return false;
  const stateFull = (stateFullName(stateAbbr) || "").toLowerCase();
  if (stateFull && text.toLowerCase().includes(stateFull)) return true;
  if (new RegExp(`,\\s*${stateAbbr}\\b`, "i").test(text)) return true;
  return false;
}

// Normalizes a raw parsed model response into the exact shape both callers
// return to their client -- trimmed strings, a validated confidence value,
// and a fallback source label built from whatever sources were actually
// usable. `schoolLocation` (optional, { city, state, hasKnownDuplicates })
// is the school this lookup was actually FOR -- when given, triggers the
// otherStatesMentioned same-name-school backstop above; when
// hasKnownDuplicates is also true (this school's name collides with
// another real school elsewhere -- see findDuplicateNameSchools/
// findDuplicateNameSchoolsForMany), also triggers the targetLocationConfirmed
// backstop just above, which catches a same-name mix-up even when the
// model never names the wrong place outright. Every caller should pass it;
// it's optional only so nothing breaks if a future caller forgets to.
export function normalizeSuggestion(parsed, defaultSource, schoolLocation) {
  const hc_email = (parsed.hc_email || "").toString().trim();
  // Trust the model's own hc_email_estimated flag, but don't rely on it
  // alone -- if there's no email at all there's nothing to mark as
  // estimated, regardless of what the model returned.
  const hc_email_estimated = Boolean(parsed.hc_email_estimated) && Boolean(hc_email);
  const rawConfidence = ["high", "medium", "low"].includes(parsed.confidence) ? parsed.confidence : "low";
  let confidence = hc_email_estimated && rawConfidence === "high" ? "medium" : rawConfidence;
  let notes = (parsed.notes || "").toString().trim();

  if (schoolLocation?.state) {
    const combinedText = `${notes} ${(parsed.source || "").toString()}`;
    const otherStates = otherStatesMentioned(combinedText, schoolLocation.state);
    const targetLabel = [schoolLocation.city, stateFullName(schoolLocation.state) || schoolLocation.state].filter(Boolean).join(", ");
    if (otherStates.length > 0) {
      // Forced to "low" outright, not just capped below its current tier --
      // this is a strong enough red flag that it must never land at "high"
      // (the confidence auto-apply writes unattended, no human review) or
      // even "medium" (still one click away from Apply on the review page).
      confidence = "low";
      notes = `⚠️ Possible same-name-school mix-up -- this response mentions ${otherStates.join("/")}, but this school is in ${
        targetLabel || schoolLocation.state
      }. Verify the source is actually about THIS school before applying. ${notes}`.trim();
    } else if (schoolLocation.hasKnownDuplicates && confidence !== "low") {
      // The model didn't name a wrong place, but this school's name is a
      // known collision (see findDuplicateNameSchools) and it never
      // affirmatively confirmed the right one either -- exactly the
      // Columbia High School (SC vs. Huntsville, AL) gap. Same treatment as
      // the branch above: force to "low", never let it slip through at
      // "high"/"medium" just because nothing wrong was technically stated.
      if (!targetLocationConfirmed(combinedText, schoolLocation.city, schoolLocation.state)) {
        confidence = "low";
        notes = `⚠️ This school's name collides with another real school elsewhere, and this response never confirmed its source was actually about ${
          targetLabel || schoolLocation.state
        } specifically. Verify the source is actually about THIS school before applying. ${notes}`.trim();
      }
    }
  }

  return {
    hc_first_name: (parsed.hc_first_name || "").toString().trim(),
    hc_last_name: (parsed.hc_last_name || "").toString().trim(),
    hc_email,
    // A pattern-derived email is a guess, not a confirmed find -- never
    // let it carry "high" confidence out of here even if the model said
    // so, since "high" is exactly the tier every batch collect route
    // checks before auto-writing a suggestion straight into the schools
    // table with no human review (see autoApplyHighConfidenceSuggestion
    // below). Capping this centrally, once, protects every caller
    // (single-school button, batch tool, cron collector, Review Queue)
    // without each of them needing to know this rule exists.
    hc_email_estimated,
    hc_office: (parsed.hc_office || "").toString().trim(),
    hc_cell: (parsed.hc_cell || "").toString().trim(),
    hc_twitter: (parsed.hc_twitter || "").toString().trim(),
    hc_facebook: (parsed.hc_facebook || "").toString().trim(),
    // Athletic Director fallback contact -- captured alongside the head
    // coach fields, never in place of them. Deliberately never estimated
    // (no ad_email_estimated flag): the prompt is only ever allowed to
    // derive an estimate for hc_email.
    ad_name: (parsed.ad_name || "").toString().trim(),
    ad_email: (parsed.ad_email || "").toString().trim(),
    // Display-only context for the reviewer, sourced from a search-result
    // link the model saw (see the maxpreps_url rule in SYSTEM_PROMPT) --
    // never fetched, never written to schools.maxpreps_url automatically.
    // That column has its own dedicated, ToS-reviewed discovery tool
    // (discover-maxpreps); this is just a convenience link on the
    // suggestion card, not a competing write path, so it's deliberately
    // left out of AUTO_APPLY_FIELDS below.
    maxpreps_url: (parsed.maxpreps_url || "").toString().trim(),
    confidence,
    source: (parsed.source || defaultSource || "web search").toString(),
    notes,
  };
}

// Looks up other schools in the database whose name is basically the same
// as this one -- added September 2026 alongside the same-name-school
// SYSTEM_PROMPT rule, after a live mix-up between the two "Buchanan High
// School"s (Buchanan, MI and Clovis, CA) showed this isn't a hypothetical: a
// national HS football database inevitably has a lot of reused/near-reused
// school names, and this tool already knows exactly which ones from its own
// data -- no reason to leave the model guessing when the collision is
// already a known fact.
//
// Originally this only matched an EXACT `name` string -- which is exactly
// what missed a second real mix-up in September 2026 between "Saint Edward
// High School" (Lakewood, OH) and "Saint Edwards High School" (Vero Beach,
// FL): two different schools already in this database whose names differ by
// one trailing letter, so `name = school.name` found nothing and the model
// got no heads-up at all before conflating them. Switched to looseSchoolNameKey
// (see lib/importReconcile.js) -- folds "St."/"Saint", punctuation, HS
// suffixes, and simple trailing-s plural/possessive variants, so "Saint
// Edward" and "Saint Edwards" (and "St. Xavier" / "Saint Xavier," etc.) are
// treated as the same name family. Deliberately loose: a false positive here
// only costs the model one unnecessary "double check this" line; a false
// negative costs a real same-name-school mix-up like the two above.
//
// `supabase` can be any client with read access to `schools` (a route-scoped
// verifier/sysadmin client or the admin client both work). Best-effort: a
// query failure here shouldn't sink the whole lookup, it just means the
// prompt won't get this particular assist -- the SYSTEM_PROMPT's general
// same-name-school rule still applies regardless. Pulls every non-closed
// school's id/name/city/state once (a few thousand rows -- this is a US
// high-school football database, not a nationwide institution list) and
// folds in JS rather than filtering in SQL, since there's no fuzzy-match
// index set up on this column; worth revisiting if this table ever grows
// dramatically past its current few-thousand-row scale.
export async function findDuplicateNameSchools({ supabase, school }) {
  if (!supabase || !school?.name || !school?.id) return [];
  const targetKey = looseSchoolNameKey(school.name);
  if (!targetKey) return [];
  try {
    const { data, error } = await supabase.from("schools").select("id,name,city,state").eq("is_closed", false);
    if (error || !data) return [];
    return data
      .filter((s) => s.id !== school.id && looseSchoolNameKey(s.name) === targetKey)
      .slice(0, 10)
      .map((s) => ({ city: s.city, state: s.state }));
  } catch (_) {
    return [];
  }
}

// Batched sibling of findDuplicateNameSchools above, for the two collect
// routes (manual + the unattended cron) instead of the two single-school
// prompt-building routes. Added alongside the targetLocationConfirmed
// backstop (see normalizeSuggestion) after the Columbia High School (SC vs.
// Huntsville, AL) mix-up -- that backstop needs to know, per item, whether
// THIS school's name is a known collision, and calling findDuplicateNameSchools
// once per item in a run of hundreds would mean re-fetching the entire
// schools table hundreds of times over. This does the same grouping work
// with exactly one query for the whole batch of schools handed in, same
// "one query for the whole run instead of one per item" pattern the collect
// routes' own schoolLocationByItemId fetch already uses. Returns a Map from
// school id -> boolean (true when 2+ open schools share its loose name
// key); a school whose id/name isn't resolvable, or a query failure, is
// simply absent/false rather than throwing -- best-effort, same as the
// single-school version above.
export async function findDuplicateNameSchoolsForMany({ supabase, schools }) {
  const result = new Map();
  if (!supabase || !schools || schools.length === 0) return result;
  try {
    const { data, error } = await supabase.from("schools").select("id,name").eq("is_closed", false);
    if (error || !data) return result;
    const countByKey = new Map();
    for (const s of data) {
      const key = looseSchoolNameKey(s.name);
      if (!key) continue;
      countByKey.set(key, (countByKey.get(key) || 0) + 1);
    }
    for (const s of schools) {
      if (!s?.id) continue;
      const key = looseSchoolNameKey(s.name);
      result.set(s.id, Boolean(key && (countByKey.get(key) || 0) > 1));
    }
    return result;
  } catch (_) {
    return result;
  }
}

// Builds the combined source text (fetched page(s) + search results) for a
// single school, and the "currently on file" summary block -- shared shape
// used both for the single-school route's live Anthropic call and for a
// batch item's saved source_text ahead of Batch API submission.
export function buildSourceBlocks({
  school,
  athleticsFetch,
  websiteFetch,
  searchResults,
  searchQuery,
  directoryPage,
  directorySearchResults,
  recencyPage,
  recencySearchResults,
  knowledgeGraph,
  answerBox,
  // Other schools sharing this exact name, from findDuplicateNameSchools
  // above -- e.g. [{city: "Clovis", state: "CA"}]. Optional: every existing
  // caller that doesn't pass this keeps working exactly as before, just
  // without the extra warning line.
  duplicateSchools,
  // The email address on file for this school that's confirmed to have
  // hard-bounced (e.g. from email_bounce_events), if any. Optional: every
  // existing caller that doesn't pass this keeps working exactly as before.
  // When set, the model is told explicitly that this address is dead rather
  // than just "not independently verified" -- see bounceWarningBlock below.
  bouncedEmail,
}) {
  const usableBlocks = [];
  if (athleticsFetch?.ok && athleticsFetch.text) usableBlocks.push({ label: "athletics site", url: school.athletics_url, text: athleticsFetch.text, cap: MAX_CHARS_PER_SOURCE });
  if (websiteFetch?.ok && websiteFetch.text) usableBlocks.push({ label: "general website", url: school.website, text: websiteFetch.text, cap: MAX_CHARS_PER_SOURCE });
  // findDirectoryPage's fetched result, if it found one worth reading in
  // full (see that function's own comment) -- often the actual staff/
  // faculty directory page, which neither of the two blocks above turns
  // out to be. Gets the larger MAX_CHARS_DIRECTORY_PAGE budget (see that
  // constant's own comment) rather than the standard per-source cap, since
  // an all-staff directory listing is often long and a name worth finding
  // (an Athletic Director, say) can sit well past where the standard cap
  // would have cut it off.
  if (directoryPage?.text) usableBlocks.push({ label: "staff directory search result", url: directoryPage.url, text: directoryPage.text, cap: MAX_CHARS_DIRECTORY_PAGE });
  // findRecentGameEvidence's fetched result, if it found one -- a
  // current-season schedule/scores page, kept as its own labeled block
  // (rather than folded into the two above) so the model can point to it
  // by name in notes as its recency evidence, per the SYSTEM_PROMPT rule.
  if (recencyPage?.text) usableBlocks.push({ label: "recent schedule/scores page", url: recencyPage.url, text: recencyPage.text, cap: MAX_CHARS_PER_SOURCE });

  const pageTextBlocks = usableBlocks.map((b) => `--- Full text from the ${b.label} (${b.url}) ---\n${b.text.slice(0, b.cap)}`);
  const searchBlock =
    searchResults && searchResults.length > 0
      ? `--- Web search results for "${searchQuery}" ---\n${searchResults.map((r, i) => `${i + 1}. ${r.title} (${r.link})\n   ${r.snippet}`).join("\n")}`
      : null;
  const directorySearchBlock =
    directorySearchResults && directorySearchResults.length > 0
      ? `--- Web search results for "${buildDirectorySearchQuery(school)}" ---\n${directorySearchResults.map((r, i) => `${i + 1}. ${r.title} (${r.link})\n   ${r.snippet}`).join("\n")}`
      : null;
  // Recency search's own organic results -- worth handing to the model even
  // when no single result was worth a full fetch (e.g. every hit was
  // MaxPreps/a social platform): a search-result snippet alone often
  // already contains a dated score line ("...beat Benbrook 50-49 (9/11)")
  // that's exactly the recency evidence the SYSTEM_PROMPT rule is looking
  // for, the same way it would be if a person read that same snippet in a
  // Google results page.
  const recencySearchBlock =
    recencySearchResults && recencySearchResults.length > 0
      ? `--- Web search results for "${buildRecencySearchQuery(school)}" ---\n${recencySearchResults.map((r, i) => `${i + 1}. ${r.title} (${r.link})\n   ${r.snippet}`).join("\n")}`
      : null;
  // Google's own Knowledge Graph entry for this query, when it has one --
  // see searchWebWithGraph's own comment for why this is worth reading at
  // all. attributes is a free-form key/value object Google attaches (job
  // title, employer, etc.) -- flattened into plain "key: value" lines since
  // there's no fixed shape to rely on ahead of time.
  const knowledgeGraphBlock = knowledgeGraph
    ? `--- Google Knowledge Graph entry for "${searchQuery}" ---\n${[
        knowledgeGraph.title ? `Title: ${knowledgeGraph.title}` : null,
        knowledgeGraph.type ? `Type: ${knowledgeGraph.type}` : null,
        knowledgeGraph.description ? `Description: ${knowledgeGraph.description}` : null,
        knowledgeGraph.website ? `Website: ${knowledgeGraph.website}` : null,
        ...Object.entries(knowledgeGraph.attributes || {}).map(([k, v]) => `${k}: ${v}`),
      ]
        .filter(Boolean)
        .join("\n")}`
    : null;
  // Google's featured-snippet/"answer box" for this query, when it has one
  // -- often the closest thing Serper can give us to the synthesized
  // narrative answer a person sees typing the same query into google.com
  // directly.
  const answerBoxBlock = answerBox
    ? `--- Google answer box for "${searchQuery}" ---\n${[
        answerBox.title ? `Title: ${answerBox.title}` : null,
        answerBox.answer ? `Answer: ${answerBox.answer}` : null,
        answerBox.snippet ? `Snippet: ${answerBox.snippet}` : null,
        answerBox.link ? `Source: ${answerBox.link}` : null,
      ]
        .filter(Boolean)
        .join("\n")}`
    : null;
  const textBlocks = [...pageTextBlocks, searchBlock, directorySearchBlock, recencySearchBlock, knowledgeGraphBlock, answerBoxBlock].filter(Boolean).join("\n\n");

  // True when the bouncedEmail we were handed is in fact the same address
  // currently on file -- guards against a stale bounce record for an email
  // that's since been updated to something else, in which case we don't
  // want to tell the model the (now-different) on-file address is dead.
  const onFileEmailIsBounced = Boolean(bouncedEmail && school.hc_email && bouncedEmail.trim().toLowerCase() === school.hc_email.trim().toLowerCase());

  const currentlyOnFile = [
    "(Not independently verified -- see the system prompt's rule on this.)",
    school.hc_first_name || school.hc_last_name ? `Head coach on file: ${[school.hc_first_name, school.hc_last_name].filter(Boolean).join(" ")}` : "Head coach on file: none",
    school.hc_email
      ? `Email on file: ${school.hc_email}${onFileEmailIsBounced ? " -- CONFIRMED DEAD (hard-bounced on a real send). Do not suggest this same address again." : ""}`
      : "Email on file: none",
    school.hc_cell ? `Cell on file: ${school.hc_cell}` : null,
    school.hc_office ? `Office phone on file: ${school.hc_office}` : null,
    school.hc_twitter ? `Twitter/X on file: ${school.hc_twitter}` : null,
    school.hc_facebook ? `Facebook on file: ${school.hc_facebook}` : null,
    school.ad_name ? `Athletic Director on file: ${school.ad_name}` : null,
    school.ad_email ? `Athletic Director email on file: ${school.ad_email}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  const defaultSource = [...usableBlocks.map((b) => b.label), searchResults && searchResults.length > 0 ? "web search" : null].filter(Boolean).join(" + ");

  // Explicit warning line built from findDuplicateNameSchools -- this is
  // what turns the SYSTEM_PROMPT's general same-name-school rule into a
  // concrete, this-lookup-specific fact when the database already knows one
  // applies. Placed right under the "School:" line, ahead of everything
  // else, so it's the first thing the model reads about this school, not
  // something buried after a page of source text.
  const duplicateSchoolsBlock =
    duplicateSchools && duplicateSchools.length > 0
      ? `IMPORTANT -- this database also contains ${duplicateSchools.length} other school${duplicateSchools.length > 1 ? "s" : ""} named "${school.name}" at a DIFFERENT location: ${duplicateSchools
          .map((d) => `${d.city || "unknown city"}, ${d.state || "unknown state"}`)
          .join("; ")}. Any source that actually describes one of those is NOT this school -- see the same-name school check rule above.`
      : null;

  // Up-front warning, same placement pattern as duplicateSchoolsBlock, so
  // the model sees this before it reads any source text -- otherwise a
  // hard-bounced address the model finds re-confirmed on the school's own
  // (stale) athletics page could easily get suggested right back.
  const bounceWarningBlock = onFileEmailIsBounced
    ? `IMPORTANT -- the email currently on file for this school (${school.hc_email}) is CONFIRMED DEAD: it hard-bounced on a real newsletter send. Do not suggest this same address again, even if a source you find repeats it. If you cannot find a different, verifiable email, say so explicitly rather than re-confirming the bad one.`
    : null;

  return {
    hasUsableContent:
      usableBlocks.length > 0 ||
      (searchResults && searchResults.length > 0) ||
      (directorySearchResults && directorySearchResults.length > 0) ||
      (recencySearchResults && recencySearchResults.length > 0) ||
      Boolean(knowledgeGraph) ||
      Boolean(answerBox),
    userMessage: `School: ${school.name}, ${school.city || ""}, ${school.state || ""}\n\n${[bounceWarningBlock, duplicateSchoolsBlock, currentlyOnFile].filter(Boolean).join("\n\n")}\n\n${textBlocks}`,
    defaultSource,
  };
}

// Runs `worker` over every item in `items`, at most `limit` in flight at
// once, instead of one-at-a-time. Same shape as the client-side helper of
// the same name already duplicated in the batch review pages (e.g.
// app/(app)/admin/review-queue/page.js) for their bulk-apply buttons -- kept
// here as the one server-side copy so every batch collect route (Athletics,
// MaxPreps, Coach-Info, and the automated cron collector) can share it.
//
// Why this exists: every collect route below used to loop over a batch
// run's results with a plain `for...of` and `await` each item's database
// write in turn. That's safe but slow -- for an oversized run (Athletics
// Run #20: 996 schools) the sequential wait time added up past Vercel's
// function time limit and the request got killed mid-run before it could
// mark the run "collected", even though every item up to that point had
// already saved fine. Processing items `limit`-at-a-time cuts wall-clock
// time by roughly that same factor with no change in what gets written --
// each item's own update+auto-apply logic is unchanged and untouched by
// any other item running alongside it.
export async function runWithConcurrency(items, limit, worker) {
  let next = 0;
  async function runNext() {
    const i = next++;
    if (i >= items.length) return;
    await worker(items[i], i);
    return runNext();
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runNext));
}

// Same field list applySuggestionCore in app/(app)/admin/batch-coach-info/page.js
// writes on a manual Apply click -- kept here too so the auto-apply path
// below (called from server routes that never loaded that page's module)
// can't drift from it.
export const AUTO_APPLY_FIELDS = ["hc_first_name", "hc_last_name", "hc_email", "hc_office", "hc_cell", "hc_twitter", "hc_facebook"];

// The school_change_log source string every auto-applied change gets --
// deliberately distinct from the "...reviewed)" string a human Apply click
// writes, so both the review page and Data Quality's "My Recent Updates"
// list can tell at a glance which suggestions a person looked at first and
// which were written unattended.
export const AUTO_APPLY_SOURCE_LABEL = "Batch AI lookup (high confidence, auto-applied)";

// Fields where writing OVER an existing non-blank value is treated as an
// identity change, not a safe fill-in-the-blank -- added after Larry
// caught 60 schools (out of 477 duplicated by the Sept 2026 row-cap
// exclusion bug -- see claude/batch-exclusion-row-cap-bug-fix.md) where a
// later high-confidence run silently overwrote an earlier one's coach
// name/email with a DIFFERENT answer, unattended, with no human ever
// seeing the disagreement. "High confidence" describes how sure the model
// is about what it found, not whether replacing who CSD already has on
// file for this school is safe to do without a person looking -- those
// are different questions, and this function used to only ask the first
// one. hc_office/hc_cell/hc_twitter/hc_facebook are deliberately left out:
// they're contact details for whichever coach is already on record, not
// an identity claim, and gating them too would hold back nearly every
// legitimate auto-apply (almost every suggestion touches at least one of
// these alongside a name/email).
const OVERWRITE_GATED_FIELDS = new Set(["hc_first_name", "hc_last_name", "hc_email"]);

// Writes a single high-confidence coach-info suggestion straight into the
// schools table the moment a batch collects it -- no click required. Mirrors
// applySuggestionCore's write shape exactly (same fields, same
// school_change_log columns, same coach_info_batch_items status update) so
// an auto-applied change looks and audits identically to a manually-applied
// one everywhere else in the app; the only difference is the source label
// and who gets attributed as the actor. Only ever call this when the
// suggestion's own confidence is "high" -- medium/low still needs a human
// on the review page, exactly like the existing bulk-apply button's bar.
//
// Splits the suggestion's fields into two groups (see OVERWRITE_GATED_FIELDS
// above): a blank-on-file field gets written immediately, same as always.
// A field that would REPLACE an existing non-blank value with a different
// one is held back -- written into the item's own suggestion.notes as a
// flagged note instead, with the item left at review_status "pending" so
// it surfaces on the review page exactly like any medium/low-confidence
// suggestion, waiting for a person to confirm it's a real coaching change
// (not a mix-up or a stale duplicate) before it lands on the school.
//
// `supabase` can be either the admin client (automated cron, bypasses RLS,
// attributed to the CSD sysadmin account) or a signed-in verifier/sysadmin's
// route-scoped client (the manual "Collect Results" click) -- both expose
// the same .from() surface this needs.
export async function autoApplyHighConfidenceSuggestion({ supabase, itemId, itemsTable, schoolId, suggestion, actorUserId }) {
  const { data: school, error: schoolErr } = await supabase
    .from("schools")
    .select(`id,${AUTO_APPLY_FIELDS.join(",")}`)
    .eq("id", schoolId)
    .maybeSingle();
  if (schoolErr || !school) return { applied: false, held: false, changedFields: [], heldFields: [], error: schoolErr?.message || "School not found for auto-apply." };

  const update = {};
  const changes = [];
  const heldFields = [];
  AUTO_APPLY_FIELDS.forEach((f) => {
    const newVal = (suggestion[f] || "").trim();
    const currentVal = (school[f] || "").trim();
    if (!newVal || newVal === currentVal) return;
    if (OVERWRITE_GATED_FIELDS.has(f) && currentVal) {
      heldFields.push(f);
      return;
    }
    update[f] = newVal;
    changes.push({ school_id: school.id, field_name: f, old_value: school[f] || null, new_value: newVal, source: AUTO_APPLY_SOURCE_LABEL, changed_by: actorUserId });
  });

  // Captured before the needs_review clear fields below get folded into
  // `update`, so changedFields (returned to the caller) stays a true list of
  // schools.* coach-data columns actually changed, not padded out with the
  // bookkeeping fields.
  const changedFields = Object.keys(update);

  if (changedFields.length > 0) {
    // Same needs_review clear every human Apply path uses (lib/needsReview.js)
    // -- but only when hc_email is actually one of the fields this
    // auto-apply just changed. An unattended auto-apply that only confirms
    // a name/office/Twitter while leaving an already-confirmed-dead email
    // untouched (because the AI found no replacement) must NOT clear the
    // flag -- that's exactly what silently happened to a live school
    // (Estrella Foothills, caught checking Run #36) before this check was
    // added, and it's even more important to gate here than on the manual
    // Apply buttons since nobody's reviewing this write at all.
    if (update.hc_email) {
      Object.assign(update, NEEDS_REVIEW_CLEAR_FIELDS);
    }
    const { error: updateErr } = await supabase.from("schools").update(update).eq("id", school.id);
    if (updateErr) return { applied: false, held: false, changedFields: [], heldFields, error: updateErr.message };
    const { error: logErr } = await supabase.from("school_change_log").insert(changes);
    if (logErr) return { applied: false, held: false, changedFields: [], heldFields, error: logErr.message };
  }

  if (heldFields.length > 0) {
    const heldLabel = heldFields
      .map((f) => (f === "hc_email" ? "email" : "coach name"))
      .filter((v, i, arr) => arr.indexOf(v) === i)
      .join(" and ");
    const heldNote = `⚠️ Auto-apply held back the ${heldLabel} -- this suggestion would replace what's already on file with a different value. Confirm this is a real coaching change (not a mix-up or a stale duplicate) before applying.`;
    await supabase
      .from(itemsTable || "coach_info_batch_items")
      .update({ suggestion: { ...suggestion, notes: [heldNote, suggestion.notes].filter(Boolean).join(" ") } })
      .eq("id", itemId);
    // Item stays at whatever review_status it already had (the default,
    // "pending") -- NOT marked "applied" -- so it shows up on the review
    // page like any other suggestion waiting for a person, instead of
    // silently disappearing the way it used to.
    return { applied: false, held: true, changedFields, heldFields, error: null };
  }

  const { error: itemErr } = await supabase
    .from(itemsTable || "coach_info_batch_items")
    .update({ review_status: "applied", reviewed_at: new Date().toISOString(), reviewed_by: actorUserId })
    .eq("id", itemId);
  if (itemErr) return { applied: false, held: false, changedFields, heldFields: [], error: itemErr.message };

  return { applied: true, held: false, changedFields, heldFields: [] };
}

// Same generic write path as autoApplyHighConfidenceSuggestion above, but
// for the single-URL-field batch tools (Athletics-URL, MaxPreps) instead of
// coach-info's seven-field shape -- writes a suggestion's best_url straight
// into one schools column the moment a batch collects a high-confidence
// result. Kept here rather than duplicated in each tool's collect route so
// all three auto-apply paths share one write/log/mark-applied shape and
// can't quietly drift from each other, same reasoning as
// autoApplyHighConfidenceSuggestion itself. Only ever call this when the
// suggestion's own confidence is "high" -- medium/low/none still needs a
// human on that tool's review page.
export async function autoApplyHighConfidenceUrlSuggestion({ supabase, itemId, itemsTable, schoolId, fieldName, newUrl, actorUserId }) {
  const url = (newUrl || "").toString().trim();
  if (!url) return { applied: false, changedFields: [], error: null };

  const { data: school, error: schoolErr } = await supabase.from("schools").select(`id,${fieldName}`).eq("id", schoolId).maybeSingle();
  if (schoolErr || !school) return { applied: false, changedFields: [], error: schoolErr?.message || "School not found for auto-apply." };

  const changedFields = [];
  if (url !== (school[fieldName] || "")) {
    const { error: updateErr } = await supabase.from("schools").update({ [fieldName]: url }).eq("id", school.id);
    if (updateErr) return { applied: false, changedFields: [], error: updateErr.message };
    const { error: logErr } = await supabase.from("school_change_log").insert({
      school_id: school.id,
      field_name: fieldName,
      old_value: school[fieldName] || null,
      new_value: url,
      source: AUTO_APPLY_SOURCE_LABEL,
      changed_by: actorUserId,
    });
    if (logErr) return { applied: false, changedFields: [], error: logErr.message };
    changedFields.push(fieldName);
  }

  const { error: itemErr } = await supabase
    .from(itemsTable)
    .update({ review_status: "applied", reviewed_at: new Date().toISOString(), reviewed_by: actorUserId })
    .eq("id", itemId);
  if (itemErr) return { applied: false, changedFields, error: itemErr.message };

  return { applied: true, changedFields };
}

// Unattended counterpart to each tool's own manual "Confirm No Data
// Available" button (confirmNoDataAvailableCore in each tool's page.js).
// Called from collect-batch-runs for the Athletics/MaxPreps/Social
// dimensions when a collected result came back with nothing usable -- an
// AI confidence of "none", an outright parse/API failure, or a search that
// found no results to even send to the AI. Deliberately NOT offered to
// Coach-Info: that dimension has no *_not_available escape hatch in
// hasFullCoachRecord() (lib/dataQuality.js), so "confirm no data" there
// just marks the school reviewed without asserting anything is actually
// complete -- a human call, not one worth making unattended.
//
// Unlike autoApplyHighConfidenceSuggestion/autoApplyHighConfidenceUrlSuggestion
// above, this never writes a specific value the AI proposed -- it only
// records an absence (the same *_not_available flag a human clicking the
// button would set), which is why it's safe to run without a human
// reviewing each one first. Mirrors confirmNoDataAvailableCore's exact
// write shape: marks the school verified, sets the not-available flag
// (only if it wasn't already true, so a repeat confirmation doesn't spam
// school_change_log with no-op entries), logs the flag flip plus a
// confirmation entry against the field(s) this tool tracks, and marks the
// batch item confirmed_no_data.
export async function autoConfirmNoDataAvailable({ supabase, itemId, itemsTable, schoolId, notAvailableField, confirmFields, source, actorUserId }) {
  const selectCols = Array.from(new Set([notAvailableField, ...confirmFields])).join(",");
  const { data: school, error: schoolErr } = await supabase.from("schools").select(`id,${selectCols}`).eq("id", schoolId).maybeSingle();
  if (schoolErr || !school) return { applied: false, error: schoolErr?.message || "School not found for auto-confirm." };

  const wasNotAvailable = !!school[notAvailableField];
  const { error: updateErr } = await supabase
    .from("schools")
    .update({ verification_status: "verified", last_verified_at: new Date().toISOString(), [notAvailableField]: true })
    .eq("id", schoolId);
  if (updateErr) return { applied: false, error: updateErr.message };

  const logRows = confirmFields.map((f) => ({
    school_id: schoolId,
    field_name: f,
    old_value: school[f] || null,
    new_value: school[f] || null,
    source,
    changed_by: actorUserId,
  }));
  if (!wasNotAvailable) {
    logRows.push({
      school_id: schoolId,
      field_name: notAvailableField,
      old_value: String(wasNotAvailable),
      new_value: "true",
      source,
      changed_by: actorUserId,
    });
  }
  const { error: logErr } = await supabase.from("school_change_log").insert(logRows);
  if (logErr) return { applied: false, error: logErr.message };

  const { error: itemErr } = await supabase
    .from(itemsTable)
    .update({ review_status: "confirmed_no_data", reviewed_at: new Date().toISOString(), reviewed_by: actorUserId })
    .eq("id", itemId);
  if (itemErr) return { applied: false, error: itemErr.message };

  return { applied: true };
}
