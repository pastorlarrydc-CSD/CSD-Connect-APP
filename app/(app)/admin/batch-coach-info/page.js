"use client";
import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { useAuth } from "@/lib/auth-context";

// Overnight Coach-Info Batch API job -- see the batch-coach-info-discovery
// spec doc in the project for the full plan this implements. Turns the
// one-school-at-a-time "Suggest Coach Info (AI)" button into a real batch
// job that can run against hundreds of schools at once, using Anthropic's
// discounted (50% off) Batch API instead of live one-at-a-time calls.
//
// Four stages, matching the spec exactly:
//  1. Prep   -- fetch each school's athletics/website page + a web search,
//               save the assembled source text (fetch-item route, driven
//               here with a few requests in flight at once).
//  2. Submit -- bundle every "ready" item into one Anthropic Batch API
//               submission (submit route).
//  3. Wait   -- Anthropic processes asynchronously; check back later
//               (check-status route, polled by hand -- no auto-refresh).
//  4. Collect -- once Anthropic reports the batch "ended", download and
//               parse its results into a review queue (collect route).
//
// Same non-authoritative contract as every other discovery tool in this
// app: nothing here ever writes to the schools table until a human clicks
// Apply on a specific school's suggestion below.
const PRIORITY_STATES = ["TX", "FL", "GA", "CA", "OH", "IN"];
const TARGET_COUNTS = [100, 300, 500, 1000];
const DEFAULT_TARGET_COUNT = 300;
const FETCH_CONCURRENCY = 3;
const SUGGESTION_FIELDS = ["hc_first_name", "hc_last_name", "hc_email", "hc_office", "hc_cell", "hc_twitter", "hc_facebook"];
const FIELD_LABELS = {
  hc_first_name: "First name",
  hc_last_name: "Last name",
  hc_email: "Email",
  hc_office: "Office phone",
  hc_cell: "Cell",
  hc_twitter: "Twitter / X",
  hc_facebook: "Facebook",
};

const ITEM_SELECT =
  "id,batch_run_id,school_id,fetch_status,suggestion,suggestion_error,review_status,school:schools(id,name,city,state,hc_first_name,hc_last_name,hc_email,hc_cell,hc_office,hc_twitter,hc_facebook,athletics_url,website)";

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
    collecting: ["Fetching sources", "#697386"],
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

export default function BatchCoachInfoPage() {
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
  // Off by default so this tool keeps pulling from its full existing pool
  // (athletics URL OR just a general website) unless asked not to. On, it
  // narrows to schools that already have an Athletics URL specifically --
  // an athletics/staff page tends to read cleaner for the model than a
  // school's general homepage, so results skew more accurate at the cost
  // of a smaller candidate pool per run.
  const [requireAthletics, setRequireAthletics] = useState(false);
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

  const selectedRun = runs.find((r) => r.id === selectedRunId) || null;

  const loadRuns = useCallback(async () => {
    setLoadingRuns(true);
    const { data } = await supabase.from("coach_info_batch_runs").select("*").order("created_at", { ascending: false }).limit(30);
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
      const { data } = await supabase.from("coach_info_batch_items").select(ITEM_SELECT).eq("batch_run_id", runId).order("id");
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
  }

  async function startRun() {
    setCreateError("");
    setCreating(true);
    try {
      const states = scopeMode === "priority" ? PRIORITY_STATES : customStates.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);

      let query = supabase
        .from("schools")
        .select("id,name,city,state")
        .or("hc_first_name.is.null,hc_first_name.eq.")
        .or("hc_last_name.is.null,hc_last_name.eq.")
        .order("id", { ascending: true })
        .limit(targetCount);
      // requireAthletics narrows the source pool to just Athletics URL;
      // otherwise keep the looser "athletics OR general website" check
      // this tool has always used.
      query = requireAthletics ? query.not("athletics_url", "is", null).neq("athletics_url", "") : query.or("athletics_url.not.is.null,website.not.is.null");
      if (scopeMode !== "all" || states.length) {
        query = query.in("state", states);
      }

      const { data: schoolsData, error: schoolsErr } = await query;
      if (schoolsErr) throw schoolsErr;
      if (!schoolsData || schoolsData.length === 0) {
        setCreateError("No schools matched -- everyone missing coach info in this scope already has a batch run, or has no website/athletics URL on file to search from.");
        return;
      }

      const { data: runRow, error: runErr } = await supabase
        .from("coach_info_batch_runs")
        .insert({ status: "collecting", state_filter: scopeMode === "all" && states.length === 0 ? null : states, requested_count: schoolsData.length, created_by: user.id })
        .select()
        .single();
      if (runErr) throw runErr;

      const itemRows = schoolsData.map((s) => ({ batch_run_id: runRow.id, school_id: s.id }));
      const { error: itemsErr } = await supabase.from("coach_info_batch_items").insert(itemRows);
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
        const res = await fetch("/api/admin/batch-coach-info/fetch-item", {
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
      const res = await fetch(`/api/admin/batch-coach-info/${selectedRun.id}/submit`, {
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
      const res = await fetch(`/api/admin/batch-coach-info/${selectedRun.id}/check-status`, {
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
      const res = await fetch(`/api/admin/batch-coach-info/${selectedRun.id}/collect`, {
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

  async function applyItem(item) {
    const s = item.school;
    const sug = item.suggestion;
    if (!s || !sug) return;
    setApplyingId(item.id);
    setReviewError("");
    try {
      const update = {};
      const changes = [];
      SUGGESTION_FIELDS.forEach((f) => {
        const newVal = (sug[f] || "").trim();
        if (newVal && newVal !== (s[f] || "")) {
          update[f] = newVal;
          changes.push({ school_id: s.id, field_name: f, old_value: s[f] || null, new_value: newVal, source: `Batch AI lookup (${sug.confidence} confidence, reviewed)`, changed_by: user.id });
        }
      });
      if (Object.keys(update).length > 0) {
        const { error: updateErr } = await supabase.from("schools").update(update).eq("id", s.id);
        if (updateErr) throw updateErr;
        const { error: logErr } = await supabase.from("school_change_log").insert(changes);
        if (logErr) throw logErr;
      }
      const { error: itemErr } = await supabase
        .from("coach_info_batch_items")
        .update({ review_status: "applied", reviewed_at: new Date().toISOString(), reviewed_by: user.id })
        .eq("id", item.id);
      if (itemErr) throw itemErr;
      setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, review_status: "applied" } : i)));
    } catch (err) {
      setReviewError(err.message || "Could not apply this suggestion.");
    } finally {
      setApplyingId(null);
    }
  }

  async function skipItem(item) {
    setApplyingId(item.id);
    setReviewError("");
    try {
      const { error } = await supabase
        .from("coach_info_batch_items")
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
        <div className="notice danger">Batch coach-info discovery is limited to Verification Staff and System Admins.</div>
      </div>
    );
  }

  const readyCount = items.filter((i) => i.fetch_status === "ready").length;
  const pendingFetchCount = items.filter((i) => i.fetch_status === "pending").length;
  const noContentCount = items.filter((i) => i.fetch_status === "no_content").length;
  const suggestedItems = items.filter((i) => i.suggestion);
  const pendingReview = suggestedItems.filter((i) => i.review_status === "pending");
  const reviewedItems = suggestedItems.filter((i) => i.review_status !== "pending");
  const failedItems = suggestedItems.filter((i) => i.suggestion_error);

  return (
    <div className="view">
      <Link href="/admin" className="btn btn-sm" style={{ marginBottom: 12, display: "inline-flex" }}>
        ← Back to Admin
      </Link>
      <div className="view-header">
        <div>
          <h1>Batch Coach-Info Discovery</h1>
          <p>Run "Suggest Coach Info (AI)" against many schools overnight via Anthropic's Batch API, then review and apply the suggestions here.</p>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <h3>Start a New Batch Run</h3>
        <p style={{ fontSize: 12.5, color: "#697386", marginTop: -4 }}>
          Pulls schools missing a head coach name that have an athletics or general website on file to search from -- schools with neither can't be helped by this tool.
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
          <label style={{ fontSize: 13, display: "flex", gap: 6, alignItems: "center" }}>
            <input type="checkbox" checked={requireAthletics} onChange={(e) => setRequireAthletics(e.target.checked)} />
            Require an Athletics URL on file (more accurate — skips schools with only a general website)
          </label>
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
                Step 1: fetch each school's page text and a web search, then save it. {readyCount} ready, {pendingFetchCount} not fetched yet, {noContentCount} found nothing usable.
              </p>
              <button className="btn btn-sm" onClick={fetchSources} disabled={fetching || loadingItems || pendingFetchCount === 0}>
                {fetching ? `Fetching ${fetchProgress.done} of ${fetchProgress.total}…` : pendingFetchCount === 0 ? "All Fetched" : `Fetch Source Text (${pendingFetchCount} schools)`}
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
                  {pendingReview.length} suggestion{pendingReview.length === 1 ? "" : "s"} to review, {reviewedItems.length} already reviewed, {failedItems.length} the AI couldn't produce a
                  suggestion for.
                </p>
                <label style={{ fontSize: 12.5, display: "flex", gap: 6, alignItems: "center" }}>
                  <input type="checkbox" checked={showReviewed} onChange={(e) => setShowReviewed(e.target.checked)} />
                  Show already-reviewed
                </label>
              </div>

              {reviewError && (
                <div className="notice danger" style={{ marginBottom: 10, fontSize: 12.5 }}>
                  {reviewError}
                </div>
              )}

              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {(showReviewed ? suggestedItems : pendingReview)
                  .filter((i) => !i.suggestion_error)
                  .map((item) => {
                    const s = item.school;
                    const sug = item.suggestion;
                    if (!s || !sug) return null;
                    const applying = applyingId === item.id;
                    const reviewed = item.review_status !== "pending";
                    return (
                      <div key={item.id} style={{ border: "1px solid #e3e6ea", borderRadius: 8, padding: 12, opacity: reviewed ? 0.6 : 1 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 6 }}>
                          <div>
                            <strong>{s.name}</strong>
                            <div style={{ fontSize: 12, color: "#697386" }}>
                              {s.city}, {s.state}
                            </div>
                          </div>
                          <span
                            className="badge"
                            style={{ fontSize: 11, color: sug.confidence === "high" ? "#1e7145" : sug.confidence === "medium" ? "#8a6100" : "#b3261e" }}
                          >
                            {sug.confidence} confidence
                          </span>
                        </div>

                        <div style={{ marginTop: 8, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, fontSize: 12.5 }}>
                          {SUGGESTION_FIELDS.map((f) => {
                            const current = s[f] || "";
                            const suggested = sug[f] || "";
                            if (!current && !suggested) return null;
                            const changed = suggested && suggested !== current;
                            return (
                              <div key={f}>
                                <div style={{ fontWeight: 600 }}>{FIELD_LABELS[f]}</div>
                                <div style={{ color: "#9aa1ab" }}>Current: {current || "(blank)"}</div>
                                <div style={{ color: changed ? "#1e7145" : "#697386", fontWeight: changed ? 600 : 400 }}>Suggested: {suggested || "(blank)"}</div>
                              </div>
                            );
                          })}
                        </div>
                        {sug.notes && (
                          <div style={{ marginTop: 8, fontSize: 12, fontStyle: "italic", color: "#697386" }}>
                            "{sug.notes}" — source: {sug.source}
                          </div>
                        )}

                        <div style={{ marginTop: 10, display: "flex", gap: 8 }}>
                          {reviewed ? (
                            <span style={{ fontSize: 12, fontWeight: 600, color: item.review_status === "applied" ? "#1e7145" : "#697386" }}>
                              {item.review_status === "applied" ? "✓ Applied" : "Skipped"}
                            </span>
                          ) : (
                            <>
                              <button className="btn btn-gold btn-sm" disabled={applying} onClick={() => applyItem(item)}>
                                {applying ? "Applying…" : "Apply"}
                              </button>
                              <button className="btn btn-sm" disabled={applying} onClick={() => skipItem(item)}>
                                Skip
                              </button>
                              <Link href={`/schools/${s.id}`} className="btn btn-sm">
                                Open Profile
                              </Link>
                            </>
                          )}
                        </div>
                      </div>
                    );
                  })}
                {!showReviewed && pendingReview.length === 0 && <div className="empty-state">Nothing left to review.</div>}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
