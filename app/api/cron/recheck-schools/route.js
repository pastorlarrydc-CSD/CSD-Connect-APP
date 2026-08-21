import { NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { checkSchoolCoach } from "@/lib/schoolRecheck";

export const maxDuration = 60;

// Nightly automated sweep -- Coach-Change Radar. Picks the schools that have
// gone longest without a recheck (or have never been checked, via the
// school_recheck_priority view) and runs the same "does the on-file head
// coach's name still appear on their website -- or, failing that, their
// MaxPreps roster page" check the manual "Check for updates" button runs,
// just at scale across the database. Invoked by Vercel Cron (see
// vercel.json) once a night; Vercel automatically attaches
// `Authorization: Bearer <CRON_SECRET>` using the CRON_SECRET environment
// variable, and this route rejects anything that doesn't match.
//
// Deliberately conservative, same as the manual route: never writes to the
// schools table itself. Every check is logged to school_recheck_log so the
// data is there to review (attributed to CSD's own sysadmin account, since
// there's no human to credit an automated check to).
//
// In practice most school websites are the school's homepage, not a
// staff/roster page, so a single "not found" is very often just the coach's
// name not being on the homepage rather than the listing actually being
// stale -- flagging on every miss would flood the verifier queue with false
// positives. So this route only opens a flag once a school has come back
// "not found" on MISS_THRESHOLD separate nightly checks IN A ROW (looking
// at the most recent log rows for that school). A "confirmed" (including a
// MaxPreps confirmation) in between resets the streak. Once a flag is
// opened for a streak, it won't open a second one on top of a still-pending
// automated flag for the same school.
//
// Processes up to BATCH_SIZE candidates per run, but stops picking up new
// work once TIME_BUDGET_MS has elapsed so it always finishes comfortably
// within maxDuration -- whatever doesn't get to this run just rises to the
// top of tomorrow's, since the priority view always orders by staleness.
const BATCH_SIZE = 500;
const CONCURRENCY = 8;
const TIME_BUDGET_MS = 50_000;
const MISS_THRESHOLD = 2; // consecutive nightly "not_found" results before opening a flag

const SYSTEM_USER_ID = "d24ad753-f759-479d-8958-fae8f995faa1"; // CSD sysadmin account (Larry)

export async function GET(req) {
  // Vercel's real nightly invocation sends the secret as a Bearer header.
  // Also accept it as a ?secret= query param so this can be smoke-tested
  // from a plain browser/URL (e.g. right after setup, or spot-checking
  // later) without needing a tool that can set custom headers.
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

  const { data: candidates, error: candErr } = await supabase
    .from("school_recheck_priority")
    .select("school_id, website, hc_first_name, hc_last_name, maxpreps_url")
    .order("last_checked_at", { ascending: true, nullsFirst: true })
    .limit(BATCH_SIZE);

  if (candErr) {
    console.error("cron recheck: could not load candidates", candErr);
    return NextResponse.json({ error: "Could not load candidate schools." }, { status: 500 });
  }

  const summary = { confirmed: 0, confirmed_maxpreps: 0, not_found: 0, no_website: 0, no_coach_on_file: 0, fetch_error: 0 };
  let processed = 0;
  let flagsOpened = 0;
  let cursor = 0;

  async function worker() {
    while (true) {
      if (Date.now() - startedAt > TIME_BUDGET_MS) return;
      const i = cursor++;
      if (i >= candidates.length) return;
      const c = candidates[i];

      const { result, detail } = await checkSchoolCoach({
        website: c.website,
        hc_last_name: c.hc_last_name,
        maxpreps_url: c.maxpreps_url,
      });
      summary[result] = (summary[result] || 0) + 1;
      processed++;

      await supabase.from("school_recheck_log").insert({
        school_id: c.school_id,
        checked_by: SYSTEM_USER_ID,
        website_checked: c.website || null,
        coach_name_checked: [c.hc_first_name, c.hc_last_name].filter(Boolean).join(" ") || null,
        result,
        detail: `[Automated nightly sweep] ${detail}`,
      });

      if (result === "not_found") {
        const { data: recentChecks } = await supabase
          .from("school_recheck_log")
          .select("result, checked_at")
          .eq("school_id", c.school_id)
          .order("checked_at", { ascending: false })
          .limit(MISS_THRESHOLD);

        const streak = recentChecks?.length === MISS_THRESHOLD && recentChecks.every((row) => row.result === "not_found");

        if (streak) {
          const { data: existingFlag } = await supabase
            .from("school_flags")
            .select("id")
            .eq("school_id", c.school_id)
            .eq("status", "pending")
            .ilike("reason", "Automated nightly recheck%")
            .maybeSingle();

          if (!existingFlag) {
            await supabase.from("school_flags").insert({
              school_id: c.school_id,
              flagged_by: SYSTEM_USER_ID,
              reason: `Automated nightly recheck: "${c.hc_last_name}" was not found on ${c.website}${c.maxpreps_url ? " or the MaxPreps roster page on file" : ""} on ${MISS_THRESHOLD} checks in a row. May be outdated -- please verify.`,
            });
            flagsOpened++;
          }
        }
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  const result = {
    processed,
    candidates_available: candidates.length,
    stopped_early: cursor < candidates.length,
    duration_ms: Date.now() - startedAt,
    flags_opened: flagsOpened,
    summary,
  };
  console.log("cron recheck-schools:", JSON.stringify(result));
  return NextResponse.json(result);
}
