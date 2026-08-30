import { NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { searchWeb } from "@/lib/coachInfoLookup";
import { EXCLUDED_HOSTS, buildAthleticsSourceText, SYSTEM_PROMPT, MODEL, MAX_TOKENS } from "@/lib/athleticsLookup";

export const maxDuration = 60;

// Weekly automated kickoff for Batch Athletics-URL Discovery -- the
// automation half of turning "run this when I remember to" into "this
// already happened, just come review it." Athletics URL is the single
// biggest data-coverage gap in the whole database (13,000+ schools missing
// one, versus ~1,200 for coach info -- see the full-sweep-roadmap doc), and
// the batch tool at /admin/batch-athletics already works, it just requires
// a human to click Start Run, then Fetch Source Text, then Submit -- three
// separate steps that are easy to let slide on a busy week.
//
// This does exactly those first three stages on its own, every Monday
// morning (see vercel.json): pick a batch of schools still missing an
// athletics URL, run one Serper search per school (same query the manual
// tool uses), and submit whatever comes back usable to Anthropic's Batch
// API. By the time anyone opens /admin/batch-athletics later in the week,
// the run is already sitting at "submitted" or "ready to collect" -- all
// that's left is the part that should stay a human's call: clicking
// Collect Results and reviewing/applying suggestions. Nothing here ever
// writes to the schools table itself -- same non-authoritative contract as
// every other discovery tool in this app.
//
// Same CRON_SECRET Bearer-header auth (plus ?secret= for a browser smoke
// test) as every other cron route in this app, and the same
// system_settings kill-switch pattern as recheck-schools/coach-news-check
// (key: weekly_athletics_batch_enabled) so this can be paused without a
// code change or redeploy if it ever needs to be.
const PRIORITY_STATES = ["TX", "FL", "GA", "CA", "OH", "IN"];
const WEEKLY_TARGET_COUNT = 300; // matches the manual tool's own default run size
const FETCH_CONCURRENCY = 8; // no live user waiting on this one, so this can push harder than the manual UI's 3 -- matches recheck-schools' own concurrency
const TIME_BUDGET_MS = 45_000; // leaves headroom under maxDuration=60 for the Anthropic Batch submit call after the fetch loop

const SYSTEM_USER_ID = "d24ad753-f759-479d-8958-fae8f995faa1"; // CSD sysadmin account (Larry) -- same attribution recheck-schools uses for automated writes

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
      { error: "Weekly athletics batch isn't fully configured -- SERPER_API_KEY and/or ANTHROPIC_API_KEY missing from the server environment." },
      { status: 500 }
    );
  }

  const startedAt = Date.now();
  const supabase = getSupabaseAdminClient();

  try {
    const { data: setting } = await supabase.from("system_settings").select("value").eq("key", "weekly_athletics_batch_enabled").maybeSingle();
    if (setting && setting.value === false) {
      console.log("cron weekly-athletics-batch: skipped -- weekly_athletics_batch_enabled is false in system_settings");
      return NextResponse.json({ skipped: true, reason: "Weekly Athletics-URL batch is currently suspended (system_settings.weekly_athletics_batch_enabled = false)." });
    }

    // Schools already sitting in an unresolved batch item (fetched or not,
    // but not yet reviewed) from a previous run shouldn't be queued again --
    // avoids paying for a second Serper/AI look at a school nobody's gotten
    // to reviewing yet. Over-fetch the candidate pool since this filter
    // happens client-side, then trim to the target count.
    const { data: pendingItemRows, error: pendingErr } = await supabase.from("athletics_batch_items").select("school_id").eq("review_status", "pending");
    if (pendingErr) throw pendingErr;
    const excludedIds = new Set((pendingItemRows || []).map((r) => r.school_id));

    const { data: rawCandidates, error: candErr } = await supabase
      .from("schools")
      .select("id,name,city,state")
      .or("athletics_url.is.null,athletics_url.eq.")
      .in("state", PRIORITY_STATES)
      .order("id", { ascending: true })
      .limit(WEEKLY_TARGET_COUNT * 3);
    if (candErr) throw candErr;

    const candidates = (rawCandidates || []).filter((s) => !excludedIds.has(s.id)).slice(0, WEEKLY_TARGET_COUNT);
    if (candidates.length === 0) {
      console.log("cron weekly-athletics-batch: skipped -- no eligible schools (everyone missing an athletics URL already has an unreviewed batch item, or priority-state coverage is complete)");
      return NextResponse.json({ skipped: true, reason: "No eligible schools -- everyone missing an athletics URL in the priority states already has an unreviewed batch item pending." });
    }

    const { data: runRow, error: runErr } = await supabase
      .from("athletics_batch_runs")
      .insert({ status: "collecting", state_filter: PRIORITY_STATES, requested_count: candidates.length, created_by: SYSTEM_USER_ID })
      .select()
      .single();
    if (runErr) throw runErr;

    const { data: itemRows, error: itemsErr } = await supabase
      .from("athletics_batch_items")
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
          // Same query shape as the single-school "Find athletics page"
          // button and the manual batch tool's fetch-item route.
          const searchQuery = `${school.name} ${school.city || ""} ${school.state || ""} athletics department football`;
          const rawResults = await searchWeb(searchQuery, serperKey);
          const searchResults = rawResults.filter((r) => !EXCLUDED_HOSTS.some((host) => r.link.includes(host)));

          if (searchResults.length === 0) {
            await supabase.from("athletics_batch_items").update({ fetch_status: "no_content" }).eq("id", item.id);
            fetchedNoContent++;
            continue;
          }

          const sourceText = buildAthleticsSourceText({ school, searchResults, searchQuery });
          await supabase.from("athletics_batch_items").update({ fetch_status: "ready", source_text: sourceText, source_label: "web search" }).eq("id", item.id);
          fetchedReady++;
        } catch (err) {
          console.error("cron weekly-athletics-batch: fetch error for school", item.school_id, err);
          await supabase.from("athletics_batch_items").update({ fetch_status: "error" }).eq("id", item.id);
          fetchErrors++;
        }
      }
    }

    await Promise.all(Array.from({ length: FETCH_CONCURRENCY }, () => fetchWorker()));

    // Whatever came back "ready" gets submitted, even if the time budget
    // cut the fetch loop off before every item got a turn -- a partial
    // submission this week is strictly better than none, and any items
    // left at fetch_status "pending" can still be picked up by hand later
    // from the run's page (its Fetch Source Text button only re-fetches
    // items still marked "pending"), same as if a human had walked away
    // partway through a manual run.
    const { data: readyItems, error: readyErr } = await supabase.from("athletics_batch_items").select("id,source_text").eq("batch_run_id", runRow.id).eq("fetch_status", "ready");
    if (readyErr) throw readyErr;

    if (!readyItems || readyItems.length === 0) {
      await supabase
        .from("athletics_batch_runs")
        .update({ status: "error", error_message: "No usable search results came back for any school in this run -- nothing to submit to Anthropic." })
        .eq("id", runRow.id);
      console.log("cron weekly-athletics-batch: run", runRow.id, "had zero ready items -- marked error");
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
      console.error("cron weekly-athletics-batch: Anthropic Batch API submit error", batchRes.status, detail);
      await supabase
        .from("athletics_batch_runs")
        .update({ status: "error", error_message: `Anthropic Batch API returned HTTP ${batchRes.status} on submit.` })
        .eq("id", runRow.id);
      return NextResponse.json({ error: "Anthropic's Batch API returned an error submitting this run.", run_id: runRow.id }, { status: 502 });
    }

    const batchJson = await batchRes.json();
    await supabase
      .from("athletics_batch_runs")
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
    console.log("cron weekly-athletics-batch:", JSON.stringify(result));
    return NextResponse.json(result);
  } catch (err) {
    console.error("cron weekly-athletics-batch error", err);
    return NextResponse.json({ error: err.message || "Weekly athletics batch run failed." }, { status: 500 });
  }
}
