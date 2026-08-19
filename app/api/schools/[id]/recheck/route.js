import { NextResponse } from "next/server";
import { getSupabaseRouteClient } from "@/lib/supabase/routeClient";
import { checkSchoolWebsite } from "@/lib/schoolRecheck";

// On-demand coach-change check against a school's own website -- the
// "first pass" of automated verification. Any signed-in user can trigger it
// (read-only against the target site, and it never writes to the schools
// table itself -- only logs the result and, on a miss, opens a flag in the
// same review queue a human "flag as outdated" already uses). See also the
// nightly automated sweep at app/api/cron/recheck-schools, which runs the
// same check across the whole database on a schedule.
export async function POST(req, { params }) {
  try {
    const schoolId = Number(params.id);
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

    const { data: school, error: schoolErr } = await supabase
      .from("schools")
      .select("id,name,website,hc_first_name,hc_last_name")
      .eq("id", schoolId)
      .maybeSingle();
    if (schoolErr || !school) {
      return NextResponse.json({ error: "School not found." }, { status: 404 });
    }

    const { result, detail } = await checkSchoolWebsite(school);

    await supabase.from("school_recheck_log").insert({
      school_id: schoolId,
      checked_by: userData.user.id,
      website_checked: school.website || null,
      coach_name_checked: [school.hc_first_name, school.hc_last_name].filter(Boolean).join(" ") || null,
      result,
      detail,
    });

    if (result === "not_found") {
      await supabase.from("school_flags").insert({
        school_id: schoolId,
        flagged_by: userData.user.id,
        reason: `Automated recheck: "${school.hc_last_name}" was not found on ${school.website}. May be outdated -- please verify.`,
      });
    }

    return NextResponse.json({ result, detail, checked_at: new Date().toISOString() });
  } catch (err) {
    console.error("school recheck error", err);
    return NextResponse.json({ error: "Could not run this check. Please try again." }, { status: 500 });
  }
}
