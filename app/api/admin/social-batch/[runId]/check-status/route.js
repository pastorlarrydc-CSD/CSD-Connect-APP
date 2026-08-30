import { NextResponse } from "next/server";
import { getSupabaseRouteClient } from "@/lib/supabase/routeClient";

const REVIEWER_ROLES = ["verifier", "sysadmin"];

// Wait stage of the overnight Social Media Batch API job -- identical
// shape to app/api/admin/athletics-batch/[runId]/check-status, just
// pointed at the social_batch_runs table. Anthropic processes a batch
// asynchronously -- results aren't instant, so the review page polls this
// route (on a button click, not an automatic interval) to ask Anthropic
// how a submitted run is doing. Once Anthropic reports processing_status
// "ended", the run flips to "ready" and the Collect Results button on the
// review page lights up.
export async function GET(req, { params }) {
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
      return NextResponse.json({ error: "Only verification staff or a system admin can check a batch run's status." }, { status: 403 });
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: "ANTHROPIC_API_KEY is missing from the server environment." }, { status: 500 });
    }

    const { data: run, error: runErr } = await supabase.from("social_batch_runs").select("id,status,anthropic_batch_id").eq("id", runId).maybeSingle();
    if (runErr || !run) {
      return NextResponse.json({ error: "Batch run not found." }, { status: 404 });
    }
    if (!run.anthropic_batch_id) {
      return NextResponse.json({ error: "This run hasn't been submitted to Anthropic yet." }, { status: 400 });
    }

    const statusRes = await fetch(`https://api.anthropic.com/v1/messages/batches/${run.anthropic_batch_id}`, {
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    });
    if (!statusRes.ok) {
      const detail = await statusRes.text().catch(() => "");
      console.error("Anthropic Batch API status error", statusRes.status, detail);
      return NextResponse.json({ error: "Anthropic's Batch API returned an error checking this run's status." }, { status: 502 });
    }
    const statusJson = await statusRes.json();
    const processingStatus = statusJson.processing_status || "in_progress";

    const isEnded = processingStatus === "ended";
    const nextStatus = isEnded && run.status !== "collected" ? "ready" : run.status === "submitted" ? "processing" : run.status;

    const update = { anthropic_batch_status: processingStatus };
    if (nextStatus !== run.status) update.status = nextStatus;
    if (isEnded && nextStatus === "ready") update.ready_at = new Date().toISOString();

    const { error: updateErr } = await supabase.from("social_batch_runs").update(update).eq("id", runId);
    if (updateErr) {
      console.error("batch-social check-status update error", updateErr);
    }

    return NextResponse.json({
      processing_status: processingStatus,
      request_counts: statusJson.request_counts || null,
      status: update.status || run.status,
    });
  } catch (err) {
    console.error("batch-social check-status error", err);
    return NextResponse.json({ error: "Could not check this run's status. Please try again." }, { status: 500 });
  }
}
