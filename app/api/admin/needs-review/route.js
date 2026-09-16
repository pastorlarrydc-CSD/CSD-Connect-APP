// app/api/admin/needs-review/route.js
//
// GET  /api/admin/needs-review              -> per-state rollup (state list / progress bars)
// GET  /api/admin/needs-review?state=TX     -> the review queue for one state,
//                                              never-reviewed first, then oldest-reviewed first
//
// Reads two views created directly in Supabase (school_review_status,
// school_review_state_summary) -- see needs-review-db-views.sql. They define
// "reviewed" as: this school has had hc_first_name/hc_last_name/hc_email/hc_cell/
// hc_office specifically touched (via school_change_log), not just "has a value" --
// 99%+ of schools already have something in coach name/email from the original
// import, but most of that has never actually been re-checked.
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
      .order("never_reviewed", { ascending: false })
      .order("days_since_review", { ascending: false, nullsFirst: true })
      .limit(500);
    if (error) throw error;

    return NextResponse.json({ state, schools: data });
  } catch (err) {
    console.error("needs-review GET error", err);
    return NextResponse.json({ error: "Could not load the Needs Review queue. Please try again." }, { status: 500 });
  }
}
