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
  if (schoolErr || !school) return { applied: false, changedFields: [], error: schoolErr?.message || "School not found for auto-apply." };

  const update = {};
  const changes = [];
  AUTO_APPLY_FIELDS.forEach((f) => {
    const newVal = (suggestion[f] || "").trim();
    if (newVal && newVal !== (school[f] || "")) {
      update[f] = newVal;
      changes.push({ school_id: school.id, field_name: f, old_value: school[f] || null, new_value: newVal, source: AUTO_APPLY_SOURCE_LABEL, changed_by: actorUserId });
    }
  });

  if (Object.keys(update).length > 0) {
    const { error: updateErr } = await supabase.from("schools").update(update).eq("id", school.id);
    if (updateErr) return { applied: false, changedFields: [], error: updateErr.message };
    const { error: logErr } = await supabase.from("school_change_log").insert(changes);
    if (logErr) return { applied: false, changedFields: [], error: logErr.message };
  }

  const { error: itemErr } = await supabase
    .from(itemsTable || "coach_info_batch_items")
    .update({ review_status: "applied", reviewed_at: new Date().toISOString(), reviewed_by: actorUserId })
    .eq("id", itemId);
  if (itemErr) return { applied: false, changedFields: Object.keys(update), error: itemErr.message };

  return { applied: true, changedFields: Object.keys(update) };
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
