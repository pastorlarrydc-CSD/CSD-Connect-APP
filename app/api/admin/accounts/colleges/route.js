import { NextResponse } from "next/server";
import { getSupabaseRouteClient } from "@/lib/supabase/routeClient";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";

export const maxDuration = 15;

// Small helper for the account-edit form's "which college is this person
// tied to" dropdown -- colleges isn't directly readable client-side (RLS
// scopes it to a college's own members, same reason business-dashboard
// reads it through its own API route rather than a direct client query),
// so this is the sysadmin-only server-side equivalent, just the handful of
// fields the dropdown actually needs.
const OWNER_ROLES = ["sysadmin"];

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

    const { data: callerProfile } = await supabase.from("profiles").select("role").eq("id", userData.user.id).maybeSingle();
    if (!callerProfile || !OWNER_ROLES.includes(callerProfile.role)) {
      return NextResponse.json({ error: "Limited to System Admins." }, { status: 403 });
    }

    const admin = getSupabaseAdminClient();
    const { data, error } = await admin.from("colleges").select("id,name,division,state").order("name", { ascending: true });
    if (error) throw error;

    return NextResponse.json({ colleges: data || [] });
  } catch (err) {
    console.error("admin/accounts/colleges error", err);
    return NextResponse.json({ error: err.message || "Could not load colleges." }, { status: 500 });
  }
}
