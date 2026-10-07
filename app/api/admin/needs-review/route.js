// app/api/admin/needs-review/route.js
//
// GET  /api/admin/needs-review              -> per-state rollup (state list / progress bars)
// GET  /api/admin/needs-review?state=TX     -> the still-outstanding review queue for one
//                                              state (never_reviewed schools only), plus
//                                              how many were confirmed today in that state
//
// Reads two views created directly in Supabase (school_review_status,
// school_review_state_summary) -- see needs-review-db-views.sql. They define
// "reviewed" as: this school has had hc_first_name/hc_last_name/hc_email/hc_cell/
// hc_office specifically touched (via school_change_log), not just "has a value" --
// 99%+ of schools already have something in coach name/email from the original
// import, but most of that has never actually been re-checked.
//
// Bug fixed 2026-09-21: this route used to return every open school in the
// state regardless of review status, just sorted never-reviewed-first. Once
// Larry confirmed a school it dropped off the LOCAL browser list (the page
// filters its own state client-side after a successful confirm) but came
// right back the moment the queue was reloaded, because the query itself
// never excluded already-reviewed schools -- so a fully-cleared state still
// looked untouched on refresh. Now filtered server-side to never_reviewed =
// true only, so a cleared state actually shows empty.
import { NextResponse } from "next/server";
import { getSupabaseRouteClient } from "@/lib/supabase/routeClient";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { compareSuggestion, isFreshAiCheck, AI_TRUSTED_MODE } from "@/lib/needsReviewAi";

const REVIEWER_ROLES = ["verifier", "sysadmin"];
const PRIORITY_STATES = ["TX", "FL", "GA", "CA", "OH", "IN"];
// Per-state queue size cap. Was 500, which Texas (459 after the 10/5
// paste-match flagging) was close to hitting -- a state with more than the
// cap would silently hide the rest. The response now also carries
// total_in_queue so the page can say so when a state IS truncated.
const QUEUE_LIMIT = 1000;

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

    const { data: profile } = await supabase.from("profiles").select("role").eq("id", userData.user.id).maybeSingle();
    if (!profile || !REVIEWER_ROLES.includes(profile.role)) {
      return NextResponse.json(
        { error: "Only verification staff or a system admin can open the Needs Review queue." },
        { status: 403 }
      );
    }

    const admin = getSupabaseAdminClient();
    const { searchParams } = new URL(req.url);
    const state = searchParams.get("state");

    if (!state) {
      const { data, error } = await admin
        .from("school_review_state_summary")
        .select("*")
        .order("total_schools", { ascending: false });
      if (error) throw error;

      const withPriority = data.map((row) => ({
        ...row,
        is_priority_state: PRIORITY_STATES.includes(row.state),
      }));
      return NextResponse.json({ states: withPriority });
    }

    // Flagged schools (needs_review = true, with their needs_review_note
    // reason) come first -- those are the ones somebody specifically said
    // need a second look -- then everything else alphabetically. Both
    // flagged_needs_review and needs_review_note are columns of the
    // school_review_status view (added when the view started honoring the
    // needs_review flag).
    const { data, error, count } = await admin
      .from("school_review_status")
      .select("*", { count: "exact" })
      .eq("state", state)
      .eq("never_reviewed", true)
      .order("flagged_needs_review", { ascending: false })
      .order("name", { ascending: true })
      .limit(QUEUE_LIMIT);
    if (error) throw error;

    // AI-check result per school: the most recent Batch Coach-Info item for
    // each school in this queue (queued from this page, or from any other run
    // that happened to include it), read against the school's CURRENT on-file
    // coach by compareSuggestion (lib/needsReviewAi.js). Chunked because a
    // state's queue can be several hundred schools.
    const aiBySchool = new Map();
    // Newest item per school that actually carries an AI result, from ANY run
    // type -- feeds the "AI found" panel in Quick Fix. Unlike ai_check (which
    // only trusts re_verify runs, because it can auto-confirm), these are only
    // ever offered to a reviewer to look at and click, so any mode may show.
    const sugBySchool = new Map();
    const schoolRows = data || [];
    for (let i = 0; i < schoolRows.length; i += 200) {
      const chunk = schoolRows.slice(i, i + 200).map((s) => s.id);
      const { data: items, error: itemsErr } = await admin
        .from("coach_info_batch_items")
        .select("id,school_id,batch_run_id,fetch_status,suggestion,suggestion_error,review_status")
        .in("school_id", chunk)
        .order("id", { ascending: false });
      if (itemsErr) throw itemsErr;
      (items || []).forEach((it) => {
        if (!aiBySchool.has(it.school_id)) aiBySchool.set(it.school_id, it); // newest first, keep the first seen
        const sg = it.suggestion;
        if (sg && !sugBySchool.has(it.school_id) && (sg.hc_first_name || sg.hc_last_name || sg.hc_email || sg.hc_office || sg.hc_cell)) sugBySchool.set(it.school_id, it);
      });
    }
    const runIds = [...new Set([...aiBySchool.values(), ...sugBySchool.values()].map((it) => it.batch_run_id))];
    const runStatus = new Map();
    for (let i = 0; i < runIds.length; i += 200) {
      const { data: runs, error: runsErr } = await admin.from("coach_info_batch_runs").select("id,status,collected_at,created_at,candidate_mode").in("id", runIds.slice(i, i + 200));
      if (runsErr) throw runsErr;
      (runs || []).forEach((r) => runStatus.set(r.id, { status: r.status, collected_at: r.collected_at, created_at: r.created_at, candidate_mode: r.candidate_mode }));
    }
    // school_review_status doesn't carry the athletics/website URLs, so they
    // are read from schools here -- the Needs Review page shows an "Athletics
    // site" link on every row so a reviewer can pull up the staff page.
    const siteBySchool = new Map();
    for (let i = 0; i < schoolRows.length; i += 200) {
      const chunk = schoolRows.slice(i, i + 200).map((s) => s.id);
      const { data: sites, error: sitesErr } = await admin.from("schools").select("id,athletics_url,website").in("id", chunk);
      if (sitesErr) throw sitesErr;
      (sites || []).forEach((r) => siteBySchool.set(r.id, { athletics_url: r.athletics_url || null, website: r.website || null }));
    }
    // What the AI found for a school, trimmed to what Quick Fix shows. Null when
    // there is no result, or it is older than AI_CHECK_MAX_AGE_DAYS.
    const aiSuggestionFor = (schoolId) => {
      const it = sugBySchool.get(schoolId);
      if (!it) return null;
      const run = runStatus.get(it.batch_run_id);
      if (!isFreshAiCheck(run?.collected_at)) return null;
      const sg = it.suggestion;
      const text = (v) => String(v == null ? "" : v).trim();
      return {
        item_id: it.id,
        run_id: it.batch_run_id,
        mode: run?.candidate_mode || null,
        confidence: sg.confidence || null,
        hc_first_name: text(sg.hc_first_name),
        hc_last_name: text(sg.hc_last_name),
        hc_email: text(sg.hc_email),
        hc_email_estimated: Boolean(sg.hc_email_estimated),
        hc_office: text(sg.hc_office),
        hc_cell: text(sg.hc_cell),
        source: text(sg.source).slice(0, 80),
        notes: text(sg.notes).slice(0, 600),
      };
    };
    const schoolsWithAi = schoolRows.map((row) => {
      const s = { ...row, ...(siteBySchool.get(row.id) || { athletics_url: null, website: null }) };
      const it = aiBySchool.get(s.id);
      if (!it) return { ...s, ai_check: null };
      // Only re_verify runs count (see AI_TRUSTED_MODE) -- results from
      // other run types are ignored here, so those schools show as not yet
      // AI-checked and can be queued fresh.
      if (runStatus.get(it.batch_run_id)?.candidate_mode !== AI_TRUSTED_MODE) return { ...s, ai_check: null };
      if (!it.suggestion && !it.suggestion_error) {
        // Queued/fetching/submitted but no answer yet -- unless the run was
        // queued long ago and never went anywhere, in which case treat the
        // school as not checked so it can be queued again.
        const queuedAt = runStatus.get(it.batch_run_id)?.created_at;
        if (queuedAt && Date.now() - new Date(queuedAt).getTime() > 14 * 24 * 60 * 60 * 1000) return { ...s, ai_check: null };
        return { ...s, ai_check: { status: "pending", run_id: it.batch_run_id, run_status: runStatus.get(it.batch_run_id)?.status || null, item_id: it.id, confirmable: false } };
      }
      // An old result (see AI_CHECK_MAX_AGE_DAYS) is treated as never checked.
      if (!isFreshAiCheck(runStatus.get(it.batch_run_id)?.collected_at)) return { ...s, ai_check: null };
      const cmp = compareSuggestion(s, it.suggestion);
      return { ...s, ai_check: { ...cmp, run_id: it.batch_run_id, item_id: it.id } };
    });

    const schoolsOut = schoolsWithAi.map((s) => ({ ...s, ai_suggestion: aiSuggestionFor(s.id) }));

    // A same-day counter for the queue screen itself -- a positive "X
    // confirmed today" recap right where the work is happening, not just in
    // the state-picker list one click back.
    const startOfToday = new Date();
    startOfToday.setUTCHours(0, 0, 0, 0);
    const { count: reviewedTodayCount, error: countErr } = await admin
      .from("school_review_status")
      .select("id", { count: "exact", head: true })
      .eq("state", state)
      .eq("never_reviewed", false)
      .gte("coach_radar_reviewed_at", startOfToday.toISOString());
    if (countErr) throw countErr;

    return NextResponse.json({ state, schools: schoolsOut, total_in_queue: count ?? data.length, reviewed_today: reviewedTodayCount || 0 });
  } catch (err) {
    console.error("needs-review GET error", err);
    return NextResponse.json({ error: "Could not load the Needs Review queue. Please try again." }, { status: 500 });
  }
}
