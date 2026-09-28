// app/api/admin/state-coverage/export/route.js
//
// GET /api/admin/state-coverage/export?state=XX -> full editable-record
// export (JSON rows, not a CSV file) for every open, still-incomplete
// school in one state -- or, with no state param, every state combined.
// Built for the "Export CSV" / "Export All States" buttons on State
// Progress (app/(app)/admin/state-progress/page.js), so Larry can pull a
// current, fillable list straight from the screen he's already looking at
// instead of asking Claude to run a one-off database query each time.
//
// Returns raw rows; the client builds and downloads the actual CSV with
// Papa.unparse, the same pattern already used throughout
// app/(app)/admin/data-quality/page.js. Keeping the formatting and column
// labels on the client means this route stays a plain data endpoint and
// there's exactly one place that decides what a CSV column is called.
//
// The needs_* flags below are computed per-row in JS from the same
// field-blank + not_available + verification_status logic as the
// state_data_coverage Postgres view that backs the parent
// /api/admin/state-coverage route -- a view can't hand back its own WHERE
// clause per matching row, so this is a hand-kept copy of that logic. If
// the view's definition ever changes, this needs to change with it.
//
// Same auth pattern as the parent route -- bearer-token session,
// verifier/sysadmin only, admin client for the actual read (the schools
// table isn't otherwise exposed row-by-row across every state to every
// role that can reach this dashboard).
import { NextResponse } from "next/server";
import { getSupabaseRouteClient } from "@/lib/supabase/routeClient";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { isBlank } from "@/lib/dataQuality";

const REVIEWER_ROLES = ["verifier", "sysadmin"];

const SCHOOL_COLUMNS =
  "id,name,city,state,hc_first_name,hc_last_name,hc_email,hc_cell,hc_office,athletics_url,maxpreps_url,hc_twitter,hc_facebook,ad_name,ad_email,social_not_available,athletics_not_available,maxpreps_not_available,verification_status,last_verified_at,needs_review";

// PostgREST caps a plain .select() at (typically) 1000 rows per request --
// with ~9,000+ schools matching this filter across all 50+ states, a
// single request would silently come back truncated with no error. Page
// through with .range() instead, same approach loadProgress() in the Data
// Quality page already uses for the same reason: fetch page 1 with an
// exact count, then fire every remaining page in parallel rather than one
// at a time.
async function fetchAllRows(queryFactory, pageSize = 1000) {
  const first = await queryFactory({ count: "exact" }).range(0, pageSize - 1);
  if (first.error) throw first.error;
  const rows = [...(first.data || [])];
  const total = first.count ?? rows.length;
  const remainingPages = Math.max(0, Math.ceil(total / pageSize) - 1);
  if (remainingPages > 0) {
    const pages = await Promise.all(
      Array.from({ length: remainingPages }, (_, i) => {
        const offset = (i + 1) * pageSize;
        return queryFactory().range(offset, offset + pageSize - 1);
      })
    );
    for (const p of pages) {
      if (p.error) throw p.error;
      rows.push(...(p.data || []));
    }
  }
  return rows;
}

function toExportRow(s) {
  const hasName = !isBlank(s.hc_first_name) && !isBlank(s.hc_last_name);
  const verified = s.verification_status === "verified";
  return {
    school_id: s.id,
    school_name: s.name || "",
    city: s.city || "",
    state: s.state || "",
    coach_first_name: s.hc_first_name || "",
    coach_last_name: s.hc_last_name || "",
    coach_email: s.hc_email || "",
    coach_cell: s.hc_cell || "",
    coach_office: s.hc_office || "",
    athletics_url: s.athletics_url || "",
    maxpreps_url: s.maxpreps_url || "",
    coach_twitter: s.hc_twitter || "",
    coach_facebook: s.hc_facebook || "",
    ad_name: s.ad_name || "",
    ad_email: s.ad_email || "",
    needs_coach_name: !hasName && !verified,
    needs_email: hasName && isBlank(s.hc_email) && !verified,
    needs_cell: hasName && isBlank(s.hc_cell) && !verified,
    needs_athletics_url: isBlank(s.athletics_url) && s.athletics_not_available !== true && !verified,
    needs_maxpreps_url: isBlank(s.maxpreps_url) && s.maxpreps_not_available !== true && !verified,
    needs_social: hasName && (isBlank(s.hc_twitter) || isBlank(s.hc_facebook)) && s.social_not_available !== true && !verified,
    social_not_available: s.social_not_available === true,
    athletics_not_available: s.athletics_not_available === true,
    maxpreps_not_available: s.maxpreps_not_available === true,
    verification_status: s.verification_status || "",
    last_verified_at: s.last_verified_at || "",
    needs_review: s.needs_review === true,
  };
}

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
      return NextResponse.json({ error: "Only verification staff or a system admin can export from State Progress." }, { status: 403 });
    }

    const { searchParams } = new URL(req.url);
    const state = (searchParams.get("state") || "").trim().toUpperCase();

    const admin = getSupabaseAdminClient();
    const rows = await fetchAllRows((opts) => {
      let q = admin.from("schools").select(SCHOOL_COLUMNS, opts).eq("is_closed", false).not("state", "is", null).neq("state", "");
      if (state) q = q.eq("state", state);
      return q.order("state", { ascending: true }).order("name", { ascending: true });
    });

    return NextResponse.json({ rows: rows.map(toExportRow), total: rows.length });
  } catch (err) {
    console.error("state-coverage export GET error", err);
    return NextResponse.json({ error: "Could not build this export. Please try again." }, { status: 500 });
  }
}
