"use client";
import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { useAuth } from "@/lib/auth-context";

// Overnight MaxPreps-URL Batch API job -- the MaxPreps-discovery counterpart
// to /admin/batch-athletics (see that page for the pattern this mirrors
// closely: MaxPreps URL, like athletics URL, is a single field on the
// school with a single best-pick AI suggestion, unlike Social's two
// independent handles). MaxPreps coverage matters because it's the fallback
// source the nightly Coach-Change Radar checks when a school has no
// athletics URL on file (see lib/schoolRecheck.js) -- and it's also the
// single best data-quality gut-check for the recruiting staff who add this
// app's prospect data, since a school's MaxPreps team page is often the
// fastest way to confirm a roster is current.
//
// Same four stages as Batch Athletics/Social, and the same non-authoritative
// contract -- nothing here ever writes to the schools table until a human
// clicks Apply on a specific school's suggestion below:
//  1. Prep    -- run one site:maxpreps.com web search per school, save the
//                raw candidate results (fetch-item route, driven here with
//                a few requests in flight at once).
//  2. Submit  -- bundle every "ready" item into one Anthropic Batch API
//                submission (submit route). The model's job is picking
//                which ONE search result (if any) is genuinely this
//                school's own football team page -- not extracting
//                anything from a page, since there's no known page to read
//                yet.
//  3. Wait    -- Anthropic processes asynchronously; check back later
//                (check-status route, polled by hand -- no auto-refresh).
//  4. Collect -- once Anthropic reports the batch "ended", download and
//                parse its results into a review queue (collect route).
const PRIORITY_STATES = ["TX", "FL", "GA", "CA", "OH", "IN"];
const TARGET_COUNTS = [100, 300, 500, 1000];
const DEFAULT_TARGET_COUNT = 300;
const FETCH_CONCURRENCY = 8; // matches the weekly automated cron's own concurrency (app/api/cron/weekly-maxpreps-batch) -- this manual page used to run at 3, well under what the same Serper calls handle fine unattended, which just meant a longer wait staring at this tab for a same-size run
const APPLY_CONCURRENCY = 5; // applying is just a DB write, no web fetch/AI call, so higher concurrency than FETCH_CONCURRENCY is safe -- matches batch-athletics/batch-social

const ITEM_SELECT =
  "id,batch_run_id,school_id,fetch_status,suggestion,suggestion_error,review_status,school:schools(id,name,city,state,maxpreps_url)";

async function runWithConcurrency(items, limit, worker) {
  let next = 0;
  async function runNext() {
    const i = next++;
    if (i >= items.length) return;
    await worker(items[i], i);
    return runNext();
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runNext));
}

function StatusBadge({ status }) {
  const labels = {
    collecting: ["Searching", "#697386"],
    submitted: ["Submitted to Anthropic", "#2f5fa8"],
    processing: ["Processing", "#2f5fa8"],
    ready: ["Ready to collect", "#8a6100"],
    collected: ["Ready for review", "#1e7145"],
    error: ["Error", "#b3261e"],
  };
  const [label, color] = labels[status] || [status, "#697386"];
  return (
    <span className="badge" style={{ color, background: `${color}1a`, fontWeight: 600 }}>
      {label}
    </span>
  );
}

function confidenceColor(confidence) {
  if (confidence === "high") return "#1e7145";
  if (confidence === "medium") return "#8a6100";
  return "#b3261e"; // low or none
}

export default function BatchMaxPrepsPage() {
  const supabase = getSupabaseBrowserClient();
  const { user, profile } = useAuth();
  const canReview = profile?.role === "verifier" || profile?.role === "sysadmin";

  const [runs, setRuns] = useState([]);
  const [loadingRuns, setLoadingRuns] = useState(true);
  const [selectedRunId, setSelectedRunId] = useState(null);
  const [items, setItems] = useState([]);
  const [loadingItems, setLoadingItems] = useState(false);

  const [scopeMode, setScopeMode] = useState("priority"); // "priority" | "all"
  const [customStates, setCustomStates] = useState(PRIORITY_STATES.join(", "));
  const [targetCount, setTargetCount] = useState(DEFAULT_TARGET_COUNT);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");

  const [fetching, setFetching] = useState(false);
  const [fetchProgress, setFetchProgress] = useState({ done: 0, total: 0 });

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");

  const [checkingStatus, setCheckingStatus] = useState(false);
  const [statusError, setStatusError] = useState("");
  const [lastCheckedStatus, setLastCheckedStatus] = useState("");

  const [collecting, setCollecting] = useState(false);
  const [collectError, setCollectError] = useState("");

  const [applyingId, setApplyingId] = useState(null);
  const [reviewError, setReviewError] = useState("");
  const [showReviewed, setShowReviewed] = useState(false);
  const [bulkApplying, setBulkApplying] = useState(false);
  const [bulkProgress, setBulkProgress] = useState({ done: 0, total: 0 });
  const [focusedIndex, setFocusedIndex] = useState(0);

  const selectedRun = runs.find((r) => r.id === selectedRunId) || null;

  const readyCount = items.filter((i) => i.fetch_status === "ready").length;
  const pendingFetchCount = items.filter((i) => i.fetch_status === "pending").length;
  const noContentCount = items.filter((i) => i.fetch_status === "no_content").length;
  const suggestedItems = items.filter((i) => i.suggestion);
  const matchedItems = suggestedItems.filter((i) => i.suggestion.best_url);
  const noMatchItems = suggestedItems.filter((i) => !i.suggestion.best_url && !i.suggestion_error);
  const failedItems = suggestedItems.filter((i) => i.suggestion_error);
  const pendingReview = matchedItems.filter((i) => i.review_status === "pending");
  const reviewedItems = matchedItems.filter((i) => i.review_status !== "pending");
  const highConfidencePendingCount = pendingReview.filter((i) => i.suggestion?.confidence === "high").length;

  const clampedFocusedIndex = pendingReview.length === 0 ? 0 : Math.min(focusedIndex, pendingReview.length - 1);
  const focusedItem = pendingReview[clampedFocusedIndex] || null;

  // Keyboard shortcuts for the review queue -- Up/Down move focus between
  // pending rows, A applies the focused row, S skips it. Only active while
  // this run is at the "collected" review stage, nothing's mid-flight, and
  // the user isn't typing into a form field (e.g. the custom-states input
  // above). Lets a reviewer clear a run without reaching for the mouse for
  // every single Apply/Skip click.
  useEffect(() => {
    function onKeyDown(e) {
      if (selectedRun?.status !== "collected") return;
      if (bulkApplying || applyingId) return;
      const tag = document.activeElement?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      if (e.key === "ArrowDown") {
        e.preventDefault();
        setFocusedIndex((prev) => (pendingReview.length === 0 ? 0 : Math.min(prev + 1, pendingReview.length - 1)));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setFocusedIndex((prev) => Math.max(prev - 1, 0));
      } else if (e.key === "a" || e.key === "A") {
        if (focusedItem) {
          e.preventDefault();
          applyItem(focusedItem);
        }
      } else if (e.key === "s" || e.key === "S") {
        if (focusedItem) {
          e.preventDefault();
          skipItem(focusedItem);
        }
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedRun?.status, bulkApplying, applyingId, focusedItem, pendingReview.length]);

  const loadRuns = useCallback(async () => {
    setLoadingRuns(true);
    const { data } = await supabase.from("maxpreps_batch_runs").select("*").order("created_at", { ascending: false }).limit(30);
    setRuns(data || []);
    setLoadingRuns(false);
  }, [supabase]);

  useEffect(() => {
    loadRuns();
  }, [loadRuns]);

  const loadItems = useCallback(
    async (runId) => {
      if (!runId) return;
      setLoadingItems(true);
      const { data } = await supabase.from("maxpreps_batch_items").select(ITEM_SELECT).eq("batch_run_id", runId).order("id");
      setItems(data || []);
      setLoadingItems(false);
    },
    [supabase]
  );

  useEffect(() => {
    if (selectedRunId) loadItems(selectedRunId);
  }, [selectedRunId, loadItems]);

  function openRun(runId) {
    setSelectedRunId(runId);
    setCreateError("");
    setSubmitError("");
    setStatusError("");
    setCollectError("");
    setReviewError("");
    setFocusedIndex(0);
  }

  async function startRun() {
    setCreateError("");
    setCreating(true);
    try {
      const states = scopeMode === "priority" ? PRIORITY_STATES : customStates.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);

      // Excludes every school that's EVER gone through this tool before --
      // applied, skipped, or a suggestion the AI found no match for -- not
      // just ones sitting in a still-open run (same fix just made to Batch
      // Coach-Info's startRun; see that page for the full reasoning). Over-
      // fetches 3x and filters client-side rather than a giant SQL "not in"
      // list.
      const { data: touchedRows, error: touchedErr } = await supabase.from("maxpreps_batch_items").select("school_id");
      if (touchedErr) throw touchedErr;
      const excludedIds = new Set((touchedRows || []).map((r) => r.school_id));

      let query = supabase
        .from("schools")
        .select("id,name,city,state")
        .or("maxpreps_url.is.null,maxpreps_url.eq.")
        .order("id", { ascending: true })
        .limit(targetCount * 3);
      if (scopeMode !== "all" || states.length) {
        query = query.in("state", states);
      }

      const { data: rawSchoolsData, error: schoolsErr } = await query;
      if (schoolsErr) throw schoolsErr;
      const schoolsData = (rawSchoolsData || []).filter((s) => !excludedIds.has(s.id)).slice(0, targetCount);
      if (!schoolsData || schoolsData.length === 0) {
        setCreateError("No schools matched -- everyone missing a MaxPreps URL in this scope has already been through this tool before.");
        return;
      }

      const { data: runRow, error: runErr } = await supabase
        .from("maxpreps_batch_runs")
        .insert({ status: "collecting", state_filter: scopeMode === "all" && states.length === 0 ? null : states, requested_count: schoolsData.length, created_by: user.id })
        .select()
        .single();
      if (runErr) throw runErr;

      const itemRows = schoolsData.map((s) => ({ batch_run_id: runRow.id, school_id: s.id }));
      const { error: itemsErr } = await supabase.from("maxpreps_batch_items").insert(itemRows);
      if (itemsErr) throw itemsErr;

      await loadRuns();
      openRun(runRow.id);
    } catch (err) {
      setCreateError(err.message || "Could not start a new batch run.");
    } finally {
      setCreating(false);
    }
  }

  async function fetchSources() {
    const toFetch = items.filter((i) => i.fetch_status === "pending");
    if (!toFetch.length) return;
    setFetching(true);
    setFetchProgress({ done: 0, total: toFetch.length });
    let done = 0;
    await runWithConcurrency(toFetch, FETCH_CONCURRENCY, async (item) => {
      try {
        const {
          data: { session },
        } = await supabase.auth.getSession();
        const res = await fetch("/api/admin/maxpreps-batch/fetch-item", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token}` },
          body: JSON.stringify({ itemId: item.id }),
        });
        const json = await res.json().catch(() => ({}));
        const newStatus = res.ok ? json.fetch_status : "error";
        setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, fetch_status: newStatus } : i)));
      } catch (_) {
        setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, fetch_status: "error" } : i)));
      } finally {
        done++;
        setFetchProgress({ done, total: toFetch.length });
      }
    });
    setFetching(false);
  }

  async function submitRun() {
    if (!selectedRun) return;
    setSubmitting(true);
    setSubmitError("");
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const res = await fetch(`/api/admin/maxpreps-batch/${selectedRun.id}/submit`, {
        method: "POST",
        headers: { Authorization: `Bearer ${session?.access_token}` },
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Could not submit this run.");
      await loadRuns();
    } catch (err) {
      setSubmitError(err.message || "Could not submit this run.");
    } finally {
      setSubmitting(false);
    }
  }

  async function checkStatus() {
    if (!selectedRun) return;
    setCheckingStatus(true);
    setStatusError("");
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const res = await fetch(`/api/admin/maxpreps-batch/${selectedRun.id}/check-status`, {
        headers: { Authorization: `Bearer ${session?.access_token}` },
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Could not check this run's status.");
      setLastCheckedStatus(json.processing_status || "");
      await loadRuns();
    } catch (err) {
      setStatusError(err.message || "Could not check this run's status.");
    } finally {
      setCheckingStatus(false);
    }
  }

  async function collectResults() {
    if (!selectedRun) return;
    setCollecting(true);
    setCollectError("");
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const res = await fetch(`/api/admin/maxpreps-batch/${selectedRun.id}/collect`, {
        method: "POST",
        headers: { Authorization: `Bearer ${session?.access_token}` },
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Could not collect this run's results.");
      await loadRuns();
      await loadItems(selectedRun.id);
    } catch (err) {
      setCollectError(err.message || "Could not collect this run's results.");
    } finally {
      setCollecting(false);
    }
  }

  // Pulled out of applyItem so bulkApplyHighConfidence can reuse the exact
  // same write path (schools update + school_change_log entry + item
  // marked applied) for each item in a batch, without touching the
  // single-item applyingId/reviewError state that only makes sense for one
  // row at a time. Mirrors the same split on the Batch Athletics/Social
  // pages.
  async function applySuggestionCore(item) {
    const s = item.school;
    const sug = item.suggestion;
    if (!s || !sug || !sug.best_url) return { ok: false, error: "Missing school or suggestion." };
    try {
      const newVal = sug.best_url;
      if (newVal !== (s.maxpreps_url || "")) {
        const { error: updateErr } = await supabase.from("schools").update({ maxpreps_url: newVal }).eq("id", s.id);
        if (updateErr) throw updateErr;
        const { error: logErr } = await supabase.from("school_change_log").insert({
          school_id: s.id,
          field_name: "maxpreps_url",
          old_value: s.maxpreps_url || null,
          new_value: newVal,
          source: `Batch AI lookup (${sug.confidence} confidence, reviewed)`,
          changed_by: user.id,
        });
        if (logErr) throw logErr;
      }
      const { error: itemErr } = await supabase
        .from("maxpreps_batch_items")
        .update({ review_status: "applied", reviewed_at: new Date().toISOString(), reviewed_by: user.id })
        .eq("id", item.id);
      if (itemErr) throw itemErr;
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message || "Could not apply this suggestion." };
    }
  }

  async function applyItem(item) {
    setApplyingId(item.id);
    setReviewError("");
    const result = await applySuggestionCore(item);
    if (result.ok) {
      setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, review_status: "applied" } : i)));
    } else {
      setReviewError(result.error);
    }
    setApplyingId(null);
  }

  // Applies every PENDING high-confidence suggestion in the current run in
  // one click -- the AI only marks a suggestion "high confidence" when the
  // search result was unambiguously this school's own MaxPreps football
  // page, so these are the ones a reviewer would almost always click Apply
  // on anyway. Same batching pattern as Batch Athletics/Social's
  // bulkApplyHighConfidence.
  async function bulkApplyHighConfidence() {
    const targets = pendingReview.filter((i) => i.suggestion?.confidence === "high");
    if (!targets.length) return;
    setBulkApplying(true);
    setReviewError("");
    setBulkProgress({ done: 0, total: targets.length });
    let done = 0;
    const failures = [];
    await runWithConcurrency(targets, APPLY_CONCURRENCY, async (item) => {
      const result = await applySuggestionCore(item);
      if (result.ok) {
        setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, review_status: "applied" } : i)));
      } else {
        failures.push(`${item.school?.name || `#${item.id}`}: ${result.error}`);
      }
      done++;
      setBulkProgress({ done, total: targets.length });
    });
    setBulkApplying(false);
    setFocusedIndex(0);
    if (failures.length > 0) {
      setReviewError(
        `Applied ${targets.length - failures.length} of ${targets.length} high-confidence suggestions. ${failures.length} failed: ${failures.slice(0, 3).join("; ")}${
          failures.length > 3 ? "…" : ""
        }`
      );
    }
  }

  async function skipItem(item) {
    setApplyingId(item.id);
    setReviewError("");
    try {
      const { error } = await supabase
        .from("maxpreps_batch_items")
        .update({ review_status: "skipped", reviewed_at: new Date().toISOString(), reviewed_by: user.id })
        .eq("id", item.id);
      if (error) throw error;
      setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, review_status: "skipped" } : i)));
    } catch (err) {
      setReviewError(err.message || "Could not skip this suggestion.");
    } finally {
      setApplyingId(null);
    }
  }

  if (!canReview) {
    return (
      <div className="view">
        <div className="notice danger">Batch MaxPreps discovery is limited to Verification Staff and System Admins.</div>
      </div>
    );
  }

  return (
    <div className="view">
      <Link href="/admin" className="btn btn-sm" style={{ marginBottom: 12, display: "inline-flex" }}>
        ← Back to Admin
      </Link>
      <div className="view-header">
        <div>
          <h1>Batch MaxPreps Discovery</h1>
          <p>Run a web search for each school's MaxPreps football team page overnight via Anthropic's Batch API, then review and apply the AI's best pick here.</p>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <h3>Start a New Batch Run</h3>
        <p style={{ fontSize: 12.5, color: "#697386", marginTop: -4 }}>
          Pulls schools with no MaxPreps URL on file yet. A school's MaxPreps team page is the fallback source the nightly Coach-Change Radar checks when there's no athletics URL on file,
          and it's often the fastest way for recruiting staff to confirm a roster is current -- closing this gap raises the accuracy ceiling here too.
          {" "}Any school already applied, skipped, or attempted here before is automatically left out of every future run.
        </p>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <label style={{ fontSize: 13, display: "flex", gap: 6, alignItems: "center" }}>
            <input type="radio" checked={scopeMode === "priority"} onChange={() => setScopeMode("priority")} />
            Priority recruiting states ({PRIORITY_STATES.join(", ")})
          </label>
          <label style={{ fontSize: 13, display: "flex", gap: 6, alignItems: "center" }}>
            <input type="radio" checked={scopeMode === "all"} onChange={() => setScopeMode("all")} />
            All states (or type a custom list below)
          </label>
          {scopeMode === "all" && (
            <input
              value={customStates}
              onChange={(e) => setCustomStates(e.target.value)}
              placeholder="Leave blank for every state, or type e.g. TX, OK, AR"
              style={{ maxWidth: 360 }}
            />
          )}
          <label style={{ fontSize: 13 }}>
            How many schools:{" "}
            <select value={targetCount} onChange={(e) => setTargetCount(Number(e.target.value))}>
              {TARGET_COUNTS.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <div>
            <button className="btn btn-primary btn-sm" onClick={startRun} disabled={creating}>
              {creating ? "Starting…" : "Start Run"}
            </button>
          </div>
          {createError && (
            <div className="notice danger" style={{ fontSize: 12.5 }}>
              {createError}
            </div>
          )}
        </div>
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <h3 style={{ margin: 0, marginBottom: 8 }}>Batch Runs</h3>
        {loadingRuns ? (
          <div className="empty-state">Loading…</div>
        ) : runs.length === 0 ? (
          <div className="empty-state">No batch runs yet -- start one above.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {runs.map((r) => (
              <div
                key={r.id}
                onClick={() => openRun(r.id)}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  flexWrap: "wrap",
                  gap: 8,
                  padding: "8px 10px",
                  border: r.id === selectedRunId ? "1px solid #2f5fa8" : "1px solid #e3e6ea",
                  borderRadius: 8,
                  cursor: "pointer",
                }}
              >
                <div style={{ fontSize: 12.5 }}>
                  <strong>Run #{r.id}</strong> — {new Date(r.created_at).toLocaleString()} — {r.state_filter ? r.state_filter.join(", ") : "all states"} — {r.requested_count} school
                  {r.requested_count === 1 ? "" : "s"}
                </div>
                <StatusBadge status={r.status} />
              </div>
            ))}
          </div>
        )}
      </div>

      {selectedRun && (
        <div className="card" style={{ marginBottom: 14 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, marginBottom: 8 }}>
            <h3 style={{ margin: 0 }}>Run #{selectedRun.id}</h3>
            <StatusBadge status={selectedRun.status} />
          </div>

          {selectedRun.status === "collecting" && (
            <div>
              <p style={{ fontSize: 12.5, color: "#697386" }}>
                Step 1: search for each school's MaxPreps page, then save the results. {readyCount} ready, {pendingFetchCount} not searched yet, {noContentCount} found nothing usable.
              </p>
              <button className="btn btn-sm" onClick={fetchSources} disabled={fetching || loadingItems || pendingFetchCount === 0}>
                {fetching ? `Searching ${fetchProgress.done} of ${fetchProgress.total}…` : pendingFetchCount === 0 ? "All Searched" : `Search (${pendingFetchCount} schools)`}
              </button>
              <button className="btn btn-gold btn-sm" style={{ marginLeft: 8 }} onClick={submitRun} disabled={submitting || readyCount === 0}>
                {submitting ? "Submitting…" : `Submit ${readyCount} School${readyCount === 1 ? "" : "s"} to Anthropic Batch`}
              </button>
              {submitError && (
                <div className="notice danger" style={{ marginTop: 10, fontSize: 12.5 }}>
                  {submitError}
                </div>
              )}
            </div>
          )}

          {(selectedRun.status === "submitted" || selectedRun.status === "processing") && (
            <div>
              <p style={{ fontSize: 12.5, color: "#697386" }}>
                Step 2: submitted to Anthropic's Batch API ({selectedRun.fetched_count} schools). Results usually land same-day, worst case within 24 hours -- check back and click below.
                {selectedRun.anthropic_batch_status ? ` Last known status: ${selectedRun.anthropic_batch_status}.` : ""}
              </p>
              <button className="btn btn-sm" onClick={checkStatus} disabled={checkingStatus}>
                {checkingStatus ? "Checking…" : "Check Batch Status"}
              </button>
              {lastCheckedStatus && !statusError && (
                <span style={{ marginLeft: 10, fontSize: 12.5, color: "#697386" }}>Anthropic says: {lastCheckedStatus}</span>
              )}
              {statusError && (
                <div className="notice danger" style={{ marginTop: 10, fontSize: 12.5 }}>
                  {statusError}
                </div>
              )}
            </div>
          )}

          {selectedRun.status === "ready" && (
            <div>
              <p style={{ fontSize: 12.5, color: "#697386" }}>Step 3: Anthropic has finished processing this batch. Collect the results to start reviewing suggestions.</p>
              <button className="btn btn-gold btn-sm" onClick={collectResults} disabled={collecting}>
                {collecting ? "Collecting…" : "Collect Results"}
              </button>
              {collectError && (
                <div className="notice danger" style={{ marginTop: 10, fontSize: 12.5 }}>
                  {collectError}
                </div>
              )}
            </div>
          )}

          {selectedRun.status === "collected" && (
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
                <p style={{ fontSize: 12.5, color: "#697386", margin: 0 }}>
                  {pendingReview.length} suggestion{pendingReview.length === 1 ? "" : "s"} to review, {reviewedItems.length} already reviewed, {noMatchItems.length} where the AI found no
                  confident match, {failedItems.length} the AI couldn't produce a suggestion for.
                </p>
                <label style={{ fontSize: 12.5, display: "flex", gap: 6, alignItems: "center" }}>
                  <input type="checkbox" checked={showReviewed} onChange={(e) => setShowReviewed(e.target.checked)} />
                  Show already-reviewed
                </label>
              </div>

              {highConfidencePendingCount > 0 && (
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    flexWrap: "wrap",
                    gap: 10,
                    marginBottom: 10,
                    padding: "10px 12px",
                    background: "#eef4fb",
                    border: "1px solid #cfe0f2",
                    borderRadius: 8,
                  }}
                >
                  <span style={{ fontSize: 12.5 }}>
                    <strong>{highConfidencePendingCount}</strong> of those are <strong>high confidence</strong> -- the AI was confident the search result was unambiguously this school's own
                    MaxPreps football page. These are safe to clear in one click instead of reviewing one at a time.
                  </span>
                  <button className="btn btn-gold btn-sm" onClick={bulkApplyHighConfidence} disabled={bulkApplying}>
                    {bulkApplying ? `Applying ${bulkProgress.done} of ${bulkProgress.total}…` : `Apply All High-Confidence (${highConfidencePendingCount})`}
                  </button>
                </div>
              )}

              {reviewError && (
                <div className="notice danger" style={{ marginBottom: 10, fontSize: 12.5 }}>
                  {reviewError}
                </div>
              )}

              <div style={{ fontSize: 11.5, color: "#9aa1ab", marginBottom: 6 }}>
                Keyboard shortcuts: <strong>↑</strong>/<strong>↓</strong> move focus · <strong>A</strong> apply · <strong>S</strong> skip
              </div>

              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
                  <thead>
                    <tr style={{ borderBottom: "2px solid #e3e6ea", textAlign: "left" }}>
                      <th style={{ padding: "6px 8px", whiteSpace: "nowrap" }}>School</th>
                      <th style={{ padding: "6px 8px" }}>Suggested MaxPreps URL</th>
                      <th style={{ padding: "6px 8px", whiteSpace: "nowrap" }}>Confidence</th>
                      <th style={{ padding: "6px 8px", whiteSpace: "nowrap" }}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(showReviewed ? matchedItems : pendingReview).map((item) => {
                      const s = item.school;
                      const sug = item.suggestion;
                      if (!s || !sug) return null;
                      const applying = applyingId === item.id;
                      const reviewed = item.review_status !== "pending";
                      const isFocused = !reviewed && focusedItem?.id === item.id;
                      return (
                        <tr
                          key={item.id}
                          style={{
                            borderBottom: "1px solid #eef0f3",
                            opacity: reviewed ? 0.55 : 1,
                            verticalAlign: "top",
                            background: isFocused ? "#eef4fb" : undefined,
                            boxShadow: isFocused ? "inset 3px 0 0 #2f5fa8" : undefined,
                          }}
                        >
                          <td style={{ padding: "8px", whiteSpace: "nowrap" }}>
                            <div style={{ fontWeight: 600 }}>{s.name}</div>
                            <div style={{ color: "#9aa1ab" }}>
                              {s.city}, {s.state}
                            </div>
                          </td>
                          <td style={{ padding: "8px", minWidth: 260 }}>
                            <div style={{ color: "#1e7145", fontWeight: 600 }}>{sug.best_url}</div>
                            <div style={{ color: "#9aa1ab" }}>Current: {s.maxpreps_url || "(blank)"}</div>
                            {sug.reasoning && <div style={{ marginTop: 4, fontStyle: "italic", color: "#9aa1ab" }}>"{sug.reasoning}"</div>}
                          </td>
                          <td style={{ padding: "8px", whiteSpace: "nowrap" }}>
                            <span className="badge" style={{ fontSize: 11, color: confidenceColor(sug.confidence) }}>
                              {sug.confidence}
                            </span>
                          </td>
                          <td style={{ padding: "8px", whiteSpace: "nowrap" }}>
                            {reviewed ? (
                              <span style={{ fontWeight: 600, color: item.review_status === "applied" ? "#1e7145" : "#697386" }}>
                                {item.review_status === "applied" ? "✓ Applied" : "Skipped"}
                              </span>
                            ) : (
                              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                                <button className="btn btn-gold btn-sm" disabled={applying || bulkApplying} onClick={() => applyItem(item)}>
                                  {applying ? "…" : "Apply"}
                                </button>
                                <button className="btn btn-sm" disabled={applying || bulkApplying} onClick={() => skipItem(item)}>
                                  Skip
                                </button>
                                <Link href={`/schools/${s.id}`} className="btn btn-sm">
                                  Open
                                </Link>
                              </div>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {!showReviewed && pendingReview.length === 0 && <div className="empty-state">Nothing left to review.</div>}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
