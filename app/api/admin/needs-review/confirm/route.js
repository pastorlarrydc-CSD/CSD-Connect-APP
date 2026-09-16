// app/api/admin/needs-review/confirm/route.js
//
// POST { school_id } -> marks a school as "checked, current data is accurate" without
// changing any of its fields. Right now a school only shows up as "reviewed" if
// someone actually edits a field -- a staffer who looks at a school and confirms
// it's already correct has no way to record that, so it keeps showing up in the
// Needs-Review queue forever even though it WAS checked.
//
// Writes one school_change_log row (old_value === new_value, so it reads as a
// confirmation, not an edit) and stamps coach_radar_reviewed_at + verification_status,
// same fields Coach-Change Radar and the rest of the app already read.
import { NextResponse } from "next/server";
import { getSupabaseRouteClient } from "@/lib/supabase/routeClient";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";

const REVIEWER_ROLES = ["verifier", "sysadmin"];

export async function POST(req) {
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
        { error: "Only verification staff or a system admin can confirm a school as reviewed." },
        { status: 403 }
      );
    }

    const body = await req.json().catch(() => ({}));
    const schoolId = Number(body.school_id);
    if (!schoolId) {
      return NextResponse.json({ error: "school_id is required." }, { status: 400 });
    }

    const admin = getSupabaseAdminClient();
    const { data: school, error: fetchErr } = await admin
      .from("schools")
      .select("id, hc_first_name, hc_last_name, hc_email, hc_cell, hc_office")
      .eq("id", schoolId)
      .maybeSingle();
    if (fetchErr || !school) {
      return NextResponse.json({ error: "School not found." }, { status: 404 });
    }

    const snapshot = JSON.stringify({
      coach: `${school.hc_first_name ?? ""} ${school.hc_last_name ?? ""}`.trim(),
      email: school.hc_email,
      cell: school.hc_cell,
      office: school.hc_office,
    });

    const { error: logErr } = await admin.from("school_change_log").insert({
      school_id: schoolId,
      field_name: "review_confirmed",
      old_value: snapshot,
      new_value: snapshot,
      source: "Needs-Review dashboard - confirmed accurate, no change needed",
      changed_by: userData.user.id,
    });
    if (logErr) throw logErr;

    const { error: updateErr } = await admin
      .from("schools")
      .update({
        coach_radar_reviewed_at: new Date().toISOString(),
        verification_status: "verified",
        last_verified_at: new Date().toISOString(),
      })
      .eq("id", schoolId);
    if (updateErr) throw updateErr;

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("needs-review confirm error", err);
    return NextResponse.json({ error: "Could not save this confirmation. Please try again." }, { status: 500 });
  }
}
