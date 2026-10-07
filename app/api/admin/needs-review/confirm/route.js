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
import { NEEDS_REVIEW_CLEAR_FIELDS } from "@/lib/needsReview";
import { compareSuggestion, isFreshAiCheck, AI_TRUSTED_MODE } from "@/lib/needsReviewAi";

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

    // Optional: confirm because an AI web check (a Batch Coach-Info item)
    // matched the on-file coach and email. Re-verified HERE from the item
    // itself -- the page's say-so isn't trusted -- and logged with its own
    // source wording so the Database screen's "How verified" shows it as an
    // AI lookup, not as a human confirmation. Wording deliberately avoids the
    // phrases school_verification_meta uses for paste-match / independent.
    let confirmSource = "Needs-Review dashboard - confirmed accurate, no change needed";
    const aiItemId = Number(body.ai_item_id) || null;
    if (aiItemId) {
      const { data: aiItem } = await admin
        .from("coach_info_batch_items")
        .select("id,school_id,batch_run_id,suggestion")
        .eq("id", aiItemId)
        .maybeSingle();
      const { data: aiRun } = aiItem ? await admin.from("coach_info_batch_runs").select("collected_at,candidate_mode").eq("id", aiItem.batch_run_id).maybeSingle() : { data: null };
      const cmp = aiItem && aiItem.school_id === schoolId && aiRun?.candidate_mode === AI_TRUSTED_MODE && isFreshAiCheck(aiRun?.collected_at) ? compareSuggestion(school, aiItem.suggestion) : null;
      if (!cmp || !cmp.confirmable) {
        return NextResponse.json(
          { error: "That AI check no longer matches this school's coach and email at high confidence, so it can't be used to confirm it. Review the school by hand." },
          { status: 409 }
        );
      }
      confirmSource = `Batch AI lookup - web check matched the on-file coach and email (confirmed from Needs Review, batch run #${aiItem.batch_run_id})`;
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
      source: confirmSource,
      changed_by: userData.user.id,
    });
    if (logErr) throw logErr;

    // NEEDS_REVIEW_CLEAR_FIELDS (lib/needsReview.js): confirming a school here
    // also lifts its needs_review flag. The queue now treats a flagged school
    // as still needing review (see school_review_status), so without this a
    // school someone just confirmed would keep reappearing in the queue.
    const { error: updateErr } = await admin
      .from("schools")
      .update({
        coach_radar_reviewed_at: new Date().toISOString(),
        verification_status: "verified",
        last_verified_at: new Date().toISOString(),
        ...NEEDS_REVIEW_CLEAR_FIELDS,
      })
      .eq("id", schoolId);
    if (updateErr) throw updateErr;

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("needs-review confirm error", err);
    return NextResponse.json({ error: "Could not save this confirmation. Please try again." }, { status: 500 });
  }
}
