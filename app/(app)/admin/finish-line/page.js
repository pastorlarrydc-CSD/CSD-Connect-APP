"use client";

// Finish Line -- one page that answers "what is actually left?" so nothing has
// to be hunted for across five tools.
//
// A school is "left" when it is not verified, or verified but flagged for
// review. The page shows the total, a bar per state, and -- open a state -- ONE
// CARD PER SCHOOL with everything waiting for it in one place (its flag and
// reason, the AI coach answer with the proof the AI showed, and any athletics /
// MaxPreps / social finds). Finished states drop out of the way.
//
// Read-only on purpose: every button here is a link into the tool that already
// does the work (Batch Coach-Info, Needs Review, the school record). Data comes
// from /api/admin/finish-line (finish_line_state_summary view + per-state cards).
import { Suspense, useState, useEffect, useCallback, useMemo } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { useAuth } from "@/lib/auth-context";
import { Headline, NextMove, nextMove, SprintPlan, buildSprintPlan, StateRow, SchoolCard, LANES, fmt } from "@/components/FinishLineParts";

const PAGE_SIZE = 100;

function FinishLineInner() {
  const supabase = getSupabaseBrowserClient();
  const { profile } = useAuth();
  const canReview = profile?.role === "verifier" || profile?.role === "sysadmin";
  const searchParams = useSearchParams();

  const [states, setStates] = useState([]);
  const [history, setHistory] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [sortKey, setSortKey] = useState("smallest"); // "smallest" | "biggest" | "priority"
  const [openState, setOpenState] = useState(() => (searchParams.get("state") || "").toUpperCase() || null);
  const [lists, setLists] = useState({}); // state -> { loading, error, data }
  const [laneFilter, setLaneFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [shown, setShown] = useState(PAGE_SIZE);

  const authedFetch = useCallback(
    async (url) => {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      return fetch(url, { headers: { Authorization: `Bearer ${session?.access_token}` } });
    },
    [supabase]
  );

  const loadStates = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await authedFetch("/api/admin/finish-line");
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Could not load the Finish Line.");
      setStates(json.states || []);
      setHistory(json.history || null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [authedFetch]);

  useEffect(() => {
    if (canReview) loadStates();
  }, [canReview, loadStates]);

  const loadList = useCallback(
    async (code, force = false) => {
      setLists((prev) => (!force && prev[code]?.data ? prev : { ...prev, [code]: { loading: true, error: "", data: prev[code]?.data || null } }));
      try {
        const res = await authedFetch(`/api/admin/finish-line?state=${encodeURIComponent(code)}`);
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || "Could not load this state.");
        setLists((prev) => ({ ...prev, [code]: { loading: false, error: "", data: json } }));
      } catch (err) {
        setLists((prev) => ({ ...prev, [code]: { loading: false, error: err.message, data: prev[code]?.data || null } }));
      }
    },
    [authedFetch]
  );

  useEffect(() => {
    if (canReview && openState && !lists[openState]) loadList(openState);
  }, [canReview, openState, lists, loadList]);

  // Opens a state's list straight onto one lane (used by the sprint plan buttons).
  function openStateOn(code, lane) {
    setSearch("");
    setShown(PAGE_SIZE);
    setLaneFilter(lane);
    setOpenState(code);
    setTimeout(() => {
      const el = typeof document !== "undefined" ? document.getElementById(`state-${code}`) : null;
      if (el && el.scrollIntoView) el.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 150);
  }

  function toggleState(code) {
    setLaneFilter("all");
    setSearch("");
    setShown(PAGE_SIZE);
    setOpenState((cur) => (cur === code ? null : code));
  }

  const totals = useMemo(
    () =>
      states.reduce(
        (t, s) => ({
          total_open: t.total_open + s.total_open,
          verified: t.verified + s.verified,
          remaining: t.remaining + s.remaining,
          ai_ready: t.ai_ready + s.ai_ready,
          flagged: t.flagged + s.flagged,
          never_checked: t.never_checked + s.never_checked,
        }),
        { total_open: 0, verified: 0, remaining: 0, ai_ready: 0, flagged: 0, never_checked: 0 }
      ),
    [states]
  );

  const active = useMemo(() => {
    const rows = states.filter((s) => s.remaining > 0);
    const by = {
      smallest: (a, b) => a.remaining - b.remaining || a.state.localeCompare(b.state),
      biggest: (a, b) => b.remaining - a.remaining || a.state.localeCompare(b.state),
      priority: (a, b) => Number(b.is_priority_state) - Number(a.is_priority_state) || b.remaining - a.remaining,
    };
    return rows.slice().sort(by[sortKey] || by.smallest);
  }, [states, sortKey]);
  const plan = useMemo(() => buildSprintPlan(states, history), [states, history]);
  const finished = useMemo(() => states.filter((s) => s.remaining === 0).map((s) => s.state).sort(), [states]);

  if (!canReview) {
    return (
      <div className="view">
        <div className="notice danger">Only verification staff or a system admin can open the Finish Line.</div>
      </div>
    );
  }

  function renderList(code) {
    const entry = lists[code];
    if (!entry || (entry.loading && !entry.data)) return <div className="empty-state">Loading {code}…</div>;
    if (entry.error && !entry.data) return <div className="notice danger">{entry.error}</div>;
    const data = entry.data;
    const q = search.trim().toLowerCase();
    const rows = (data.schools || []).filter((c) => (laneFilter === "all" || c.lane === laneFilter) && (!q || `${c.name} ${c.city} ${c.coach}`.toLowerCase().includes(q)));
    return (
      <div style={{ margin: "0 0 14px 0", padding: "10px 12px", background: "#f7f8fa", border: "1px solid #dde1e7", borderRadius: 10 }}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 10 }}>
          <button type="button" className={`btn btn-sm ${laneFilter === "all" ? "btn-primary" : ""}`} onClick={() => { setLaneFilter("all"); setShown(PAGE_SIZE); }}>
            All ({fmt(data.total)})
          </button>
          {LANES.map((l) => (
            <button
              key={l.key}
              type="button"
              className={`btn btn-sm ${laneFilter === l.key ? "btn-primary" : ""}`}
              onClick={() => { setLaneFilter(l.key); setShown(PAGE_SIZE); }}
              disabled={!data.counts?.[l.key]}
            >
              {l.label} ({fmt(data.counts?.[l.key] || 0)})
            </button>
          ))}
          <input
            type="search"
            value={search}
            onChange={(e) => { setSearch(e.target.value); setShown(PAGE_SIZE); }}
            placeholder="Search school, city or coach"
            style={{ border: "1px solid #dde1e7", borderRadius: 7, padding: "6px 9px", minWidth: 200 }}
          />
          <button type="button" className="btn btn-sm" onClick={() => loadList(code, true)} disabled={entry.loading}>
            {entry.loading ? "Refreshing…" : "Refresh"}
          </button>
        </div>
        <div style={{ fontSize: 12, color: "#697386", marginBottom: 8 }}>Best chances first: AI answers that match what you have, then high-confidence answers, then flagged schools, then schools not checked yet.</div>
        {rows.length === 0 ? (
          <div className="empty-state">No schools match this filter.</div>
        ) : (
          <>
            {rows.slice(0, shown).map((c) => (
              <SchoolCard key={c.id} card={c} />
            ))}
            {rows.length > shown && (
              <button type="button" className="btn btn-sm" onClick={() => setShown((n) => n + PAGE_SIZE)}>
                Show {Math.min(PAGE_SIZE, rows.length - shown)} more ({fmt(rows.length - shown)} left in this view)
              </button>
            )}
          </>
        )}
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
          <h1>Finish Line</h1>
          <p>Everything still left to verify, in one place. Open a state to see each school once, with every answer waiting for it on the same card. Finished states stay out of the way.</p>
        </div>
      </div>

      {error && (
        <div className="notice danger" style={{ marginBottom: 14 }}>
          {error}{" "}
          <button type="button" className="btn btn-sm" onClick={loadStates}>
            Try again
          </button>
        </div>
      )}

      {loading ? (
        <div className="empty-state">Loading…</div>
      ) : (
        <>
          <Headline totals={totals} />
          <NextMove move={nextMove(totals, states)} />
          <SprintPlan plan={plan} onOpen={openStateOn} />

          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 10 }}>
            <strong style={{ fontSize: 14 }}>{fmt(active.length)} states still have work</strong>
            <label style={{ fontSize: 12.5, display: "flex", gap: 6, alignItems: "center" }}>
              Order:
              <select value={sortKey} onChange={(e) => setSortKey(e.target.value)} style={{ border: "1px solid #dde1e7", borderRadius: 7, padding: "5px 8px" }}>
                <option value="smallest">Smallest first (quick wins)</option>
                <option value="biggest">Biggest first</option>
                <option value="priority">Priority states first</option>
              </select>
            </label>
          </div>

          {active.length === 0 && <div className="empty-state">Every open school is verified.</div>}
          {active.map((row) => (
            <div key={row.state} id={`state-${row.state}`}>
              <StateRow row={row} open={openState === row.state} onToggle={() => toggleState(row.state)} />
              {openState === row.state && renderList(row.state)}
            </div>
          ))}

          {finished.length > 0 && (
            <div style={{ marginTop: 16, fontSize: 12.5, color: "#1e7145" }}>
              ✓ {fmt(finished.length)} finished states: {finished.join(", ")}
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default function FinishLinePage() {
  return (
    <Suspense fallback={<div className="view"><div className="empty-state">Loading…</div></div>}>
      <FinishLineInner />
    </Suspense>
  );
}
