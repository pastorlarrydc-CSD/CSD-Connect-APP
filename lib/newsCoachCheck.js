// Shared logic for the Coaching-Change News Check -- the search/prompt/parse
// helpers used to catch a head football coaching change straight from news
// coverage, instead of waiting for a school's own website to update (which
// can lag an actual hire by weeks or months). Mirrors the shape of
// lib/coachInfoLookup.js and lib/athleticsLookup.js -- same conventions,
// same MODEL default, reuses parseModelJson from lib/coachInfoLookup.js
// rather than duplicating it.
//
// runNewsCheckBatch() below is the actual candidate-select-and-process
// loop, extracted here so it has exactly one implementation shared by both
// callers: the nightly cron (app/api/cron/coach-news-check) and the
// on-demand "Run Now" trigger (app/api/admin/run-news-check) that lets a
// verifier/sysadmin work through the backlog faster than the fixed nightly
// slice without waiting on the clock. Both pass the same batchSize/
// concurrency/timeBudgetMs the cron always has, so a manual run behaves
// identically to a nightly one -- just triggered on request. Each call
// only ever advances against school_news_check_priority's own staleness
// ordering, so firing this by hand several times in a row is safe: every
// run picks up the next-stalest slice, never the same schools twice in a
// row.

import { parseModelJson } from "@/lib/coachInfoLookup";

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

// CSD sysadmin account (Larry) -- used to attribute the nightly cron's own
// rows, since there's no human to credit an automated check to. A manual
// "Run Now" trigger passes the actual clicking user's id instead (see
// checkedBy below), so the audit trail still shows who ran it.
export const SYSTEM_USER_ID = "d24ad753-f759-479d-8958-fae8f995faa1";

// The actual candidate-select-and-process loop, shared by the nightly cron
// and the on-demand admin trigger. Returns a plain result object on
// success, or { error } if the candidate query itself failed -- callers
// turn that into whatever HTTP response shape fits their route.
export async function runNewsCheckBatch({
  supabase,
  apiKey,
  serperKey,
  batchSize,
  concurrency = 6,
  timeBudgetMs = 50_000,
  checkedBy = SYSTEM_USER_ID,
  // Distinguishes a nightly row from a manually-triggered one in
  // school_news_check_log's detail text. Deliberately NOT used for the
  // school_flags reason prefix below -- every flag this opens (nightly or
  // manual) is still a system/AI-generated check rather than a coach
  // self-report, so it keeps the "Automated news check:" prefix either
  // way. That prefix is what AUTOMATED_FLAG_PREFIXES (data-quality/page.js
  // and the verifier-digest email) key off of to tell automated flags
  // apart from coach-reported ones -- changing it here would silently
  // stop a manually-triggered run's flags from being recognized there.
  logPrefix = "[Automated news check]",
}) {
  const startedAt = Date.now();

  const { data: candidates, error: candErr } = await supabase
    .from("school_news_check_priority")
    .select("school_id, name, city, state, hc_first_name, hc_last_name")
    .order("last_news_checked_at", { ascending: true, nullsFirst: true })
    .order("school_id", { ascending: true })
    .limit(batchSize);

  if (candErr) {
    return { error: "Could not load candidate schools." };
  }

  const summary = { change_detected: 0, no_change_found: 0, no_results: 0, fetch_error: 0 };
  let processed = 0;
  let flagsOpened = 0;
  let confidenceUpdated = 0;
  let cursor = 0;

  async function worker() {
    while (true) {
      if (Date.now() - startedAt > timeBudgetMs) return;
      const i = cursor++;
      if (i >= candidates.length) return;
      const c = candidates[i];

      const school = { name: c.name, city: c.city, state: c.state, hc_first_name: c.hc_first_name, hc_last_name: c.hc_last_name };
      const searchQuery = `${c.name} ${c.city || ""} ${c.state || ""} new head football coach`;

      let result = "fetch_error";
      let detail = "";
      let sourceUrl = null;
      let newsCheck = null;

      try {
        const searchResults = await searchNews(searchQuery, serperKey);
        if (!searchResults.length) {
          result = "no_results";
          detail = "No news results found for this school.";
        } else {
          const userMessage = buildNewsSourceText({ school, searchResults, searchQuery });
          const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
            body: JSON.stringify({ model: MODEL, max_tokens: MAX_TOKENS, system: SYSTEM_PROMPT, messages: [{ role: "user", content: userMessage }] }),
          });

          if (!aiRes.ok) {
            result = "fetch_error";
            detail = `Anthropic API error (${aiRes.status}).`;
          } else {
            const aiJson = await aiRes.json();
            const parsed = parseModelJson(aiJson?.content?.[0]?.text || "");
            if (!parsed) {
              result = "fetch_error";
              detail = "Could not parse the AI response.";
            } else {
              newsCheck = normalizeNewsCheckResult(parsed);
              sourceUrl = newsCheck.article_url || null;
              if (newsCheck.change_detected) {
                result = "change_detected";
                detail = `Reported new coach: "${newsCheck.new_coach_name || "(name not given)"}" (${newsCheck.confidence} confidence). ${newsCheck.notes}`.trim();
              } else {
                result = "no_change_found";
                detail = newsCheck.notes || "No head football coaching change found in recent news.";
              }
            }
          }
        }
      } catch (err) {
        result = "fetch_error";
        detail = `Unexpected error: ${err?.message || err}`;
      }

      summary[result] = (summary[result] || 0) + 1;
      processed++;

      await supabase.from("school_news_check_log").insert({
        school_id: c.school_id,
        checked_by: checkedBy,
        result,
        detail: `${logPrefix} ${detail}`,
        source_url: sourceUrl,
      });

      const reportedLastName = (newsCheck?.new_coach_name || "").trim().split(/\s+/).pop() || "";
      const alreadyOnFile = !!reportedLastName && !!c.hc_last_name && reportedLastName.toLowerCase() === c.hc_last_name.toLowerCase();

      if (result === "change_detected" && newsCheck.confidence !== "low" && !alreadyOnFile) {
        const { data: existingFlag } = await supabase
          .from("school_flags")
          .select("id")
          .eq("school_id", c.school_id)
          .eq("status", "pending")
          .ilike("reason", "Automated news check%")
          .maybeSingle();

        if (!existingFlag) {
          const nameNote = newsCheck.new_coach_name ? `"${newsCheck.new_coach_name}"` : "a new head football coach";
          const onFileNote = [c.hc_first_name, c.hc_last_name].filter(Boolean).join(" ") || "no coach on file";
          const sourceNote = newsCheck.article_url ? ` Source: ${newsCheck.article_url}` : "";
          await supabase.from("school_flags").insert({
            school_id: c.school_id,
            flagged_by: checkedBy,
            reason: `Automated news check: news coverage reports ${nameNote} at this school (${newsCheck.confidence} confidence) -- on file: "${onFileNote}". Please verify and use AI Coach-Info lookup to fill in full contact details.${sourceNote}`,
          });
          flagsOpened++;
        }
      }

      const { error: touchErr } = await supabase.rpc("touch_school_confidence_score", { p_school_id: c.school_id });
      if (!touchErr) confidenceUpdated++;
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  return {
    processed,
    candidates_available: candidates.length,
    stopped_early: cursor < candidates.length,
    duration_ms: Date.now() - startedAt,
    flags_opened: flagsOpened,
    confidence_scores_updated: confidenceUpdated,
    summary,
  };
}
