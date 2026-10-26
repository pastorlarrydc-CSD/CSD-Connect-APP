// app/api/admin/shared-email/check/route.js
//
// GET /api/admin/shared-email/check?school_id=123[&email=someone@school.org]
//   -> { shared: [{ id, name, city, state }] }
//
// Which OTHER open schools already use this email? Without &email= it checks
// the school's own saved head-coach email (the persistent banner on the school
// profile); with &email= it checks what is being typed in Quick Fix before it
// is saved. Quiet (empty list) when the email was already marked "both
// correct" on the Shared Email page. Staff only. Read-only.
import { NextResponse } from "next/server";
import { getSupabaseRouteClient } from "@/lib/supabase/routeClient";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { findSharedWarnings } from "@/lib/sharedEmail";

const REVIEWER_ROLES = ["verifier", "sysadmin"];

export async function GET(req) {
  try {
    const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    if (!token) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
    const supabase = getSupabaseRouteClient(token);
    const { data: userData, error: userErr } = await supabase.auth.getUser();
    if (userErr || !userData?.user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
    const { data: profile } = await supabase.from("profiles").select("role").eq("id", userData.user.id).maybeSingle();
    if (!profile || !REVIEWER_ROLES.includes(profile.role)) {
      return NextResponse.json({ error: "Staff only." }, { status: 403 });
    }

    const url = new URL(req.url);
    const schoolId = Number(url.searchParams.get("school_id"));
    if (!schoolId) return NextResponse.json({ error: "school_id is required." }, { status: 400 });

    const admin = getSupabaseAdminClient();
    let email = url.searchParams.get("email");
    if (email == null) {
      const { data: row } = await admin.from("schools").select("hc_email").eq("id", schoolId).maybeSingle();
      email = row?.hc_email || "";
    }
    const shared = await findSharedWarnings(admin, email, schoolId);
    return NextResponse.json({ shared });
  } catch (err) {
    console.error("shared-email check error", err);
    return NextResponse.json({ error: "Could not check that email." }, { status: 500 });
  }
}
