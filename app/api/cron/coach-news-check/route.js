import { NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { runNewsCheckBatch, SYSTEM_USER_ID } from "@/lib/newsCoachCheck";

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
//
// The actual candidate-select-and-process loop lives in
// runNewsCheckBatch() (lib/newsCoachCheck.js) -- this route just handles
// cron auth, the kill switch, and the env check, then calls it with the
// same batchSize/concurrency/timeBudgetMs every night. app/api/admin/
// run-news-check is the on-demand twin: same shared function, session
// auth instead of the cron secret, so a verifier/sysadmin can work
// through the backlog faster than the fixed nightly slice without waiting
// on the clock.
const BATCH_SIZE = 300;
const CONCURRENCY = 6; // lower than recheck-schools' 8 -- each iteration here makes a real Anthropic call, not just a page fetch
const TIME_BUDGET_MS = 50_000;

export async function GET(req) {
  const authHeader = req.headers.get("authorization") || "";
  const { searchParams } = new URL(req.url);
  const querySecret = searchParams.get("secret") || "";
  const expected = process.env.CRON_SECRET;
  const authorized = !!expected && (authHeader === `Bearer ${expected}` || querySecret === expected);
  if (!authorized) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

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

  const result = await runNewsCheckBatch({
    supabase,
    apiKey,
    serperKey,
    batchSize: BATCH_SIZE,
    concurrency: CONCURRENCY,
    timeBudgetMs: TIME_BUDGET_MS,
    checkedBy: SYSTEM_USER_ID,
    logPrefix: "[Automated news check]",
  });

  if (result.error) {
    console.error("cron coach-news-check: could not load candidates");
    return NextResponse.json({ error: result.error }, { status: 500 });
  }

  console.log("cron coach-news-check:", JSON.stringify(result));
  return NextResponse.json(result);
}
