"use client";
import { useState, useEffect, useCallback, useRef } from "react";
import Link from "next/link";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { useAuth } from "@/lib/auth-context";
import { classifySchools, classifySchool } from "@/lib/dataQuality";

const PAGE_SIZE = 1000;
const DISPLAY_CAP = 200;

const FILTERS = [
  { key: "all", label: "All actionable issues" },
  { key: "no_contact", label: "No contact info" },
  { key: "bad_email", label: "Malformed email" },
  { key: "bad_cell", label: "Malformed cell" },
  { key: "bad_office", label: "Malformed office phone" },
  { key: "no_name", label: "No coach name" },
];

const EDIT_FIELDS = [
  ["hc_first_name", "First name"],
  ["hc_last_name", "Last name"],
  ["hc_email", "Email"],
  ["hc_cell", "Cell"],
  ["hc_office", "Office"],
];

function fmtPhone(v) {
  if (!v) return "";
  const digits = String(v).replace(/\D/g, "");
  return digits.length === 10 ? `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}` : v;
}

export default function DataQualityPage() {
  const supabase = getSupabaseBrowserClient();
  const { user, profile } = useAuth();
  const canReview = profile?.role === "verifier" || profile?.role === "sysadmin";

  // Flagged-as-outdated queue -- loads automatically (unlike the full scan
  // below, which is opt-in) so stale records surface the moment someone
  // reports one, rather than waiting for the next manual scan.
  const [flaggedQueue, setFlaggedQueue] = useState([]);
  const [loadingFlags, setLoadingFlags] = useState(true);
  const [flagActionId, setFlagActionId] = useState(null);
  const [flagActionError, setFlagActionError] = useState("");

  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState("");
  const [result, setResult] = useState(null); // { flagged, counts, totalFlagged, totalScanned }
  const [filter, setFilter] = useState("all");

  const [editingId, setEditingId] = useState(null);
  const [editValues, setEditValues] = useState({});
  const [saving, setSaving] = useState(null);
  const [saveError, setSaveError] = useState("");
  const scannedAt = useRef(null);

  const loadFlags = useCallback(async () => {
    if (!canReview) {
      setLoadingFlags(false);
      return;
    }
    setLoadingFlags(true);
    const { data } = await supabase
      .from("school_flags")
      .select("*, schools(id,name,city,state,hc_first_name,hc_last_name,hc_email,hc_cell,hc_office), colleges:flagged_by_college_id(name)")
      .eq("status", "pending")
      .order("created_at", { ascending: true });
    setFlaggedQueue(data || []);
    setLoadingFlags(false);
  }, [supabase, canReview]);

  useEffect(() => {
    loadFlags();
  }, [loadFlags]);

  const fetchAllSchools = useCallback(async () => {
    const rows = [];
    let from = 0;
    for (;;) {
      const { data, error } = await supabase
        .from("schools")
        .select("id,name,city,state,hc_first_name,hc_last_name,hc_email,hc_cell,hc_office,lat,lon,verification_status")
        .order("id", { ascending: true })
        .range(from, from + PAGE_SIZE - 1);
      if (error) throw error;
      rows.push(...(data || []));
      if (!data || data.length < PAGE_SIZE) break;
      from += PAGE_SIZE;
    }
    return rows;
  }, [supabase]);

  const runScan = useCallback(async () => {
    setScanning(true);
    setScanError("");
    try {
      const schools = await fetchAllSchools();
      setResult(classifySchools(schools));
      scannedAt.current = new Date();
    } catch (err) {
      setScanError(err.message || "Could not scan the database.");
    } finally {
      setScanning(false);
    }
  }, [fetchAllSchools]);

  function startEdit(school) {
    setEditingId(school.id);
    setSaveError("");
    setEditValues({
      hc_first_name: school.hc_first_name || "",
      hc_last_name: school.hc_last_name || "",
      hc_email: school.hc_email || "",
      hc_cell: school.hc_cell || "",
      hc_office: school.hc_office || "",
    });
  }

  function cancelEdit() {
    setEditingId(null);
    setSaveError("");
  }

  async function resolvePendingFlags(schoolId) {
    await supabase
      .from("school_flags")
      .update({ status: "resolved", resolved_by: user.id, resolved_at: new Date().toISOString() })
      .eq("school_id", schoolId)
      .eq("status", "pending");
    setFlaggedQueue((prev) => prev.filter((f) => f.school_id !== schoolId));
  }

  // Saves the quick-fix directly to schools (verifier/sysadmin have direct
  // write access via RLS -- this doesn't go through the coach-suggestion
  // review queue, since the reviewer IS the one making the fix here) and
  // marks the record verified, same bookkeeping as the bulk-update tool:
  // a school_change_log row per changed field. Also clears any pending
  // "possibly outdated" flags on this school, since a human just fixed it.
  async function saveEdit(school) {
    setSaving(school.id);
    setSaveError("");
    try {
      const before = school;
      const changes = [];
      const update = { verification_status: "verified", last_verified_at: new Date().toISOString() };
      EDIT_FIELDS.forEach(([field]) => {
        const newVal = editValues[field].trim() || null;
        const oldVal = before[field] || null;
        if (newVal !== oldVal) {
          update[field] = newVal;
          changes.push({
            school_id: before.id,
            field_name: field,
            old_value: oldVal,
            new_value: newVal,
            source: "Data quality review (quick fix)",
            changed_by: user.id,
          });
        }
      });

      const { error: updateError } = await supabase.from("schools").update(update).eq("id", before.id);
      if (updateError) throw updateError;
      if (changes.length) {
        const { error: logError } = await supabase.from("school_change_log").insert(changes);
        if (logError) throw logError;
      }
      await resolvePendingFlags(before.id);

      // Reflect the fix locally without a full re-scan: drop the row from
      // the queue if it's no longer actionable, otherwise re-classify it.
      setResult((prev) => {
        if (!prev) return prev;
        const merged = { ...before, ...update };
        const nextFlagged = prev.flagged.map((r) => (r.school.id === before.id ? { ...r, school: merged } : r));
        const reclass = classifySchool(merged);
        const finalFlagged = reclass.actionable
          ? nextFlagged.map((r) => (r.school.id === before.id ? { ...r, ...reclass, school: merged } : r))
          : nextFlagged.filter((r) => r.school.id !== before.id);
        return { ...prev, flagged: finalFlagged, totalFlagged: finalFlagged.length };
      });
      setEditingId(null);
    } catch (err) {
      setSaveError(err.message || "Could not save this fix.");
    } finally {
      setSaving(null);
    }
  }

  async function confirmAccurate(flag) {
    setFlagActionError("");
    setFlagActionId(flag.id);
    try {
      const { error } = await supabase
        .from("school_flags")
        .update({ status: "resolved", resolved_by: user.id, resolved_at: new Date().toISOString() })
        .eq("id", flag.id);
      if (error) throw error;
      const { error: schoolError } = await supabase
        .from("schools")
        .update({ verification_status: "verified", last_verified_at: new Date().toISOString() })
        .eq("id", flag.school_id);
      if (schoolError) throw schoolError;
      setFlaggedQueue((prev) => prev.filter((f) => f.id !== flag.id));
    } catch (err) {
      setFlagActionError(err.message || "Could not dismiss this flag.");
    } finally {
      setFlagActionId(null);
    }
  }

  if (!canReview) {
    return (
      <div className="view">
        <div className="notice danger">Data quality review is limited to Verification Staff and System Admins.</div>
      </div>
    );
  }

  const visibleRows = result
    ? result.flagged.filter((r) => filter === "all" || r.issues.some((iss) => iss.code === filter)).slice(0, DISPLAY_CAP)
    : [];
  const visibleTotal = result ? result.flagged.filter((r) => filter === "all" || r.issues.some((iss) => iss.code === filter)).length : 0;

  return (
    <div className="view">
      <Link href="/admin" className="btn btn-sm" style={{ marginBottom: 12, display: "inline-flex" }}>
        ← Back to Admin
      </Link>
      <div className="view-header">
        <div>
          <h1>Data Quality Review</h1>
          <p>Scans every school for outreach-critical problems — missing contact info, malformed emails/phones, orphaned contact info with no coach name.</p>
        </div>
        <button className="btn btn-gold" onClick={runScan} disabled={scanning}>
          {scanning ? "Scanning…" : result ? "Re-scan Database" : "Scan Database"}
        </button>
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <h3 style={{ marginBottom: 4 }}>Flagged as Possibly Outdated ({flaggedQueue.length})</h3>
        <p style={{ fontSize: 12.5, color: "#697386", marginTop: -2, marginBottom: 10 }}>
          Reported by coaches browsing the database — surfaces here immediately, no scan needed.
        </p>
        {flagActionError && <div className="notice danger" style={{ marginBottom: 10 }}>{flagActionError}</div>}
        {loadingFlags ? (
          <div className="empty-state">Loading…</div>
        ) : flaggedQueue.length === 0 ? (
          <div className="empty-state">Nothing flagged right now. Coaches can flag a listing from any school profile page.</div>
        ) : (
          flaggedQueue.map((flag) => {
            const s = flag.schools;
            const isEditing = editingId === s?.id;
            return (
              <div className="log-item" key={flag.id} style={{ paddingBottom: 12 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 8 }}>
                  <div>
                    <strong>{s?.name}</strong> — {s?.city}, {s?.state}
                    <div style={{ fontSize: 12, color: "#697386", marginTop: 2 }}>
                      Flagged {new Date(flag.created_at).toLocaleDateString()} by {flag.colleges?.name || "an HS coach account"}
                      {flag.reason ? ` — "${flag.reason}"` : ""}
                    </div>
                    <div style={{ fontSize: 12, color: "#697386", marginTop: 2 }}>
                      Currently: {[s?.hc_first_name, s?.hc_last_name].filter(Boolean).join(" ") || "no name"}
                      {s?.hc_email ? ` · ${s.hc_email}` : ""}
                      {s?.hc_cell ? ` · ${fmtPhone(s.hc_cell)}` : ""}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 6 }}>
                    <Link href={`/schools/${flag.school_id}`} className="btn btn-sm">Open Profile</Link>
                    {!isEditing && s && (
                      <button className="btn btn-sm btn-primary" onClick={() => startEdit(s)}>Quick Fix</button>
                    )}
                    <button className="btn btn-sm" disabled={flagActionId === flag.id} onClick={() => confirmAccurate(flag)}>
                      {flagActionId === flag.id ? "Saving…" : "Confirm accurate"}
                    </button>
                  </div>
                </div>

                {isEditing && s && (
                  <div style={{ background: "#f7f8fa", border: "1px solid #dde1e7", borderRadius: 8, padding: 10, marginTop: 8 }}>
                    <div className="grid grid-2" style={{ marginBottom: 8 }}>
                      {EDIT_FIELDS.map(([field, label]) => (
                        <div className="form-field" key={field} style={{ marginBottom: 0 }}>
                          <label>{label}</label>
                          <input value={editValues[field]} onChange={(e) => setEditValues((prev) => ({ ...prev, [field]: e.target.value }))} />
                        </div>
                      ))}
                    </div>
                    {saveError && <div className="notice danger" style={{ marginBottom: 8 }}>{saveError}</div>}
                    <div style={{ display: "flex", gap: 8 }}>
                      <button className="btn btn-sm btn-gold" disabled={saving === s.id} onClick={() => saveEdit(s)}>
                        {saving === s.id ? "Saving…" : "Save & Mark Verified"}
                      </button>
                      <button type="button" className="btn btn-sm" onClick={cancelEdit} disabled={saving === s.id}>
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {scanError && <div className="notice danger" style={{ marginBottom: 14 }}>{scanError}</div>}

      {!result && !scanning && (
        <div className="card">
          <div className="empty-state">Click &quot;Scan Database&quot; to build the review queue. This checks all ~14,600 schools client-side and doesn&apos;t change anything until you fix a record.</div>
        </div>
      )}

      {result && (
        <>
          <div className="grid grid-4" style={{ marginBottom: 14 }}>
            <div className="card stat-card">
              <div className="label">Actionable Issues</div>
              <div className="num">{result.totalFlagged.toLocaleString()}</div>
              <div className="sub">of {result.totalScanned.toLocaleString()} schools scanned</div>
            </div>
            <div className="card stat-card">
              <div className="label">No Contact Info</div>
              <div className="num">{(result.counts.no_contact || 0).toLocaleString()}</div>
              <div className="sub">completely unreachable</div>
            </div>
            <div className="card stat-card">
              <div className="label">Malformed Email/Phone</div>
              <div className="num">{((result.counts.bad_email || 0) + (result.counts.bad_cell || 0) + (result.counts.bad_office || 0)).toLocaleString()}</div>
              <div className="sub">likely to bounce or misdial</div>
            </div>
            <div className="card stat-card">
              <div className="label">Never Verified</div>
              <div className="num">{(result.counts.never_verified || 0).toLocaleString()}</div>
              <div className="sub">background count, not in the queue below</div>
            </div>
          </div>

          <div className="filters">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                className="btn btn-sm"
                style={filter === f.key ? { background: "#0b1f3a", color: "#fff", borderColor: "#0b1f3a" } : undefined}
                onClick={() => setFilter(f.key)}
              >
                {f.label}
                {f.key !== "all" && result.counts[f.key] ? ` (${result.counts[f.key]})` : ""}
              </button>
            ))}
          </div>

          <div className="card">
            <h3 style={{ marginBottom: 4 }}>
              Review Queue {visibleTotal > DISPLAY_CAP ? `— showing top ${DISPLAY_CAP} of ${visibleTotal}` : `(${visibleTotal})`}
            </h3>
            {saveError && <div className="notice danger" style={{ margin: "8px 0" }}>{saveError}</div>}
            {visibleRows.length === 0 ? (
              <div className="empty-state">Nothing in this filter — nice work.</div>
            ) : (
              visibleRows.map((row) => {
                const s = row.school;
                const isEditing = editingId === s.id;
                return (
                  <div className="log-item" key={s.id} style={{ paddingBottom: 12 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 8 }}>
                      <div>
                        <strong>{s.name}</strong> — {s.city}, {s.state}
                        <div style={{ marginTop: 4, display: "flex", flexWrap: "wrap", gap: 6 }}>
                          {row.issues
                            .filter((iss) => iss.actionable)
                            .map((iss) => (
                              <span key={iss.code} className={iss.severity === "critical" ? "badge badge-private" : "badge badge-unverified"}>
                                {iss.label}
                              </span>
                            ))}
                        </div>
                      </div>
                      <div style={{ display: "flex", gap: 6 }}>
                        <Link href={`/schools/${s.id}`} className="btn btn-sm">Open Profile</Link>
                        {!isEditing && (
                          <button className="btn btn-sm btn-primary" onClick={() => startEdit(s)}>Quick Fix</button>
                        )}
                      </div>
                    </div>

                    {isEditing && (
                      <div style={{ background: "#f7f8fa", border: "1px solid #dde1e7", borderRadius: 8, padding: 10, marginTop: 8 }}>
                        <div className="grid grid-2" style={{ marginBottom: 8 }}>
                          {EDIT_FIELDS.map(([field, label]) => (
                            <div className="form-field" key={field} style={{ marginBottom: 0 }}>
                              <label>{label}</label>
                              <input
                                value={editValues[field]}
                                onChange={(e) => setEditValues((prev) => ({ ...prev, [field]: e.target.value }))}
                              />
                            </div>
                          ))}
                        </div>
                        <div style={{ display: "flex", gap: 8 }}>
                          <button className="btn btn-sm btn-gold" disabled={saving === s.id} onClick={() => saveEdit(s)}>
                            {saving === s.id ? "Saving…" : "Save & Mark Verified"}
                          </button>
                          <button type="button" className="btn btn-sm" onClick={cancelEdit} disabled={saving === s.id}>
                            Cancel
                          </button>
                        </div>
                      </div>
                    )}

                    {!isEditing && (
                      <div style={{ fontSize: 12, color: "#697386", marginTop: 4 }}>
                        {[s.hc_first_name, s.hc_last_name].filter(Boolean).join(" ") || "no name"}
                        {s.hc_email ? ` · ${s.hc_email}` : ""}
                        {s.hc_cell ? ` · ${fmtPhone(s.hc_cell)}` : ""}
                        {s.hc_office ? ` · office ${fmtPhone(s.hc_office)}` : ""}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </>
      )}
    </div>
  );
}
