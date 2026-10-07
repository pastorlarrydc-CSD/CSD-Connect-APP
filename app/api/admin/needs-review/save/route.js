// app/api/admin/needs-review/save/route.js
//
// POST { school_id, fields: { hc_first_name, hc_last_name, hc_email, hc_office, hc_cell }, clear_email? }
//
// Quick Fix from the Needs Review queue: the reviewer pulled up the school's
// athletics site, fixed what was wrong (or fixed nothing), and pressed save.
// Blank fields are "leave as-is" (same as Batch Coach-Info's Quick Fix); only
// values that differ from what's on file are written, each logged to
// school_change_log. clear_email removes the on-file email when no replacement
// was typed.
//
// Then, like "Confirmed accurate", a successful save counts as the human
// check: the school is marked verified and its needs_review flag lifted --
// EXCEPT when the record would be left with a previous coach's email (the
// flag's own note says whose), a coach name changed with no confirmed new
// email, or the email was removed and nothing replaced it. Those are saved
// but stay flagged and unverified, with a note saying what is still missing,
// so a mismatched name/email pair is never stamped verified.
import { NextResponse } from "next/server";
import { getSupabaseRouteClient } from "@/lib/supabase/routeClient";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { NEEDS_REVIEW_CLEAR_FIELDS } from "@/lib/needsReview";
import { assessCoachChange, emailFit } from "@/lib/coachEmailFit";
import { EDIT_FIELDS, isValidEmail, priorLastFromNote } from "@/lib/needsReviewEdit";

const REVIEWER_ROLES = ["verifier", "sysadmin"];
const EDIT_SOURCE = "Needs-Review quick fix - edited by hand";
const CONFIRM_SOURCE = "Needs-Review dashboard - confirmed accurate after hand edit";

function clean(v) {
  return String(v == null ? "" : v).trim();
}

export async function POST(req) {
  try {
    const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    if (!token) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

    const supabase = getSupabaseRouteClient(token);
    const { data: userData, error: userErr } = await supabase.auth.getUser();
    if (userErr || !userData?.user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

    const { data: profile } = await supabase.from("profiles").select("role").eq("id", userData.user.id).maybeSingle();
    if (!profile || !REVIEWER_ROLES.includes(profile.role)) {
      return NextResponse.json({ error: "Only verification staff or a system admin can save changes from the Needs Review queue." }, { status: 403 });
    }

    const body = await req.json().catch(() => ({}));
    const schoolId = Number(body.school_id);
    if (!schoolId) return NextResponse.json({ error: "school_id is required." }, { status: 400 });
    const fields = body.fields && typeof body.fields === "object" ? body.fields : {};

    const admin = getSupabaseAdminClient();
    const { data: school, error: fetchErr } = await admin
      .from("schools")
      .select("id,name,hc_first_name,hc_last_name,hc_email,hc_cell,hc_office,needs_review,needs_review_note")
      .eq("id", schoolId)
      .maybeSingle();
    if (fetchErr || !school) return NextResponse.json({ error: "School not found." }, { status: 404 });

    // Which fields actually change.
    const update = {};
    const changes = [];
    for (const f of EDIT_FIELDS) {
      const v = clean(fields[f]);
      if (v.length > 200) return NextResponse.json({ error: `${f} is too long.` }, { status: 400 });
      if (v && v !== clean(school[f])) {
        if (f === "hc_email" && !isValidEmail(v)) return NextResponse.json({ error: `"${v}" doesn't look like an email address.` }, { status: 400 });
        update[f] = v;
        changes.push({ school_id: schoolId, field_name: f, old_value: school[f] || null, new_value: v, source: EDIT_SOURCE, changed_by: userData.user.id });
      }
    }
    let emailRemoved = false;
    if (body.clear_email && !clean(fields.hc_email) && clean(school.hc_email)) {
      emailRemoved = true;
      update.hc_email = null;
      changes.push({ school_id: schoolId, field_name: "hc_email", old_value: school.hc_email, new_value: null, source: `${EDIT_SOURCE} (previous coach's email removed)`, changed_by: userData.user.id });
    }

    // Is anything still wrong with the record as it will stand after this save?
    const next = { ...school, ...update };
    const assess = assessCoachChange(school, update, {});
    const priorLast = priorLastFromNote(school.needs_review_note);
    const staleLeft =
      !assess.nameChanged && priorLast && emailFit(next.hc_email, { last: next.hc_last_name }, { last: priorLast }) === "stale";
    let holdReason = null;
    if (assess.nameChanged && assess.emailUnconfirmed) holdReason = assess.reviewNote(null);
    else if (staleLeft) holdReason = `The email on file (${next.hc_email}) still contains the previous coach's surname (${priorLast}) -- find or confirm the current coach's email.`;
    else if (emailRemoved && !clean(next.hc_email)) holdReason = "The previous coach's email was removed and no replacement was added yet -- find the current coach's email.";

    const now = new Date().toISOString();
    const schoolUpdate = { ...update };
    if (holdReason) {
      // Any edit that leaves the record unresolved also drops it back to unverified.
      if (changes.length > 0) schoolUpdate.verification_status = "not_verified";
      if (!school.needs_review) {
        schoolUpdate.needs_review = true;
        schoolUpdate.needs_review_note = holdReason;
        schoolUpdate.needs_review_marked_at = now;
        schoolUpdate.needs_review_marked_by = userData.user.id;
      }
    } else {
      schoolUpdate.coach_radar_reviewed_at = now;
      schoolUpdate.verification_status = "verified";
      schoolUpdate.last_verified_at = now;
      Object.assign(schoolUpdate, NEEDS_REVIEW_CLEAR_FIELDS);
    }

    const { error: updateErr } = await admin.from("schools").update(schoolUpdate).eq("id", schoolId);
    if (updateErr) throw updateErr;

    const logRows = [...changes];
    if (!holdReason) {
      const snapshot = JSON.stringify({
        coach: `${next.hc_first_name ?? ""} ${next.hc_last_name ?? ""}`.trim(),
        email: next.hc_email,
        cell: next.hc_cell,
        office: next.hc_office,
      });
      logRows.push({ school_id: schoolId, field_name: "review_confirmed", old_value: snapshot, new_value: snapshot, source: CONFIRM_SOURCE, changed_by: userData.user.id });
    }
    if (logRows.length > 0) {
      const { error: logErr } = await admin.from("school_change_log").insert(logRows);
      if (logErr) throw logErr;
    }

    return NextResponse.json({
      ok: true,
      cleared: !holdReason,
      reason: holdReason,
      changed: changes.map((c) => c.field_name),
      school: { hc_first_name: next.hc_first_name, hc_last_name: next.hc_last_name, hc_email: next.hc_email, hc_office: next.hc_office, hc_cell: next.hc_cell },
    });
  } catch (err) {
    console.error("needs-review save error", err);
    return NextResponse.json({ error: "Could not save this school. Please try again." }, { status: 500 });
  }
}
