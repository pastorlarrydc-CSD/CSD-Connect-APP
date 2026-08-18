import { NextResponse } from "next/server";
import { getSupabaseRouteClient } from "@/lib/supabase/routeClient";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";

const REVIEWER_ROLES = ["verifier", "sysadmin"];

export async function POST(req, { params }) {
  try {
    const claimId = params.id;
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
      return NextResponse.json({ error: "Only verification staff or a system admin can review school claims." }, { status: 403 });
    }

    const body = await req.json().catch(() => ({}));
    const decision = body.decision === "approve" ? "approved" : body.decision === "reject" ? "rejected" : null;
    if (!decision) {
      return NextResponse.json({ error: "decision must be 'approve' or 'reject'." }, { status: 400 });
    }

    const admin = getSupabaseAdminClient();

    // Read under RLS first so a reviewer can only act on a claim they're
    // actually allowed to see (defense in depth -- the admin client below
    // bypasses RLS, so this lookup is what keeps that scoped correctly).
    const { data: claim, error: claimErr } = await supabase
      .from("school_claims")
      .select("id,school_id,user_id,status")
      .eq("id", claimId)
      .maybeSingle();
    if (claimErr || !claim) {
      return NextResponse.json({ error: "Claim not found." }, { status: 404 });
    }
    if (claim.status !== "pending") {
      return NextResponse.json({ error: "This claim has already been reviewed." }, { status: 400 });
    }

    const { error: updateErr } = await admin
      .from("school_claims")
      .update({
        status: decision,
        reviewed_by: userData.user.id,
        review_note: body.reviewNote || null,
        reviewed_at: new Date().toISOString(),
      })
      .eq("id", claimId);
    if (updateErr) throw updateErr;

    if (decision === "approved") {
      // Cross-user writes -- setting *another* account's profile.school_id
      // and the school's claimed_by -- aren't reachable through the
      // reviewer's own RLS-scoped session (profiles_update_self only
      // covers your own row), which is exactly why this whole action runs
      // through the admin client after the role check above.
      const { error: profileErr } = await admin.from("profiles").update({ school_id: claim.school_id }).eq("id", claim.user_id);
      if (profileErr) throw profileErr;

      const { error: schoolErr } = await admin
        .from("schools")
        .update({ claimed_by: claim.user_id, claimed_at: new Date().toISOString() })
        .eq("id", claim.school_id);
      if (schoolErr) throw schoolErr;
    }

    return NextResponse.json({ ok: true, status: decision });
  } catch (err) {
    console.error("claim decide error", err);
    return NextResponse.json({ error: "Could not process this claim. Please try again." }, { status: 500 });
  }
}
