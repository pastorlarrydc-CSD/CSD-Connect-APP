// lib/backlogVerify.js
//
// Backlog verification: turns a collected "re_verify" Batch Coach-Info result
// into one of three outcomes for a school that is NOT yet verified and NOT
// already flagged for review (the unverified backlog):
//
//   confirmed -- the AI's web check named the SAME head coach and the SAME
//                email that are on file, at high confidence (so it had a
//                dated current-season signal and the email was not a guess),
//                the email fits the coach's name, and that email has never
//                bounced. The school is stamped verified, with a
//                review_confirmed log row, exactly like the Needs Review
//                "Confirm AI-matched" button does -- just without a click.
//   flagged   -- the AI found a DIFFERENT head coach (high or medium
//                confidence). Nothing about the coach is changed; the school
//                is flagged for Needs Review with the new name and why, so a
//                person decides.
//   skipped   -- anything else (no result, same coach but the email was not
//                seen, low confidence, bounced email...). The school stays
//                exactly as it was.
//
// Why this exists: a rule-based bulk "verify everything that looks clean"
// was tested on a random sample of 50 (Oct 2026) and about 1 in 4 had the
// wrong coach -- the email still matched the OLD coach's surname and school
// domain. Only a fresh web check against current sources can tell. See
// claude/low-risk-bulk-verify-audit-result.md.
//
// Schools already flagged for review or already verified are never touched
// here: flagged schools keep their human "Confirm AI-matched" path in the
// Needs Review queue.

import { compareSuggestion } from "@/lib/needsReviewAi";
import { emailFit } from "@/lib/coachEmailFit";
import { NEEDS_REVIEW_CLEAR_FIELDS } from "@/lib/needsReview";

// Wording deliberately starts with "Batch AI lookup" so the Database screen's
// "How verified" shows it as an AI check (ai_batch), never as a human or
// independent confirmation (see the school_verification_meta view).
function confirmSource(runId) {
  return `Batch AI lookup - web check matched the on-file coach and email (confirmed automatically when re-verify run #${runId} was collected, high confidence)`;
}

function trimTo(s, n) {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

function onFileName(s) {
  return [s.hc_first_name, s.hc_last_name].filter(Boolean).join(" ").trim();
}

// -> { outcome: "confirmed" | "flagged" | "skipped" | "error", reason }
// applyResult: what autoApplyHighConfidenceSuggestion returned for this same
// item (or null). If it wrote anything to the school, the record is no longer
// "what was on file" and is left for a person to look at.
export async function settleReVerifyItem({ supabase, schoolId, runId, suggestion, applyResult, actorUserId }) {
  try {
    if (!schoolId || !suggestion) return { outcome: "skipped", reason: "no suggestion" };

    const { data: school, error: schoolErr } = await supabase
      .from("schools")
      .select("id,hc_first_name,hc_last_name,hc_email,hc_cell,hc_office,verification_status,needs_review,is_closed")
      .eq("id", schoolId)
      .maybeSingle();
    if (schoolErr || !school) return { outcome: "error", reason: schoolErr?.message || "school not found" };

    if (school.is_closed) return { outcome: "skipped", reason: "closed" };
    if (school.verification_status === "verified") return { outcome: "skipped", reason: "already verified" };
    if (school.needs_review) return { outcome: "skipped", reason: "already flagged" };
    // If the auto-apply step just filled in the coach's name or email from this
    // same AI result, "the AI agrees with what's on file" would be circular --
    // leave it for a person. (Filling a blank cell/office number is harmless.)
    const wroteIdentity =
      !!applyResult &&
      Array.isArray(applyResult.changedFields) &&
      applyResult.changedFields.some((f) => f === "hc_first_name" || f === "hc_last_name" || f === "hc_email");

    const cmp = compareSuggestion(school, suggestion);

    if (cmp.status === "differs") {
      if (cmp.confidence !== "high" && cmp.confidence !== "medium") return { outcome: "skipped", reason: "low confidence difference" };
      const note =
        `AI re-verification (batch run #${runId}) found a different head coach: ${cmp.suggestedName} (${cmp.confidence} confidence). ` +
        `On file: ${onFileName(school) || "(blank)"}. ` +
        (suggestion.source ? `Source: ${trimTo(suggestion.source, 160)}. ` : "") +
        (suggestion.notes ? `${trimTo(suggestion.notes, 280)} ` : "") +
        "Confirm which is right before the next send.";
      const { error: flagErr } = await supabase
        .from("schools")
        .update({ needs_review: true, needs_review_note: note, needs_review_marked_at: new Date().toISOString(), needs_review_marked_by: null })
        .eq("id", schoolId)
        .eq("needs_review", false)
        .neq("verification_status", "verified");
      if (flagErr) return { outcome: "error", reason: flagErr.message };
      return { outcome: "flagged", reason: "different coach" };
    }

    if (wroteIdentity) return { outcome: "skipped", reason: "auto-apply filled the coach name/email" };
    if (cmp.status !== "matches" || !cmp.confirmable) return { outcome: "skipped", reason: `not confirmable (${cmp.status})` };
    if (suggestion.hc_email_estimated) return { outcome: "skipped", reason: "estimated email" };
    if (emailFit(school.hc_email, { first: school.hc_first_name, last: school.hc_last_name }) !== "match") {
      return { outcome: "skipped", reason: "email does not carry the coach's name" };
    }

    const { data: bounces, error: bounceErr } = await supabase
      .from("email_bounce_events")
      .select("id,bounced_email")
      .eq("school_id", schoolId);
    if (bounceErr) return { outcome: "error", reason: bounceErr.message };
    const onFile = String(school.hc_email || "").trim().toLowerCase();
    if ((bounces || []).some((b) => String(b.bounced_email || "").trim().toLowerCase() === onFile)) {
      return { outcome: "skipped", reason: "email on file has bounced" };
    }

    const snapshot = JSON.stringify({ coach: onFileName(school), email: school.hc_email, cell: school.hc_cell, office: school.hc_office });
    const { error: logErr } = await supabase.from("school_change_log").insert({
      school_id: schoolId,
      field_name: "review_confirmed",
      old_value: snapshot,
      new_value: snapshot,
      source: confirmSource(runId),
      changed_by: actorUserId,
    });
    if (logErr) return { outcome: "error", reason: logErr.message };

    const nowIso = new Date().toISOString();
    const { error: updErr } = await supabase
      .from("schools")
      .update({ verification_status: "verified", last_verified_at: nowIso, coach_radar_reviewed_at: nowIso, ...NEEDS_REVIEW_CLEAR_FIELDS })
      .eq("id", schoolId)
      .eq("needs_review", false);
    if (updErr) return { outcome: "error", reason: updErr.message };
    return { outcome: "confirmed", reason: "matched" };
  } catch (err) {
    return { outcome: "error", reason: err?.message || "unexpected error" };
  }
}

// Every school that already went through a re_verify run created in the last
// `days` days (any item, any result). Used to keep a second run from paying
// for the same schools again. Paged in 1000-row chunks -- Supabase caps a
// single request at 1000 rows (see lib/batchExclusion.js).
export async function fetchRecentReVerifySchoolIds(supabase, days = 60) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const { data: runs, error: runErr } = await supabase
    .from("coach_info_batch_runs")
    .select("id")
    .eq("candidate_mode", "re_verify")
    .gte("created_at", since);
  if (runErr) throw runErr;
  const ids = new Set();
  const runIds = (runs || []).map((r) => r.id);
  for (let i = 0; i < runIds.length; i += 50) {
    const chunk = runIds.slice(i, i + 50);
    let from = 0;
    const pageSize = 1000;
    for (;;) {
      const { data, error } = await supabase
        .from("coach_info_batch_items")
        .select("school_id")
        .in("batch_run_id", chunk)
        .range(from, from + pageSize - 1);
      if (error) throw error;
      (data || []).forEach((r) => ids.add(r.school_id));
      if (!data || data.length < pageSize) break;
      from += pageSize;
    }
  }
  return ids;
}
