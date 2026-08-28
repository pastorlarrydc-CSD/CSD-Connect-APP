 import { NextResponse } from "next/server";
import { getSupabaseRouteClient } from "@/lib/supabase/routeClient";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { runNewsCheckBatch } from "@/lib/newsCoachCheck";

export const maxDuration = 60;

const REVIEWER_ROLES = ["verifier", "sysadmin"];

// On-demand twin of the nightly Coaching-Change News Check cron
// (app/api/cron/coach-news-check) -- same runNewsCheckBatch() call, same
// batch size and time budget, just triggered by a "Run Now" button
// instead of waiting for the 11:00 AM UTC schedule (see vercel.json). The
// point is letting a verifier/sysadmin work through the news-check
// backlog faster than the fixed 300-school nightly slice, without having
// to wait on the clock -- click it again right after and it picks up the
// NEXT-stalest slice (school_news_check_priority orders by staleness), so
// firing this repeatedly is safe and never re-checks the same schools
// back to back.
//
// Session-authenticated (Bearer <the caller's own Supabase access token>,
// same pattern as batch-coach-info/fetch-item) rather than the cron's
// CRON_SECRET -- this is a person clicking a button in the app, not
// Vercel's scheduler.
export async function POST(req) {
  try {
    const authHeader = req.headers.get("authorization") || "";
    const token = authHeader.replace(/^Bearer\s+/i, "");
    if (!token) {
      return NextResponse.json({ error: "Not signed in." }, { status: 401 });
    }

    // Session-scoped client, RLS-bound to whoever is calling -- used only
    // to answer "who is this and are they allowed to do this," same as
    // business-dashboard/route.js. The actual batch run below switches to
    // the admin client, same service-role access the nightly cron already
    // has for these system/audit tables (school_news_check_log,
    // school_flags, the confidence-score RPC) -- this route's own role
    // check above is what stands in for the cron's CRON_SECRET.
    const sessionClient = getSupabaseRouteClient(token);
    const { data: userData, error: userErr } = await sessionClient.auth.getUser();
    if (userErr || !userData?.user) {
      return NextResponse.json({ error: "Not signed in." }, { status: 401 });
    }

    const { data: profile } = await sessionClient.from("profiles").select("role").eq("id", userData.user.id).maybeSingle();
    if (!profile || !REVIEWER_ROLES.includes(profile.role)) {
      return NextResponse.json({ error: "Only verification staff or a system admin can run the news check." }, { status: 403 });
    }

    const supabase = getSupabaseAdminClient();

    // Same kill switch the nightly cron respects -- if Larry's paused the
    // sweep from Data Quality settings, a manual click shouldn't bypass
    // that.
    const { data: setting } = await supabase.from("system_settings").select("value").eq("key", "coach_news_check_enabled").maybeSingle();
    if (setting && setting.value === false) {
      return NextResponse.json({ skipped: true, reason: "Coaching-change news check is currently suspended in Data Quality settings." });
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    const serperKey = process.env.SERPER_API_KEY;
    if (!apiKey || !serperKey) {
      return NextResponse.json(
        { error: "News check isn't fully configured -- ANTHROPIC_API_KEY and/or SERPER_API_KEY missing from the server environment." },
        { status: 500 }
      );
    }

    const result = await runNewsCheckBatch({
      supabase,
      apiKey,
      serperKey,
      batchSize: 300,
      concurrency: 6,
      timeBudgetMs: 50_000,
      checkedBy: userData.user.id,
      logPrefix: "[Manual run by staff]",
    });

    if (result.error) {
      return NextResponse.json({ error: result.error }, { status: 500 });
    }

    return NextResponse.json(result);
  } catch (err) {
    console.error("run-news-check error", err);
    return NextResponse.json({ error: err.message || "Could not run the news check. Please try again." }, { status: 500 });
  }
}
