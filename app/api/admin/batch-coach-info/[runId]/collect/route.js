import { NextResponse } from "next/server";
import { getSupabaseRouteClient } from "@/lib/supabase/routeClient";
import { parseModelJson, normalizeSuggestion, autoApplyHighConfidenceSuggestion, runWithConcurrency, findDuplicateNameSchoolsForMany } from "@/lib/coachInfoLookup";

const REVIEWER_ROLES = ["verifier", "sysadmin"];

// How many result lines this route processes at once instead of one at a
// time -- see runWithConcurrency's own comment in lib/coachInfoLookup.js for
// why (the same sequential design timed out Batch Athletics' Run #20 on an
// oversized run; this route shares that exact structure).
const COLLECT_CONCURRENCY = 8;

// Collect stage of the overnight Coach-Info Batch API job. Once Anthropic
// reports a batch's processing_status as "ended" (checked via
// check-status), this route downloads the batch's results file -- a
// newline-delimited JSON (JSONL) file Anthropic hosts at results_url, one
// line per submitted request -- and drops each school's parsed suggestion
// into coach_info_batch_items for the review page to show.
//
// High-confidence suggestions get written straight into the schools table
// right here, the moment they're collected -- no click required (see
// autoApplyHighConfidenceSuggestion in lib/coachInfoLookup.js). Medium and
// low confidence still just sit on the review page waiting for a human
// Apply click, same as always: the AI itself flags those as less certain,
// and an unattended write there risks landing bad data before anyone
// catches it (the "Ajo High School -- coach could not be verified" case is
// exactly the kind of low-confidence miss this bar exists to keep out of
// the schools table without a human's own click). The reviewer who clicked
// "Collect Results" is attributed as the actor on every auto-applied
// change, same as if they'd clicked Apply themselves.
export async function POST(req, { params }) {
  try {
    const runId = Number(params.runId);
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
      return NextResponse.json({ error: "Only verification staff or a system admin can collect a batch run's results." }, { status: 403 });
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: "ANTHROPIC_API_KEY is missing from the server environment." }, { status: 500 });
    }

    // candidate_mode needed for the bounce_recovery carve-out below -- see
    // the matching check (and its own comment) in
    // app/api/cron/collect-batch-runs/route.js, which this manual button
    // had been missing entirely until Larry caught a bounce-recovery run
    // that got auto-applied through THIS route instead of the overnight
    // cron. Same rule either way a run gets collected: bounce_recovery
    // always waits for a human Apply click, regardless of confidence.
    const { data: run, error: runErr } = await supabase.from("coach_info_batch_runs").select("id,status,anthropic_batch_id,candidate_mode").eq("id", runId).maybeSingle();
    if (runErr || !run) {
      return NextResponse.json({ error: "Batch run not found." }, { status: 404 });
    }
    if (!run.anthropic_batch_id) {
      return NextResponse.json({ error: "This run hasn't been submitted to Anthropic yet." }, { status: 400 });
    }

    const batchRes = await fetch(`https://api.anthropic.com/v1/messages/batches/${run.anthropic_batch_id}`, {
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    });
    if (!batchRes.ok) {
      const detail = await batchRes.text().catch(() => "");
      console.error("Anthropic Batch API status error (collect)", batchRes.status, detail);
      return NextResponse.json({ error: "Anthropic's Batch API returned an error looking up this run." }, { status: 502 });
    }
    const batchJson = await batchRes.json();
    if (batchJson.processing_status !== "ended" || !batchJson.results_url) {
      return NextResponse.json({ error: "This batch hasn't finished processing yet -- check its status again in a bit." }, { status: 409 });
    }

    const resultsRes = await fetch(batchJson.results_url, {
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    });
    if (!resultsRes.ok) {
      const detail = await resultsRes.text().catch(() => "");
      console.error("Anthropic Batch API results fetch error", resultsRes.status, detail);
      return NextResponse.json({ error: "Could not download this batch's results from Anthropic." }, { status: 502 });
    }
    const resultsText = await resultsRes.text();

    // Needed to auto-apply below (a result line only carries an item id, not
    // the school it belongs to) -- one query for the whole run instead of
    // one per item. Also embeds each item's school name/city/state (via the
    // school_id -> schools FK) so normalizeSuggestion's same-name-school
    // backstops below have something to check the AI's answer against --
    // see that function's own comment in lib/coachInfoLookup.js.
    const { data: itemRows } = await supabase.from("coach_info_batch_items").select("id,school_id,school:schools(name,city,state)").eq("batch_run_id", runId);
    const schoolIdByItemId = new Map((itemRows || []).map((r) => [r.id, r.school_id]));
    // hasKnownDuplicates per school -- one query for the whole run (see
    // findDuplicateNameSchoolsForMany's own comment) rather than one per
    // item, folded into the same location object normalizeSuggestion
    // already expects.
    const duplicateMap = await findDuplicateNameSchoolsForMany({
      supabase,
      schools: (itemRows || []).map((r) => ({ id: r.school_id, name: r.school?.name })),
    });
    const schoolLocationByItemId = new Map(
      (itemRows || []).map((r) => [r.id, { ...(r.school || {}), hasKnownDuplicates: duplicateMap.get(r.school_id) || false }])
    );

    // Each result line updates an EXISTING item row (created back in the
    // "start run" step, one per school) -- so this is always an update,
    // never an insert. Deliberately not using upsert(): coach_info_batch_items
    // has other required columns (batch_run_id, school_id) that aren't known
    // here, and Postgres validates NOT NULL constraints against the full
    // candidate row on the insert path of an upsert even when the row will
    // end up just being updated. A plain update() only ever touches the
    // columns listed below, so it can't trip that.
    const resultLines = resultsText.split("\n").map((l) => l.trim()).filter(Boolean);
    let succeeded = 0;
    let failed = 0;
    let autoApplied = 0;
    let autoApplyHeld = 0;
    let autoApplyErrors = 0;
    let saveErr = null;

    // Processed COLLECT_CONCURRENCY-at-a-time rather than one line at a
    // time -- see COLLECT_CONCURRENCY's comment above. The counters below
    // are all simple increments on plain numbers, which is safe to share
    // across concurrent workers here: JavaScript never runs two of these
    // callbacks' synchronous stretches at the same instant, only their
    // `await`s overlap, so no two increments can ever land on top of each
    // other.
    await runWithConcurrency(resultLines, COLLECT_CONCURRENCY, async (trimmed) => {
      let entry;
      try {
        entry = JSON.parse(trimmed);
      } catch (_) {
        return;
      }
      const match = /^item-(\d+)$/.exec(entry.custom_id || "");
      if (!match) return;
      const itemId = Number(match[1]);

      let patch;
      if (entry.result?.type === "succeeded") {
        const rawText = entry.result.message?.content?.[0]?.text || "";
        const parsed = parseModelJson(rawText);
        if (parsed) {
          patch = { suggestion: normalizeSuggestion(parsed, "batch AI lookup", schoolLocationByItemId.get(itemId)), suggestion_error: null };
          succeeded++;
        } else {
          patch = { suggestion: null, suggestion_error: "Could not parse the AI's response for this school." };
          failed++;
        }
      } else {
        const kind = entry.result?.type || "unknown";
        patch = { suggestion: null, suggestion_error: `Anthropic reported this request as "${kind}" -- it did not produce a suggestion.` };
        failed++;
      }

      const { error: itemErr } = await supabase.from("coach_info_batch_items").update(patch).eq("id", itemId);
      if (itemErr && !saveErr) saveErr = itemErr;

      // bounce_recovery is the one candidate_mode this button must NOT
      // auto-apply for -- same rule the overnight cron already enforces
      // (see collect-batch-runs/route.js), now enforced here too so
      // clicking "Collect Results" manually on a bounce-recovery run can't
      // silently auto-apply an email that's often recently been marked
      // "verified" (the whole reason bounce recovery flags it in the first
      // place). Larry chose "always manual review" for this mode
      // specifically -- every suggestion from a bounce_recovery run should
      // land in the review queue for a human Apply click, no matter which
      // button collected the results.
      if (!itemErr && run.candidate_mode !== "bounce_recovery" && patch.suggestion?.confidence === "high") {
        const schoolId = schoolIdByItemId.get(itemId);
        if (schoolId) {
          const result = await autoApplyHighConfidenceSuggestion({
            supabase,
            itemId,
            itemsTable: "coach_info_batch_items",
            schoolId,
            suggestion: patch.suggestion,
            actorUserId: userData.user.id,
          });
          if (result.applied) autoApplied++;
          else if (result.held) {
            // Not an error -- see OVERWRITE_GATED_FIELDS in
            // lib/coachInfoLookup.js. The suggestion would have replaced an
            // existing coach name/email with a different one, so it was
            // left "pending" for a human instead of auto-applied.
            autoApplyHeld++;
          } else {
            autoApplyErrors++;
            console.error("batch-coach-info collect auto-apply error for item", itemId, result.error);
          }
        }
      }
    });

    if (saveErr) {
      return NextResponse.json({ error: saveErr.message || "Downloaded results but could not save all of them." }, { status: 500 });
    }

    const { error: updateErr } = await supabase
      .from("coach_info_batch_runs")
      .update({ status: "collected", collected_at: new Date().toISOString() })
      .eq("id", runId);
    if (updateErr) {
      console.error("batch-coach-info collect run-update error", updateErr);
    }

    return NextResponse.json({ status: "collected", succeeded, failed, auto_applied: autoApplied, auto_apply_held: autoApplyHeld, auto_apply_errors: autoApplyErrors });
  } catch (err) {
    console.error("batch-coach-info collect error", err);
    return NextResponse.json({ error: "Could not collect this run's results. Please try again." }, { status: 500 });
  }
}
