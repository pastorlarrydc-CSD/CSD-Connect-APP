import { NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { hasFullCoachRecord } from "@/lib/dataQuality";

export const maxDuration = 60;

// Once-a-day email summary of last night's Coach-Change Radar sweep, sent
// to CSD's own verification staff (sysadmin + verifier roles). Separate
// from coach-alert-digest, which emails COLLEGES about coach changes on
// schools they track -- this one is internal, so nobody on the CSD side
// has to remember to open the Data Quality page every morning just to
// find out whether anything is waiting.
//
// Mirrors exactly what the Coach-Change Radar report on
// app/(app)/admin/data-quality/page.js shows: same 26-hour lookback, same
// per-bucket counts, and the same "handled" definition -- an explicit
// Mark Reviewed on the report page, OR the school already having every
// one of coach name+email, Athletics URL, MaxPreps URL, and a social
// handle on file (hasFullCoachRecord, in lib/dataQuality.js -- the single
// shared source of truth for that check, so this email and the report
// page can't quietly disagree with each other about what still needs
// attention).
//
// Sends every morning the sweep actually produced rows, even when
// everything's already handled -- a predictable "all clear" is worth
// more than a digest that only shows up on bad days, since the latter
// trains people to stop trusting it's actually still running.
//
// Invoked by Vercel Cron (see vercel.json), scheduled after
// coach-alert-digest so recheck-schools, coach-news-check, and the flags
// either of those opened have all already landed by send time. Same
// CRON_SECRET Bearer-header auth (plus ?secret= for a browser smoke test)
// as every other cron route in this app.
//
// Requires RESEND_API_KEY -- see the FROM_EMAIL note in
// coach-alert-digest/route.js. Same sandbox restriction applies here:
// until a sending domain is verified in Resend, this only actually
// delivers to the Resend account's own address.
const FROM_EMAIL = process.env.ALERT_FROM_EMAIL || "CSD CoachConnect Alerts <onboarding@resend.dev>";
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://coachconnect.vercel.app";

const RESULT_LABEL = {
  not_found: "Not found",
  fetch_error: "Could not load",
  no_website: "No website on file",
  no_coach_on_file: "No coach on file",
  confirmed_weak: "Confirmed (low confidence)",
  confirmed_maxpreps: "Confirmed (MaxPreps)",
  confirmed: "Confirmed",
};
// Display order -- most-actionable first, "Confirmed" last since a plain
// confirmed match rarely needs a second look.
const RESULT_ORDER = ["not_found", "fetch_error", "no_website", "no_coach_on_file", "confirmed_weak", "confirmed_maxpreps", "confirmed"];

// Same four prefixes recheck-schools/coach-news-check use to tag a flag
// as automated (see AUTOMATED_FLAG_PREFIXES in data-quality/page.js) --
// duplicated here rather than imported since that constant lives in a
// "use client" page component.
const AUTOMATED_FLAG_PREFIXES = ["Automated nightly recheck", "Automated weak-match recheck", "Automated email check", "Automated news check"];

function escapeHtml(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function buildEmail({ totalChecked, remainingByResult, flagRows }) {
  const totalRemaining = Object.values(remainingByResult).reduce((sum, n) => sum + n, 0);
  const subject =
    totalRemaining > 0
      ? `Coach-Change Radar: ${totalRemaining} school${totalRemaining === 1 ? "" : "s"} need a look this morning`
      : "Coach-Change Radar: all caught up";

  const bucketRowsHtml = RESULT_ORDER.filter((key) => remainingByResult[key])
    .map(
      (key) => `
      <tr>
        <td style="padding:6px 12px;border-bottom:1px solid #e5e7eb;">${escapeHtml(RESULT_LABEL[key] || key)}</td>
        <td style="padding:6px 12px;border-bottom:1px solid #e5e7eb;text-align:right;font-weight:600;">${remainingByResult[key]}</td>
      </tr>`
    )
    .join("");

  const flagsHtml = flagRows.length
    ? `<h3 style="margin-top:28px;margin-bottom:6px;">New flags from last night (${flagRows.length})</h3>
       <table style="width:100%;border-collapse:collapse;font-size:13.5px;">
         <tbody>${flagRows
           .map(
             (f) => `
           <tr>
             <td style="padding:6px 12px;border-bottom:1px solid #e5e7eb;white-space:nowrap;">${escapeHtml(f.schoolLabel)}</td>
             <td style="padding:6px 12px;border-bottom:1px solid #e5e7eb;color:#697386;">${escapeHtml(f.reason)}</td>
           </tr>`
           )
           .join("")}</tbody>
       </table>`
    : "";

  const html = `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;max-width:640px;margin:0 auto;color:#1a1a1a;">
    <h2 style="margin-bottom:4px;">Coach-Change Radar — overnight results</h2>
    <p style="color:#697386;margin-top:0;">
      ${totalChecked} school${totalChecked === 1 ? "" : "s"} checked last night.
      ${totalRemaining > 0 ? `${totalRemaining} still need${totalRemaining === 1 ? "s" : ""} your attention.` : "Nothing left to handle from last night's run."}
    </p>
    ${
      bucketRowsHtml
        ? `<table style="width:100%;border-collapse:collapse;font-size:14px;">
      <thead>
        <tr style="text-align:left;color:#697386;font-size:12px;text-transform:uppercase;">
          <th style="padding:6px 12px;border-bottom:2px solid #e5e7eb;">Result</th>
          <th style="padding:6px 12px;border-bottom:2px solid #e5e7eb;text-align:right;">Remaining</th>
        </tr>
      </thead>
      <tbody>${bucketRowsHtml}</tbody>
    </table>`
        : ""
    }
    ${flagsHtml}
    <p style="margin-top:24px;">
      <a href="${SITE_URL}/admin/data-quality" style="background:#1a1a2e;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;display:inline-block;">
        Open Coach-Change Radar
      </a>
    </p>
    <p style="color:#9ca3af;font-size:12px;margin-top:32px;">CSD CoachConnect — Collegiate Sports Data</p>
  </div>`;

  return { subject, html };
}

export async function GET(req) {
  const authHeader = req.headers.get("authorization") || "";
  const { searchParams } = new URL(req.url);
  const querySecret = searchParams.get("secret") || "";
  const expected = process.env.CRON_SECRET;
  const authorized = !!expected && (authHeader === `Bearer ${expected}` || querySecret === expected);
  if (!authorized) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) {
    return NextResponse.json({ error: "RESEND_API_KEY is not set. Add it in Vercel Project Settings -> Environment Variables." }, { status: 500 });
  }

  const supabase = getSupabaseAdminClient();

  try {
    // Same 26-hour lookback the Coach-Change Radar report uses -- covers
    // "last night's run" even if the schedule drifts, without pulling in
    // more than one night's worth of rows.
    const since = new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString();

    const { data: radarRows, error: radarErr } = await supabase
      .from("school_recheck_log")
      .select(
        "id, school_id, result, reviewed_at, schools(hc_first_name,hc_last_name,hc_email,athletics_url,maxpreps_url,hc_twitter,hc_facebook)"
      )
      .ilike("detail", "[Automated nightly sweep]%")
      .gte("checked_at", since)
      .limit(2000);
    if (radarErr) throw radarErr;

    if (!radarRows || radarRows.length === 0) {
      return NextResponse.json({ skipped: true, reason: "No Coach-Change Radar rows in the last 26 hours -- nothing to summarize." });
    }

    const remainingByResult = {};
    radarRows.forEach((row) => {
      const done = !!row.reviewed_at || hasFullCoachRecord(row.schools);
      if (!done) remainingByResult[row.result] = (remainingByResult[row.result] || 0) + 1;
    });

    const { data: flags, error: flagsErr } = await supabase
      .from("school_flags")
      .select("school_id, reason, created_at, schools(name,city,state)")
      .eq("status", "pending")
      .gte("created_at", since)
      .order("created_at", { ascending: true })
      .limit(200);
    if (flagsErr) throw flagsErr;

    const flagRows = (flags || [])
      .filter((f) => AUTOMATED_FLAG_PREFIXES.some((prefix) => (f.reason || "").startsWith(prefix)))
      .map((f) => ({
        schoolLabel: f.schools ? `${f.schools.name}${f.schools.city ? ` — ${f.schools.city}, ${f.schools.state || ""}` : ""}` : `School #${f.school_id}`,
        reason: f.reason,
      }));

    const { data: recipientProfiles, error: profilesErr } = await supabase.from("profiles").select("id").in("role", ["sysadmin", "verifier"]);
    if (profilesErr) throw profilesErr;

    const emails = [];
    for (const p of recipientProfiles || []) {
      const { data: userRes } = await supabase.auth.admin.getUserById(p.id);
      if (userRes?.user?.email) emails.push(userRes.user.email);
    }
    if (!emails.length) {
      return NextResponse.json({ error: "No sysadmin/verifier email addresses found -- nothing to send to." }, { status: 500 });
    }

    const { subject, html } = buildEmail({ totalChecked: radarRows.length, remainingByResult, flagRows });

    const sendRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${resendKey}` },
      body: JSON.stringify({ from: FROM_EMAIL, to: emails, subject, html }),
    });
    if (!sendRes.ok) {
      const detail = await sendRes.text().catch(() => "");
      throw new Error(`Resend error ${sendRes.status} — ${detail.slice(0, 300)}`);
    }

    return NextResponse.json({ sent: true, to: emails, totalChecked: radarRows.length, remainingByResult, newFlags: flagRows.length });
  } catch (err) {
    console.error("verifier-digest error", err);
    return NextResponse.json({ error: err.message || "Digest run failed." }, { status: 500 });
  }
}
