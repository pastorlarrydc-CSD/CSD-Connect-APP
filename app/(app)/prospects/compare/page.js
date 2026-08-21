"use client";
import { useEffect, useState, useCallback, useRef, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";

const MAX_COMPARE = 4;

const SELECT_COLS =
  "id,athlete_name,grad_year,position,jersey_number,height,weight,gpa,forty_yard_dash,vertical_jump,broad_jump,bench_press_reps,shuttle_time,level_of_play,hudl_url,x_url,coach_evaluation,offers_received,committed_to,is_underexposed,ai_summary,ai_sleeper_flag,status,schools(id,name,city,state)";

const ROWS = [
  { label: "School", render: (p) => (p.schools ? <Link href={`/schools/${p.schools.id}`}>{p.schools.name}</Link> : "—") },
  { label: "City / State", render: (p) => `${p.city || p.schools?.city || "—"}${p.state || p.schools?.state ? `, ${p.state || p.schools?.state}` : ""}` },
  { label: "Grad Year", render: (p) => p.grad_year || "—" },
  { label: "Position", render: (p) => p.position || "—" },
  { label: "Jersey #", render: (p) => p.jersey_number || "—" },
  { label: "Level of Play", render: (p) => p.level_of_play || "—" },
  { label: "Height / Weight", render: (p) => `${p.height || "—"}${p.weight ? ` / ${p.weight}` : ""}` },
  { label: "GPA", render: (p) => p.gpa ?? "—" },
  { label: "40-Yard Dash", render: (p) => (p.forty_yard_dash != null ? `${p.forty_yard_dash}s` : "—") },
  { label: "Vertical Jump", render: (p) => (p.vertical_jump != null ? `${p.vertical_jump}"` : "—") },
  { label: "Broad Jump", render: (p) => (p.broad_jump != null ? `${p.broad_jump}"` : "—") },
  { label: "Bench Press", render: (p) => (p.bench_press_reps != null ? `${p.bench_press_reps} reps` : "—") },
  { label: "Shuttle", render: (p) => (p.shuttle_time != null ? `${p.shuttle_time}s` : "—") },
  { label: "Offers Received", render: (p) => p.offers_received || "—" },
  { label: "Committed To", render: (p) => p.committed_to || "—" },
  { label: "Hudl Film", render: (p) => (p.hudl_url ? <a href={p.hudl_url} target="_blank" rel="noopener noreferrer">Watch film</a> : "—") },
  { label: "Coach Evaluation", render: (p) => p.coach_evaluation || "—" },
  {
    label: "Underexposed",
    render: (p) =>
      p.is_underexposed ? (
        <span className="badge badge-not-contacted">Yes</span>
      ) : (
        "No"
      ),
  },
  {
    label: "AI Insight",
    render: (p) =>
      p.ai_summary ? (
        <span title={p.ai_summary} style={{ cursor: "help" }}>
          {p.ai_sleeper_flag ? <span className="badge badge-not-contacted" style={{ marginRight: 4 }}>Sleeper</span> : null}
          {p.ai_summary.length > 90 ? `${p.ai_summary.slice(0, 90)}…` : p.ai_summary}
        </span>
      ) : (
        <span className="empty-state">not generated</span>
      ),
  },
];

function CompareInner() {
  const supabase = getSupabaseBrowserClient();
  const searchParams = useSearchParams();

  const [selected, setSelected] = useState([]);
  const [loadingInitial, setLoadingInitial] = useState(true);

  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const debounceRef = useRef(null);

  const [error, setError] = useState("");

  // Load prospects passed via ?ids=1,2,3 (e.g. linked from a search or the
  // recruiting board) so a comparison can be shared/bookmarked.
  useEffect(() => {
    const idsParam = searchParams.get("ids");
    if (!idsParam) {
      setLoadingInitial(false);
      return;
    }
    const ids = idsParam
      .split(",")
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n));
    if (!ids.length) {
      setLoadingInitial(false);
      return;
    }
    (async () => {
      const { data } = await supabase.from("prospects").select(SELECT_COLS).in("id", ids);
      if (data) {
        // preserve the order the ids were given in
        const byId = new Map(data.map((p) => [p.id, p]));
        setSelected(ids.map((i) => byId.get(i)).filter(Boolean).slice(0, MAX_COMPARE));
      }
      setLoadingInitial(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const searchProspects = useCallback(
    (value) => {
      setQuery(value);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (value.trim().length < 2) {
        setResults([]);
        return;
      }
      setSearching(true);
      debounceRef.current = setTimeout(async () => {
        const { data } = await supabase
          .from("prospects")
          .select("id,athlete_name,grad_year,position,schools(name,city,state)")
          .ilike("athlete_name", `%${value.trim()}%`)
          .order("athlete_name", { ascending: true })
          .limit(8);
        setResults(data || []);
        setSearching(false);
      }, 250);
    },
    [supabase]
  );

  async function addProspect(basic) {
    setError("");
    if (selected.some((p) => p.id === basic.id)) return;
    if (selected.length >= MAX_COMPARE) {
      setError(`You can compare up to ${MAX_COMPARE} prospects at a time. Remove one to add another.`);
      return;
    }
    const { data } = await supabase.from("prospects").select(SELECT_COLS).eq("id", basic.id).maybeSingle();
    if (data) setSelected((prev) => [...prev, data]);
    setQuery("");
    setResults([]);
  }

  function removeProspect(id) {
    setSelected((prev) => prev.filter((p) => p.id !== id));
  }

  return (
    <div className="view">
      <Link href="/prospects" className="btn btn-sm" style={{ marginBottom: 12, display: "inline-flex" }}>
        ← Back to Prospects
      </Link>
      <div className="view-header">
        <div>
          <h1>Compare Prospects</h1>
          <p>Side-by-side comparison — measurables, offers, and AI insight for up to {MAX_COMPARE} athletes at once.</p>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <h3>Add a prospect</h3>
        {error && <div className="notice danger" style={{ marginBottom: 10 }}>{error}</div>}
        <div style={{ position: "relative", maxWidth: 420 }}>
          <input
            value={query}
            onChange={(e) => searchProspects(e.target.value)}
            placeholder="Start typing an athlete's name…"
            autoComplete="off"
            disabled={selected.length >= MAX_COMPARE}
          />
          {results.length > 0 && (
            <div
              style={{
                position: "absolute",
                top: "100%",
                left: 0,
                right: 0,
                zIndex: 10,
                background: "#fff",
                border: "1px solid #dde1e7",
                borderRadius: 8,
                boxShadow: "0 4px 14px rgba(11,31,58,.12)",
                maxHeight: 220,
                overflow: "auto",
              }}
            >
              {results.map((p) => (
                <div key={p.id} onClick={() => addProspect(p)} style={{ padding: "7px 10px", fontSize: 13, cursor: "pointer", borderBottom: "1px solid #f2f3f5" }}>
                  <strong>{p.athlete_name}</strong>{" "}
                  <span style={{ color: "#697386" }}>
                    {p.grad_year ? `· Class of ${p.grad_year} ` : ""}
                    {p.position ? `· ${p.position} ` : ""}
                    {p.schools?.name ? `· ${p.schools.name}` : ""}
                  </span>
                </div>
              ))}
            </div>
          )}
          {searching && <div style={{ fontSize: 11, color: "#697386", marginTop: 3 }}>Searching…</div>}
        </div>
        {selected.length >= MAX_COMPARE && (
          <div style={{ fontSize: 12, color: "#697386", marginTop: 6 }}>Comparison is full — remove a prospect below to add a different one.</div>
        )}
      </div>

      {loadingInitial ? (
        <div className="card">
          <div className="empty-state">Loading…</div>
        </div>
      ) : selected.length === 0 ? (
        <div className="card">
          <div className="empty-state">Search for prospects above to start a comparison.</div>
        </div>
      ) : (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th style={{ minWidth: 140 }}>&nbsp;</th>
                  {selected.map((p) => (
                    <th key={p.id} style={{ minWidth: 200 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 6 }}>
                        <Link href={`/prospects/${p.id}`}>
                          <strong>{p.athlete_name}</strong>
                        </Link>
                        <button className="btn btn-sm" onClick={() => removeProspect(p.id)} title="Remove from comparison">
                          ✕
                        </button>
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {ROWS.map((row) => (
                  <tr key={row.label}>
                    <td style={{ fontWeight: 600, color: "#3a4557", fontSize: 12.5 }}>{row.label}</td>
                    {selected.map((p) => (
                      <td key={p.id} style={{ fontSize: 13 }}>
                        {row.render(p)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p style={{ fontSize: 11.5, color: "#9aa2b1", marginTop: 10, marginBottom: 0 }}>
            AI Insight is AI-generated and unverified — hover a summary to read it in full, or open the prospect&apos;s profile to generate/refresh it.
          </p>
        </div>
      )}
    </div>
  );
}

export default function ComparePage() {
  return (
    <Suspense fallback={<div className="view"><div className="empty-state">Loading…</div></div>}>
      <CompareInner />
    </Suspense>
  );
}
