import { NextResponse } from "next/server";
import { getSupabaseRouteClient } from "@/lib/supabase/routeClient";
import { parseModelJson, autoApplyHighConfidenceUrlSuggestion, runWithConcurrency } from "@/lib/coachInfoLookup";
import { normalizeAthleticsSuggestion } from "@/lib/athleticsLookup";

const REVIEWER_ROLES = ["verifier", "sysadmin"];

// How many result lines this route processes at once instead of one at a
// time -- see runWithConcurrency's own comment in lib/coachInfoLookup.js for
// why (this route timing out on an oversized run is exactly what led to
// adding it).
const COLLECT_CONCURRENCY = 8;

// Collect stage of the overnight Athletics-URL Batch API job -- identical
// shape to app/api/admin/batch-coach-info/[runId]/collect, just pointed at
// athletics_batch_items and the athletics suggestion shape. Once Anthropic
// reports a batch's processing_status as "ended" (checked via
// check-status), this route downloads the batch's results file -- a
// newline-delimited JSON (JSONL) file Anthropic hosts at results_url, one
// line per submitted request -- and drops each school's parsed suggestion
// into athletics_batch_items for the review page to show.
//
// High-confidence suggestions get written straight into the schools
// table's athletics_url column right here, the moment they're collected --
// no click required (see autoApplyHighConfidenceUrlSuggestion in
// lib/coachInfoLookup.js, the same generic write path Batch Coach-Info's
// own auto-apply uses). Medium/low/none confidence still just sit on the
// review page waiting for a human Apply click -- the AI itself flags those
// as less certain, and an unattended write there risks landing a wrong
// athletics link before anyone catches it. The reviewer who clicked
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

    const { data: run, error: runErr } = await supabase.from("athletics_batch_runs").select("id,status,anthropic_batch_id").eq("id", runId).maybeSingle();
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
    // one per item.
    const { data: itemRows } = await supabase.from("athletics_batch_items").select("id,school_id").eq("batch_run_id", runId);
    const schoolIdByItemId = new Map((itemRows || []).map((r) => [r.id, r.school_id]));

    // Each result line updates an EXISTING item row (created back in the
    // "start run" step, one per school) -- so this is always an update,
    // never an insert. Deliberately not using upsert(): athletics_batch_items
    // has other required columns (batch_run_id, school_id) that aren't known
    // here, and Postgres validates NOT NULL constraints against the full
    // candidate row on the insert path of an upsert even when the row will
    // end up just being updated. A plain update() only ever touches the
    // columns listed below, so it can't trip that (same lesson learned the
    // hard way building the coach-info batch job's collect route).
    const resultLines = resultsText.split("\n").map((l) => l.trim()).filter(Boolean);
    let succeeded = 0;
    let failed = 0;
    let autoApplied = 0;
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
          patch = { suggestion: normalizeAthleticsSuggestion(parsed), suggestion_error: null };
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

      const { error: itemErr } = await supabase.from("athletics_batch_items").update(patch).eq("id", itemId);
      if (itemErr && !saveErr) saveErr = itemErr;

      if (!itemErr && patch.suggestion?.confidence === "high") {
        const schoolId = schoolIdByItemId.get(itemId);
        if (schoolId) {
          const result = await autoApplyHighConfidenceUrlSuggestion({
            supabase,
            itemId,
            itemsTable: "athletics_batch_items",
            schoolId,
            fieldName: "athletics_url",
            newUrl: patch.suggestion.best_url,
            actorUserId: userData.user.id,
          });
          if (result.applied) autoApplied++;
          else {
            autoApplyErrors++;
            console.error("batch-athletics collect auto-apply error for item", itemId, result.error);
          }
        }
      }
    });

    if (saveErr) {
      return NextResponse.json({ error: saveErr.message || "Downloaded results but could not save all of them." }, { status: 500 });
    }

    const { error: updateErr } = await supabase
      .from("athletics_batch_runs")
      .update({ status: "collected", collected_at: new Date().toISOString() })
      .eq("id", runId);
    if (updateErr) {
      console.error("batch-athletics collect run-update error", updateErr);
    }

    return NextResponse.json({ status: "collected", succeeded, failed, auto_applied: autoApplied, auto_apply_errors: autoApplyErrors });
  } catch (err) {
    console.error("batch-athletics collect error", err);
    return NextResponse.json({ error: "Could not collect this run's results. Please try again." }, { status: 500 });
  }
}
