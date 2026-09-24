import { NextResponse } from "next/server";
import { getSupabaseRouteClient } from "@/lib/supabase/routeClient";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";

export const maxDuration = 15;

// Sysadmin-only counterpart to /api/admin/accounts/search -- edits the
// PROFILE side of an account only (full_name, title, role, which
// college/school they're tied to). Deliberately does NOT touch auth.users
// (email, password, ban/suspend) -- Larry scoped this first pass to "view
// + basic edits" and asked to add login-security actions later if support
// requests actually need them (see the account-search feature discussion).
// A service-role write, same as every other admin route here, since
// editing someone ELSE's profile is exactly what RLS is supposed to block
// for a normal user -- this route is what re-opens that door, gated on the
// caller's own role instead.
const OWNER_ROLES = ["sysadmin"];
const VALID_ROLES = ["college_coach", "athletic_director", "hs_coach", "verifier", "sysadmin"];

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

    const { data: callerProfile } = await supabase.from("profiles").select("role").eq("id", userData.user.id).maybeSingle();
    if (!callerProfile || !OWNER_ROLES.includes(callerProfile.role)) {
      return NextResponse.json({ error: "Editing accounts is limited to System Admins." }, { status: 403 });
    }

    const body = await req.json().catch(() => ({}));
    const { userId, full_name, title, role, college_id, school_id } = body;
    if (!userId) {
      return NextResponse.json({ error: "Missing userId." }, { status: 400 });
    }
    if (role !== undefined && !VALID_ROLES.includes(role)) {
      return NextResponse.json({ error: `Role must be one of: ${VALID_ROLES.join(", ")}.` }, { status: 400 });
    }

    const admin = getSupabaseAdminClient();

    // Only lets this route touch an account that already has a profile
    // row -- creating one from scratch is a different, riskier operation
    // (it's normally the signup flow's job, which also sets things this
    // route doesn't know about) and out of scope for "edit an existing
    // account."
    const { data: existing, error: existingErr } = await admin.from("profiles").select("id").eq("id", userId).maybeSingle();
    if (existingErr) throw existingErr;
    if (!existing) {
      return NextResponse.json({ error: "This account doesn't have a profile row yet -- nothing to edit here." }, { status: 404 });
    }

    const update = {};
    if (full_name !== undefined) update.full_name = (full_name || "").trim() || null;
    if (title !== undefined) update.title = (title || "").trim() || null;
    if (role !== undefined) update.role = role;
    if (college_id !== undefined) update.college_id = college_id || null;
    if (school_id !== undefined) update.school_id = school_id === "" || school_id === null ? null : Number(school_id);

    if (Object.keys(update).length === 0) {
      return NextResponse.json({ error: "Nothing to update." }, { status: 400 });
    }

    const { data: updated, error: updateErr } = await admin
      .from("profiles")
      .update(update)
      .eq("id", userId)
      .select("id,college_id,full_name,role,title,school_id,created_at")
      .single();
    if (updateErr) throw updateErr;

    return NextResponse.json({ profile: updated });
  } catch (err) {
    console.error("admin/accounts/update error", err);
    return NextResponse.json({ error: err.message || "Could not save this account." }, { status: 500 });
  }
}
