import { NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { parseModelJson, normalizeSuggestion, autoApplyHighConfidenceSuggestion, autoConfirmNoDataAvailable, runWithConcurrency, findDuplicateNameSchoolsForMany } from "@/lib/coachInfoLookup";
import { normalizeAthleticsSuggestion } from "@/lib/athleticsLookup";
import { normalizeMaxPrepsSuggestion } from "@/lib/maxPrepsLookup";
import { normalizeSocialSuggestion } from "@/lib/socialLookup";

export const maxDuration = 60;

// How many result lines a single run's collect step processes at once
// instead of one at a time -- see runWithConcurrency's own comment in
// lib/coachInfoLookup.js. This cron only has a 60-second budget total
// (TIME_BUDGET_MS below stops it from STARTING a new run once that's spent,
// but a run already in progress here still has to finish item-by-item) --
// on a run with a lot of items, the old sequential loop could all by itself
// run past the 60s ceiling and get killed mid-run, same failure mode as the
// manual "Collect Results" click on an oversized Athletics/MaxPreps/
// Coach-Info run.
const COLLECT_CONCURRENCY = 8;

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
//
// Also runs a pool-depletion check every time this cron fires (see the
// end of the GET handler below) -- separate from the collect loop above,
// it looks at how many eligible, never-touched schools are left for each
// tool in the priority states and emails Larry once a tool's pool first
// drops below one more week's worth. Built alongside the new
// /admin/batch-status dashboard (same underlying batch_tool_pool_status()
// Postgres function powers both) in response to Larry asking for a
// pool-depletion alert so a tool running dry doesn't go unnoticed.
//
// And a duplicate-touch canary right after that -- a second, independent
// check (batch_duplicate_touch_status(), also shared with /admin/batch-
// status) that emails Larry if any tool's count of schools touched more
// than once GROWS past the baseline recorded when the Sept 24 2026
// row-cap exclusion bug was fixed (see
// claude/batch-exclusion-row-cap-bug-fix.md). That fix should make new
// duplicates permanently impossible going forward -- this is the trip
// wire that catches it if the exclusion logic ever breaks again in some
// new way, instead of it going unnoticed for weeks the way the original
// bug did.
const TIME_BUDGET_MS = 50_000;

const SYSTEM_USER_ID = "d24ad753-f759-479d-8958-fae8f995faa1"; // CSD sysadmin account (Larry) -- same attribution every other cron uses for automated writes

// Matches WEEKLY_TARGET_COUNT on every weekly-*-batch cron -- "fewer than
// one more week's worth of eligible schools left" is the bar for the
// pool-depletion alert below.
const POOL_ALERT_THRESHOLD = 300;
// Same FROM_EMAIL/SITE_URL fallback pattern as coach-alert-digest and
// verifier-digest -- see the comment on FROM_EMAIL in
// app/api/cron/coach-alert-digest/route.js for the Resend sandbox note.
const ALERT_FROM_EMAIL = process.env.ALERT_FROM_EMAIL || "CSD CoachConnect Alerts <onboarding@resend.dev>";
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://coachconnect.vercel.app";
// One system_settings row per tool records whether that tool's alert has
// already fired for its CURRENT low spell -- stops the same alert from
// re-sending every single day while a pool stays low. Cleared back to
// false once the pool recovers above POOL_ALERT_THRESHOLD, so a later
// dip alerts again.
const poolAlertSettingKey = (toolKey) => `batch_pool_alert_sent__${toolKey}`;

// Same "don't re-send every day" pattern as poolAlertSettingKey above, for
// the duplicate-touch canary below -- one system_settings row per tool
// records whether Larry's already been alerted for the CURRENT spell of
// new duplicates, and batch_duplicate_baseline__<tool> holds the
// known-duplicate count from the moment the row-cap exclusion fix shipped
// (Sept 24 2026 -- see claude/batch-exclusion-row-cap-bug-fix.md). The
// baseline is deliberately never reset back down after an alert -- once a
// tool's count is confirmed to have grown past it, that's the new floor
// this canary watches from.
const duplicateAlertSettingKey = (toolKey) => `batch_duplicate_alert_sent__${toolKey}`;
const duplicateBaselineSettingKey = (toolKey) => `batch_duplicate_baseline__${toolKey}`;

// One entry per batch discovery tool -- everything that differs between
// them (table names, how a parsed suggestion gets normalized) lives here;
// the loop below is otherwise identical for all four, mirroring each
// tool's own [runId]/check-status + [runId]/collect routes exactly.
// label/criteria/href are only used by the pool-depletion alert email
// below (the collect loop above never touches them).
// notAvailableField/confirmFields/autoConfirmSource are only set on the
// three tools that HAVE a *_not_available escape hatch in
// hasFullCoachRecord() (lib/dataQuality.js) -- Coach-Info doesn't, so it's
// left off autoConfirmNoDataAvailable entirely (see that function's own
// comment in lib/coachInfoLookup.js for why). confirmFields matches each
// tool's own confirmNoDataAvailableCore exactly, so the school_change_log
// trail this leaves behind reads the same whether a human clicked the
// button or this cron did.
const TOOLS = [
  {
    key: "athletics",
    runsTable: "athletics_batch_runs",
    itemsTable: "athletics_batch_items",
    buildSuggestion: (parsed) => normalizeAthleticsSuggestion(parsed),
    notAvailableField: "athletics_not_available",
    confirmFields: ["athletics_url"],
    autoConfirmSource: "Batch Athletics auto-collect -- confirmed no data available (unattended)",
    label: "Athletics-URL",
    criteria: "Missing an athletics-site URL",
    href: "/admin/batch-athletics",
  },
  {
    key: "coach_info",
    runsTable: "coach_info_batch_runs",
    itemsTable: "coach_info_batch_items",
    // `location` (school city/state) is only ever supplied for coach_info
    // (see the schoolLocationByItemId fetch below) -- normalizeSuggestion
    // uses it for the same-name-school confidence backstop; the other three
    // tools' normalize* functions below simply don't declare a second
    // parameter, so passing one is harmless.
    buildSuggestion: (parsed, location) => normalizeSuggestion(parsed, "batch AI lookup", location),
    autoApplyHighConfidence: true,
    label: "Coach-Info",
    criteria: "Coach name on file, missing email",
    href: "/admin/batch-coach-info",
  },
  {
    key: "maxpreps",
    runsTable: "maxpreps_batch_runs",
    itemsTable: "maxpreps_batch_items",
    buildSuggestion: (parsed) => normalizeMaxPrepsSuggestion(parsed),
    notAvailableField: "maxpreps_not_available",
    confirmFields: ["maxpreps_url"],
    autoConfirmSource: "Batch MaxPreps auto-collect -- confirmed no data available (unattended)",
    label: "MaxPreps",
    criteria: "Missing a MaxPreps page URL",
    href: "/admin/batch-maxpreps",
  },
  {
    key: "social",
    runsTable: "social_batch_runs",
    itemsTable: "social_batch_items",
    buildSuggestion: (parsed) => normalizeSocialSuggestion(parsed),
    notAvailableField: "social_not_available",
    confirmFields: ["hc_twitter", "hc_facebook"],
    autoConfirmSource: "Batch Social auto-collect -- confirmed no data available (unattended)",
    label: "Social Media",
    criteria: "Coach name on file, missing Twitter/X or Facebook",
    href: "/admin/batch-social",
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
      // candidate_mode is only meaningful for coach_info (see the
      // bounce_recovery carve-out below), but harmless to select for every
      // tool -- the other three runsTables don't have the column at all
      // reachable here since this select only ever touches coach_info's
      // own runsTable for that check.
      const { data: runs, error: runsErr } = await supabase
        .from(tool.runsTable)
        .select(tool.key === "coach_info" ? "id,status,anthropic_batch_id,submitted_at,candidate_mode" : "id,status,anthropic_batch_id,submitted_at")
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

        // coach_info auto-applies, athletics/maxpreps/social auto-confirm
        // "no data" -- both need a school_id per item, since a result line
        // itself only carries the item id. One query for the whole run
        // instead of one per item. Also embeds each item's school
        // name/city/state (via the school_id -> schools FK) for coach_info
        // specifically -- normalizeSuggestion's same-name-school confidence
        // backstops need it, and coach_info's is the one collect path that
        // writes a specific value to the schools table with zero human
        // review, so it's the most important place for those backstops to
        // actually run.
        let schoolIdByItemId = null;
        let schoolLocationByItemId = null;
        if (tool.autoApplyHighConfidence || tool.notAvailableField) {
          const selectCols = tool.key === "coach_info" ? "id,school_id,school:schools(name,city,state)" : "id,school_id";
          const { data: itemRows } = await supabase.from(tool.itemsTable).select(selectCols).eq("batch_run_id", run.id);
          schoolIdByItemId = new Map((itemRows || []).map((r) => [r.id, r.school_id]));
          if (tool.key === "coach_info") {
            // hasKnownDuplicates per school -- one query for the whole run
            // (see findDuplicateNameSchoolsForMany's own comment), same
            // pattern as the manual collect route. This is the unattended
            // auto-apply path, so it's the single most important place for
            // this backstop to actually catch something before it writes
            // to the schools table with nobody watching.
            const duplicateMap = await findDuplicateNameSchoolsForMany({
              supabase,
              schools: (itemRows || []).map((r) => ({ id: r.school_id, name: r.school?.name })),
            });
            schoolLocationByItemId = new Map(
              (itemRows || []).map((r) => [r.id, { ...(r.school || {}), hasKnownDuplicates: duplicateMap.get(r.school_id) || false }])
            );
          }
        }

        // Same update-only approach (never upsert) as every manual collect
        // route -- each line updates an EXISTING item row created back at
        // Submit time, and upsert would trip NOT NULL constraints on
        // columns (batch_run_id, school_id) this loop never sees.
        const resultLines = resultsText.split("\n").map((l) => l.trim()).filter(Boolean);
        let succeeded = 0;
        let failed = 0;
        let autoApplied = 0;
        let autoApplyErrors = 0;
        let autoApplyHeld = 0;
        let autoConfirmed = 0;
        let autoConfirmErrors = 0;

        // Processed COLLECT_CONCURRENCY-at-a-time rather than one line at a
        // time -- see COLLECT_CONCURRENCY's comment above. The counters
        // below are plain-number increments, safe to share across
        // concurrent workers here since JavaScript never runs two of these
        // callbacks' synchronous stretches at the same instant.
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
              patch = { suggestion: tool.buildSuggestion(parsed, schoolLocationByItemId?.get(itemId)), suggestion_error: null };
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

          // bounce_recovery runs are the one coach_info carve-out: they're
          // overwriting an email that was often recently marked "verified"
          // (that's the whole reason it's worth flagging -- see the
          // bounce-recovery feature's project doc), not just filling a
          // blank field the way every other coach_info run's high-confidence
          // auto-apply assumes. Larry chose "always manual review" for this
          // candidate_mode specifically, so it skips auto-apply here even
          // though tool.autoApplyHighConfidence is true for coach_info as a
          // whole -- every suggestion from a bounce_recovery run still lands
          // in the review queue for a human Apply click, same as
          // medium/low-confidence suggestions from any other run.
          if (!itemErr && tool.autoApplyHighConfidence && run.candidate_mode !== "bounce_recovery" && patch.suggestion?.confidence === "high") {
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
              else if (applyResult.held) {
                // Not an error -- autoApplyHighConfidenceSuggestion itself
                // decided this suggestion would overwrite an existing
                // coach name/email with a different value and held it back
                // for a human instead (see OVERWRITE_GATED_FIELDS in
                // lib/coachInfoLookup.js). The item stays "pending" and
                // surfaces on the review page same as any other suggestion.
                autoApplyHeld++;
              } else {
                autoApplyErrors++;
                console.error(`cron collect-batch-runs: auto-apply error for ${tool.key} run ${run.id} item ${itemId}`, applyResult.error);
              }
            }
          }

          // "Nothing usable" -- either the AI explicitly said confidence
          // "none", or this item never got a suggestion at all (a parse
          // failure or an outright API-level error on this request, both of
          // which land here with suggestion: null). Same bucket each
          // tool's own noDataItems covers on the review page (see that
          // page's own comment on noMatchItems/failedItems). Only ever
          // records an absence, never a specific value, so unlike the
          // auto-apply branch above this is safe to do without a human
          // reviewing each one -- see autoConfirmNoDataAvailable's own
          // comment in lib/coachInfoLookup.js.
          if (!itemErr && tool.notAvailableField && (patch.suggestion === null || patch.suggestion?.confidence === "none")) {
            const schoolId = schoolIdByItemId?.get(itemId);
            if (schoolId) {
              const confirmResult = await autoConfirmNoDataAvailable({
                supabase,
                itemId,
                itemsTable: tool.itemsTable,
                schoolId,
                notAvailableField: tool.notAvailableField,
                confirmFields: tool.confirmFields,
                source: tool.autoConfirmSource,
                actorUserId: SYSTEM_USER_ID,
              });
              if (confirmResult.applied) autoConfirmed++;
              else {
                autoConfirmErrors++;
                console.error(`cron collect-batch-runs: auto-confirm error for ${tool.key} run ${run.id} item ${itemId}`, confirmResult.error);
              }
            }
          }
        });

        await supabase.from(tool.runsTable).update({ status: "collected", collected_at: new Date().toISOString(), anthropic_batch_status: processingStatus }).eq("id", run.id);
        summary.push({
          tool: tool.key,
          run_id: run.id,
          collected: true,
          succeeded,
          failed,
          auto_applied: autoApplied,
          auto_apply_held: autoApplyHeld,
          auto_apply_errors: autoApplyErrors,
          auto_confirmed_no_data: autoConfirmed,
          auto_confirm_errors: autoConfirmErrors,
        });
        console.log(
          `cron collect-batch-runs: collected ${tool.key} run ${run.id} -- ${succeeded} succeeded, ${failed} failed` +
            (tool.notAvailableField ? `, ${autoConfirmed} auto-confirmed no-data, ${autoConfirmErrors} auto-confirm errors` : "") +
            (tool.autoApplyHighConfidence ? `, ${autoApplied} auto-applied, ${autoApplyHeld} held for review (would overwrite existing name/email), ${autoApplyErrors} auto-apply errors` : "")
        );
      }
    }

    // --- Pool-depletion check ---------------------------------------
    // Runs every time this cron fires, independent of whatever the collect
    // loop above did (or didn't) find -- checks batch_tool_pool_status()
    // (a Postgres function; same one the /admin/batch-status dashboard
    // reads) for how many never-touched, criteria-matching schools are
    // left for each tool in the priority states, and emails Larry the
    // first time a tool drops below POOL_ALERT_THRESHOLD. Wrapped in its
    // own try/catch so a problem here (bad RPC, Resend hiccup, etc.) never
    // costs the collect-loop summary above -- worst case this section
    // fails silently into the logs and next run tries again.
    let poolAlert = null;
    try {
      const { data: poolRows, error: poolErr } = await supabase.rpc("batch_tool_pool_status");
      if (poolErr) throw poolErr;
      const poolByKey = new Map((poolRows || []).map((r) => [r.tool_key, r]));

      const { data: flagRows, error: flagErr } = await supabase
        .from("system_settings")
        .select("key,value")
        .in("key", TOOLS.map((t) => poolAlertSettingKey(t.key)));
      if (flagErr) throw flagErr;
      const flagByKey = new Map((flagRows || []).map((r) => [r.key, r.value === true]));

      const newlyLow = [];
      const recovered = [];
      for (const tool of TOOLS) {
        const pool = poolByKey.get(tool.key);
        if (!pool) continue;
        const remaining = Number(pool.remaining_pool);
        const settingKey = poolAlertSettingKey(tool.key);
        const alreadyFlagged = flagByKey.get(settingKey) || false;
        if (remaining < POOL_ALERT_THRESHOLD && !alreadyFlagged) {
          newlyLow.push({ ...tool, remaining });
        } else if (remaining >= POOL_ALERT_THRESHOLD && alreadyFlagged) {
          recovered.push(settingKey);
        }
      }

      for (const settingKey of recovered) {
        await supabase.from("system_settings").upsert({ key: settingKey, value: false, updated_at: new Date().toISOString() }, { onConflict: "key" });
      }

      if (newlyLow.length > 0) {
        const resendKey = process.env.RESEND_API_KEY;
        if (!resendKey) {
          console.warn(
            "cron collect-batch-runs: pool-depletion alert triggered but RESEND_API_KEY is not set -- skipping email:",
            newlyLow.map((t) => t.key).join(", ")
          );
          poolAlert = { triggered: newlyLow.map((t) => t.key), emailed: false, reason: "RESEND_API_KEY not set" };
        } else {
          const { data: recipientProfiles } = await supabase.from("profiles").select("id").in("role", ["sysadmin", "verifier"]);
          const emails = [];
          for (const p of recipientProfiles || []) {
            const { data: userRes } = await supabase.auth.admin.getUserById(p.id);
            if (userRes?.user?.email) emails.push(userRes.user.email);
          }

          if (emails.length === 0) {
            poolAlert = { triggered: newlyLow.map((t) => t.key), emailed: false, reason: "No sysadmin/verifier email addresses found" };
          } else {
            const rowsHtml = newlyLow
              .map(
                (t) => `<tr>
                <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;">${t.label}</td>
                <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;text-align:right;font-weight:700;color:${
                  t.remaining === 0 ? "#b3261e" : "#8a6100"
                };">${t.remaining}</td>
                <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;color:#697386;">${t.criteria}</td>
              </tr>`
              )
              .join("");
            const subject = `Batch Discovery: ${newlyLow.length} tool${newlyLow.length === 1 ? "" : "s"} running low on eligible schools`;
            const html = `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;max-width:640px;margin:0 auto;color:#1a1a1a;">
              <h2 style="margin-bottom:4px;">Batch discovery pool running low</h2>
              <p style="color:#697386;margin-top:0;">
                ${newlyLow.length} of the four AI discovery tools ${newlyLow.length === 1 ? "has" : "have"} fewer than ${POOL_ALERT_THRESHOLD} eligible
                schools left to work with in the priority states (TX, FL, GA, CA, OH, IN). Their weekly automated runs will keep coming back with
                nothing new until this is addressed -- typically by adding more states or widening the search criteria.
              </p>
              <table style="width:100%;border-collapse:collapse;font-size:14px;">
                <thead>
                  <tr style="text-align:left;color:#697386;font-size:12px;text-transform:uppercase;">
                    <th style="padding:8px 12px;border-bottom:2px solid #e5e7eb;">Tool</th>
                    <th style="padding:8px 12px;border-bottom:2px solid #e5e7eb;text-align:right;">Remaining</th>
                    <th style="padding:8px 12px;border-bottom:2px solid #e5e7eb;">Criteria</th>
                  </tr>
                </thead>
                <tbody>${rowsHtml}</tbody>
              </table>
              <p style="margin-top:24px;">
                <a href="${SITE_URL}/admin/batch-status" style="background:#1a1a2e;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;display:inline-block;">
                  Open Batch Discovery Status
                </a>
              </p>
              <p style="color:#9ca3af;font-size:12px;margin-top:32px;">CSD CoachConnect — Collegiate Sports Data. You'll only get this once per tool until its pool recovers and drops low again.</p>
            </div>`;

            const sendRes = await fetch("https://api.resend.com/emails", {
              method: "POST",
              headers: { "content-type": "application/json", authorization: `Bearer ${resendKey}` },
              body: JSON.stringify({ from: ALERT_FROM_EMAIL, to: emails, subject, html }),
            });

            if (sendRes.ok) {
              for (const t of newlyLow) {
                await supabase
                  .from("system_settings")
                  .upsert({ key: poolAlertSettingKey(t.key), value: true, updated_at: new Date().toISOString() }, { onConflict: "key" });
              }
              poolAlert = { triggered: newlyLow.map((t) => t.key), emailed: true, to: emails };
              console.log("cron collect-batch-runs: pool-depletion alert sent for", newlyLow.map((t) => t.key).join(", "));
            } else {
              const detail = await sendRes.text().catch(() => "");
              console.error("cron collect-batch-runs: pool-depletion alert Resend error", sendRes.status, detail);
              poolAlert = { triggered: newlyLow.map((t) => t.key), emailed: false, reason: `Resend error ${sendRes.status}` };
            }
          }
        }
      }
    } catch (err) {
      console.error("cron collect-batch-runs: pool-depletion check failed (non-fatal -- the collection summary above still completed)", err);
      poolAlert = { error: err.message || String(err) };
    }

    // --- Duplicate-touch canary --------------------------------------
    // Same independent, non-fatal shape as the pool-depletion check above,
    // reading batch_duplicate_touch_status() (a Postgres function -- see
    // its own migration) instead of batch_tool_pool_status(). That
    // function counts, per tool, how many schools have been touched by
    // more than one run -- exactly the failure mode of the Sept 2026
    // row-cap exclusion bug (claude/batch-exclusion-row-cap-bug-fix.md).
    // The count itself never reaches zero (477+ schools were already
    // duplicated before the fix, and those old extra rows are left in
    // place rather than deleted), so this doesn't alert on the count being
    // non-zero -- it alerts only when the count GROWS past the baseline
    // recorded the moment the fix shipped, which would mean the exclusion
    // logic broke again in some new way and deserves the same kind of
    // attention the original bug got.
    let duplicateAlert = null;
    try {
      const { data: dupRows, error: dupErr } = await supabase.rpc("batch_duplicate_touch_status");
      if (dupErr) throw dupErr;

      const settingKeys = TOOLS.flatMap((t) => [duplicateBaselineSettingKey(t.key), duplicateAlertSettingKey(t.key)]);
      const { data: dupSettingRows, error: dupSettingErr } = await supabase.from("system_settings").select("key,value").in("key", settingKeys);
      if (dupSettingErr) throw dupSettingErr;
      const settingByKey = new Map((dupSettingRows || []).map((r) => [r.key, r.value]));
      const dupByKey = new Map((dupRows || []).map((r) => [r.tool_key, Number(r.duplicate_schools)]));

      const newlyDuplicated = [];
      for (const tool of TOOLS) {
        const current = dupByKey.get(tool.key);
        if (current === undefined) continue;
        const baseline = Number(settingByKey.get(duplicateBaselineSettingKey(tool.key)) ?? current);
        const alreadyFlagged = settingByKey.get(duplicateAlertSettingKey(tool.key)) === true;
        if (current > baseline && !alreadyFlagged) {
          newlyDuplicated.push({ ...tool, current, baseline, grew_by: current - baseline });
        }
      }

      if (newlyDuplicated.length > 0) {
        const resendKey = process.env.RESEND_API_KEY;
        if (!resendKey) {
          console.warn("cron collect-batch-runs: duplicate-touch canary triggered but RESEND_API_KEY is not set -- skipping email:", newlyDuplicated.map((t) => t.key).join(", "));
          duplicateAlert = { triggered: newlyDuplicated.map((t) => t.key), emailed: false, reason: "RESEND_API_KEY not set" };
        } else {
          const { data: recipientProfiles } = await supabase.from("profiles").select("id").in("role", ["sysadmin", "verifier"]);
          const emails = [];
          for (const p of recipientProfiles || []) {
            const { data: userRes } = await supabase.auth.admin.getUserById(p.id);
            if (userRes?.user?.email) emails.push(userRes.user.email);
          }

          if (emails.length === 0) {
            duplicateAlert = { triggered: newlyDuplicated.map((t) => t.key), emailed: false, reason: "No sysadmin/verifier email addresses found" };
          } else {
            const rowsHtml = newlyDuplicated
              .map(
                (t) => `<tr>
                <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;">${t.label}</td>
                <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;text-align:right;font-weight:700;color:#b3261e;">+${t.grew_by}</td>
                <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;color:#697386;">${t.baseline} → ${t.current}</td>
              </tr>`
              )
              .join("");
            const subject = `Batch Discovery: ${newlyDuplicated.length} tool${newlyDuplicated.length === 1 ? "" : "s"} showing NEW duplicate-touched schools`;
            const html = `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;max-width:640px;margin:0 auto;color:#1a1a1a;">
              <h2 style="margin-bottom:4px;">Duplicate-touch canary tripped</h2>
              <p style="color:#697386;margin-top:0;">
                ${newlyDuplicated.length} of the four AI discovery tools now show MORE schools touched by more than one run than right after the
                Sept 24 2026 exclusion-list fix. That fix was supposed to make this permanently impossible going forward -- this growing again means
                something in the "already touched" exclusion logic broke a second time and is worth a look before it repeats what happened before.
              </p>
              <table style="width:100%;border-collapse:collapse;font-size:14px;">
                <thead>
                  <tr style="text-align:left;color:#697386;font-size:12px;text-transform:uppercase;">
                    <th style="padding:8px 12px;border-bottom:2px solid #e5e7eb;">Tool</th>
                    <th style="padding:8px 12px;border-bottom:2px solid #e5e7eb;text-align:right;">Grew by</th>
                    <th style="padding:8px 12px;border-bottom:2px solid #e5e7eb;">Baseline → now</th>
                  </tr>
                </thead>
                <tbody>${rowsHtml}</tbody>
              </table>
              <p style="margin-top:24px;">
                <a href="${SITE_URL}/admin/batch-status" style="background:#1a1a2e;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;display:inline-block;">
                  Open Batch Discovery Status
                </a>
              </p>
              <p style="color:#9ca3af;font-size:12px;margin-top:32px;">CSD CoachConnect — Collegiate Sports Data. You'll only get this once per tool until it's addressed.</p>
            </div>`;

            const sendRes = await fetch("https://api.resend.com/emails", {
              method: "POST",
              headers: { "content-type": "application/json", authorization: `Bearer ${resendKey}` },
              body: JSON.stringify({ from: ALERT_FROM_EMAIL, to: emails, subject, html }),
            });

            if (sendRes.ok) {
              for (const t of newlyDuplicated) {
                await supabase
                  .from("system_settings")
                  .upsert({ key: duplicateAlertSettingKey(t.key), value: true, updated_at: new Date().toISOString() }, { onConflict: "key" });
              }
              duplicateAlert = { triggered: newlyDuplicated.map((t) => t.key), emailed: true, to: emails };
              console.log("cron collect-batch-runs: duplicate-touch canary alert sent for", newlyDuplicated.map((t) => t.key).join(", "));
            } else {
              const detail = await sendRes.text().catch(() => "");
              console.error("cron collect-batch-runs: duplicate-touch canary Resend error", sendRes.status, detail);
              duplicateAlert = { triggered: newlyDuplicated.map((t) => t.key), emailed: false, reason: `Resend error ${sendRes.status}` };
            }
          }
        }
      }
    } catch (err) {
      console.error("cron collect-batch-runs: duplicate-touch canary failed (non-fatal -- the collection summary above still completed)", err);
      duplicateAlert = { error: err.message || String(err) };
    }

    return NextResponse.json({ summary, duration_ms: Date.now() - startedAt, pool_alert: poolAlert, duplicate_touch_alert: duplicateAlert });
  } catch (err) {
    console.error("cron collect-batch-runs error", err);
    return NextResponse.json({ error: err.message || "Automated batch collection failed.", summary }, { status: 500 });
  }
}
