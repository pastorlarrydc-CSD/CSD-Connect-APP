"use client";

// State Progress -- a single cross-tool view of exactly what's still
// missing, by state, across all five data types the batch/bulk discovery
// tools chase (coach name, email, athletics URL, MaxPreps URL, social
// media). Built in response to Larry's ask: pick a state, see what's left,
// jump straight into the right batch tool already scoped to clear it --
// instead of typing a state code into each tool's "custom states" box with
// no idea how much is actually left there.
//
// Reads state_data_coverage (a Postgres view created directly in Supabase)
// via /api/admin/state-coverage. That view mirrors each batch tool's own
// default eligibility filter (same field-blank + not_available + closed +
// verification_status checks) but deliberately leaves out each tool's own
// "already attempted before" exclusion -- this page measures genuine data
// gaps, not run history, so a school a tool searched and came up empty on
// still counts here as still-needed (see the view's own comment in the
// migration for the full reasoning).
import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { useAuth } from "@/lib/auth-context";

const PRIORITY_STATES = ["TX", "FL", "GA", "CA", "OH", "IN"];

// Each column: which state_data_coverage field it reads, its label, and
// where "Focus this state" should send you. Coach-Info has two distinct
// candidate modes (no coach name at all vs. name-but-no-email) so it gets
// two focus targets sharing one underlying gap type split by field.
const METRICS = [
  { key: "needs_coach_name", label: "Coach Name", short: "Coach", href: (state) => `/admin/batch-coach-info?state=${state}&mode=no_name` },
  { key: "needs_email", label: "Email", short: "Email", href: (state) => `/admin/batch-coach-info?state=${state}&mode=missing_email` },
  { key: "needs_athletics_url", label: "Athletics URL", short: "Athletics", href: (state) => `/admin/batch-athletics?state=${state}` },
  { key: "needs_maxpreps_url", label: "MaxPreps URL", short: "MaxPreps", href: (state) => `/admin/batch-maxpreps?state=${state}` },
  { key: "needs_social", label: "Social Media", short: "Social", href: (state) => `/admin/batch-social?state=${state}` },
];

function neededColor(count) {
  if (!count) return "#1e7145"; // nothing left -- green
  if (count < 25) return "#b8860b"; // a handful left -- amber
  return "#b3261e"; // a real gap -- red
}

function MetricCell({ count, total, state, metric }) {
  const pct = total ? Math.round((100 * count) / total) : 0;
  return (
    <td style={{ padding: "8px 10px", textAlign: "center", borderLeft: "1px solid #eef0f3" }}>
      <div style={{ fontWeight: 700, color: neededColor(count), fontSize: 14 }}>{count}</div>
      <div style={{ fontSize: 10.5, color: "#9aa1ab" }}>{count > 0 ? `${pct}% of state` : "complete"}</div>
      {count > 0 && (
        <Link href={metric.href(state)} className="btn btn-sm" style={{ marginTop: 4, fontSize: 11, padding: "2px 8px" }}>
          Focus →
        </Link>
      )}
    </td>
  );
}

export default function StateProgressPage() {
  const supabase = getSupabaseBrowserClient();
  const { profile } = useAuth();
  const canReview = profile?.role === "verifier" || profile?.role === "sysadmin";

  const [states, setStates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [priorityOnly, setPriorityOnly] = useState(false);
  // Which column drives the sort -- defaults to Social since that's the
  // one data type still meaningfully incomplete almost everywhere today
  // (coach name/email/athletics/MaxPreps are already ~fully covered from
  // the original import plus the weekly automated sweeps). Clicking any
  // column header re-sorts by that metric instead, in case that balance
  // shifts later or Larry wants to attack a different gap first.
  const [sortKey, setSortKey] = useState("needs_social");

  const authedFetch = useCallback(
    async (url, options = {}) => {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      return fetch(url, {
        ...options,
        headers: { ...(options.headers || {}), Authorization: `Bearer ${session?.access_token}` },
      });
    },
    [supabase]
  );

  const loadStates = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await authedFetch("/api/admin/state-coverage");
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Could not load state coverage.");
      setStates(json.states || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [authedFetch]);

  useEffect(() => {
    if (canReview) loadStates();
  }, [canReview, loadStates]);

  if (!canReview) {
    return (
      <div className="view">
        <div className="notice danger">State Progress is limited to Verification Staff and System Admins.</div>
      </div>
    );
  }

  const visibleStates = (priorityOnly ? states.filter((s) => PRIORITY_STATES.includes(s.state)) : states)
    .slice()
    .sort((a, b) => (b[sortKey] || 0) - (a[sortKey] || 0) || (b.total_open || 0) - (a.total_open || 0));

  const totals = METRICS.reduce((acc, m) => {
    acc[m.key] = states.reduce((sum, s) => sum + (s[m.key] || 0), 0);
    return acc;
  }, {});
  const totalOpen = states.reduce((sum, s) => sum + (s.total_open || 0), 0);

  return (
    <div className="view">
      <Link href="/admin" className="btn btn-sm" style={{ marginBottom: 12, display: "inline-flex" }}>
        ← Back to Admin
      </Link>
      <div className="view-header">
        <div>
          <h1>State Progress</h1>
          <p>
            What's still genuinely missing, state by state, across coach name, email, athletics URL, MaxPreps URL, and social media -- pick a state, see the real gap, and jump straight
            into the right batch tool sized to clear it in one run.
          </p>
        </div>
      </div>

      {error && (
        <div className="notice danger" style={{ marginBottom: 14 }}>
          {error}
        </div>
      )}

      <div className="card" style={{ marginBottom: 14 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
          <h3 style={{ margin: 0 }}>Coverage by state</h3>
          <label style={{ fontSize: 13, display: "flex", gap: 6, alignItems: "center" }}>
            <input type="checkbox" checked={priorityOnly} onChange={(e) => setPriorityOnly(e.target.checked)} />
            Priority recruiting states only ({PRIORITY_STATES.join(", ")})
          </label>
        </div>

        {!loading && states.length > 0 && (
          <div style={{ fontSize: 12, color: "#697386", marginBottom: 10 }}>
            Across {states.length} states / {totalOpen.toLocaleString()} open schools: <strong>{totals.needs_coach_name}</strong> missing a coach name,{" "}
            <strong>{totals.needs_email}</strong> missing an email, <strong>{totals.needs_athletics_url}</strong> missing an athletics URL, <strong>{totals.needs_maxpreps_url}</strong>{" "}
            missing a MaxPreps URL, and <strong>{totals.needs_social}</strong> missing a social handle.
          </div>
        )}

        {loading ? (
          <div className="empty-state">Loading…</div>
        ) : visibleStates.length === 0 ? (
          <div className="empty-state">No states to show.</div>
        ) : (
          <div className="table-wrap">
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
              <thead>
                <tr style={{ borderBottom: "2px solid #e3e6ea", textAlign: "left" }}>
                  <th style={{ padding: "6px 10px" }}>State</th>
                  <th style={{ padding: "6px 10px", textAlign: "center" }}>Open Schools</th>
                  {METRICS.map((m) => (
                    <th
                      key={m.key}
                      onClick={() => setSortKey(m.key)}
                      style={{ padding: "6px 10px", textAlign: "center", borderLeft: "1px solid #eef0f3", cursor: "pointer", color: sortKey === m.key ? "#0b5fff" : undefined }}
                      title="Click to sort by this column"
                    >
                      {m.short}
                      {sortKey === m.key ? " ▾" : ""}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visibleStates.map((s) => (
                  <tr key={s.state} style={{ borderBottom: "1px solid #eef0f3" }}>
                    <td style={{ padding: "8px 10px" }}>
                      <strong>{s.state}</strong>
                      {PRIORITY_STATES.includes(s.state) && (
                        <span className="badge" style={{ marginLeft: 6, fontSize: 10, color: "#1c5fb3", background: "#e7effc" }}>
                          ICP
                        </span>
                      )}
                    </td>
                    <td style={{ padding: "8px 10px", textAlign: "center", color: "#697386" }}>{s.total_open}</td>
                    {METRICS.map((m) => (
                      <MetricCell key={m.key} count={s[m.key] || 0} total={s.total_open} state={s.state} metric={m} />
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
