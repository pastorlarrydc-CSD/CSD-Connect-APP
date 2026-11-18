// app/api/admin/finish-line/route.js
//
// GET /api/admin/finish-line            -> one row per state (finish_line_state_summary view):
//                                          how many open schools, how many verified, how many
//                                          still to finish, and how many of those already have
//                                          an AI coach answer waiting / were never AI-checked.
// GET /api/admin/finish-line?state=MI   -> every school in that state that still needs work,
//                                          ONE CARD PER SCHOOL, with everything waiting for it
//                                          in one place: its review flag and reason, the AI
//                                          coach answer (with the proof the AI showed), and any
//                                          athletics / MaxPreps / social finds.
//
// Read-only. Same auth pattern as /api/admin/state-coverage -- bearer-token
// session, verifier/sysadmin only, admin client for the reads (the data spans
// the whole schools table and the batch tables).
//
// "Still to finish" = not verified, OR verified but flagged needs_review.
import { NextResponse } from "next/server";
import { getSupabaseRouteClient } from "@/lib/supabase/routeClient";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { compareSuggestion } from "@/lib/needsReviewAi";

const REVIEWER_ROLES = ["verifier", "sysadmin"];
const PRIORITY_STATES = ["TX", "FL", "GA", "CA", "OH", "IN"];
const CHUNK = 150;

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

function daysSince(ts) {
  if (!ts) return null;
  const t = new Date(ts).getTime();
  if (Number.isNaN(t)) return null;
  return Math.floor((Date.now() - t) / 86400000);
}

// Rank used to put the quickest wins first inside a state.
function rankOf(card) {
  if (card.lane === "answer_ready") {
    if (card.ai?.confirmable) return 0; // matches on file, proof holds up
    if (card.ai?.confidence === "high") return 1;
    return 2;
  }
  if (card.lane === "flagged") return 3;
  if (card.lane === "not_checked") return 4;
  return 5;
}

export async function GET(req) {
  try {
    const authHeader = req.headers.get("authorization") || "";
    const token = authHeader.replace(/^Bearer\s+/i, "");
    if (!token) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

    const supabase = getSupabaseRouteClient(token);
    const { data: userData, error: userErr } = await supabase.auth.getUser();
    if (userErr || !userData?.user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

    const { data: profile } = await supabase.from("profiles").select("role").eq("id", userData.user.id).maybeSingle();
    if (!profile || !REVIEWER_ROLES.includes(profile.role)) {
      return NextResponse.json({ error: "Only verification staff or a system admin can open the Finish Line." }, { status: 403 });
    }

    const admin = getSupabaseAdminClient();
    const { searchParams } = new URL(req.url);
    const state = (searchParams.get("state") || "").toUpperCase().trim();

    if (!state) {
      const { data, error } = await admin.from("finish_line_state_summary").select("*").order("remaining", { ascending: false });
      if (error) throw error;
      const states = (data || []).map((r) => ({
        state: r.state,
        total_open: Number(r.total_open) || 0,
        verified: Number(r.verified) || 0,
        remaining: Number(r.remaining) || 0,
        unverified: Number(r.unverified) || 0,
        flagged: Number(r.flagged) || 0,
        ai_ready: Number(r.ai_ready) || 0,
        never_checked: Number(r.never_checked) || 0,
        is_priority_state: PRIORITY_STATES.includes(r.state),
      }));
      // What recent verification-backlog AI runs achieved (finish_line_sprint_history view),
      // so the sprint plan can set honest expectations. Optional: a failure here never
      // blocks the page.
      let history = null;
      try {
        const { data: h } = await admin.from("finish_line_sprint_history").select("*");
        const pick = (after) => {
          const r = (h || []).find((x) => Boolean(x.after_evidence_checks) === after);
          return r
            ? { schools: Number(r.schools) || 0, runs: Number(r.runs) || 0, verified: Number(r.verified_after) || 0, flagged: Number(r.flagged_after) || 0, waiting: Number(r.waiting_for_you) || 0 }
            : null;
        };
        history = { before: pick(false), after: pick(true) };
      } catch (_) {
        history = null;
      }
      return NextResponse.json({ states, history });
    }

    if (!/^[A-Z]{2}$/.test(state)) return NextResponse.json({ error: "Unknown state." }, { status: 400 });

    const { data: schools, error: sErr } = await admin
      .from("schools")
      .select(
        "id,name,city,state,hc_first_name,hc_last_name,hc_email,hc_cell,hc_office,athletics_url,website,verification_status,needs_review,needs_review_note,needs_review_marked_at,last_verified_at"
      )
      .eq("state", state)
      .eq("is_closed", false)
      .or("verification_status.neq.verified,verification_status.is.null,needs_review.eq.true")
      .order("name")
      .range(0, 1999);
    if (sErr) throw sErr;

    const list = schools || [];
    const ids = list.map((s) => s.id);
    const coachPending = new Map(); // school_id -> newest pending item
    const anyAi = new Set();
    const finds = new Map(); // school_id -> [{kind,url,confidence}]
    const addFind = (sid, f) => {
      if (!finds.has(sid)) finds.set(sid, []);
      finds.get(sid).push(f);
    };

    for (const part of chunk(ids, CHUNK)) {
      const [coach, coachAny, ath, mp, soc] = await Promise.all([
        admin
          .from("coach_info_batch_items")
          .select("id,school_id,batch_run_id,suggestion,created_at")
          .in("school_id", part)
          .eq("review_status", "pending")
          .not("suggestion", "is", null)
          .order("id", { ascending: false }),
        admin.from("coach_info_batch_items").select("school_id").in("school_id", part).not("suggestion", "is", null),
        admin.from("athletics_batch_items").select("id,school_id,batch_run_id,suggestion").in("school_id", part).eq("review_status", "pending").not("suggestion", "is", null),
        admin.from("maxpreps_batch_items").select("id,school_id,batch_run_id,suggestion").in("school_id", part).eq("review_status", "pending").not("suggestion", "is", null),
        admin.from("social_batch_items").select("id,school_id,batch_run_id,suggestion").in("school_id", part).eq("review_status", "pending").not("suggestion", "is", null),
      ]);
      for (const r of [coach, coachAny, ath, mp, soc]) if (r.error) throw r.error;
      for (const it of coach.data || []) if (!coachPending.has(it.school_id)) coachPending.set(it.school_id, it); // newest first
      for (const it of coachAny.data || []) anyAi.add(it.school_id);
      for (const it of ath.data || []) {
        const u = it.suggestion?.best_url;
        if (u) addFind(it.school_id, { kind: "Athletics link", value: u, confidence: it.suggestion?.confidence || "" });
      }
      for (const it of mp.data || []) {
        const u = it.suggestion?.best_url;
        if (u) addFind(it.school_id, { kind: "MaxPreps link", value: u, confidence: it.suggestion?.confidence || "" });
      }
      for (const it of soc.data || []) {
        if (it.suggestion?.twitter_url) addFind(it.school_id, { kind: "Coach on X", value: it.suggestion.twitter_url, confidence: it.suggestion?.confidence || "" });
        if (it.suggestion?.facebook_url) addFind(it.school_id, { kind: "Coach on Facebook", value: it.suggestion.facebook_url, confidence: it.suggestion?.confidence || "" });
      }
    }

    const cards = list.map((s) => {
      const item = coachPending.get(s.id) || null;
      let ai = null;
      if (item) {
        const cmp = compareSuggestion(s, item.suggestion);
        ai = {
          item_id: item.id,
          run_id: item.batch_run_id,
          age_days: daysSince(item.created_at),
          status: cmp.status,
          confidence: cmp.confidence,
          confirmable: cmp.confirmable,
          suggested_name: cmp.suggestedName,
          suggested_email: cmp.suggestedEmail,
          email_estimated: Boolean(item.suggestion?.hc_email_estimated),
          notes: String(item.suggestion?.notes || "").slice(0, 320),
          evidence: cmp.evidence,
          second_pass: cmp.second_pass,
        };
      }
      const lane = ai ? "answer_ready" : s.needs_review ? "flagged" : anyAi.has(s.id) ? "checked_no_answer" : "not_checked";
      const card = {
        id: s.id,
        name: s.name,
        city: s.city,
        coach: [s.hc_first_name, s.hc_last_name].filter(Boolean).join(" "),
        email: s.hc_email || "",
        cell: s.hc_cell || "",
        office: s.hc_office || "",
        has_site: Boolean(s.athletics_url || s.website),
        verification_status: s.verification_status,
        needs_review: Boolean(s.needs_review),
        needs_review_note: s.needs_review_note || "",
        flagged_days: daysSince(s.needs_review_marked_at),
        lane,
        ai,
        finds: finds.get(s.id) || [],
      };
      return card;
    });

    cards.sort((a, b) => rankOf(a) - rankOf(b) || String(a.name).localeCompare(String(b.name)));

    const counts = { answer_ready: 0, flagged: 0, not_checked: 0, checked_no_answer: 0 };
    for (const c of cards) counts[c.lane] += 1;

    return NextResponse.json({ state, total: cards.length, counts, schools: cards });
  } catch (err) {
    console.error("finish-line GET error", err);
    return NextResponse.json({ error: "Could not load the Finish Line. Please try again." }, { status: 500 });
  }
}
