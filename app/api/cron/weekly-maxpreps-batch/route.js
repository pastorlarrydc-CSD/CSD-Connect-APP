import { NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { searchWeb } from "@/lib/coachInfoLookup";
import { buildMaxPrepsSourceText, SYSTEM_PROMPT, MODEL, MAX_TOKENS } from "@/lib/maxPrepsLookup";

export const maxDuration = 60;

// Weekly automated kickoff for Batch MaxPreps Discovery -- the MaxPreps
// counterpart to app/api/cron/weekly-athletics-batch (see that route for the
// pattern this mirrors). The batch tool at /admin/batch-maxpreps already
// works, it just requires a human to click Start Run, then Search, then
// Submit -- three separate steps that are easy to let slide on a busy week,
// same as Athletics and Social before this automation existed for them.
//
// This does exactly those first three stages on its own, every Monday
// morning (see vercel.json, scheduled two hours after weekly-athletics-batch
// and an hour after weekly-social-batch so none of the three compete for the
// same minute): pick a batch of schools still missing a MaxPreps URL, run
// the same site:maxpreps.com-restricted search the single-school "Find
// MaxPreps page" button uses, and submit whatever comes back usable to
// Anthropic's Batch API. By the time anyone opens /admin/batch-maxpreps
// later in the week, the run is already sitting at "submitted" or "ready to
// collect" -- all that's left is the part that should stay a human's call:
// clicking Collect Results and reviewing/applying suggestions. Nothing here
// ever writes to the schools table itself -- same non-authoritative
// contract as every other discovery tool in this app.
//
// Same CRON_SECRET Bearer-header auth (plus ?secret= for a browser smoke
// test) as every other cron route in this app, and the same
// system_settings kill-switch pattern as weekly-athletics-batch/
// weekly-social-batch (key: weekly_maxpreps_batch_enabled) so this can be
// paused without a code change or redeploy if it ever needs to be.
const PRIORITY_STATES = ["TX", "FL", "GA", "CA", "OH", "IN"];
const WEEKLY_TARGET_COUNT = 300; // matches the manual tool's own default run size
const FETCH_CONCURRENCY = 8; // no live user waiting on this one -- matches weekly-athletics-batch/weekly-social-batch's own concurrency
const TIME_BUDGET_MS = 45_000; // leaves headroom under maxDuration=60 for the Anthropic Batch submit call after the fetch loop

const SYSTEM_USER_ID = "d24ad753-f759-479d-8958-fae8f995faa1"; // CSD sysadmin account (Larry) -- same attribution recheck-schools/weekly-athletics-batch/weekly-social-batch use for automated writes

export async function GET(req) {
  const authHeader = req.headers.get("authorization") || "";
  const { searchParams } = new URL(req.url);
  const querySecret = searchParams.get("secret") || "";
  const expected = process.env.CRON_SECRET;
  const authorized = !!expected && (authHeader === `Bearer ${expected}` || querySecret === expected);
  if (!authorized) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const serperKey = process.env.SERPER_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!serperKey || !anthropicKey) {
    return NextResponse.json(
      { error: "Weekly MaxPreps batch isn't fully configured -- SERPER_API_KEY and/or ANTHROPIC_API_KEY missing from the server environment." },
      { status: 500 }
    );
  }

  const startedAt = Date.now();
  const supabase = getSupabaseAdminClient();

  try {
    const { data: setting } = await supabase.from("system_settings").select("value").eq("key", "weekly_maxpreps_batch_enabled").maybeSingle();
    if (setting && setting.value === false) {
      console.log("cron weekly-maxpreps-batch: skipped -- weekly_maxpreps_batch_enabled is false in system_settings");
      return NextResponse.json({ skipped: true, reason: "Weekly MaxPreps batch is currently suspended (system_settings.weekly_maxpreps_batch_enabled = false)." });
    }

    // Schools already sitting in an unresolved batch item (fetched or not,
    // but not yet reviewed) from a previous run shouldn't be queued again --
    // avoids paying for a second Serper/AI look at a school nobody's gotten
    // to reviewing yet. Over-fetch the candidate pool since this filter
    // happens client-side, then trim to the target count.
    const { data: pendingItemRows, error: pendingErr } = await supabase.from("maxpreps_batch_items").select("school_id").eq("review_status", "pending");
    if (pendingErr) throw pendingErr;
    const excludedIds = new Set((pendingItemRows || []).map((r) => r.school_id));

    const { data: rawCandidates, error: candErr } = await supabase
      .from("schools")
      .select("id,name,city,state")
      .or("maxpreps_url.is.null,maxpreps_url.eq.")
      .in("state", PRIORITY_STATES)
      .order("id", { ascending: true })
      .limit(WEEKLY_TARGET_COUNT * 3);
    if (candErr) throw candErr;

    const candidates = (rawCandidates || []).filter((s) => !excludedIds.has(s.id)).slice(0, WEEKLY_TARGET_COUNT);
    if (candidates.length === 0) {
      console.log("cron weekly-maxpreps-batch: skipped -- no eligible schools (everyone missing a MaxPreps URL already has an unreviewed batch item, or priority-state coverage is complete)");
      return NextResponse.json({ skipped: true, reason: "No eligible schools -- everyone missing a MaxPreps URL in the priority states already has an unreviewed batch item pending." });
    }

    const { data: runRow, error: runErr } = await supabase
      .from("maxpreps_batch_runs")
      .insert({ status: "collecting", state_filter: PRIORITY_STATES, requested_count: candidates.length, created_by: SYSTEM_USER_ID })
      .select()
      .single();
    if (runErr) throw runErr;

    const { data: itemRows, error: itemsErr } = await supabase
      .from("maxpreps_batch_items")
      .insert(candidates.map((s) => ({ batch_run_id: runRow.id, school_id: s.id })))
      .select("id,school_id");
    if (itemsErr) throw itemsErr;

    const schoolById = new Map(candidates.map((s) => [s.id, s]));
    let fetchedReady = 0;
    let fetchedNoContent = 0;
    let fetchErrors = 0;
    let cursor = 0;

    async function fetchWorker() {
      while (true) {
        if (Date.now() - startedAt > TIME_BUDGET_MS) return;
        const i = cursor++;
        if (i >= itemRows.length) return;
        const item = itemRows[i];
        const school = schoolById.get(item.school_id);
        if (!school) continue;

        try {
          // Same query shape as the single-school "Find MaxPreps page"
          // button and the manual batch tool's fetch-item route.
          const searchQuery = `site:maxpreps.com ${school.name} ${school.city || ""} ${school.state || ""} football`;
          const rawResults = await searchWeb(searchQuery, serperKey);
          const searchResults = rawResults.filter((r) => r.link && r.link.includes("maxpreps.com"));

          if (searchResults.length === 0) {
            await supabase.from("maxpreps_batch_items").update({ fetch_status: "no_content" }).eq("id", item.id);
            fetchedNoContent++;
            continue;
          }

          const sourceText = buildMaxPrepsSourceText({ school, searchResults, searchQuery });
          await supabase.from("maxpreps_batch_items").update({ fetch_status: "ready", source_text: sourceText, source_label: "web search" }).eq("id", item.id);
          fetchedReady++;
        } catch (err) {
          console.error("cron weekly-maxpreps-batch: fetch error for school", item.school_id, err);
          await supabase.from("maxpreps_batch_items").update({ fetch_status: "error" }).eq("id", item.id);
          fetchErrors++;
        }
      }
    }

    await Promise.all(Array.from({ length: FETCH_CONCURRENCY }, () => fetchWorker()));

    // Whatever came back "ready" gets submitted, even if the time budget
    // cut the fetch loop off before every item got a turn -- a partial
    // submission this week is strictly better than none, and any items
    // left at fetch_status "pending" can still be picked up by hand later
    // from the run's page, same as if a human had walked away partway
    // through a manual run.
    const { data: readyItems, error: readyErr } = await supabase.from("maxpreps_batch_items").select("id,source_text").eq("batch_run_id", runRow.id).eq("fetch_status", "ready");
    if (readyErr) throw readyErr;

    if (!readyItems || readyItems.length === 0) {
      await supabase
        .from("maxpreps_batch_runs")
        .update({ status: "error", error_message: "No usable search results came back for any school in this run -- nothing to submit to Anthropic." })
        .eq("id", runRow.id);
      console.log("cron weekly-maxpreps-batch: run", runRow.id, "had zero ready items -- marked error");
      return NextResponse.json({
        run_id: runRow.id,
        requested: candidates.length,
        fetched_ready: 0,
        fetched_no_content: fetchedNoContent,
        fetch_errors: fetchErrors,
        submitted: false,
        reason: "No usable search results for any school in this run.",
      });
    }

    const requests = readyItems.map((item) => ({
      custom_id: `item-${item.id}`,
      params: { model: MODEL, max_tokens: MAX_TOKENS, system: SYSTEM_PROMPT, messages: [{ role: "user", content: item.source_text }] },
    }));

    const batchRes = await fetch("https://api.anthropic.com/v1/messages/batches", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": anthropicKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ requests }),
    });

    if (!batchRes.ok) {
      const detail = await batchRes.text().catch(() => "");
      console.error("cron weekly-maxpreps-batch: Anthropic Batch API submit error", batchRes.status, detail);
      await supabase
        .from("maxpreps_batch_runs")
        .update({ status: "error", error_message: `Anthropic Batch API returned HTTP ${batchRes.status} on submit.` })
        .eq("id", runRow.id);
      return NextResponse.json({ error: "Anthropic's Batch API returned an error submitting this run.", run_id: runRow.id }, { status: 502 });
    }

    const batchJson = await batchRes.json();
    await supabase
      .from("maxpreps_batch_runs")
      .update({
        status: "submitted",
        anthropic_batch_id: batchJson.id,
        anthropic_batch_status: batchJson.processing_status || "in_progress",
        fetched_count: readyItems.length,
        submitted_at: new Date().toISOString(),
      })
      .eq("id", runRow.id);

    const result = {
      run_id: runRow.id,
      requested: candidates.length,
      fetched_ready: fetchedReady,
      fetched_no_content: fetchedNoContent,
      fetch_errors: fetchErrors,
      stopped_early: cursor < itemRows.length,
      submitted: true,
      submitted_count: readyItems.length,
      anthropic_batch_id: batchJson.id,
      duration_ms: Date.now() - startedAt,
    };
    console.log("cron weekly-maxpreps-batch:", JSON.stringify(result));
    return NextResponse.json(result);
  } catch (err) {
    console.error("cron weekly-maxpreps-batch error", err);
    return NextResponse.json({ error: err.message || "Weekly MaxPreps batch run failed." }, { status: 500 });
  }
}
