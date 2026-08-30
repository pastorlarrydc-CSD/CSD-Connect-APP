import { NextResponse } from "next/server";
import { getSupabaseRouteClient } from "@/lib/supabase/routeClient";
import { SYSTEM_PROMPT, MODEL, MAX_TOKENS } from "@/lib/maxPrepsLookup";

const REVIEWER_ROLES = ["verifier", "sysadmin"];

// Submit stage of the overnight MaxPreps-URL Batch API job. Bundles every
// item in this run that has usable fetched source text (fetch_status =
// "ready", set by the fetch-item prep route) into ONE submission to
// Anthropic's Message Batches API -- same shape as
// app/api/admin/athletics-batch/[runId]/submit, just pointed at the
// MaxPreps-picking prompt (lib/maxPrepsLookup).
//
// custom_id per request is deterministically "item-<maxpreps_batch_items.id>"
// -- not stored anywhere -- so the collect route can rebuild the same ID to
// match each result back to its item without an extra write here.
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
      return NextResponse.json({ error: "Only verification staff or a system admin can submit a batch run." }, { status: 403 });
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: "Batch MaxPreps discovery isn't configured yet -- ANTHROPIC_API_KEY is missing from the server environment." }, { status: 500 });
    }

    const { data: run, error: runErr } = await supabase.from("maxpreps_batch_runs").select("id,status").eq("id", runId).maybeSingle();
    if (runErr || !run) {
      return NextResponse.json({ error: "Batch run not found." }, { status: 404 });
    }
    if (run.status !== "collecting") {
      return NextResponse.json({ error: `This run has already been submitted (status: ${run.status}). Start a new run instead.` }, { status: 409 });
    }

    const { data: items, error: itemsErr } = await supabase
      .from("maxpreps_batch_items")
      .select("id,source_text")
      .eq("batch_run_id", runId)
      .eq("fetch_status", "ready");
    if (itemsErr) {
      return NextResponse.json({ error: itemsErr.message || "Could not load this run's items." }, { status: 500 });
    }
    if (!items || items.length === 0) {
      return NextResponse.json({ error: "Nothing to submit yet -- fetch search results for at least one school first." }, { status: 400 });
    }

    const requests = items.map((item) => ({
      custom_id: `item-${item.id}`,
      params: {
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: item.source_text }],
      },
    }));

    const batchRes = await fetch("https://api.anthropic.com/v1/messages/batches", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({ requests }),
    });

    if (!batchRes.ok) {
      const detail = await batchRes.text().catch(() => "");
      console.error("Anthropic Batch API submit error", batchRes.status, detail);
      return NextResponse.json({ error: "Anthropic's Batch API returned an error submitting this run. Please try again in a moment." }, { status: 502 });
    }

    const batchJson = await batchRes.json();

    const { error: updateErr } = await supabase
      .from("maxpreps_batch_runs")
      .update({
        status: "submitted",
        anthropic_batch_id: batchJson.id,
        anthropic_batch_status: batchJson.processing_status || "in_progress",
        fetched_count: items.length,
        submitted_at: new Date().toISOString(),
      })
      .eq("id", runId);
    if (updateErr) {
      return NextResponse.json({ error: updateErr.message || "Submitted to Anthropic but could not save the batch ID -- contact support with this run's ID." }, { status: 500 });
    }

    return NextResponse.json({ status: "submitted", anthropic_batch_id: batchJson.id, submitted_count: items.length });
  } catch (err) {
    console.error("batch-maxpreps submit error", err);
    return NextResponse.json({ error: "Could not submit this run. Please try again." }, { status: 500 });
  }
}
