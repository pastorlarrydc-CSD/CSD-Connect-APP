// app/api/admin/compare-list/route.js
//
// Compare a state's published head-coach list (school + coach) with the schools we have on file.
//
// POST /api/admin/compare-list
//   { action: "analyze", state: "WI", rows: [{ school, coach }, ...] }
//       -> { as_of, counts, rows } -- one result per list row (see lib/listCompare.js), each with the
//          school's current verifiedAt. Read-only. The page calls it again to refresh a saved comparison.
//   { action: "fix_spelling", state, label, fixes: [{ school_id, old_first, old_last, new_first, new_last }] }
//       -> corrects coach-name spelling at schools where the EMAIL ON FILE carries the list's
//          spelling. Every fix is re-checked here (same school, still the old name, pure
//          spelling change, email agrees) before anything is written; one change-log row per
//          field. Rows that fail the check are returned as "skipped" with the reason.
//   { action: "queue_review", state, label, items: [{ school_id, note }] }
//       -> flags schools whose coach differs from the list so they show up in Needs Review (where
//          "Send N to AI verification" picks them up). Never touches a school that is already
//          flagged, never changes a coach, email or verification status.
//
// Reviewer-only (verifier / sysadmin), admin client, same bearer-token pattern as the other
// /api/admin routes.
import { NextResponse } from "next/server";
import { getSupabaseRouteClient } from "@/lib/supabase/routeClient";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { compareList, fixIsSafe } from "@/lib/listCompare";

export const maxDuration = 60;

const REVIEWER_ROLES = ["verifier", "sysadmin"];
const SCHOOL_COLS = "id,name,city,state,hc_first_name,hc_last_name,hc_email,verification_status,needs_review,last_verified_at";
const PAGE = 1000;
const MAX_ROWS = 2000;
const MAX_WRITES = 300;
const clean = (v) => String(v == null ? "" : v).trim();

async function authorize(req) {
  const authHeader = req.headers.get("authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) return { error: NextResponse.json({ error: "Not signed in." }, { status: 401 }) };
  const supabase = getSupabaseRouteClient(token);
  const { data: userData, error: userErr } = await supabase.auth.getUser();
  if (userErr || !userData?.user) return { error: NextResponse.json({ error: "Not signed in." }, { status: 401 }) };
  const { data: profile } = await supabase.from("profiles").select("role").eq("id", userData.user.id).maybeSingle();
  if (!profile || !REVIEWER_ROLES.includes(profile.role)) {
    return { error: NextResponse.json({ error: "Only verification staff or a system admin can compare a coach list." }, { status: 403 }) };
  }
  return { user: userData.user };
}

// Every open school in a state, in pages of 1,000 (a single read stops at 1,000).
async function loadStateSchools(admin, state) {
  const out = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await admin
      .from("schools")
      .select(SCHOOL_COLS)
      .eq("state", state)
      .eq("is_closed", false)
      .order("id")
      .range(from, from + PAGE - 1);
    if (error) throw error;
    out.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  return out;
}

function validState(v) {
  const s = clean(v).toUpperCase();
  return /^[A-Z]{2}$/.test(s) ? s : null;
}

export async function POST(req) {
  try {
    const auth = await authorize(req);
    if (auth.error) return auth.error;
    const admin = getSupabaseAdminClient();
    const body = await req.json().catch(() => ({}));
    const state = validState(body.state);
    if (!state) return NextResponse.json({ error: "Pick a state first." }, { status: 400 });
    const nowIso = new Date().toISOString();
    const label = clean(body.label).slice(0, 80) || "coach list";

    if (body.action === "analyze") {
      const rows = (Array.isArray(body.rows) ? body.rows : [])
        .map((r) => ({ school: clean(r?.school), coach: clean(r?.coach) }))
        .filter((r) => r.school);
      if (rows.length === 0) return NextResponse.json({ error: "No schools found in that list. It needs a school column and a coach column." }, { status: 400 });
      if (rows.length > MAX_ROWS) return NextResponse.json({ error: `That list has ${rows.length} rows. Compare up to ${MAX_ROWS} at a time.` }, { status: 400 });
      const schools = await loadStateSchools(admin, state);
      if (schools.length === 0) return NextResponse.json({ error: `No open schools on file for ${state}.` }, { status: 404 });
      const byId = new Map(schools.map((sc) => [sc.id, sc]));
      // verifiedAt lets the page tell a school verified AFTER the comparison from one that was already verified.
      const results = compareList(rows, schools).map((r) => ({ ...r, verifiedAt: r.schoolId ? byId.get(r.schoolId)?.last_verified_at || null : null }));
      const counts = {};
      for (const r of results) counts[r.category] = (counts[r.category] || 0) + 1;
      return NextResponse.json({ state, as_of: nowIso, schools_on_file: schools.length, counts, rows: results });
    }

    if (body.action === "fix_spelling") {
      const fixes = (Array.isArray(body.fixes) ? body.fixes : []).slice(0, MAX_WRITES);
      if (fixes.length === 0) return NextResponse.json({ error: "Nothing to fix." }, { status: 400 });
      const applied = [];
      const skipped = [];
      for (const f of fixes) {
        const id = Number(f?.school_id);
        const oldFirst = clean(f?.old_first);
        const oldLast = clean(f?.old_last);
        const newFirst = clean(f?.new_first);
        const newLast = clean(f?.new_last);
        if (!Number.isFinite(id) || id <= 0) {
          skipped.push({ school_id: f?.school_id, reason: "Unknown school." });
          continue;
        }
        const { data: s, error } = await admin
          .from("schools")
          .select("id,name,state,is_closed,hc_first_name,hc_last_name,hc_email")
          .eq("id", id)
          .maybeSingle();
        if (error) throw error;
        if (!s || s.is_closed || s.state !== state) {
          skipped.push({ school_id: id, reason: "School not found in that state." });
          continue;
        }
        if (clean(s.hc_first_name) !== oldFirst || clean(s.hc_last_name) !== oldLast) {
          skipped.push({ school_id: id, name: s.name, reason: "The coach on file changed since the comparison. Run it again." });
          continue;
        }
        if (!fixIsSafe(oldFirst, oldLast, s.hc_email, newFirst, newLast)) {
          skipped.push({ school_id: id, name: s.name, reason: "Not a clear spelling fix backed by the email on file." });
          continue;
        }
        const updates = {};
        const logs = [];
        const source = `Coach list comparison (${label}): spelling fixed, email on file matches the list spelling`;
        if (newFirst !== oldFirst) {
          updates.hc_first_name = newFirst;
          logs.push({ school_id: id, field_name: "hc_first_name", old_value: oldFirst, new_value: newFirst, source, changed_by: auth.user.id, changed_at: nowIso });
        }
        if (newLast !== oldLast) {
          updates.hc_last_name = newLast;
          logs.push({ school_id: id, field_name: "hc_last_name", old_value: oldLast, new_value: newLast, source, changed_by: auth.user.id, changed_at: nowIso });
        }
        // Guarded on the old values so a concurrent edit can never be overwritten.
        const { data: done, error: uErr } = await admin
          .from("schools")
          .update(updates)
          .eq("id", id)
          .eq("hc_first_name", oldFirst)
          .eq("hc_last_name", oldLast)
          .select("id");
        if (uErr) throw uErr;
        if (!done || done.length === 0) {
          skipped.push({ school_id: id, name: s.name, reason: "The coach on file changed while saving. Run it again." });
          continue;
        }
        const { error: lErr } = await admin.from("school_change_log").insert(logs);
        if (lErr) throw lErr;
        applied.push({ school_id: id, name: s.name, from: `${oldFirst} ${oldLast}`, to: `${newFirst} ${newLast}` });
      }
      return NextResponse.json({ ok: true, applied, skipped });
    }

    if (body.action === "queue_review") {
      const items = (Array.isArray(body.items) ? body.items : []).slice(0, MAX_WRITES);
      if (items.length === 0) return NextResponse.json({ error: "Nothing to queue." }, { status: 400 });
      const queued = [];
      const skipped = [];
      for (const it of items) {
        const id = Number(it?.school_id);
        const note = clean(it?.note).slice(0, 400);
        if (!Number.isFinite(id) || id <= 0 || !note) {
          skipped.push({ school_id: it?.school_id, reason: "Missing school or note." });
          continue;
        }
        const { data: s, error } = await admin
          .from("schools")
          .select("id,name,state,is_closed,needs_review,needs_review_note")
          .eq("id", id)
          .maybeSingle();
        if (error) throw error;
        if (!s || s.is_closed || s.state !== state) {
          skipped.push({ school_id: id, reason: "School not found in that state." });
          continue;
        }
        if (s.needs_review) {
          skipped.push({ school_id: id, name: s.name, reason: "Already flagged for review." });
          continue;
        }
        const { data: done, error: uErr } = await admin
          .from("schools")
          .update({ needs_review: true, needs_review_note: note, needs_review_marked_at: nowIso, needs_review_marked_by: auth.user.id })
          .eq("id", id)
          .or("needs_review.is.null,needs_review.eq.false")
          .select("id");
        if (uErr) throw uErr;
        if (!done || done.length === 0) {
          skipped.push({ school_id: id, name: s.name, reason: "Already flagged for review." });
          continue;
        }
        const source = `Queued for AI checking: ${label} shows a different coach`;
        const { error: lErr } = await admin.from("school_change_log").insert([
          { school_id: id, field_name: "needs_review", old_value: "false", new_value: "true", source, changed_by: auth.user.id, changed_at: nowIso },
          { school_id: id, field_name: "needs_review_note", old_value: s.needs_review_note ?? null, new_value: note, source, changed_by: auth.user.id, changed_at: nowIso },
        ]);
        if (lErr) throw lErr;
        queued.push({ school_id: id, name: s.name });
      }
      return NextResponse.json({ ok: true, queued, skipped });
    }

    return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  } catch (err) {
    console.error("compare-list error", err);
    return NextResponse.json({ error: "Something went wrong comparing that list. Please try again." }, { status: 500 });
  }
}
