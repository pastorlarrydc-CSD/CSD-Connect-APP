"use client";
import { useEffect, useState, useCallback, useMemo } from "react";
import Link from "next/link";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { useAuth } from "@/lib/auth-context";

const STATUS_LABEL = { submitted: "Submitted", reviewed: "Reviewed", contacted: "Contacted" };
const LEVELS = ["FBS", "FCS", "D2", "D3", "NAIA", "JUCO", "Prep/Post-Grad"];

function fmtPhone(v) {
  if (!v) return "";
  const digits = String(v).replace(/\D/g, "");
  return digits.length === 10 ? `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}` : v;
}

const EMPTY_FILTERS = { gradYear: "", position: "", state: "", levelOfPlay: "", status: "", watchlistOnly: false, notContactedOnly: false };

export default function RecruitingBoardPage() {
  const supabase = getSupabaseBrowserClient();
  const { session, user, college } = useAuth();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState("");
  const [flaggedSchoolIds, setFlaggedSchoolIds] = useState(new Set());
  const [flaggingId, setFlaggingId] = useState(null);
  const [flagError, setFlagError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      const { data: prospects, error: prospectsErr } = await supabase
        .from("prospects")
        .select(
          "id,athlete_name,grad_year,position,level_of_play,gpa,height,weight,hudl_url,x_url,athlete_email,athlete_cell,guardian_authorized,status,created_at,school_id,schools(id,name,city,state,hc_first_name,hc_last_name,hc_email,hc_cell,hc_office)"
        )
        .order("created_at", { ascending: false })
        .limit(2000);
      if (prospectsErr) throw prospectsErr;

      let watchlistSet = new Set();
      let lastContactBySchool = {};
      if (college?.id) {
        const [{ data: watchlist }, { data: contacts }] = await Promise.all([
          supabase.from("watchlist_items").select("school_id").eq("college_id", college.id),
          supabase
            .from("contact_logs")
            .select("school_id,contact_date,contact_type")
            .eq("college_id", college.id)
            .order("created_at", { ascending: false }),
        ]);
        watchlistSet = new Set((watchlist || []).map((w) => w.school_id));
        (contacts || []).forEach((c) => {
          if (!lastContactBySchool[c.school_id]) lastContactBySchool[c.school_id] = c;
        });
      }

      if (user?.id) {
        const { data: flags } = await supabase.from("school_flags").select("school_id").eq("flagged_by", user.id).eq("status", "pending");
        setFlaggedSchoolIds(new Set((flags || []).map((f) => f.school_id)));
      }

      setRows(
        (prospects || []).map((p) => ({
          ...p,
          watchlisted: p.school_id ? watchlistSet.has(p.school_id) : false,
          lastContact: p.school_id ? lastContactBySchool[p.school_id] : null,
        }))
      );
    } catch (err) {
      setLoadError(err.message || "Could not load the recruiting board.");
    } finally {
      setLoading(false);
    }
  }, [supabase, college]);

  useEffect(() => {
    load();
  }, [load]);

  const options = useMemo(() => {
    const gradYears = new Set();
    const positions = new Set();
    const states = new Set();
    rows.forEach((r) => {
      if (r.grad_year) gradYears.add(r.grad_year);
      if (r.position) positions.add(r.position);
      const st = r.state || r.schools?.state;
      if (st) states.add(st);
    });
    return {
      gradYears: [...gradYears].sort(),
      positions: [...positions].sort(),
      states: [...states].sort(),
    };
  }, [rows]);

  const visible = useMemo(() => {
    return rows.filter((r) => {
      if (filters.gradYear && String(r.grad_year) !== filters.gradYear) return false;
      if (filters.position && r.position !== filters.position) return false;
      if (filters.levelOfPlay && r.level_of_play !== filters.levelOfPlay) return false;
      if (filters.status && r.status !== filters.status) return false;
      const st = r.state || r.schools?.state;
      if (filters.state && st !== filters.state) return false;
      if (filters.watchlistOnly && !r.watchlisted) return false;
      if (filters.notContactedOnly && r.lastContact) return false;
      return true;
    });
  }, [rows, filters]);

  function updateFilter(key, value) {
    setFilters((prev) => ({ ...prev, [key]: value }));
  }

  async function flagSchool(schoolId) {
    if (!schoolId || flaggedSchoolIds.has(schoolId)) return;
    setFlagError("");
    setFlaggingId(schoolId);
    try {
      const { error } = await supabase.from("school_flags").insert({
        school_id: schoolId,
        flagged_by: user.id,
        flagged_by_college_id: college?.id || null,
      });
      if (error) throw error;
      setFlaggedSchoolIds((prev) => new Set(prev).add(schoolId));
    } catch (err) {
      setFlagError(err.message || "Could not flag this school.");
    } finally {
      setFlaggingId(null);
    }
  }

  async function exportExcel() {
    setExporting(true);
    setExportError("");
    try {
      const token = session?.access_token;
      if (!token) throw new Error("Not signed in.");
      const res = await fetch("/api/exports/recruiting-board", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || "Export failed.");
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `csd-recruiting-board-${new Date().toISOString().slice(0, 10)}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setExportError(err.message || "Export failed.");
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="view">
      <Link href="/crm" className="btn btn-sm" style={{ marginBottom: 12, display: "inline-flex" }}>
        ← Back to Recruiting CRM
      </Link>
      <div className="view-header">
        <div>
          <h1>Recruiting Board</h1>
          <p>Every prospect, cross-referenced with your watchlist and contact history — filter to find who to call next.</p>
        </div>
        <button className="btn btn-gold" onClick={exportExcel} disabled={exporting}>
          {exporting ? "Building workbook…" : "Export to Excel"}
        </button>
      </div>

      {exportError && <div className="notice danger" style={{ marginBottom: 14 }}>{exportError}</div>}
      {loadError && <div className="notice danger" style={{ marginBottom: 14 }}>{loadError}</div>}
      {flagError && <div className="notice danger" style={{ marginBottom: 14 }}>{flagError}</div>}

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="grid grid-4" style={{ marginBottom: 10 }}>
          <div className="form-field" style={{ marginBottom: 0 }}>
            <label>Grad Year</label>
            <select value={filters.gradYear} onChange={(e) => updateFilter("gradYear", e.target.value)}>
              <option value="">All</option>
              {options.gradYears.map((y) => (
                <option key={y} value={y}>{y}</option>
              ))}
            </select>
          </div>
          <div className="form-field" style={{ marginBottom: 0 }}>
            <label>Position</label>
            <select value={filters.position} onChange={(e) => updateFilter("position", e.target.value)}>
              <option value="">All</option>
              {options.positions.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          </div>
          <div className="form-field" style={{ marginBottom: 0 }}>
            <label>State</label>
            <select value={filters.state} onChange={(e) => updateFilter("state", e.target.value)}>
              <option value="">All</option>
              {options.states.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>
          <div className="form-field" style={{ marginBottom: 0 }}>
            <label>Level of Play</label>
            <select value={filters.levelOfPlay} onChange={(e) => updateFilter("levelOfPlay", e.target.value)}>
              <option value="">All</option>
              {LEVELS.map((l) => (
                <option key={l} value={l}>{l}</option>
              ))}
            </select>
          </div>
        </div>
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "center" }}>
          <div className="form-field" style={{ marginBottom: 0, minWidth: 160 }}>
            <label>Status</label>
            <select value={filters.status} onChange={(e) => updateFilter("status", e.target.value)}>
              <option value="">All</option>
              {Object.entries(STATUS_LABEL).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </select>
          </div>
          <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12.5 }}>
            <input type="checkbox" checked={filters.watchlistOnly} onChange={(e) => updateFilter("watchlistOnly", e.target.checked)} />
            Watchlisted schools only
          </label>
          <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12.5 }}>
            <input type="checkbox" checked={filters.notContactedOnly} onChange={(e) => updateFilter("notContactedOnly", e.target.checked)} />
            No contact logged yet
          </label>
          {(filters.gradYear || filters.position || filters.state || filters.levelOfPlay || filters.status || filters.watchlistOnly || filters.notContactedOnly) && (
            <button className="btn btn-sm" onClick={() => setFilters(EMPTY_FILTERS)}>Clear filters</button>
          )}
        </div>
      </div>

      <div className="card">
        <h3 style={{ marginBottom: 4 }}>{loading ? "Loading…" : `${visible.length} of ${rows.length} prospects`}</h3>
        {loading ? (
          <div className="empty-state">Loading recruiting board…</div>
        ) : visible.length === 0 ? (
          <div className="empty-state">
            {rows.length === 0 ? "No prospects in the database yet." : "No prospects match these filters."}
          </div>
        ) : (
          <div className="table-wrap" style={{ boxShadow: "none", border: "none" }}>
            <table>
              <thead>
                <tr>
                  <th>Athlete</th>
                  <th>Grad / Pos / Level</th>
                  <th>High School</th>
                  <th>HS Head Coach</th>
                  <th>Territory</th>
                  <th>Last Contact</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((r) => {
                  const coachName = [r.schools?.hc_first_name, r.schools?.hc_last_name].filter(Boolean).join(" ");
                  return (
                    <tr key={r.id}>
                      <td>
                        <Link href={`/prospects/${r.id}`}>{r.athlete_name}</Link>
                        {r.athlete_email || r.athlete_cell ? (
                          <div style={{ fontSize: 11, color: "#697386" }}>
                            {r.athlete_email}{r.athlete_email && r.athlete_cell ? " · " : ""}{fmtPhone(r.athlete_cell)}
                          </div>
                        ) : null}
                      </td>
                      <td>
                        {r.grad_year || "—"}{r.position ? ` · ${r.position}` : ""}{r.level_of_play ? ` · ${r.level_of_play}` : ""}
                      </td>
                      <td>
                        {r.schools ? (
                          <Link href={`/schools/${r.schools.id}`}>{r.schools.name}</Link>
                        ) : (
                          <span className="empty-state">not linked</span>
                        )}
                        <div style={{ fontSize: 11, color: "#697386" }}>{r.city || r.schools?.city}{(r.state || r.schools?.state) ? `, ${r.state || r.schools?.state}` : ""}</div>
                      </td>
                      <td style={{ fontSize: 12 }}>
                        {coachName || <span className="empty-state">no name on file</span>}
                        <div style={{ fontSize: 11, color: "#697386" }}>
                          {r.schools?.hc_email || ""}{r.schools?.hc_email && r.schools?.hc_cell ? " · " : ""}{fmtPhone(r.schools?.hc_cell)}
                        </div>
                        {r.schools?.id && (
                          flaggedSchoolIds.has(r.schools.id) ? (
                            <span style={{ fontSize: 10.5, color: "#9a6b00" }}>Flagged outdated</span>
                          ) : (
                            <button
                              className="btn btn-sm"
                              style={{ marginTop: 4, padding: "2px 7px", fontSize: 10.5 }}
                              disabled={flaggingId === r.schools.id}
                              onClick={() => flagSchool(r.schools.id)}
                            >
                              {flaggingId === r.schools.id ? "Flagging…" : "Flag outdated"}
                            </button>
                          )
                        )}
                      </td>
                      <td>{r.watchlisted ? <span className="badge badge-contacted">Watchlisted</span> : <span className="empty-state">—</span>}</td>
                      <td style={{ fontSize: 12 }}>
                        {r.lastContact ? `${r.lastContact.contact_date} — ${r.lastContact.contact_type}` : <span className="badge badge-not-contacted">None logged</span>}
                      </td>
                      <td><span className="badge badge-contacted">{STATUS_LABEL[r.status] || r.status}</span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
