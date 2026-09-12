import { NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { withProtocol } from "@/lib/schoolRecheck";
import { fetchPageText, searchWebWithGraph, findDirectoryPage, buildSourceBlocks, buildSearchQuery, SYSTEM_PROMPT, MODEL } from "@/lib/coachInfoLookup";

export const maxDuration = 60;
const MAX_TOKENS = 400; // matches app/api/admin/batch-coach-info/[runId]/submit's own constant

// Weekly automated kickoff for Batch Coach-Info Discovery -- the fourth and
// last of the four discovery tools to get this treatment (Athletics,
// MaxPreps, and Social Media already run this way; see
// weekly-athletics-batch/weekly-maxpreps-batch/weekly-social-batch). Same
// idea: the manual tool at /admin/batch-coach-info already works end to
// end, it just requires a human to click Start Run, then Fetch Source
// Text, then Submit -- three steps that are easy to let slide. This does
// those first three stages on its own every Monday morning (see
// vercel.json), so by the time anyone opens the review page later in the
// week, the run is already sitting at "submitted" -- all that's left is
// the human part: reviewing and applying suggestions.
//
// Coach-info's prep stage is richer than the other three (see
// app/api/admin/batch-coach-info/fetch-item, which this mirrors exactly):
// it fetches the school's own athletics/website page text AND runs a web
// search, rather than just a single search. That's slower per-school than
// the search-only prep the other three tools use, which is exactly why
// this one benefits the most from not needing a human to sit and watch
// it happen.
//
// Targets "missing_email" candidates (a coach name already on file, no
// email) rather than "no_name" -- checked against live data on
// 2026-09-02: the "no coach name at all" gap this tool originally
// targeted is essentially closed everywhere, priority states and beyond,
// while missing email is the real remaining gap. Same query condition the
// manual tool's own "missing_email" mode uses
// (app/(app)/admin/batch-coach-info/page.js) -- both name fields present,
// email blank -- and, matching that mode, doesn't require an
// athletics/website URL: the name-targeted search buildSearchQuery()
// builds once a coach name is already known is usually enough on its
// own, and requiring a URL here would needlessly shrink an already-small
// candidate pool.
//
// Runs against every state, not scoped to the priority recruiting ones
// (TX/FL/GA/CA/OH/IN) the way the other three weekly-*-batch crons still
// are. Checked against live data on 2026-09-10: inside those six states
// this gap is already closed (4,141 of 4,147 schools have a full name
// and email on file, only 6 short), so keeping this cron fenced to them
// would leave it with essentially nothing left to do most weeks. The
// remaining ~741 missing-email schools are the exact same shape of gap,
// just spread across every other state -- opening this cron up lets it
// keep draining that backlog a few hundred schools a week on its own,
// instead of someone having to remember to run the manual "All states"
// mode by hand. state_filter is left null on the inserted run row for
// the same reason the manual tool's own "All states" mode does -- see
// app/(app)/admin/batch-coach-info/page.js.
//
// Same CRON_SECRET auth and system_settings kill-switch pattern (key:
// weekly_coach_info_batch_enabled) as every other cron route in this app.
const WEEKLY_TARGET_COUNT = 300; // matches the manual tool's own default run size
const FETCH_CONCURRENCY = 8; // no live user waiting on this one -- matches the other three weekly-*-batch crons' own concurrency
const TIME_BUDGET_MS = 45_000; // leaves headroom under maxDuration=60 for the Anthropic Batch submit call after the fetch loop

const SYSTEM_USER_ID = "d24ad753-f759-479d-8958-fae8f995faa1"; // CSD sysadmin account (Larry) -- same attribution every other cron uses for automated writes

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
      { error: "Weekly coach-info batch isn't fully configured -- SERPER_API_KEY and/or ANTHROPIC_API_KEY missing from the server environment." },
      { status: 500 }
    );
  }

  const startedAt = Date.now();
  const supabase = getSupabaseAdminClient();

  try {
    const { data: setting } = await supabase.from("system_settings").select("value").eq("key", "weekly_coach_info_batch_enabled").maybeSingle();
    if (setting && setting.value === false) {
      console.log("cron weekly-coach-info-batch: skipped -- weekly_coach_info_batch_enabled is false in system_settings");
      return NextResponse.json({ skipped: true, reason: "Weekly Coach-Info batch is currently suspended (system_settings.weekly_coach_info_batch_enabled = false)." });
    }

    // Excludes every school that's EVER gone through this tool -- applied,
    // skipped, or a suggestion that errored out -- not just the ones
    // currently sitting in an unresolved run. Before this it was possible
    // for a school you'd already applied or skipped last week to come right
    // back in this week's run with nothing new to say, since only "pending"
    // items were held back. Once a school shows up here at all, it's done
    // with this tool going forward; the single-school "Suggest Coach Info
    // (AI)" button on that school's own profile page still works any time
    // someone wants to force a fresh look at one.
    const { data: touchedRows, error: touchedErr } = await supabase.from("coach_info_batch_items").select("school_id");
    if (touchedErr) throw touchedErr;
    const excludedIds = new Set((touchedRows || []).map((r) => r.school_id));

    const { data: rawCandidates, error: candErr } = await supabase
      .from("schools")
      .select("id,name,city,state,athletics_url,website,hc_first_name,hc_last_name,hc_email,hc_cell,hc_office,hc_twitter,hc_facebook,ad_name,ad_email")
      .not("hc_first_name", "is", null)
      .neq("hc_first_name", "")
      .not("hc_last_name", "is", null)
      .neq("hc_last_name", "")
      .or("hc_email.is.null,hc_email.eq.")
      // Closed/discontinued schools will never have a real coach to find
      // -- see lib/dataQuality.js.
      .eq("is_closed", false)
      .order("id", { ascending: true })
      .limit(WEEKLY_TARGET_COUNT * 3);
    if (candErr) throw candErr;

    const candidates = (rawCandidates || []).filter((s) => !excludedIds.has(s.id)).slice(0, WEEKLY_TARGET_COUNT);
    if (candidates.length === 0) {
      console.log("cron weekly-coach-info-batch: skipped -- no eligible schools (everyone with a coach name on file already has an email, or has already been through this tool before)");
      return NextResponse.json({ skipped: true, reason: "No eligible schools -- everyone with a coach name on file already has an email, or has already been through this tool before." });
    }

    const { data: runRow, error: runErr } = await supabase
      .from("coach_info_batch_runs")
      .insert({ status: "collecting", state_filter: null, requested_count: candidates.length, created_by: SYSTEM_USER_ID, candidate_mode: "missing_email" })
      .select()
      .single();
    if (runErr) throw runErr;

    const { data: itemRows, error: itemsErr } = await supabase
      .from("coach_info_batch_items")
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
          const athleticsUrl = withProtocol(school.athletics_url);
          const websiteUrl = withProtocol(school.website);
          // This cron always targets "missing_email" candidates (see the
          // file header comment) -- the one mode with an independent reason
          // to already trust the on-file name, so it keeps the
          // name-anchored search. See buildSearchQuery's own comment in
          // lib/coachInfoLookup.js for why every other caller defaults to
          // the open query instead.
          const searchQuery = buildSearchQuery(school, { contactOnly: true });

          const [athleticsFetch, websiteFetch, primarySearch, directoryResult] = await Promise.all([
            athleticsUrl ? fetchPageText(athleticsUrl) : Promise.resolve(null),
            websiteUrl ? fetchPageText(websiteUrl) : Promise.resolve(null),
            // searchWebWithGraph makes the exact same Serper call searchWeb
            // always did -- it just also keeps the knowledgeGraph/answerBox
            // fields Serper already returns alongside the organic results,
            // instead of throwing them away. See that function's own
            // comment in lib/coachInfoLookup.js.
            searchWebWithGraph(searchQuery, serperKey),
            // Second, more targeted search for the school's own staff/faculty
            // directory page -- see findDirectoryPage's own comment for why
            // this exists alongside the primary search above.
            findDirectoryPage({ school, serperKey }),
          ]);

          const { hasUsableContent, userMessage, defaultSource } = buildSourceBlocks({
            school,
            athleticsFetch,
            websiteFetch,
            searchResults: primarySearch.organic,
            searchQuery,
            directoryPage: directoryResult.page,
            directorySearchResults: directoryResult.results,
            knowledgeGraph: primarySearch.knowledgeGraph,
            answerBox: primarySearch.answerBox,
          });

          if (!hasUsableContent) {
            await supabase.from("coach_info_batch_items").update({ fetch_status: "no_content" }).eq("id", item.id);
            fetchedNoContent++;
            continue;
          }

          await supabase.from("coach_info_batch_items").update({ fetch_status: "ready", source_text: userMessage, source_label: defaultSource }).eq("id", item.id);
          fetchedReady++;
        } catch (err) {
          console.error("cron weekly-coach-info-batch: fetch error for school", item.school_id, err);
          await supabase.from("coach_info_batch_items").update({ fetch_status: "error" }).eq("id", item.id);
          fetchErrors++;
        }
      }
    }

    await Promise.all(Array.from({ length: FETCH_CONCURRENCY }, () => fetchWorker()));

    // Same "submit whatever's ready, even if the time budget cut the fetch
    // loop short" approach the other three weekly crons take -- a partial
    // submission this week beats none, and anything left "pending" can
    // still be picked up by hand later from the run's own page.
    const { data: readyItems, error: readyErr } = await supabase.from("coach_info_batch_items").select("id,source_text").eq("batch_run_id", runRow.id).eq("fetch_status", "ready");
    if (readyErr) throw readyErr;

    if (!readyItems || readyItems.length === 0) {
      await supabase
        .from("coach_info_batch_runs")
        .update({ status: "error", error_message: "No usable source text came back for any school in this run -- nothing to submit to Anthropic." })
        .eq("id", runRow.id);
      console.log("cron weekly-coach-info-batch: run", runRow.id, "had zero ready items -- marked error");
      return NextResponse.json({
        run_id: runRow.id,
        requested: candidates.length,
        fetched_ready: 0,
        fetched_no_content: fetchedNoContent,
        fetch_errors: fetchErrors,
        submitted: false,
        reason: "No usable source text for any school in this run.",
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
      console.error("cron weekly-coach-info-batch: Anthropic Batch API submit error", batchRes.status, detail);
      await supabase
        .from("coach_info_batch_runs")
        .update({ status: "error", error_message: `Anthropic Batch API returned HTTP ${batchRes.status} on submit.` })
        .eq("id", runRow.id);
      return NextResponse.json({ error: "Anthropic's Batch API returned an error submitting this run.", run_id: runRow.id }, { status: 502 });
    }

    const batchJson = await batchRes.json();
    await supabase
      .from("coach_info_batch_runs")
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
    console.log("cron weekly-coach-info-batch:", JSON.stringify(result));
    return NextResponse.json(result);
  } catch (err) {
    console.error("cron weekly-coach-info-batch error", err);
    return NextResponse.json({ error: err.message || "Weekly coach-info batch run failed." }, { status: 500 });
  }
}
