// app/(app)/admin/needs-review/page.js
"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
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

export default function NeedsReviewPage() {
  const supabase = getSupabaseBrowserClient();
  const { profile } = useAuth();
  const canReview = profile?.role === "verifier" || profile?.role === "sysadmin";

  const [states, setStates] = useState([]);
  const [loadingStates, setLoadingStates] = useState(true);
  const [selectedState, setSelectedState] = useState(null);
  const [schools, setSchools] = useState([]);
  const [loadingSchools, setLoadingSchools] = useState(false);
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
      } catch (err) {
        setError(err.message);
      } finally {
        setLoadingSchools(false);
      }
    },
    [authedFetch]
  );

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
                  <span style={{ width: 130, fontSize: 12.5, color: "#697386" }}>
                    {s.ever_reviewed}/{s.total_schools} checked
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
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
            <h3 style={{ margin: 0 }}>{selectedState} — review queue</h3>
            <button className="btn btn-sm" onClick={() => setSelectedState(null)}>
              ← All states
            </button>
          </div>

          {loadingSchools ? (
            <div className="empty-state">Loading…</div>
          ) : schools.length === 0 ? (
            <div className="empty-state">Nothing left to check in {selectedState} — nice.</div>
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
                      {s.never_reviewed ? (
                        <span className="badge" style={{ color: "#b3261e", background: "#fdeeed" }}>
                          Never checked
                        </span>
                      ) : (
                        <span className="badge" style={{ color: "#b8860b", background: "#fff8e8" }}>
                          {s.days_since_review}d ago
                        </span>
                      )}
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
        </div>
      )}
    </div>
  );
}
