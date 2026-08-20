"use client";
import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { useAuth } from "@/lib/auth-context";

function fmtDate(v) {
  return v ? new Date(v).toLocaleDateString() : "—";
}

export default function DuplicatesPage() {
  const supabase = getSupabaseBrowserClient();
  const { profile } = useAuth();
  const canReview = profile?.role === "verifier" || profile?.role === "sysadmin";

  const [tab, setTab] = useState("schools");

  // Duplicate schools -- grouped by (normalized name, city, state)
  const [schoolGroups, setSchoolGroups] = useState(null); // null = not scanned yet
  const [loadingSchools, setLoadingSchools] = useState(false);
  const [schoolsError, setSchoolsError] = useState("");
  const [keepBySchoolGroup, setKeepBySchoolGroup] = useState({}); // group_key -> id to keep
  const [mergingSchoolGroup, setMergingSchoolGroup] = useState(null);
  const [schoolMergeError, setSchoolMergeError] = useState("");

  // Duplicate prospects -- fuzzy-matched pairs within the same school
  const [prospectPairs, setProspectPairs] = useState(null);
  const [loadingProspects, setLoadingProspects] = useState(false);
  const [prospectsError, setProspectsError] = useState("");
  const [keepByPair, setKeepByPair] = useState({}); // pair_key -> "a" | "b"
  const [mergingPair, setMergingPair] = useState(null);
  const [prospectMergeError, setProspectMergeError] = useState("");
  const [dismissedPairs, setDismissedPairs] = useState({}); // pair_key -> true once merged

  const scanSchools = useCallback(async () => {
    setLoadingSchools(true);
    setSchoolsError("");
    try {
      const { data, error } = await supabase.rpc("find_duplicate_schools");
      if (error) throw error;
      const byKey = new Map();
      (data || []).forEach((row) => {
        if (!byKey.has(row.group_key)) byKey.set(row.group_key, []);
        byKey.get(row.group_key).push(row);
      });
      const groups = [...byKey.entries()].map(([key, rows]) => ({
        key,
        rows: rows.sort((a, b) => a.id - b.id),
      }));
      setSchoolGroups(groups);
      // Default "keep" pick: highest confidence score, then oldest record.
      const defaults = {};
      groups.forEach((g) => {
        const best = [...g.rows].sort((a, b) => (b.confidence_score || 0) - (a.confidence_score || 0) || a.id - b.id)[0];
        defaults[g.key] = best.id;
      });
      setKeepBySchoolGroup(defaults);
    } catch (err) {
      setSchoolsError(err.message || "Could not scan for duplicate schools.");
    } finally {
      setLoadingSchools(false);
    }
  }, [supabase]);

  const scanProspects = useCallback(async () => {
    setLoadingProspects(true);
    setProspectsError("");
    try {
      const { data, error } = await supabase.rpc("find_duplicate_prospects");
      if (error) throw error;
      setProspectPairs(data || []);
      const defaults = {};
      (data || []).forEach((p) => {
        defaults[p.pair_key] = "a";
      });
      setKeepByPair(defaults);
    } catch (err) {
      setProspectsError(err.message || "Could not scan for duplicate prospects.");
    } finally {
      setLoadingProspects(false);
    }
  }, [supabase]);

  useEffect(() => {
    if (!canReview) return;
    scanSchools();
    scanProspects();
    // Only run once on mount -- re-scans are triggered manually via the buttons.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canReview]);

  async function mergeSchoolGroup(group) {
    const keepId = keepBySchoolGroup[group.key];
    const removeIds = group.rows.filter((r) => r.id !== keepId).map((r) => r.id);
    if (!removeIds.length) return;
    if (
      !window.confirm(
        `Merge ${removeIds.length} duplicate${removeIds.length === 1 ? "" : "s"} into the selected record? The other record(s) will be permanently deleted -- their coach contacts, watchlist entries, and prospects move to the kept school first. This cannot be undone.`
      )
    )
      return;
    setSchoolMergeError("");
    setMergingSchoolGroup(group.key);
    try {
      for (const removeId of removeIds) {
        const { error } = await supabase.rpc("merge_schools", { p_keep_id: keepId, p_remove_id: removeId });
        if (error) throw error;
      }
      setSchoolGroups((prev) => (prev || []).filter((g) => g.key !== group.key));
    } catch (err) {
      setSchoolMergeError(err.message || "Could not merge these schools.");
    } finally {
      setMergingSchoolGroup(null);
    }
  }

  async function mergeProspectPair(pair) {
    const keepSide = keepByPair[pair.pair_key] || "a";
    const keepId = keepSide === "a" ? pair.id_a : pair.id_b;
    const removeId = keepSide === "a" ? pair.id_b : pair.id_a;
    if (
      !window.confirm(
        "Merge these two prospects into one? The other record will be permanently deleted -- its notes, ratings, tags, and recruiting status move to the kept prospect first. This cannot be undone."
      )
    )
      return;
    setProspectMergeError("");
    setMergingPair(pair.pair_key);
    try {
      const { error } = await supabase.rpc("merge_prospects", { p_keep_id: keepId, p_remove_id: removeId });
      if (error) throw error;
      setDismissedPairs((prev) => ({ ...prev, [pair.pair_key]: true }));
    } catch (err) {
      setProspectMergeError(err.message || "Could not merge these prospects.");
    } finally {
      setMergingPair(null);
    }
  }

  if (!canReview) {
    return (
      <div className="view">
        <div className="notice danger">Duplicate detection &amp; cleanup is limited to Verification Staff and System Admins.</div>
      </div>
    );
  }

  const visibleProspectPairs = (prospectPairs || []).filter((p) => !dismissedPairs[p.pair_key]);

  return (
    <div className="view">
      <Link href="/admin" className="btn btn-sm" style={{ marginBottom: 12, display: "inline-flex" }}>
        ← Back to Admin
      </Link>
      <div className="view-header">
        <div>
          <h1>Duplicate Detection &amp; Cleanup</h1>
          <p>
            Finds likely-duplicate school and prospect records so you can review and merge them — the record you keep absorbs
            contacts, watchlist entries, notes, and history from the one removed.
          </p>
        </div>
      </div>

      <div className="filters" style={{ marginBottom: 14 }}>
        <button
          className="btn btn-sm"
          style={tab === "schools" ? { background: "#0b1f3a", color: "#fff", borderColor: "#0b1f3a" } : undefined}
          onClick={() => setTab("schools")}
        >
          Duplicate Schools {schoolGroups ? `(${schoolGroups.length})` : ""}
        </button>
        <button
          className="btn btn-sm"
          style={tab === "prospects" ? { background: "#0b1f3a", color: "#fff", borderColor: "#0b1f3a" } : undefined}
          onClick={() => setTab("prospects")}
        >
          Duplicate Prospects {prospectPairs ? `(${visibleProspectPairs.length})` : ""}
        </button>
      </div>

      {tab === "schools" && (
        <div className="card">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8, flexWrap: "wrap", gap: 8 }}>
            <h3 style={{ margin: 0 }}>Likely Duplicate Schools</h3>
            <button className="btn btn-sm" onClick={scanSchools} disabled={loadingSchools}>
              {loadingSchools ? "Scanning…" : "Re-scan"}
            </button>
          </div>
          <p style={{ fontSize: 12.5, color: "#697386", marginTop: -2, marginBottom: 10 }}>
            Same school name, city, and state on more than one record — usually a repeated import. Pick which record to keep;
            the other is deleted and its coach contacts, watchlist entries, and prospects move to the kept record.
          </p>
          {schoolsError && <div className="notice danger" style={{ marginBottom: 10 }}>{schoolsError}</div>}
          {schoolMergeError && <div className="notice danger" style={{ marginBottom: 10 }}>{schoolMergeError}</div>}
          {loadingSchools && !schoolGroups ? (
            <div className="empty-state">Scanning…</div>
          ) : schoolGroups && schoolGroups.length === 0 ? (
            <div className="empty-state">No duplicate schools found — nice and clean.</div>
          ) : (
            (schoolGroups || []).map((group) => (
              <div className="log-item" key={group.key} style={{ paddingBottom: 14 }}>
                <strong>{group.rows[0].name}</strong> — {group.rows[0].city}, {group.rows[0].state}
                <div style={{ fontSize: 12, color: "#697386", margin: "2px 0 6px" }}>
                  {group.rows.length} matching records — choose the one to keep:
                </div>
                <div className="table-wrap" style={{ marginBottom: 8 }}>
                  <table>
                    <thead>
                      <tr>
                        <th>Keep</th>
                        <th>Head Coach</th>
                        <th>Email</th>
                        <th>Confidence</th>
                        <th>Status</th>
                        <th>Created</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {group.rows.map((r) => (
                        <tr key={r.id}>
                          <td>
                            <input
                              type="radio"
                              name={`keep-${group.key}`}
                              checked={keepBySchoolGroup[group.key] === r.id}
                              onChange={() => setKeepBySchoolGroup((prev) => ({ ...prev, [group.key]: r.id }))}
                            />
                          </td>
                          <td>{[r.hc_first_name, r.hc_last_name].filter(Boolean).join(" ") || "—"}</td>
                          <td>{r.hc_email || <span className="empty-state">none</span>}</td>
                          <td>{r.confidence_score ?? 0}%</td>
                          <td>
                            {r.verification_status || "—"}
                            {r.record_updated ? " · updated" : ""}
                          </td>
                          <td>{fmtDate(r.created_at)}</td>
                          <td>
                            <Link href={`/schools/${r.id}`} className="btn btn-sm" target="_blank">
                              Open
                            </Link>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <button className="btn btn-sm btn-gold" disabled={mergingSchoolGroup === group.key} onClick={() => mergeSchoolGroup(group)}>
                  {mergingSchoolGroup === group.key ? "Merging…" : "Merge into selected record"}
                </button>
              </div>
            ))
          )}
        </div>
      )}

      {tab === "prospects" && (
        <div className="card">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8, flexWrap: "wrap", gap: 8 }}>
            <h3 style={{ margin: 0 }}>Likely Duplicate Prospects</h3>
            <button className="btn btn-sm" onClick={scanProspects} disabled={loadingProspects}>
              {loadingProspects ? "Scanning…" : "Re-scan"}
            </button>
          </div>
          <p style={{ fontSize: 12.5, color: "#697386", marginTop: -2, marginBottom: 10 }}>
            Similarly-named athletes at the same school with a compatible graduation year — often the same recruit submitted
            twice. Pick which record to keep; the other is deleted and its notes, ratings, tags, and recruiting status move to
            the kept record.
          </p>
          {prospectsError && <div className="notice danger" style={{ marginBottom: 10 }}>{prospectsError}</div>}
          {prospectMergeError && <div className="notice danger" style={{ marginBottom: 10 }}>{prospectMergeError}</div>}
          {loadingProspects && !prospectPairs ? (
            <div className="empty-state">Scanning…</div>
          ) : visibleProspectPairs.length === 0 ? (
            <div className="empty-state">No duplicate prospects found.</div>
          ) : (
            visibleProspectPairs.map((p) => (
              <div className="log-item" key={p.pair_key} style={{ paddingBottom: 14 }}>
                <div style={{ fontSize: 12, color: "#697386", marginBottom: 6 }}>
                  {p.school_name} — {Math.round((p.similarity || 0) * 100)}% name match
                </div>
                <div className="grid grid-2" style={{ marginBottom: 8 }}>
                  <label
                    style={{
                      display: "flex",
                      gap: 8,
                      alignItems: "flex-start",
                      border: keepByPair[p.pair_key] !== "b" ? "1px solid #0b1f3a" : "1px solid #dde1e7",
                      borderRadius: 8,
                      padding: 10,
                      cursor: "pointer",
                    }}
                  >
                    <input
                      type="radio"
                      name={`keep-${p.pair_key}`}
                      checked={keepByPair[p.pair_key] !== "b"}
                      onChange={() => setKeepByPair((prev) => ({ ...prev, [p.pair_key]: "a" }))}
                      style={{ marginTop: 3 }}
                    />
                    <div>
                      <strong>{p.athlete_name_a}</strong>
                      <div style={{ fontSize: 12, color: "#697386" }}>
                        Grad {p.grad_year_a || "—"} · {p.status_a || "—"} · added {fmtDate(p.created_at_a)}
                      </div>
                      <Link href={`/prospects/${p.id_a}`} className="btn btn-sm" style={{ marginTop: 6 }} target="_blank">
                        Open
                      </Link>
                    </div>
                  </label>
                  <label
                    style={{
                      display: "flex",
                      gap: 8,
                      alignItems: "flex-start",
                      border: keepByPair[p.pair_key] === "b" ? "1px solid #0b1f3a" : "1px solid #dde1e7",
                      borderRadius: 8,
                      padding: 10,
                      cursor: "pointer",
                    }}
                  >
                    <input
                      type="radio"
                      name={`keep-${p.pair_key}`}
                      checked={keepByPair[p.pair_key] === "b"}
                      onChange={() => setKeepByPair((prev) => ({ ...prev, [p.pair_key]: "b" }))}
                      style={{ marginTop: 3 }}
                    />
                    <div>
                      <strong>{p.athlete_name_b}</strong>
                      <div style={{ fontSize: 12, color: "#697386" }}>
                        Grad {p.grad_year_b || "—"} · {p.status_b || "—"} · added {fmtDate(p.created_at_b)}
                      </div>
                      <Link href={`/prospects/${p.id_b}`} className="btn btn-sm" style={{ marginTop: 6 }} target="_blank">
                        Open
                      </Link>
                    </div>
                  </label>
                </div>
                <button className="btn btn-sm btn-gold" disabled={mergingPair === p.pair_key} onClick={() => mergeProspectPair(p)}>
                  {mergingPair === p.pair_key ? "Merging…" : "Merge into selected record"}
                </button>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
