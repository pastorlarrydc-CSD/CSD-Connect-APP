import { NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";

const MAX_TEXT = 200; // generous cap for a single-line field, guards against pasted-in abuse
const MAX_LONG_TEXT = 800; // for coach_evaluation, the one free-text paragraph field
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SUBMITTER_ROLES = ["hs_coach", "athletic_director", "parent_guardian", "athlete_self", "other"];

// Minimum time (ms) between the form rendering and a submission arriving.
// Bots that fill and POST a form in well under a second are extremely
// common; a real person reading and typing into ~15 fields never does.
// This is a soft signal, combined with the honeypot field below -- neither
// one alone is bulletproof, but together they filter out the overwhelming
// majority of automated spam without asking a human visitor to solve a
// captcha.
const MIN_FILL_TIME_MS = 2500;

// A day's worth of submissions from the same email address, above which
// something is wrong (either abuse, or a real coach who should just email
// Larry directly) -- see submission_source/submitter_email on the
// prospects table (added specifically to support this).
const MAX_SUBMISSIONS_PER_EMAIL_PER_DAY = 8;

function s(v) {
  return typeof v === "string" ? v.trim().slice(0, MAX_TEXT) : "";
}
function sLong(v) {
  return typeof v === "string" ? v.trim().slice(0, MAX_LONG_TEXT) : "";
}
function n(v) {
  if (v === null || v === undefined || v === "") return null;
  const num = Number(v);
  return Number.isFinite(num) ? num : null;
}

// Public, no-login prospect submission -- the form at app/submit-prospect.
// The normal prospects_insert RLS policy requires an authenticated
// session (submitted_by = auth.uid()), which a visiting HS coach with no
// CoachConnect account doesn't have, so this route uses the service-role
// client instead. That means everything a human would normally get for
// free from RLS -- required fields, string lengths, who's allowed to
// write -- has to be enforced here in code instead. See lib/supabase/admin.js's
// own warning about that trade-off.
//
// Same duplicate-check UX as the in-app "Submit a Prospect" form
// (app/(app)/prospects/page.js): if find_similar_prospects turns up a
// likely match at the same school, this returns the candidates instead of
// inserting, and the page shows them with a "submit anyway" option that
// re-POSTs with force: true.
export async function POST(req) {
  try {
    const body = await req.json().catch(() => ({}));

    // Honeypot: a field named to look attractive to a bot ("website")
    // that's hidden from real visitors via CSS, not markup removal --
    // real browsers never populate it, autofill bots often do. Silently
    // report success without writing anything, so a spammer probing this
    // endpoint gets no signal that they were caught.
    if (s(body.website)) {
      return NextResponse.json({ ok: true });
    }
    const loadedAt = Number(body.loaded_at);
    if (!loadedAt || Date.now() - loadedAt < MIN_FILL_TIME_MS) {
      return NextResponse.json({ ok: true });
    }

    const athleteName = s(body.athlete_name);
    const submitterName = s(body.submitter_name);
    const submitterEmail = s(body.submitter_email).toLowerCase();
    const submitterRole = SUBMITTER_ROLES.includes(body.submitter_role) ? body.submitter_role : null;

    if (!athleteName) {
      return NextResponse.json({ error: "Athlete name is required." }, { status: 400 });
    }
    if (!submitterName || !submitterEmail || !submitterRole) {
      return NextResponse.json({ error: "Your name, email, and role are required so we know who to follow up with." }, { status: 400 });
    }
    if (!EMAIL_RE.test(submitterEmail)) {
      return NextResponse.json({ error: "That doesn't look like a valid email address." }, { status: 400 });
    }

    const supabase = getSupabaseAdminClient();

    const { count: recentCount, error: throttleErr } = await supabase
      .from("prospects")
      .select("id", { count: "exact", head: true })
      .eq("submission_source", "public_form")
      .eq("submitter_email", submitterEmail)
      .gte("created_at", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
    if (throttleErr) throw throttleErr;
    if ((recentCount || 0) >= MAX_SUBMISSIONS_PER_EMAIL_PER_DAY) {
      return NextResponse.json(
        { error: `You've submitted ${MAX_SUBMISSIONS_PER_EMAIL_PER_DAY} prospects in the last day from this email. For a larger batch, email larry@collegiatesportsdata.com directly and we'll get them added.` },
        { status: 429 }
      );
    }

    const schoolId = Number.isInteger(body.school_id) ? body.school_id : null;
    const gradYear = body.grad_year ? parseInt(body.grad_year, 10) : null;

    if (schoolId && !body.force) {
      const { data: matches, error: dupErr } = await supabase.rpc("find_similar_prospects", {
        p_school_id: schoolId,
        p_athlete_name: athleteName,
        p_grad_year: Number.isFinite(gradYear) ? gradYear : null,
      });
      if (dupErr) throw dupErr;
      if (matches && matches.length) {
        return NextResponse.json({ duplicates: matches });
      }
    }

    const { error: insertErr } = await supabase.from("prospects").insert({
      submitted_by: null,
      submission_source: "public_form",
      submitter_name: submitterName,
      submitter_email: submitterEmail,
      submitter_role: submitterRole,
      athlete_name: athleteName,
      grad_year: Number.isFinite(gradYear) ? gradYear : null,
      position: s(body.position) || null,
      jersey_number: s(body.jersey_number) || null,
      height: s(body.height) || null,
      weight: s(body.weight) || null,
      gpa: n(body.gpa),
      forty_yard_dash: n(body.forty_yard_dash),
      vertical_jump: n(body.vertical_jump),
      broad_jump: n(body.broad_jump),
      bench_press_reps: body.bench_press_reps ? parseInt(body.bench_press_reps, 10) : null,
      shuttle_time: n(body.shuttle_time),
      athlete_email: s(body.athlete_email) || null,
      athlete_cell: s(body.athlete_cell) || null,
      city: s(body.city) || null,
      state: s(body.state).slice(0, 2).toUpperCase() || null,
      school_id: schoolId,
      level_of_play: s(body.level_of_play) || null,
      hudl_url: s(body.hudl_url) || null,
      x_url: s(body.x_url) || null,
      coach_evaluation: sLong(body.coach_evaluation) || null,
      guardian_authorized: !!body.guardian_authorized,
      guardian_first_name: s(body.guardian_first_name) || null,
      guardian_last_name: s(body.guardian_last_name) || null,
      guardian_email: s(body.guardian_email) || null,
      guardian_cell: s(body.guardian_cell) || null,
      offers_received: s(body.offers_received) || null,
      committed_to: s(body.committed_to) || null,
    });
    if (insertErr) throw insertErr;

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("public prospect submission error", err);
    return NextResponse.json({ error: "Could not submit this prospect. Please try again." }, { status: 500 });
  }
}
