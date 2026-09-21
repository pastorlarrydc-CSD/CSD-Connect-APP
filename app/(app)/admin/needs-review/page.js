// app/(app)/admin/needs-review/page.js
"use client";

import { useState, useEffect, useCallback, Suspense } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { useAuth } from "@/lib/auth-context";

// Same six states Batch Coach-Info Discovery treats as priority recruiting
// states (kept as a local const there too, so mirroring that here).
const PRIORITY_STATES = ["TX", "FL", "GA", "CA", "OH", "IN"];

function pctColor(pct) {
  if (pct >= 50) return "#1e7145"; // var(--green)
  if (pct >= 20) return "#b8860b"; // var(--amber)
  return "#b3261e"; // var(--red)
}

function CoverageBar({ pct }) {
  return (
    <div style={{ width: "100%", background: "#eef0f3", borderRadius: 999, height: 8 }}>
      <div
        style={{
          width: `${Math.min(pct, 100)}%`,
          background: pctColor(pct),
          height: 8,
          borderRadius: 999,
        }}
      />
    </div>
  );
}

function NeedsReviewPageInner() {
  const supabase = getSupabaseBrowserClient();
  const { profile } = useAuth();
  const canReview = profile?.role === "verifier" || profile?.role === "sysadmin";
  const searchParams = useSearchParams();
  // Lets State Progress's "Review →" link (on the new Marked Reviewed
  // column) jump straight into this state's queue instead of landing on
  // the state-picker list.
  const stateFromUrl = searchParams.get("state");

  const [states, setStates] = useState([]);
  const [loadingStates, setLoadingStates] = useState(true);
  const [selectedState, setSelectedState] = useState(null);
  const [schools, setSchools] = useState([]);
  const [loadingSchools, setLoadingSchools] = useState(false);
  const [reviewedToday, setReviewedToday] = useState(0);
  const [confirmingId, setConfirmingId] = useState(null);
  const [priorityOnly, setPriorityOnly] = useState(true);
  const [error, setError] = useState("");

  const authedFetch = useCallback(
    async (url, options = {}) => {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      return fetch(url, {
        ...options,
        headers: {
          ...(options.headers || {}),
          Authorization: `Bearer ${session?.access_token}`,
        },
      });
    },
    [supabase]
  );

  const loadStates = useCallback(async () => {
    setLoadingStates(true);
    setError("");
    try {
      const res = await authedFetch("/api/admin/needs-review");
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Could not load state coverage.");
      setStates(json.states || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoadingStates(false);
    }
  }, [authedFetch]);

  useEffect(() => {
    if (canReview) loadStates();
  }, [canReview, loadStates]);

  const loadState = useCallback(
    async (state) => {
      setSelectedState(state);
      setLoadingSchools(true);
      setError("");
      try {
        const res = await authedFetch(`/api/admin/needs-review?state=${state}`);
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || "Could not load this state's queue.");
        setSchools(json.schools || []);
        setReviewedToday(json.reviewed_today || 0);
      } catch (err) {
        setError(err.message);
      } finally {
        setLoadingSchools(false);
      }
    },
    [authedFetch]
  );

  useEffect(() => {
    if (canReview && stateFromUrl) loadState(stateFromUrl.toUpperCase());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canReview, stateFromUrl]);

  const confirmAccurate = async (schoolId) => {
    setConfirmingId(schoolId);
    setError("");
    try {
      const res = await authedFetch("/api/admin/needs-review/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ school_id: schoolId }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Could not save this confirmation.");

      setSchools((prev) => prev.filter((s) => s.id !== schoolId));
      setReviewedToday((prev) => prev + 1);
      setStates((prev) =>
        prev.map((s) =>
          s.state === selectedState
            ? {
                ...s,
                ever_reviewed: s.ever_reviewed + 1,
                never_reviewed: s.never_reviewed - 1,
                pct_reviewed: ((100 * (s.ever_reviewed + 1)) / s.total_schools).toFixed(1),
              }
            : s
        )
      );
    } catch (err) {
      setError(err.message);
    } finally {
      setConfirmingId(null);
    }
  };

  if (!canReview) {
    return (
      <div className="view">
        <div className="notice danger">The Needs Review queue is limited to Verification Staff and System Admins.</div>
      </div>
    );
  }

  const visibleStates = priorityOnly ? states.filter((s) => PRIORITY_STATES.includes(s.state)) : states;
  // Live "how many are left" counters -- the whole point of a queue is
  // knowing when you're done with it, not just what % complete it is.
  const totalRemaining = visibleStates.reduce((sum, s) => sum + (s.never_reviewed || 0), 0);
  const selectedStateSummary = selectedState ? states.find((s) => s.state === selectedState) : null;
  const remainingInSelectedState = selectedStateSummary ? selectedStateSummary.never_reviewed : schools.length;

  return (
    <div className="view">
      <Link href="/admin" className="btn btn-sm" style={{ marginBottom: 12, display: "inline-flex" }}>
        ← Back to Admin
      </Link>
      <div className="view-header">
        <div>
          <h1>Needs Review</h1>
          <p>
            Which schools have never had their coach name, email, cell, or office phone specifically re-checked
            since import — by state, oldest/never-checked first.
          </p>
        </div>
      </div>

      {error && (
        <div className="notice danger" style={{ marginBottom: 14 }}>
          {error}
        </div>
      )}

      {!selectedState && (
        <div className="card" style={{ marginBottom: 14 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
            <h3 style={{ margin: 0 }}>Coverage by state</h3>
            <label style={{ fontSize: 13, display: "flex", gap: 6, alignItems: "center" }}>
              <input type="checkbox" checked={priorityOnly} onChange={(e) => setPriorityOnly(e.target.checked)} />
              Priority recruiting states only ({PRIORITY_STATES.join(", ")})
            </label>
          </div>

          {!loadingStates && visibleStates.length > 0 && (
            <div style={{ fontSize: 12.5, color: "#697386", marginTop: 8 }}>
              <strong style={{ color: totalRemaining > 0 ? "#b3261e" : "#1e7145" }}>{totalRemaining.toLocaleString()}</strong>{" "}
              {totalRemaining === 1 ? "school" : "schools"} still left to verify{priorityOnly ? " across the priority states" : ""}.
            </div>
          )}

          {loadingStates ? (
            <div className="empty-state">Loading…</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 10 }}>
              {visibleStates.map((s) => (
                <div
                  key={s.state}
                  onClick={() => loadState(s.state)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 14,
                    padding: "9px 10px",
                    border: "1px solid #e3e6ea",
                    borderRadius: 8,
                    cursor: "pointer",
                  }}
                >
                  <span style={{ width: 34, fontWeight: 700 }}>{s.state}</span>
                  <span style={{ width: 150, fontSize: 12.5, color: "#697386" }}>
                    {s.ever_reviewed}/{s.total_schools} checked
                    {s.never_reviewed > 0 && <span style={{ color: "#b3261e", fontWeight: 600 }}> · {s.never_reviewed} left</span>}
                  </span>
                  <span style={{ flex: 1 }}>
                    <CoverageBar pct={parseFloat(s.pct_reviewed)} />
                  </span>
                  <span style={{ width: 54, textAlign: "right", fontSize: 12.5, fontWeight: 700 }}>
                    {s.pct_reviewed}%
                  </span>
                  {s.is_priority_state && (
                    <span className="badge" style={{ color: "#1c5fb3", background: "#e7effc" }}>
                      ICP
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {selectedState && (
        <div className="card" style={{ marginBottom: 14 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, flexWrap: "wrap", gap: 8 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <h3 style={{ margin: 0 }}>{selectedState} — review queue</h3>
              {!loadingSchools && (
                <span
                  className="badge"
                  style={{
                    color: remainingInSelectedState > 0 ? "#b3261e" : "#1e7145",
                    background: remainingInSelectedState > 0 ? "#fdeeed" : "#e9f5ee",
                    fontWeight: 700,
                  }}
                >
                  {remainingInSelectedState} left to verify
                </span>
              )}
              {!loadingSchools && reviewedToday > 0 && (
                <span className="badge" style={{ color: "#1e7145", background: "#e9f5ee", fontWeight: 700 }}>
                  ✓ {reviewedToday} confirmed today
                </span>
              )}
            </div>
            <button className="btn btn-sm" onClick={() => setSelectedState(null)}>
              ← All states
            </button>
          </div>

          {loadingSchools ? (
            <div className="empty-state">Loading…</div>
          ) : schools.length === 0 ? (
            <div className="empty-state">
              Nothing left to check in {selectedState} — nice.
              {reviewedToday > 0 && (
                <div style={{ marginTop: 6, fontSize: 12.5, color: "#1e7145", fontWeight: 600 }}>✓ {reviewedToday} confirmed today.</div>
              )}
            </div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>School</th>
                  <th>Coach</th>
                  <th>Email</th>
                  <th>Cell</th>
                  <th>Office</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {schools.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <Link href={`/schools/${s.id}`}>{s.name}</Link>
                      <div style={{ fontSize: 11.5, color: "#697386" }}>{s.city}</div>
                    </td>
                    <td>
                      {s.hc_first_name || s.hc_last_name ? (
                        `${s.hc_first_name ?? ""} ${s.hc_last_name ?? ""}`.trim()
                      ) : (
                        <span style={{ color: "#a2a9b6" }}>—</span>
                      )}
                    </td>
                    <td>{s.hc_email || <span style={{ color: "#a2a9b6" }}>—</span>}</td>
                    <td>{s.hc_cell || <span style={{ color: "#a2a9b6" }}>—</span>}</td>
                    <td>{s.hc_office || <span style={{ color: "#a2a9b6" }}>—</span>}</td>
                    <td>
                      {/* Every row here is guaranteed never_reviewed=true -- the API now
                          filters out anything already confirmed, so this queue only ever
                          shows what's actually still outstanding. */}
                      <span className="badge" style={{ color: "#b3261e", background: "#fdeeed" }}>
                        Never checked
                      </span>
                    </td>
                    <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                      <button
                        className="btn btn-sm"
                        style={{ background: "#1e7145", color: "#fff", borderColor: "#1e7145" }}
                        onClick={() => confirmAccurate(s.id)}
                        disabled={confirmingId === s.id}
                      >
                        {confirmingId === s.id ? "Saving…" : "Confirmed accurate"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {/* Repeats the counter after the table too, so it's visible without
              scrolling back up once the list runs longer than one screen. */}
          {!loadingSchools && schools.length > 0 && (
            <div style={{ marginTop: 10, fontSize: 12.5, color: "#697386" }}>
              <strong style={{ color: "#b3261e" }}>{remainingInSelectedState}</strong> left to verify in {selectedState}
              {reviewedToday > 0 && (
                <>
                  {" "}
                  · <strong style={{ color: "#1e7145" }}>✓ {reviewedToday}</strong> confirmed today
                </>
              )}
              .
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function NeedsReviewPage() {
  return (
    <Suspense fallback={<div className="view"><div className="empty-state">Loading…</div></div>}>
      <NeedsReviewPageInner />
    </Suspense>
  );
}
