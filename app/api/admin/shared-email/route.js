// app/api/admin/shared-email/route.js
//
// GET  /api/admin/shared-email
//        -> every head-coach email that sits on 2+ open schools (with a city),
//           grouped one object per email, most suspicious first. Reads the
//           shared_email_schools view (see lib/sharedEmail.js).
//
// POST /api/admin/shared-email  { action, email_key, ... }
//   action "keep"      { email_key, keep_school_id }
//        The email really belongs to keep_school_id. On every OTHER school in the
//        group the copied email is removed (logged) and the school is sent to
//        Needs Review with a note naming the school that keeps it.
//   action "duplicate" { email_key, keep_school_id }
//        The schools in the group are the same school entered more than once.
//        Every school except keep_school_id is closed as a duplicate of it.
//   action "dismiss"   { email_key | email_keys[], note?, mark_coop? }
//        Both/all schools are correct (a combined program, or one coach who
//        really coaches both). The email stops being listed. With mark_coop
//        true, every school in the group is also marked is_co_op = 'Yes'
//        (logged), so the co-op badge shows on its profile and in Needs Review.
//
// Nothing here changes verification_status: a school that was verified stays
// verified; an email that gets cleared leaves the school flagged for review.
import { NextResponse } from "next/server";
import { getSupabaseRouteClient } from "@/lib/supabase/routeClient";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { NEEDS_REVIEW_CLEAR_FIELDS } from "@/lib/needsReview";
import { SHARED_NOTE_PREFIX, emailKey, groupSharedRows, isSharedAuditNote } from "@/lib/sharedEmail";

const REVIEWER_ROLES = ["verifier", "sysadmin"];
const KEEP_SOURCE = "Shared-email review - email belongs to another school; cleared and sent to Needs Review";
const DUP_SOURCE = "Shared-email review - closed as a duplicate school";
const COOP_SOURCE = "Shared-email review - both schools correct; marked as a co-op / combined program";

async function authorize(req) {
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return { error: NextResponse.json({ error: "Not signed in." }, { status: 401 }) };
  const supabase = getSupabaseRouteClient(token);
  const { data: userData, error: userErr } = await supabase.auth.getUser();
  if (userErr || !userData?.user) return { error: NextResponse.json({ error: "Not signed in." }, { status: 401 }) };
  const { data: profile } = await supabase.from("profiles").select("role").eq("id", userData.user.id).maybeSingle();
  if (!profile || !REVIEWER_ROLES.includes(profile.role)) {
    return { error: NextResponse.json({ error: "Only verification staff or a system admin can use the Shared Email review." }, { status: 403 }) };
  }
  return { user: userData.user };
}

export async function GET(req) {
  try {
    const auth = await authorize(req);
    if (auth.error) return auth.error;
    const admin = getSupabaseAdminClient();
    const { data, error } = await admin.from("shared_email_schools").select("*").order("email_key", { ascending: true }).limit(5000);
    if (error) throw error;
    const groups = groupSharedRows(data || []);
    return NextResponse.json({
      groups,
      totals: { emails: groups.length, schools: groups.reduce((n, g) => n + g.schools.length, 0) },
    });
  } catch (err) {
    console.error("shared-email GET error", err);
    return NextResponse.json({ error: "Could not load the shared emails. Please try again." }, { status: 500 });
  }
}

// The schools still sharing this email right now (re-read, never trusted from the page).
async function currentGroup(admin, key) {
  const { data, error } = await admin.from("shared_email_schools").select("*").eq("email_key", key);
  if (error) throw error;
  return data || [];
}

export async function POST(req) {
  try {
    const auth = await authorize(req);
    if (auth.error) return auth.error;
    const userId = auth.user.id;
    const admin = getSupabaseAdminClient();
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "");
    const now = new Date().toISOString();

    if (action === "dismiss") {
      const keys = (Array.isArray(body.email_keys) ? body.email_keys : [body.email_key]).map(emailKey).filter(Boolean);
      if (!keys.length) return NextResponse.json({ error: "email_key is required." }, { status: 400 });
      if (keys.length > 200) return NextResponse.json({ error: "Too many at once (200 max)." }, { status: 400 });
      const note = String(body.note || "").trim().slice(0, 500) || null;
      const markCoop = body.mark_coop === true;
      let coopMarked = 0;
      if (markCoop) {
        // Read the schools still sharing these emails BEFORE the dismissal hides them.
        const { data: members, error: memErr } = await admin.from("shared_email_schools").select("id,is_co_op,email_key").in("email_key", keys).limit(5000);
        if (memErr) throw memErr;
        const todo = (members || []).filter((m) => m.is_co_op !== "Yes");
        const ids = todo.map((m) => m.id);
        for (let i = 0; i < ids.length; i += 200) {
          const { error: coopErr } = await admin.from("schools").update({ is_co_op: "Yes" }).in("id", ids.slice(i, i + 200));
          if (coopErr) throw coopErr;
        }
        if (todo.length) {
          const logRows = todo.map((m) => ({ school_id: m.id, field_name: "is_co_op", old_value: m.is_co_op == null ? null : String(m.is_co_op), new_value: "Yes", source: COOP_SOURCE, changed_by: userId }));
          for (let i = 0; i < logRows.length; i += 200) {
            const { error: logErr } = await admin.from("school_change_log").insert(logRows.slice(i, i + 200));
            if (logErr) throw logErr;
          }
        }
        coopMarked = todo.length;
      }
      const { error: insErr } = await admin
        .from("shared_email_dismissals")
        .upsert(keys.map((k) => ({ email_key: k, resolution: "both_correct", note, resolved_by: userId, resolved_at: now })), { onConflict: "email_key" });
      if (insErr) throw insErr;
      // A school the audit flagged only because of this email is now cleared.
      const { data: flagged } = await admin.from("schools").select("id,hc_email,needs_review_note").eq("needs_review", true).like("needs_review_note", `${SHARED_NOTE_PREFIX}%`);
      const clearIds = (flagged || []).filter((s) => keys.includes(emailKey(s.hc_email))).map((s) => s.id);
      if (clearIds.length) {
        const { error: clrErr } = await admin.from("schools").update({ ...NEEDS_REVIEW_CLEAR_FIELDS }).in("id", clearIds);
        if (clrErr) throw clrErr;
      }
      return NextResponse.json({ ok: true, dismissed: keys.length, flags_cleared: clearIds.length, coop_marked: coopMarked });
    }

    const key = emailKey(body.email_key);
    const keepId = Number(body.keep_school_id);
    if (!key || !keepId) return NextResponse.json({ error: "email_key and keep_school_id are required." }, { status: 400 });

    const group = await currentGroup(admin, key);
    const keeper = group.find((s) => s.id === keepId);
    const others = group.filter((s) => s.id !== keepId);
    if (!keeper || others.length === 0) {
      return NextResponse.json({ error: "That email is no longer shared by these schools -- refresh the page.", code: "stale_group" }, { status: 409 });
    }

    if (action === "keep") {
      const logRows = [];
      for (const s of others) {
        const note = `${SHARED_NOTE_PREFIX}: the head coach email "${s.hc_email}" was also on ${keeper.name}, ${keeper.city} ${keeper.state} (id ${keeper.id}) and belongs to that school, so it was cleared here. Find the correct coach/email for this school.`;
        const { error: upErr } = await admin
          .from("schools")
          .update({ hc_email: null, needs_review: true, needs_review_note: note, needs_review_marked_at: now, needs_review_marked_by: userId })
          .eq("id", s.id);
        if (upErr) throw upErr;
        logRows.push({ school_id: s.id, field_name: "hc_email", old_value: s.hc_email, new_value: null, source: KEEP_SOURCE, changed_by: userId });
      }
      if (isSharedAuditNote(keeper.needs_review_note)) {
        await admin.from("schools").update({ ...NEEDS_REVIEW_CLEAR_FIELDS }).eq("id", keeper.id);
      }
      const { error: logErr } = await admin.from("school_change_log").insert(logRows);
      if (logErr) throw logErr;
      return NextResponse.json({ ok: true, cleared: others.map((s) => s.id) });
    }

    if (action === "duplicate") {
      const reason = `Duplicate record of ${keeper.name}, ${keeper.city} ${keeper.state} (id ${keeper.id}) - closed from the Shared Email review`;
      const logRows = [];
      for (const s of others) {
        const { error: upErr } = await admin
          .from("schools")
          .update({ is_closed: true, closed_at: now, closed_by: userId, closed_reason: reason, closed_category: "school_closed", ...NEEDS_REVIEW_CLEAR_FIELDS })
          .eq("id", s.id);
        if (upErr) throw upErr;
        logRows.push({ school_id: s.id, field_name: "is_closed", old_value: "false", new_value: "true", source: DUP_SOURCE, changed_by: userId });
      }
      if (isSharedAuditNote(keeper.needs_review_note)) {
        await admin.from("schools").update({ ...NEEDS_REVIEW_CLEAR_FIELDS }).eq("id", keeper.id);
      }
      const { error: logErr } = await admin.from("school_change_log").insert(logRows);
      if (logErr) throw logErr;
      return NextResponse.json({ ok: true, closed: others.map((s) => s.id) });
    }

    return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  } catch (err) {
    console.error("shared-email POST error", err);
    return NextResponse.json({ error: "Could not save that. Please try again." }, { status: 500 });
  }
}
