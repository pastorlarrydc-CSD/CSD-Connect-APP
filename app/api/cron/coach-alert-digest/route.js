import { NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";

export const maxDuration = 60;

// Nightly email digest for Coach-Change Radar alerts. The in-app Alerts
// page (app/(app)/alerts/page.js) has always shown these events, but
// nobody sees them there unless they think to go check -- this route turns
// that into a real push: once a day it emails each college's staff a
// summary of any coach-change notifications on schools they're tracking
// (via watchlist_items or contact_logs -- see the
// fanout_coach_change_notifications() trigger on school_change_log) that
// haven't been emailed yet.
//
// Deliberately separate from seen_at (the in-app "I've read this" flag on
// coach_change_notifications). emailed_at only tracks whether THIS route
// has already sent that row once, so a college that hasn't opened the
// Alerts page in a week doesn't get the same event re-emailed every night.
//
// Invoked by Vercel Cron (see vercel.json) once a day. Vercel attaches
// `Authorization: Bearer <CRON_SECRET>`, same pattern as
// app/api/cron/recheck-schools/route.js -- also accepts ?secret= for a
// plain-browser smoke test.
//
// Requires RESEND_API_KEY to be set (https://resend.com). Until a real
// sending domain is verified in Resend, emails only deliver to the Resend
// account's own address (their onboarding@resend.dev sandbox restriction)
// -- see the code comment on FROM_EMAIL below.
const FIELD_LABEL = {
  hc_first_name: "Head Coach — first name",
  hc_last_name: "Head Coach — last name",
  hc_email: "Head Coach — email",
  hc_cell: "Head Coach — cell",
  hc_office: "Head Coach — office",
};

// Set ALERT_FROM_EMAIL once a domain is verified in Resend, e.g.
// "CSD CoachConnect Alerts <alerts@collegiatesportsdata.com>". Until then
// this falls back to Resend's shared sandbox sender, which Resend will
// only actually deliver to the Resend account's own email address.
const FROM_EMAIL = process.env.ALERT_FROM_EMAIL || "CSD CoachConnect Alerts <onboarding@resend.dev>";
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://coachconnect.vercel.app";
const MAX_ROWS_PER_COLLEGE = 50; // keeps a digest email readable if a college is tracking a lot of schools

function escapeHtml(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function buildEmail(collegeName, rows) {
  const shown = rows.slice(0, MAX_ROWS_PER_COLLEGE);
  const overflow = rows.length - shown.length;
  const subject = `${rows.length} coach-change alert${rows.length === 1 ? "" : "s"} on schools you're tracking`;

  const rowsHtml = shown
    .map((r) => {
      const school = r.schools;
      const where = school ? `${school.name}${school.city ? ` — ${school.city}, ${school.state || ""}` : ""}` : `School #${r.school_id}`;
      const label = FIELD_LABEL[r.field_name] || r.field_name;
      return `<tr>
        <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;">${escapeHtml(where)}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;">${escapeHtml(label)}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;color:#697386;">${escapeHtml(r.old_value) || "—"} &rarr; <strong>${escapeHtml(r.new_value) || "—"}</strong></td>
      </tr>`;
    })
    .join("");

  const html = `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;max-width:640px;margin:0 auto;color:#1a1a1a;">
    <h2 style="margin-bottom:4px;">Coach-change alerts for ${escapeHtml(collegeName)}</h2>
    <p style="color:#697386;margin-top:0;">${rows.length} update${rows.length === 1 ? "" : "s"} found on schools you're tracking in CSD CoachConnect.</p>
    <table style="width:100%;border-collapse:collapse;font-size:14px;">
      <thead>
        <tr style="text-align:left;color:#697386;font-size:12px;text-transform:uppercase;">
          <th style="padding:8px 12px;border-bottom:2px solid #e5e7eb;">School</th>
          <th style="padding:8px 12px;border-bottom:2px solid #e5e7eb;">What changed</th>
          <th style="padding:8px 12px;border-bottom:2px solid #e5e7eb;">Old &rarr; New</th>
        </tr>
      </thead>
      <tbody>${rowsHtml}</tbody>
    </table>
    ${overflow > 0 ? `<p style="color:#697386;font-size:13px;">+ ${overflow} more — see the full list in the app.</p>` : ""}
    <p style="margin-top:24px;">
      <a href="${SITE_URL}/alerts" style="background:#1a1a2e;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;display:inline-block;">
        Review in CoachConnect
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
  const results = { collegesEmailed: 0, notificationsEmailed: 0, errors: [] };

  try {
    const { data: pending, error: pendingErr } = await supabase
      .from("coach_change_notifications")
      .select("id, college_id, school_id, field_name, old_value, new_value, created_at, schools(name, city, state)")
      .is("emailed_at", null)
      .order("created_at", { ascending: true })
      .limit(2000);
    if (pendingErr) throw pendingErr;
    if (!pending?.length) {
      return NextResponse.json({ ...results, message: "No unemailed notifications." });
    }

    const byCollege = new Map();
    pending.forEach((row) => {
      if (!byCollege.has(row.college_id)) byCollege.set(row.college_id, []);
      byCollege.get(row.college_id).push(row);
    });

    const collegeIds = [...byCollege.keys()];
    const { data: colleges, error: collegesErr } = await supabase.from("colleges").select("id, name").in("id", collegeIds);
    if (collegesErr) throw collegesErr;
    const collegeNameById = new Map((colleges || []).map((c) => [c.id, c.name]));

    for (const collegeId of collegeIds) {
      const rows = byCollege.get(collegeId);
      const collegeName = collegeNameById.get(collegeId) || "your program";

      try {
        const { data: profiles, error: profilesErr } = await supabase.from("profiles").select("id").eq("college_id", collegeId);
        if (profilesErr) throw profilesErr;

        const emails = [];
        for (const p of profiles || []) {
          const { data: userRes } = await supabase.auth.admin.getUserById(p.id);
          if (userRes?.user?.email) emails.push(userRes.user.email);
        }
        if (!emails.length) {
          results.errors.push(`College ${collegeId} (${collegeName}): no staff email addresses found, skipped.`);
          continue;
        }

        const { subject, html } = buildEmail(collegeName, rows);

        const sendRes = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${resendKey}` },
          body: JSON.stringify({ from: FROM_EMAIL, to: emails, subject, html }),
        });

        if (!sendRes.ok) {
          const detail = await sendRes.text().catch(() => "");
          results.errors.push(`College ${collegeId} (${collegeName}): Resend error ${sendRes.status} — ${detail.slice(0, 200)}`);
          continue;
        }

        const ids = rows.map((r) => r.id);
        const { error: markErr } = await supabase
          .from("coach_change_notifications")
          .update({ emailed_at: new Date().toISOString() })
          .in("id", ids);
        if (markErr) throw markErr;

        results.collegesEmailed += 1;
        results.notificationsEmailed += ids.length;
      } catch (err) {
        results.errors.push(`College ${collegeId} (${collegeName}): ${err.message || String(err)}`);
      }
    }

    return NextResponse.json(results);
  } catch (err) {
    console.error("coach-alert-digest error", err);
    return NextResponse.json({ error: err.message || "Digest run failed." }, { status: 500 });
  }
}
