import { NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { checkSchoolWebsite } from "@/lib/schoolRecheck";

export const maxDuration = 60;

// Nightly automated sweep -- picks the schools that have gone longest
// without a website recheck (or have never been checked, via the
// school_recheck_priority view) and runs the same "does the on-file head
// coach's name still appear on their site" check the manual "Check for
// updates" button runs, just at scale across the database. Invoked by
// Vercel Cron (see vercel.json) once a night; Vercel automatically attaches
// `Authorization: Bearer <CRON_SECRET>` using the CRON_SECRET environment
// variable, and this route rejects anything that doesn't match.
//
// Deliberately conservative, same as the manual route: never writes to the
// schools table itself. A miss just opens a flag in the existing verifier
// queue. Since school_flags.flagged_by is NOT NULL and there's no human to
// attribute it to, automated flags/log rows are attributed to CSD's own
// sysadmin account -- every reason/detail string makes clear it was an
// automated check, not a person.
//
// Processes up to BATCH_SIZE candidates per run, but stops picking up new
// work once TIME_BUDGET_MS has elapsed so it always finishes comfortably
// within maxDuration -- whatever doesn't get to this run just rises to the
// top of tomorrow's, since the priority view always orders by staleness.
const BATCH_SIZE = 500;
const CONCURRENCY = 8;
const TIME_BUDGET_MS = 50_000;

const SYSTEM_USER_ID = "d24ad753-f759-479d-8958-fae8f995faa1"; // CSD sysadmin account (Larry)

export async function GET(req) {
  const authHeader = req.headers.get("authorization") || "";
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startedAt = Date.now();
  const supabase = getSupabaseAdminClient();

  const { data: candidates, error: candErr } = await supabase
    .from("school_recheck_priority")
    .select("school_id, website, hc_first_name, hc_last_name")
    .order("last_checked_at", { ascending: true, nullsFirst: true })
    .limit(BATCH_SIZE);

  if (candErr) {
    console.error("cron recheck: could not load candidates", candErr);
    return NextResponse.json({ error: "Could not load candidate schools." }, { status: 500 });
  }

  const summary = { confirmed: 0, not_found: 0, no_website: 0, no_coach_on_file: 0, fetch_error: 0 };
  let processed = 0;
  let cursor = 0;

  async function worker() {
    while (true) {
      if (Date.now() - startedAt > TIME_BUDGET_MS) return;
      const i = cursor++;
      if (i >= candidates.length) return;
      const c = candidates[i];

      const { result, detail } = await checkSchoolWebsite({ website: c.website, hc_last_name: c.hc_last_name });
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
        await supabase.from("school_flags").insert({
          school_id: c.school_id,
          flagged_by: SYSTEM_USER_ID,
          reason: `Automated nightly recheck: "${c.hc_last_name}" was not found on ${c.website}. May be outdated -- please verify.`,
        });
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  const result = {
    processed,
    candidates_available: candidates.length,
    stopped_early: cursor < candidates.length,
    duration_ms: Date.now() - startedAt,
    summary,
  };
  console.log("cron recheck-schools:", JSON.stringify(result));
  return NextResponse.json(result);
}
