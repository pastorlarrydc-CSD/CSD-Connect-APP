import { NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { checkSchoolCoach, checkEmailDeliverability } from "@/lib/schoolRecheck";

export const maxDuration = 60;

// Nightly automated sweep -- Coach-Change Radar. Picks the schools that have
// gone longest without a recheck (or have never been checked, via the
// school_recheck_priority view) and runs the same "does the on-file head
// coach's name still appear on their athletics site, their general
// website, or -- failing both -- their MaxPreps roster page" check the
// manual "Check for updates" button runs, just at scale across the
// database. Invoked by Vercel Cron (see
// vercel.json) once a night; Vercel automatically attaches
// `Authorization: Bearer <CRON_SECRET>` using the CRON_SECRET environment
// variable, and this route rejects anything that doesn't match.
//
// Deliberately conservative, same as the manual route: never edits any of
// a school's own fields (name, coach info, URLs, verification_status,
// etc.) -- that stays entirely human-driven. Every check is logged to
// school_recheck_log so the data is there to review (attributed to CSD's
// own sysadmin account, since there's no human to credit an automated
// check to). The one exception is confidence_score, which is a derived
// number the database recomputes on its own -- see the note near the
// bottom of the worker loop.
//
// Two independent accuracy checks run per school, in parallel: the coach
// name check above (now cross-referencing the first name too, when one's
// on file -- see NAME_PROXIMITY_WINDOW in lib/schoolRecheck.js, which
// downgrades a last-name-only match to "confirmed_weak" instead of a full
// "confirmed"), and a no-send email deliverability sanity check
// (checkEmailDeliverability) that flags an obviously-malformed address or
// a domain that doesn't resolve at all. Neither check ever writes to
// schools directly -- a bad email opens a flag in the same queue a coach-
// name miss does, for a human to review and fix.
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
// "confirmed_weak" gets the same streak treatment, on its own separate
// counter and its own separate flag prefix. A weak confirmation means the
// coach's LAST name was found on the site but the first name wasn't
// confirmed nearby -- that's real, if partial, evidence the on-file coach
// is probably still right (a different coach entirely wouldn't share the
// last name at all), so a single weak hit -- or even a couple -- is much
// more likely to be a nickname, a "Coach Smith"-only roster listing, or a
// formatting quirk than genuine staleness. WEAK_STREAK_THRESHOLD is
// therefore set higher than MISS_THRESHOLD: it takes longer, sustained
// disagreement before this is worth a human's attention.
//
// Every school this sweep touches also gets its confidence_score
// recomputed (see the touch_school_confidence_score RPC call at the end
// of the worker loop). That score's underlying formula
// (compute_school_confidence_score, in the database) now factors in each
// school's own recheck history and any pending automated flag on top of
// its on-file fields -- so a school that keeps confirming cleanly earns a
// bonus, and one sitting on an unresolved flag gets marked down, until
// this sweep -- or a human -- resolves it.
//
// Processes up to BATCH_SIZE candidates per run, but stops picking up new
// work once TIME_BUDGET_MS has elapsed so it always finishes comfortably
// within maxDuration -- whatever doesn't get to this run just rises to the
// top of tomorrow's, since the priority view always orders by staleness.
const BATCH_SIZE = 500;
const CONCURRENCY = 8;
const TIME_BUDGET_MS = 50_000;
const MISS_THRESHOLD = 2; // consecutive nightly "not_found" results before opening a flag
const WEAK_STREAK_THRESHOLD = 4; // consecutive nightly "confirmed_weak" results before opening a flag -- higher than MISS_THRESHOLD, see note above

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

  // Kill switch -- lets the sweep be paused/resumed from the
  // system_settings table (e.g. by CSD support) without a code change or
  // redeploy. Missing row = treated as enabled, so this table being absent
  // or not yet seeded never silently disables the sweep.
  const { data: radarSetting } = await supabase.from("system_settings").select("value").eq("key", "coach_radar_enabled").maybeSingle();
  if (radarSetting && radarSetting.value === false) {
    console.log("cron recheck-schools: skipped -- coach_radar_enabled is false in system_settings");
    return NextResponse.json({ skipped: true, reason: "Coach-Change Radar is currently suspended (system_settings.coach_radar_enabled = false)." });
  }

  const { data: candidates, error: candErr } = await supabase
    .from("school_recheck_priority")
    .select("school_id, website, hc_first_name, hc_last_name, hc_email, maxpreps_url, athletics_url")
    // Primary sort is staleness (never-checked schools first). Almost all
    // never-checked schools tie on that (last_checked_at is NULL for all of
    // them), so a second tiebreaker matters: prefer schools that have an
    // Athletics URL on file, since checkSchoolCoach() reads that source
    // FIRST and it's the highest-confidence check available. Without this,
    // newly-improved schools (e.g. from a Bulk Athletics Discovery pass)
    // have no better odds of coming up soon than any other school in a
    // 12,000+ never-checked backlog. Final school_id tiebreaker just keeps
    // the batch order deterministic run to run.
    .order("last_checked_at", { ascending: true, nullsFirst: true })
    .order("has_athletics_url", { ascending: false })
    .order("school_id", { ascending: true })
    .limit(BATCH_SIZE);

  if (candErr) {
    console.error("cron recheck: could not load candidates", candErr);
    return NextResponse.json({ error: "Could not load candidate schools." }, { status: 500 });
  }

  const summary = { confirmed: 0, confirmed_weak: 0, confirmed_maxpreps: 0, not_found: 0, no_website: 0, no_coach_on_file: 0, fetch_error: 0 };
  let processed = 0;
  let flagsOpened = 0;
  let weakFlagsOpened = 0;
  let emailFlagsOpened = 0;
  let confidenceUpdated = 0;
  let cursor = 0;

  async function worker() {
    while (true) {
      if (Date.now() - startedAt > TIME_BUDGET_MS) return;
      const i = cursor++;
      if (i >= candidates.length) return;
      const c = candidates[i];

      // The coach-name check and the email deliverability check are
      // independent of each other (different target, different failure
      // modes) -- run them concurrently instead of one after the other so
      // adding the email check doesn't roughly double this worker's time
      // per school.
      const [{ result, detail }, emailCheck] = await Promise.all([
        checkSchoolCoach({
          website: c.website,
          hc_first_name: c.hc_first_name,
          hc_last_name: c.hc_last_name,
          maxpreps_url: c.maxpreps_url,
          athletics_url: c.athletics_url,
        }),
        checkEmailDeliverability(c.hc_email),
      ]);
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
            const sourcesChecked = [c.athletics_url ? "athletics site" : null, c.website ? "school website" : null, c.maxpreps_url ? "MaxPreps" : null]
              .filter(Boolean)
              .join(", ");
            await supabase.from("school_flags").insert({
              school_id: c.school_id,
              flagged_by: SYSTEM_USER_ID,
              reason: `Automated nightly recheck: "${c.hc_last_name}" was not found on the ${sourcesChecked} on ${MISS_THRESHOLD} checks in a row. May be outdated -- please verify.`,
            });
            flagsOpened++;
          }
        }
      } else if (result === "confirmed_weak") {
        const { data: recentChecks } = await supabase
          .from("school_recheck_log")
          .select("result, checked_at")
          .eq("school_id", c.school_id)
          .order("checked_at", { ascending: false })
          .limit(WEAK_STREAK_THRESHOLD);

        const weakStreak =
          recentChecks?.length === WEAK_STREAK_THRESHOLD && recentChecks.every((row) => row.result === "confirmed_weak");

        if (weakStreak) {
          const { data: existingWeakFlag } = await supabase
            .from("school_flags")
            .select("id")
            .eq("school_id", c.school_id)
            .eq("status", "pending")
            .ilike("reason", "Automated weak-match recheck%")
            .maybeSingle();

          if (!existingWeakFlag) {
            const sourcesChecked = [c.athletics_url ? "athletics site" : null, c.website ? "school website" : null, c.maxpreps_url ? "MaxPreps" : null]
              .filter(Boolean)
              .join(", ");
            await supabase.from("school_flags").insert({
              school_id: c.school_id,
              flagged_by: SYSTEM_USER_ID,
              reason: `Automated weak-match recheck: only the last name "${c.hc_last_name}" (not the first name) has been confirmed on the ${sourcesChecked} on ${WEAK_STREAK_THRESHOLD} checks in a row. Could be a different coach with the same last name, or a nickname/formatting mismatch -- please verify.`,
            });
            weakFlagsOpened++;
          }
        }
      }

      // Email deliverability doesn't need a miss-streak -- a malformed
      // address or a dead domain today will still be wrong tomorrow, no
      // benefit in waiting for repeated misses the way a flaky website
      // fetch does. Still dedupes against an already-pending flag so a
      // still-broken email doesn't get re-flagged every single night.
      if (!emailCheck.ok && !emailCheck.skipped) {
        const { data: existingEmailFlag } = await supabase
          .from("school_flags")
          .select("id")
          .eq("school_id", c.school_id)
          .eq("status", "pending")
          .ilike("reason", "Automated email check%")
          .maybeSingle();

        if (!existingEmailFlag) {
          await supabase.from("school_flags").insert({
            school_id: c.school_id,
            flagged_by: SYSTEM_USER_ID,
            reason: `Automated email check: ${emailCheck.detail} Please verify or update this school's head coach email.`,
          });
          emailFlagsOpened++;
        }
      }

      // confidence_score is computed by a database trigger
      // (compute_school_confidence_score) that now factors in this
      // school's own recheck history and any pending automated flag, not
      // just its on-file fields -- but that trigger only fires on a write
      // to the schools row itself, and nothing above this point writes to
      // schools (this sweep only ever inserts into school_recheck_log /
      // school_flags -- see the non-authoritative note at the top of this
      // file). So the score would otherwise sit stale between manual
      // edits, blind to everything this sweep just found. Call the RPC
      // helper to force a recompute for this one school now that its
      // recheck_log/flags state is current -- it doesn't edit any of the
      // school's own fields, just lets the existing trigger redo its math.
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
    weak_flags_opened: weakFlagsOpened,
    email_flags_opened: emailFlagsOpened,
    confidence_scores_updated: confidenceUpdated,
    summary,
  };
  console.log("cron recheck-schools:", JSON.stringify(result));
  return NextResponse.json(result);
}
