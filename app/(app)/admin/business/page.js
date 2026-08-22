"use client";
import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { useAuth } from "@/lib/auth-context";

// Same subscription_status vocabulary as app/(app)/billing/page.js --
// kept in sync with that file rather than importing from it, since that
// page's copy is written for a customer reading their own status and this
// one is written for Larry reading everyone's.
const STATUS_LABEL = {
  no_subscription: "No subscription",
  trialing: "Trialing",
  active: "Active",
  past_due: "Past due",
  canceled: "Canceled",
  unpaid: "Unpaid",
  internal: "Internal",
};
const STATUS_BADGE = {
  no_subscription: "badge-not-contacted",
  trialing: "badge-unverified",
  active: "badge-public",
  past_due: "badge-private",
  canceled: "badge-not-contacted",
  unpaid: "badge-private",
  internal: "badge-contacted",
};

const LEAD_STATUS_LABEL = {
  not_contacted: "Not Contacted",
  contacted: "Contacted",
  interested: "Interested",
  trial: "Trial",
  customer: "Customer",
  not_interested: "Not Interested",
};

function fmtMoney(cents) {
  if (cents === null || cents === undefined) return "—";
  return (cents / 100).toLocaleString(undefined, { style: "currency", currency: "USD", minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function fmtDate(d) {
  if (!d) return "—";
  return new Date(d).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export default function BusinessDashboardPage() {
  const supabase = getSupabaseBrowserClient();
  const { profile } = useAuth();
  const isOwner = profile?.role === "sysadmin";

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    if (!isOwner) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError("");
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const res = await fetch("/api/admin/business-dashboard", {
        headers: { Authorization: `Bearer ${session?.access_token}` },
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Could not load the business dashboard.");
      setData(json);
    } catch (err) {
      setError(err.message || "Could not load the business dashboard.");
    } finally {
      setLoading(false);
    }
  }, [supabase, isOwner]);

  useEffect(() => {
    load();
  }, [load]);

  if (!isOwner) {
    return (
      <div className="view">
        <div className="notice danger">The business dashboard is limited to System Admins.</div>
      </div>
    );
  }

  const sortedColleges = data
    ? [...data.colleges].sort((a, b) => {
        if (a.isDormant !== b.isDormant) return a.isDormant ? -1 : 1;
        return (a.name || "").localeCompare(b.name || "");
      })
    : [];

  return (
    <div className="view">
      <Link href="/admin" className="btn btn-sm" style={{ marginBottom: 12, display: "inline-flex" }}>
        ← Back to Admin
      </Link>
      <div className="view-header">
        <div>
          <h1>Business Dashboard</h1>
          <p>Revenue, customer health, and pipeline — your whole business at a glance. Not visible to customers.</p>
        </div>
        <button className="btn btn-sm" onClick={load} disabled={loading}>
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {error && <div className="notice danger" style={{ marginBottom: 14 }}>{error}</div>}

      {loading && !data ? (
        <div className="empty-state">Loading…</div>
      ) : data ? (
        <>
          {data.dormantCount > 0 && (
            <div className="notice danger" style={{ marginBottom: 14 }}>
              <strong>{data.dormantCount}</strong> paying college{data.dormantCount === 1 ? "" : "s"} {data.dormantCount === 1 ? "hasn't" : "haven't"} logged in within the last 30 days — a churn risk worth a personal check-in. See the table below.
            </div>
          )}

          <div className="grid grid-4" style={{ marginBottom: 14 }}>
            <div className="card stat-card">
              <div className="label">MRR</div>
              <div className="num">{fmtMoney(data.mrrCents)}</div>
              <div className="sub">{data.activeCount} active customer{data.activeCount === 1 ? "" : "s"}</div>
            </div>
            <div className="card stat-card">
              <div className="label">Trialing</div>
              <div className="num">{data.trialingCount}</div>
              <div className="sub">in their free trial</div>
            </div>
            <div className="card stat-card">
              <div className="label">Dormant</div>
              <div className="num" style={{ color: data.dormantCount > 0 ? "var(--red)" : undefined }}>{data.dormantCount}</div>
              <div className="sub">paying, quiet 30+ days</div>
            </div>
            <div className="card stat-card">
              <div className="label">Past Due / Canceled</div>
              <div className="num">{data.pastDueCount + data.canceledCount}</div>
              <div className="sub">{data.pastDueCount} past due · {data.canceledCount} canceled</div>
            </div>
          </div>

          <div className="grid grid-2" style={{ marginBottom: 14 }}>
            <div className="card">
              <h3>Sales Pipeline</h3>
              <div className="kv" style={{ marginBottom: 10 }}>
                {Object.entries(LEAD_STATUS_LABEL).map(([key, label]) => (
                  <div key={key} style={{ display: "contents" }}>
                    <div className="k">{label}</div>
                    <div className="v">{data.pipelineCounts?.[key] ?? 0}</div>
                  </div>
                ))}
              </div>
              <Link href="/admin/leads" className="btn btn-sm btn-primary">
                Open College Outreach →
              </Link>
            </div>
            <div className="card">
              <h3>Product Activity (30 days)</h3>
              <div className="stat-card" style={{ marginBottom: 10 }}>
                <div className="num">{data.recentContactCount}</div>
                <div className="sub">contact-log entries recorded across all colleges in the last 30 days</div>
              </div>
              <div className="notice info">
                {data.recentContactCount > 0
                  ? "Customers are actively logging outreach in CoachConnect."
                  : "No contact activity logged anywhere in the last 30 days — worth checking whether customers are actually using the CRM."}
              </div>
            </div>
          </div>

          <div className="card">
            <h3>Colleges ({data.totalColleges})</h3>
            {sortedColleges.length ? (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>College</th>
                      <th>Division / State</th>
                      <th>Status</th>
                      <th>Staff</th>
                      <th>Last Active</th>
                      <th>Trial Ends / Renews</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedColleges.map((c) => (
                      <tr key={c.id}>
                        <td>
                          <strong>{c.name}</strong>
                          {c.isDormant && <div style={{ fontSize: 11, color: "var(--red)", fontWeight: 700 }}>Dormant</div>}
                        </td>
                        <td>{[c.division, c.state].filter(Boolean).join(", ") || "—"}</td>
                        <td>
                          <span className={STATUS_BADGE[c.subscription_status] || "badge-not-contacted"} style={{ padding: "2px 8px", borderRadius: 20, fontSize: 11, fontWeight: 700 }}>
                            {STATUS_LABEL[c.subscription_status] || c.subscription_status}
                          </span>
                        </td>
                        <td>{c.staffCount}</td>
                        <td>{c.lastActiveAt ? `${fmtDate(c.lastActiveAt)} (${c.daysSinceActive}d ago)` : "Never"}</td>
                        <td>{fmtDate(c.trial_ends_at || c.current_period_end)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="empty-state">No colleges yet.</div>
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}
