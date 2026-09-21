// app/api/admin/needs-review/route.js
//
// GET  /api/admin/needs-review              -> per-state rollup (state list / progress bars)
// GET  /api/admin/needs-review?state=TX     -> the still-outstanding review queue for one
//                                              state (never_reviewed schools only), plus
//                                              how many were confirmed today in that state
//
// Reads two views created directly in Supabase (school_review_status,
// school_review_state_summary) -- see needs-review-db-views.sql. They define
// "reviewed" as: this school has had hc_first_name/hc_last_name/hc_email/hc_cell/
// hc_office specifically touched (via school_change_log), not just "has a value" --
// 99%+ of schools already have something in coach name/email from the original
// import, but most of that has never actually been re-checked.
//
// Bug fixed 2026-09-21: this route used to return every open school in the
// state regardless of review status, just sorted never-reviewed-first. Once
// Larry confirmed a school it dropped off the LOCAL browser list (the page
// filters its own state client-side after a successful confirm) but came
// right back the moment the queue was reloaded, because the query itself
// never excluded already-reviewed schools -- so a fully-cleared state still
// looked untouched on refresh. Now filtered server-side to never_reviewed =
// true only, so a cleared state actually shows empty.
import { NextResponse } from "next/server";
import { getSupabaseRouteClient } from "@/lib/supabase/routeClient";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";

const REVIEWER_ROLES = ["verifier", "sysadmin"];
const PRIORITY_STATES = ["TX", "FL", "GA", "CA", "OH", "IN"];

export async function GET(req) {
  try {
    const authHeader = req.headers.get("authorization") || "";
    const token = authHeader.replace(/^Bearer\s+/i, "");
    if (!token) {
      return NextResponse.json({ error: "Not signed in." }, { status: 401 });
    }

    const supabase = getSupabaseRouteClient(token);
    const { data: userData, error: userErr } = await supabase.auth.getUser();
    if (userErr || !userData?.user) {
      return NextResponse.json({ error: "Not signed in." }, { status: 401 });
    }

    const { data: profile } = await supabase.from("profiles").select("role").eq("id", userData.user.id).maybeSingle();
    if (!profile || !REVIEWER_ROLES.includes(profile.role)) {
      return NextResponse.json(
        { error: "Only verification staff or a system admin can open the Needs Review queue." },
        { status: 403 }
      );
    }

    const admin = getSupabaseAdminClient();
    const { searchParams } = new URL(req.url);
    const state = searchParams.get("state");

    if (!state) {
      const { data, error } = await admin
        .from("school_review_state_summary")
        .select("*")
        .order("total_schools", { ascending: false });
      if (error) throw error;

      const withPriority = data.map((row) => ({
        ...row,
        is_priority_state: PRIORITY_STATES.includes(row.state),
      }));
      return NextResponse.json({ states: withPriority });
    }

    const { data, error } = await admin
      .from("school_review_status")
      .select("*")
      .eq("state", state)
      .eq("never_reviewed", true)
      .order("name", { ascending: true })
      .limit(500);
    if (error) throw error;

    // A same-day counter for the queue screen itself -- a positive "X
    // confirmed today" recap right where the work is happening, not just in
    // the state-picker list one click back.
    const startOfToday = new Date();
    startOfToday.setUTCHours(0, 0, 0, 0);
    const { count: reviewedTodayCount, error: countErr } = await admin
      .from("school_review_status")
      .select("id", { count: "exact", head: true })
      .eq("state", state)
      .eq("never_reviewed", false)
      .gte("coach_radar_reviewed_at", startOfToday.toISOString());
    if (countErr) throw countErr;

    return NextResponse.json({ state, schools: data, reviewed_today: reviewedTodayCount || 0 });
  } catch (err) {
    console.error("needs-review GET error", err);
    return NextResponse.json({ error: "Could not load the Needs Review queue. Please try again." }, { status: 500 });
  }
}
