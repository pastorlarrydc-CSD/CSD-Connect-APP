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
//
// Also runs a pool-depletion check every time this cron fires (see the
// end of the GET handler below) -- separate from the collect loop above,
// it looks at how many eligible, never-touched schools are left for each
// tool in the priority states and emails Larry once a tool's pool first
// drops below one more week's worth. Built alongside the new
// /admin/batch-status dashboard (same underlying batch_tool_pool_status()
// Postgres function powers both) in response to Larry asking for a
// pool-depletion alert so a tool running dry doesn't go unnoticed.
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

// One entry per batch discovery tool -- everything that differs between
// them (table names, how a parsed suggestion gets normalized) lives here;
// the loop below is otherwise identical for all four, mirroring each
// tool's own [runId]/check-status + [runId]/collect routes exactly.
// label/criteria/href are only used by the pool-depletion alert email
// below (the collect loop above never touches them).
const TOOLS = [
  {
    key: "athletics",
    runsTable: "athletics_batch_runs",
    itemsTable: "athletics_batch_items",
    buildSuggestion: (parsed) => normalizeAthleticsSuggestion(parsed),
    label: "Athletics-URL",
    criteria: "Missing an athletics-site URL",
    href: "/admin/batch-athletics",
  },
  {
    key: "coach_info",
    runsTable: "coach_info_batch_runs",
    itemsTable: "coach_info_batch_items",
    buildSuggestion: (parsed) => normalizeSuggestion(parsed, "batch AI lookup"),
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
    label: "MaxPreps",
    criteria: "Missing a MaxPreps page URL",
    href: "/admin/batch-maxpreps",
  },
  {
    key: "social",
    runsTable: "social_batch_runs",
    itemsTable: "social_batch_items",
    buildSuggestion: (parsed) => normalizeSocialSuggestion(parsed),
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

    return NextResponse.json({ summary, duration_ms: Date.now() - startedAt, pool_alert: poolAlert });
  } catch (err) {
    console.error("cron collect-batch-runs error", err);
    return NextResponse.json({ error: err.message || "Automated batch collection failed.", summary }, { status: 500 });
  }
}
