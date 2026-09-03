import { NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { parseModelJson, normalizeSuggestion, autoApplyHighConfidenceSuggestion } from "@/lib/coachInfoLookup";
import { normalizeAthleticsSuggestion } from "@/lib/athleticsLookup";
import { normalizeMaxPrepsSuggestion } from "@/lib/maxPrepsLookup";
import { normalizeSocialSuggestion } from "@/lib/socialLookup";

export const maxDuration = 60;

// Wait + Collect stages of all four overnight Batch API jobs (Athletics,
// Coach-Info, MaxPreps, Social Media), automated. The four weekly-*-batch
// crons (and the manual review pages) already handle Prep and Submit on
// their own -- this is the missing half: instead of a human having to
// remember to come back, open each review page, and click "Check Status"
// then "Collect Results" once Anthropic's done, this checks on every
// batch run currently sitting at "submitted"/"processing" across all four
// tools and, the moment Anthropic reports one "ended", downloads its
// results and drops them straight into that tool's review queue -- same
// exact logic each tool's own [runId]/check-status and [runId]/collect
// routes already use, just running unattended instead of on a click.
//
// Coach-Info is the one exception to "nothing here writes to the schools
// table": once results come back, its high-confidence suggestions get
// written straight into the school record right here (see
// autoApplyHighConfidenceSuggestion in lib/coachInfoLookup.js) -- no click
// needed, so a Monday-morning coach-info run can be fully done, applied,
// and sitting in "My Recent Updates" on the Data Quality page for a spot
// check before anyone opens the review page at all. Medium/low confidence
// still waits for a human Apply click there, matching the existing
// bulk-apply button's own bar. Athletics, MaxPreps, and Social still never
// touch the schools table here -- their suggestions (URLs, handles) aren't
// verified against a person's identity the way a name+email is, so this
// keeps them exactly as reviewer-gated as before; a human still reviews and
// applies (or skips) each of those.
//
// Anthropic's Batch API has no webhook/completion notification -- polling
// is the only way to know a batch is done (confirmed against Anthropic's
// own docs, https://platform.claude.com/docs/en/build-with-claude/batch-processing)
// -- so this runs on a schedule (see vercel.json) rather than being
// triggered by Anthropic itself.
//
// Same CRON_SECRET Bearer-header auth as every other cron route, and the
// same system_settings kill-switch pattern (key: batch_auto_collect_enabled)
// so this can be paused without a code change or redeploy.
//
// Runs once a day (see vercel.json) -- this Vercel project is on the
// Hobby plan, which only allows a cron schedule to fire once per day, so
// "check a few times a day" isn't available here. Once daily is still a
// large improvement over "whenever a human remembers to open the review
// page," and Anthropic's Batch API typically finishes well within 24
// hours, so a submitted run is normally collected the very next day.
//
// Processes runs oldest-submitted-first, across all four tools, until
// TIME_BUDGET_MS is spent -- whatever's left over just gets picked up on
// the next day's run. Checking a run's status is cheap (one small
// Anthropic API call); actually collecting a finished run's results is
// the slow part (one DB update per school), so the time budget mostly
// protects against a run finishing that happens to have a lot of items
// in one invocation.
const TIME_BUDGET_MS = 50_000;

const SYSTEM_USER_ID = "d24ad753-f759-479d-8958-fae8f995faa1"; // CSD sysadmin account (Larry) -- same attribution every other cron uses for automated writes

// One entry per batch discovery tool -- everything that differs between
// them (table names, how a parsed suggestion gets normalized) lives here;
// the loop below is otherwise identical for all four, mirroring each
// tool's own [runId]/check-status + [runId]/collect routes exactly.
const TOOLS = [
  {
    key: "athletics",
    runsTable: "athletics_batch_runs",
    itemsTable: "athletics_batch_items",
    buildSuggestion: (parsed) => normalizeAthleticsSuggestion(parsed),
  },
  {
    key: "coach_info",
    runsTable: "coach_info_batch_runs",
    itemsTable: "coach_info_batch_items",
    buildSuggestion: (parsed) => normalizeSuggestion(parsed, "batch AI lookup"),
    autoApplyHighConfidence: true,
  },
  {
    key: "maxpreps",
    runsTable: "maxpreps_batch_runs",
    itemsTable: "maxpreps_batch_items",
    buildSuggestion: (parsed) => normalizeMaxPrepsSuggestion(parsed),
  },
  {
    key: "social",
    runsTable: "social_batch_runs",
    itemsTable: "social_batch_items",
    buildSuggestion: (parsed) => normalizeSocialSuggestion(parsed),
  },
];

export async function GET(req) {
  const authHeader = req.headers.get("authorization") || "";
  const { searchParams } = new URL(req.url);
  const querySecret = searchParams.get("secret") || "";
  const expected = process.env.CRON_SECRET;
  const authorized = !!expected && (authHeader === `Bearer ${expected}` || querySecret === expected);
  if (!authorized) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "Batch auto-collect isn't fully configured -- ANTHROPIC_API_KEY is missing from the server environment." }, { status: 500 });
  }

  const startedAt = Date.now();
  const supabase = getSupabaseAdminClient();
  const summary = [];

  try {
    const { data: setting } = await supabase.from("system_settings").select("value").eq("key", "batch_auto_collect_enabled").maybeSingle();
    if (setting && setting.value === false) {
      console.log("cron collect-batch-runs: skipped -- batch_auto_collect_enabled is false in system_settings");
      return NextResponse.json({ skipped: true, reason: "Automated batch collection is currently suspended (system_settings.batch_auto_collect_enabled = false)." });
    }

    toolLoop: for (const tool of TOOLS) {
      const { data: runs, error: runsErr } = await supabase
        .from(tool.runsTable)
        .select("id,status,anthropic_batch_id,submitted_at")
        .in("status", ["submitted", "processing"])
        .not("anthropic_batch_id", "is", null)
        .order("submitted_at", { ascending: true });
      if (runsErr) {
        console.error(`cron collect-batch-runs: could not load ${tool.runsTable}`, runsErr);
        summary.push({ tool: tool.key, error: runsErr.message });
        continue;
      }

      for (const run of runs || []) {
        if (Date.now() - startedAt > TIME_BUDGET_MS) {
          summary.push({ tool: tool.key, stopped_early: true });
          break toolLoop;
        }

        const statusRes = await fetch(`https://api.anthropic.com/v1/messages/batches/${run.anthropic_batch_id}`, {
          headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
        });
        if (!statusRes.ok) {
          const detail = await statusRes.text().catch(() => "");
          console.error(`cron collect-batch-runs: status error for ${tool.key} run ${run.id}`, statusRes.status, detail);
          summary.push({ tool: tool.key, run_id: run.id, error: `Anthropic status check returned HTTP ${statusRes.status}` });
          continue;
        }
        const statusJson = await statusRes.json();
        const processingStatus = statusJson.processing_status || "in_progress";

        if (processingStatus !== "ended") {
          // Not done yet -- just keep the run's own status label current
          // (submitted -> processing) so anyone looking at the review page
          // sees accurate progress, same as a manual "Check Status" click
          // would show. Nothing else to do until a later run of this cron.
          const nextStatus = run.status === "submitted" ? "processing" : run.status;
          const update = { anthropic_batch_status: processingStatus };
          if (nextStatus !== run.status) update.status = nextStatus;
          await supabase.from(tool.runsTable).update(update).eq("id", run.id);
          summary.push({ tool: tool.key, run_id: run.id, processing_status: processingStatus, collected: false });
          continue;
        }

        if (!statusJson.results_url) {
          console.error(`cron collect-batch-runs: ${tool.key} run ${run.id} reported ended with no results_url`);
          summary.push({ tool: tool.key, run_id: run.id, error: "Anthropic reported this batch ended but did not provide a results URL." });
          continue;
        }

        const resultsRes = await fetch(statusJson.results_url, {
          headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
        });
        if (!resultsRes.ok) {
          const detail = await resultsRes.text().catch(() => "");
          console.error(`cron collect-batch-runs: results download error for ${tool.key} run ${run.id}`, resultsRes.status, detail);
          summary.push({ tool: tool.key, run_id: run.id, error: `Could not download results (HTTP ${resultsRes.status}).` });
          continue;
        }
        const resultsText = await resultsRes.text();

        // Only coach_info auto-applies (see the tool config above) -- and
        // only that lookup needs a school_id per item, since a result line
        // itself only carries the item id. One query for the whole run
        // instead of one per item.
        let schoolIdByItemId = null;
        if (tool.autoApplyHighConfidence) {
          const { data: itemRows } = await supabase.from(tool.itemsTable).select("id,school_id").eq("batch_run_id", run.id);
          schoolIdByItemId = new Map((itemRows || []).map((r) => [r.id, r.school_id]));
        }

        // Same update-only approach (never upsert) as every manual collect
        // route -- each line updates an EXISTING item row created back at
        // Submit time, and upsert would trip NOT NULL constraints on
        // columns (batch_run_id, school_id) this loop never sees.
        let succeeded = 0;
        let failed = 0;
        let autoApplied = 0;
        let autoApplyErrors = 0;
        for (const line of resultsText.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          let entry;
          try {
            entry = JSON.parse(trimmed);
          } catch (_) {
            continue;
          }
          const match = /^item-(\d+)$/.exec(entry.custom_id || "");
          if (!match) continue;
          const itemId = Number(match[1]);

          let patch;
          if (entry.result?.type === "succeeded") {
            const rawText = entry.result.message?.content?.[0]?.text || "";
            const parsed = parseModelJson(rawText);
            if (parsed) {
              patch = { suggestion: tool.buildSuggestion(parsed), suggestion_error: null };
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

          const { error: itemErr } = await supabase.from(tool.itemsTable).update(patch).eq("id", itemId);
          if (itemErr) console.error(`cron collect-batch-runs: item update error for ${tool.key} run ${run.id} item ${itemId}`, itemErr);

          if (!itemErr && tool.autoApplyHighConfidence && patch.suggestion?.confidence === "high") {
            const schoolId = schoolIdByItemId?.get(itemId);
            if (schoolId) {
              const applyResult = await autoApplyHighConfidenceSuggestion({
                supabase,
                itemId,
                itemsTable: tool.itemsTable,
                schoolId,
                suggestion: patch.suggestion,
                actorUserId: SYSTEM_USER_ID,
              });
              if (applyResult.applied) autoApplied++;
              else {
                autoApplyErrors++;
                console.error(`cron collect-batch-runs: auto-apply error for ${tool.key} run ${run.id} item ${itemId}`, applyResult.error);
              }
            }
          }
        }

        await supabase.from(tool.runsTable).update({ status: "collected", collected_at: new Date().toISOString(), anthropic_batch_status: processingStatus }).eq("id", run.id);
        summary.push({ tool: tool.key, run_id: run.id, collected: true, succeeded, failed, auto_applied: autoApplied, auto_apply_errors: autoApplyErrors });
        console.log(
          `cron collect-batch-runs: collected ${tool.key} run ${run.id} -- ${succeeded} succeeded, ${failed} failed` +
            (tool.autoApplyHighConfidence ? `, ${autoApplied} auto-applied, ${autoApplyErrors} auto-apply errors` : "")
        );
      }
    }

    return NextResponse.json({ summary, duration_ms: Date.now() - startedAt });
  } catch (err) {
    console.error("cron collect-batch-runs error", err);
    return NextResponse.json({ error: err.message || "Automated batch collection failed.", summary }, { status: 500 });
  }
}
