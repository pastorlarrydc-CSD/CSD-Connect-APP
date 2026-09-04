"use client";
import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { useAuth } from "@/lib/auth-context";

// Single-page health check across all four AI batch discovery tools --
// Coach-Info, Athletics-URL, MaxPreps, and Social Media. Built at Larry's
// request for "a single status dashboard across all four tools": before
// this, seeing where each tool stood meant opening all four
// /admin/batch-* pages separately and reading each one's own run list.
//
// Shows, per tool: the latest run's status, how many suggestions are
// waiting for review right now, lifetime applied/skipped totals, and one
// number none of the individual tool pages surface on their own -- the
// REMAINING POOL: how many schools in the six priority states (TX, FL,
// GA, CA, OH, IN) still match that tool's own candidate criteria and have
// never been touched by it before. That's the number that actually
// predicts whether next Monday's automated run will find anything to do.
//
// Remaining-pool counts come from batch_tool_pool_status(), a Postgres
// function (see the migration that created it) that mirrors each tool's
// own weekly cron candidate query exactly -- computed as one fast
// aggregate instead of downloading thousands of candidate rows into JS.
// The pool-depletion email alert added to app/api/cron/collect-batch-runs
// reads the exact same function, so this page and that alert can never
// quietly disagree about whether a tool is running low.
const WEEKLY_TARGET_COUNT = 300; // matches every weekly-*-batch cron's own per-run target -- used here only to describe "how many runs' worth is left" and to color-code pool health

const TOOLS = [
  {
    key: "coach_info",
    label: "Coach-Info",
    runsTable: "coach_info_batch_runs",
    itemsTable: "coach_info_batch_items",
    href: "/admin/batch-coach-info",
    criteria: "Coach name on file, missing email",
  },
  {
    key: "athletics",
    label: "Athletics-URL",
    runsTable: "athletics_batch_runs",
    itemsTable: "athletics_batch_items",
    href: "/admin/batch-athletics",
    criteria: "Missing an athletics-site URL",
  },
  {
    key: "maxpreps",
    label: "MaxPreps",
    runsTable: "maxpreps_batch_runs",
    itemsTable: "maxpreps_batch_items",
    href: "/admin/batch-maxpreps",
    criteria: "Missing a MaxPreps page URL",
  },
  {
    key: "social",
    label: "Social Media",
    runsTable: "social_batch_runs",
    itemsTable: "social_batch_items",
    href: "/admin/batch-social",
    criteria: "Coach name on file, missing Twitter/X or Facebook",
  },
];

// Same run-status labels/colors as each individual tool page's own
// StatusBadge (see e.g. app/(app)/admin/batch-coach-info/page.js) --
// duplicated rather than imported since that component lives inside a
// page file, not a shared lib.
const RUN_STATUS_LABELS = {
  collecting: ["Fetching sources", "#697386"],
  submitted: ["Submitted to Anthropic", "#2f5fa8"],
  processing: ["Processing", "#2f5fa8"],
  ready: ["Ready to collect", "#8a6100"],
  collected: ["Ready for review", "#1e7145"],
  error: ["Error", "#b3261e"],
};

function RunStatusBadge({ status }) {
  const [label, color] = RUN_STATUS_LABELS[status] || [status || "No runs yet", "#697386"];
  return (
    <span className="badge" style={{ color, background: `${color}1a`, fontWeight: 600 }}>
      {label}
    </span>
  );
}

// Three-tier read on "how much runway is left" -- healthy (3+ weekly runs
// worth), running low (1-2 runs left), and critical/exhausted (less than
// one run left, or literally zero) -- same threshold the pool-depletion
// email alert uses to decide when to fire.
function poolHealth(remaining) {
  if (remaining >= WEEKLY_TARGET_COUNT * 3) return { label: "Healthy", color: "#1e7145" };
  if (remaining >= WEEKLY_TARGET_COUNT) return { label: "Running low", color: "#8a6100" };
  return { label: remaining === 0 ? "Exhausted" : "Critical", color: "#b3261e" };
}

function timeAgo(iso) {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.round(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

export default function BatchStatusPage() {
  const supabase = getSupabaseBrowserClient();
  const { profile } = useAuth();
  const canReview = profile?.role === "verifier" || profile?.role === "sysadmin";

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [rows, setRows] = useState({}); // tool key -> { latestRun, pending, applied, skipped, errors, remainingPool, totalTouched }

  const load = useCallback(async () => {
    if (!canReview) return;
    setLoading(true);
    setError("");
    try {
      const { data: poolRows, error: poolErr } = await supabase.rpc("batch_tool_pool_status");
      if (poolErr) throw poolErr;
      const poolByKey = new Map((poolRows || []).map((r) => [r.tool_key, r]));

      const results = await Promise.all(
        TOOLS.map(async (tool) => {
          const [{ data: latestRuns }, { count: pending }, { count: applied }, { count: skipped }, { count: errors }] = await Promise.all([
            supabase.from(tool.runsTable).select("*").order("created_at", { ascending: false }).limit(1),
            supabase
              .from(tool.itemsTable)
              .select("id", { count: "exact", head: true })
              .eq("review_status", "pending")
              .not("suggestion", "is", null)
              .is("suggestion_error", null),
            supabase.from(tool.itemsTable).select("id", { count: "exact", head: true }).eq("review_status", "applied"),
            supabase.from(tool.itemsTable).select("id", { count: "exact", head: true }).eq("review_status", "skipped"),
            supabase.from(tool.itemsTable).select("id", { count: "exact", head: true }).not("suggestion_error", "is", null),
          ]);
          const pool = poolByKey.get(tool.key);
          return [
            tool.key,
            {
              latestRun: latestRuns?.[0] || null,
              pending: pending || 0,
              applied: applied || 0,
              skipped: skipped || 0,
              errors: errors || 0,
              remainingPool: pool ? Number(pool.remaining_pool) : null,
              totalTouched: pool ? Number(pool.total_touched) : null,
            },
          ];
        })
      );
      setRows(Object.fromEntries(results));
    } catch (err) {
      setError(err.message || "Could not load batch discovery status.");
    } finally {
      setLoading(false);
    }
  }, [supabase, canReview]);

  useEffect(() => {
    load();
  }, [load]);

  if (!canReview) {
    return (
      <div className="view">
        <div className="notice danger">Batch discovery status is limited to Verification Staff and System Admins.</div>
      </div>
    );
  }

  const criticalTools = TOOLS.filter((t) => rows[t.key] && rows[t.key].remainingPool !== null && rows[t.key].remainingPool < WEEKLY_TARGET_COUNT);
  const totalPending = TOOLS.reduce((sum, t) => sum + (rows[t.key]?.pending || 0), 0);

  return (
    <div className="view">
      <Link href="/admin" className="btn btn-sm" style={{ marginBottom: 12, display: "inline-flex" }}>
        ← Back to Admin
      </Link>
      <div className="view-header">
        <div>
          <h1>Batch Discovery Status</h1>
          <p>One-page health check across all four AI discovery tools — Coach-Info, Athletics-URL, MaxPreps, and Social Media</p>
        </div>
        <button className="btn btn-sm" onClick={load} disabled={loading}>
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {error && (
        <div className="notice danger" style={{ marginBottom: 14 }}>
          {error}
        </div>
      )}

      {!loading && criticalTools.length > 0 && (
        <div className="notice danger" style={{ marginBottom: 14 }}>
          <strong>
            {criticalTools.length} tool{criticalTools.length === 1 ? "" : "s"} running low or out of eligible schools
          </strong>{" "}
          in the six priority states (TX, FL, GA, CA, OH, IN): {criticalTools.map((t) => t.label).join(", ")}. The "Remaining pool" number on each card
          below shows exactly how many schools are left -- a tool at 0 will keep coming back empty on its weekly automated run until it's given more
          states or a wider search to work with.
        </div>
      )}

      {!loading && totalPending > 0 && (
        <div className="notice" style={{ marginBottom: 14 }}>
          <strong>
            {totalPending} suggestion{totalPending === 1 ? "" : "s"}
          </strong>{" "}
          waiting for review across all four tools.
        </div>
      )}

      <div className="grid grid-4">
        {TOOLS.map((tool) => {
          const r = rows[tool.key] || {};
          const health = r.remainingPool != null ? poolHealth(r.remainingPool) : null;
          const run = r.latestRun;
          const runsWorthLeft = r.remainingPool != null ? Math.floor(r.remainingPool / WEEKLY_TARGET_COUNT) : null;

          return (
            <div className="card" key={tool.key}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8, gap: 8 }}>
                <h3 style={{ margin: 0 }}>{tool.label}</h3>
                <Link href={tool.href} className="btn btn-sm btn-primary">
                  Open
                </Link>
              </div>

              <div style={{ marginBottom: 10, minHeight: 40 }}>
                {loading && !run ? (
                  <span className="badge" style={{ color: "#697386", background: "#6973861a" }}>
                    Loading…
                  </span>
                ) : (
                  <RunStatusBadge status={run?.status} />
                )}
                {run ? (
                  <div style={{ fontSize: 12, color: "#697386", marginTop: 4 }}>
                    Run #{run.id} started {timeAgo(run.created_at)}
                    {run.requested_count ? ` — ${run.requested_count} requested` : ""}
                    {run.error_message ? <div style={{ color: "#b3261e", marginTop: 2 }}>{run.error_message}</div> : null}
                  </div>
                ) : (
                  !loading && <div style={{ fontSize: 12, color: "#697386", marginTop: 4 }}>No runs yet.</div>
                )}
              </div>

              <div className="kv" style={{ gridTemplateColumns: "auto 1fr", fontSize: 12.5, marginBottom: 10 }}>
                <div className="k">Needs review</div>
                <div className="v">
                  {r.pending > 0 ? (
                    <Link href={tool.href} style={{ color: "#b3261e" }}>
                      {r.pending} waiting
                    </Link>
                  ) : (
                    "0 waiting"
                  )}
                </div>
                <div className="k">Applied</div>
                <div className="v" style={{ fontWeight: 400 }}>
                  {r.applied ?? 0}
                </div>
                <div className="k">Skipped</div>
                <div className="v" style={{ fontWeight: 400 }}>
                  {r.skipped ?? 0}
                </div>
                {r.errors > 0 && (
                  <>
                    <div className="k">Errors</div>
                    <div className="v" style={{ fontWeight: 400, color: "#b3261e" }}>
                      {r.errors}
                    </div>
                  </>
                )}
              </div>

              <div style={{ borderTop: "1px solid #eef0f3", paddingTop: 10 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                  <span style={{ fontSize: 11, fontWeight: 700, color: "#697386", textTransform: "uppercase" }}>Remaining pool</span>
                  {health && (
                    <span className="badge" style={{ color: health.color, background: `${health.color}1a` }}>
                      {health.label}
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 22, fontWeight: 800, color: "#131a2b" }}>{r.remainingPool != null ? r.remainingPool.toLocaleString() : "…"}</div>
                <div style={{ fontSize: 11.5, color: "#697386" }}>
                  {runsWorthLeft != null ? `~${runsWorthLeft} more weekly run${runsWorthLeft === 1 ? "" : "s"} at ${WEEKLY_TARGET_COUNT}/run` : ""}
                  {r.totalTouched != null ? ` · ${r.totalTouched.toLocaleString()} touched lifetime` : ""}
                </div>
                <div style={{ fontSize: 11, color: "#9aa3b2", marginTop: 4 }}>{tool.criteria} — TX/FL/GA/CA/OH/IN</div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
