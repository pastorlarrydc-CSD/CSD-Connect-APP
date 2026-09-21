// app/api/admin/state-coverage/route.js
//
// GET /api/admin/state-coverage -> per-state rollup of what's still missing
// across all five data types this app tracks (coach name, email, athletics
// URL, MaxPreps URL, social media), read from the state_data_coverage
// Postgres view. Backs the State Progress dashboard
// (app/(app)/admin/state-progress/page.js), which lets Larry pick a state
// to "complete" instead of guessing where the gaps are, then jump straight
// into the right batch tool pre-scoped to that state.
//
// Same auth pattern as /api/admin/needs-review -- bearer-token session,
// verifier/sysadmin only, admin client for the actual read (the view spans
// the whole schools table, which RLS wouldn't otherwise expose row-by-row
// to every role that can reach this dashboard).
import { NextResponse } from "next/server";
import { getSupabaseRouteClient } from "@/lib/supabase/routeClient";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";

const REVIEWER_ROLES = ["verifier", "sysadmin"];

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
        { error: "Only verification staff or a system admin can open State Progress." },
        { status: 403 }
      );
    }

    const admin = getSupabaseAdminClient();
    const { data, error } = await admin.from("state_data_coverage").select("*").order("total_open", { ascending: false });
    if (error) throw error;

    return NextResponse.json({ states: data || [] });
  } catch (err) {
    console.error("state-coverage GET error", err);
    return NextResponse.json({ error: "Could not load state coverage. Please try again." }, { status: 500 });
  }
}
