import { NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { parseModelJson } from "@/lib/coachInfoLookup";
import { searchNews, SYSTEM_PROMPT, buildNewsSourceText, normalizeNewsCheckResult, MODEL, MAX_TOKENS } from "@/lib/newsCoachCheck";

export const maxDuration = 60;

// Nightly automated sweep -- Coaching-Change NEWS Check. Sister job to the
// Coach-Change Radar (recheck-schools): that one waits for a school's own
// website to reflect a coaching change, which can lag the actual hire by
// weeks or months. This one searches Google News for each school instead
// ("<school> new head football coach"), so a hire that got local news
// coverage can surface within days of the announcement -- often long
// before the school's own site catches up. Invoked by Vercel Cron (see
// vercel.json) once a night, same Bearer-secret auth as recheck-schools.
//
// Same non-authoritative contract as every other tool in this app: never
// writes to a school's own fields. Every check is logged to
// school_news_check_log for the audit trail. When the model reports a
// confident, genuinely-new finding (the reported name isn't just a rehash
// of what's already on file), it opens a flag in the same school_flags
// queue every other automated check uses -- "Automated news check: ..." --
// with the reported name and article link, so Larry can verify it and
// then run AI Coach-Info lookup to fill in full contact details. Nothing
// here ever guesses an email/phone -- that's a job for the coach-info
// tools once a human has confirmed there's actually a new coach to look
// up.
//
// A real Anthropic call is made per school (interpreting news search
// results isn't a simple string match the way the website recheck is), so
// this is deliberately a lighter nightly batch than recheck-schools' 500 --
// BATCH_SIZE below cycles the roughly 14,600-school database once every
// ~7 weeks at TIME_BUDGET_MS's realistic per-run throughput, which is
// still enormously faster than "whenever the school's own site happens to
// update." Tune BATCH_SIZE up if the Anthropic/Serper cost is comfortable
// and faster full-database coverage is wanted.
const BATCH_SIZE = 300;
const CONCURRENCY = 6; // lower than recheck-schools' 8 -- each iteration here makes a real Anthropic call, not just a page fetch
const TIME_BUDGET_MS = 50_000;

const SYSTEM_USER_ID = "d24ad753-f759-479d-8958-fae8f995faa1"; // CSD sysadmin account (Larry)

export async function GET(req) {
  const authHeader = req.headers.get("authorization") || "";
  const { searchParams } = new URL(req.url);
  const querySecret = searchParams.get("secret") || "";
  const expected = process.env.CRON_SECRET;
  const authorized = !!expected && (authHeader === `Bearer ${expected}` || querySecret === expected);
  if (!authorized) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startedAt = Date.now();
  const supabase = getSupabaseAdminClient();

  // Kill switch, same pattern as recheck-schools' coach_radar_enabled --
  // missing row = treated as enabled.
  const { data: setting } = await supabase.from("system_settings").select("value").eq("key", "coach_news_check_enabled").maybeSingle();
  if (setting && setting.value === false) {
    console.log("cron coach-news-check: skipped -- coach_news_check_enabled is false in system_settings");
    return NextResponse.json({ skipped: true, reason: "Coaching-change news check is currently suspended (system_settings.coach_news_check_enabled = false)." });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  const serperKey = process.env.SERPER_API_KEY;
  if (!apiKey || !serperKey) {
    console.error("cron coach-news-check: missing ANTHROPIC_API_KEY or SERPER_API_KEY");
    return NextResponse.json(
      { error: "Coaching-change news check isn't fully configured -- ANTHROPIC_API_KEY and/or SERPER_API_KEY missing from the server environment." },
      { status: 500 }
    );
  }

  const { data: candidates, error: candErr } = await supabase
    .from("school_news_check_priority")
    .select("school_id, name, city, state, hc_first_name, hc_last_name")
    .order("last_news_checked_at", { ascending: true, nullsFirst: true })
    .order("school_id", { ascending: true })
    .limit(BATCH_SIZE);

  if (candErr) {
    console.error("cron coach-news-check: could not load candidates", candErr);
    return NextResponse.json({ error: "Could not load candidate schools." }, { status: 500 });
  }

  const summary = { change_detected: 0, no_change_found: 0, no_results: 0, fetch_error: 0 };
  let processed = 0;
  let flagsOpened = 0;
  let confidenceUpdated = 0;
  let cursor = 0;

  async function worker() {
    while (true) {
      if (Date.now() - startedAt > TIME_BUDGET_MS) return;
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
        checked_by: SYSTEM_USER_ID,
        result,
        detail: `[Automated news check] ${detail}`,
        source_url: sourceUrl,
      });

      // Only worth a human's attention when the model is reasonably
      // confident AND the reported name is genuinely new information --
      // skip flagging when it just re-confirms who's already on file (an
      // old "meet the new coach" story from back when the CURRENT on-file
      // coach was hired still turns up in a search long after the fact,
      // and shouldn't re-flag the same school every time it's checked).
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
            flagged_by: SYSTEM_USER_ID,
            reason: `Automated news check: news coverage reports ${nameNote} at this school (${newsCheck.confidence} confidence) -- on file: "${onFileNote}". Please verify and use AI Coach-Info lookup to fill in full contact details.${sourceNote}`,
          });
          flagsOpened++;
        }
      }

      // Same reasoning as recheck-schools -- confidence_score is a
      // derived number the database recomputes on its own, and now
      // factors in a pending "Automated news check" flag the same way it
      // does the other three automated flag types. This route never
      // writes to schools directly, so force a recompute here too.
      const { error: touchErr } = await supabase.rpc("touch_school_confidence_score", { p_school_id: c.school_id });
      if (!touchErr) confidenceUpdated++;
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  const result = {
    processed,
    candidates_available: candidates.length,
    stopped_early: cursor < candidates.length,
    duration_ms: Date.now() - startedAt,
    flags_opened: flagsOpened,
    confidence_scores_updated: confidenceUpdated,
    summary,
  };
  console.log("cron coach-news-check:", JSON.stringify(result));
  return NextResponse.json(result);
}
