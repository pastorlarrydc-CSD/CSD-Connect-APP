"use client";
import { useEffect, useState, useCallback, Fragment } from "react";
import Link from "next/link";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { useAuth } from "@/lib/auth-context";

const ROLE_TABLE = [
  ["College Coach / Staff", "Search, map, CRM, watchlists — own college's data only"],
  ["Athletic Director", "All coaching-staff views plus program-wide reporting"],
  ["HS Head Coach", "Claim & update own school profile, submit prospects"],
  ["Verification Staff", "Edit school records, review flagged changes"],
  ["System Admin", "Full access, manage colleges and staff"],
];

const SECURITY_CHECKLIST = [
  ["Row-level security isolating each college's CRM data", true],
  ["Authentication required for all data access", true],
  ["Encryption in transit (HTTPS) and at rest (managed Postgres)", true],
  ["Every school edit keeps a change-history record", true],
  ["Admin approval workflow for published record changes", true],
  ["Multi-factor authentication enrollment (opt-in, under Account Security)", true],
  ["Automated verification engine (source cross-checks)", false],
  ["CAN-SPAM-compliant email campaign tooling", false],
];

const EDIT_FIELDS = [
  ["hc_first_name", "First name"],
  ["hc_last_name", "Last name"],
  ["hc_email", "Email"],
  ["hc_cell", "Cell"],
  ["hc_office", "Office"],
];

export default function AdminPage() {
  const supabase = getSupabaseBrowserClient();
  const { college, profile, user } = useAuth();

  const [staff, setStaff] = useState([]);
  const [schoolStats, setSchoolStats] = useState(null);

  const [pendingCorrections, setPendingCorrections] = useState([]);
  const [loadingCorrections, setLoadingCorrections] = useState(true);
  const [correctionActingId, setCorrectionActingId] = useState(null);
  const [correctionError, setCorrectionError] = useState("");

  // Lets a reviewer tweak a coach's suggested values before approving them
  // (e.g. fix a typo'd email) instead of only being able to accept a
  // suggestion exactly as submitted or reject it outright. The suggestion
  // itself stays pending in the database the whole time you're editing --
  // navigating away and coming back just reloads the same pending row, so
  // nothing is lost by stepping away mid-review.
  const [editingCorrectionId, setEditingCorrectionId] = useState(null);
  const [correctionEditValues, setCorrectionEditValues] = useState({});

  const [pendingClaims, setPendingClaims] = useState([]);
  const [loadingClaims, setLoadingClaims] = useState(true);
  const [claimActingId, setClaimActingId] = useState(null);
  const [claimError, setClaimError] = useState("");

  const canReview = profile?.role === "verifier" || profile?.role === "sysadmin";
  const isOwner = profile?.role === "sysadmin";

  const loadCorrections = useCallback(async () => {
    if (!canReview) {
      setLoadingCorrections(false);
      return;
    }
    setLoadingCorrections(true);
    const { data } = await supabase
      .from("school_edit_suggestions")
      .select("*, schools(id,name,city,state,hc_first_name,hc_last_name,hc_email,hc_cell,hc_office,website,maxpreps_url,verification_status,confidence_score), colleges:suggested_by_college_id(name)")
      .eq("status", "pending")
      .order("created_at", { ascending: true });
    setPendingCorrections(data || []);
    setLoadingCorrections(false);
  }, [supabase, canReview]);

  const loadClaims = useCallback(async () => {
    if (!canReview) {
      setLoadingClaims(false);
      return;
    }
    setLoadingClaims(true);
    const { data: claims } = await supabase
      .from("school_claims")
      .select("*, schools(id,name,city,state,hc_first_name,hc_last_name)")
      .eq("status", "pending")
      .order("created_at", { ascending: true });
    const rows = claims || [];
    const userIds = [...new Set(rows.map((c) => c.user_id))];
    let profilesById = {};
    if (userIds.length) {
      const { data: claimants } = await supabase.from("profiles").select("id,full_name,title").in("id", userIds);
      (claimants || []).forEach((p) => (profilesById[p.id] = p));
    }
    setPendingClaims(rows.map((c) => ({ ...c, claimant: profilesById[c.user_id] || null })));
    setLoadingClaims(false);
  }, [supabase, canReview]);

  useEffect(() => {
    async function loadOverview() {
      if (college?.id) {
        const { data } = await supabase.from("profiles").select("*").eq("college_id", college.id);
        setStaff(data || []);
      }
      const { count } = await supabase.from("schools").select("*", { count: "exact", head: true });
      setSchoolStats({ total: count });
    }
    loadOverview();
    loadCorrections();
    loadClaims();
  }, [supabase, college, loadCorrections, loadClaims]);

  // overrideValues comes from the "Edit" panel below when a reviewer has
  // adjusted the coach's suggested values before approving -- when it's
  // present it wins over what was originally submitted. The suggestion row
  // itself always keeps the coach's original text (that's the record of
  // what they actually asked for); what got applied to schools + why is
  // what the school_change_log entry's source/old/new values capture.
  async function approveCorrection(suggestion, overrideValues) {
    setCorrectionError("");
    setCorrectionActingId(suggestion.id);
    try {
      const current = suggestion.schools;
      const update = {};
      const changes = [];
      for (const [field] of EDIT_FIELDS) {
        const suggested = overrideValues ? overrideValues[field]?.trim() || null : suggestion[field];
        if (suggested == null || suggested === "") continue;
        const existing = current?.[field] || null;
        if (suggested !== existing) {
          update[field] = suggested;
          changes.push({
            school_id: suggestion.school_id,
            field_name: field,
            old_value: existing,
            new_value: suggested,
            source: overrideValues ? "Coach-submitted correction (approved, edited by verifier)" : "Coach-submitted correction (approved)",
            changed_by: user.id,
          });
        }
      }
      if (Object.keys(update).length) {
        update.verification_status = "verified";
        update.last_verified_at = new Date().toISOString();
        // confidence_score is NOT set here -- schools has a BEFORE
        // UPDATE trigger (trg_set_school_confidence_score) that
        // recomputes it from the row's own columns on every write, so
        // anything sent here would just be silently overridden anyway.
        const { error } = await supabase.from("schools").update(update).eq("id", suggestion.school_id);
        if (error) throw error;
        if (changes.length) {
          const { error: logError } = await supabase.from("school_change_log").insert(changes);
          if (logError) throw logError;
        }
      }
      const { error: statusError } = await supabase
        .from("school_edit_suggestions")
        .update({ status: "approved", reviewed_by: user.id, reviewed_at: new Date().toISOString() })
        .eq("id", suggestion.id);
      if (statusError) throw statusError;
      setEditingCorrectionId(null);
      loadCorrections();
    } catch (err) {
      setCorrectionError(err.message || "Could not approve this correction.");
    } finally {
      setCorrectionActingId(null);
    }
  }

  function startEditCorrection(suggestion) {
    setCorrectionError("");
    setEditingCorrectionId(suggestion.id);
    const values = {};
    EDIT_FIELDS.forEach(([field]) => {
      values[field] = (suggestion[field] ?? suggestion.schools?.[field] ?? "").toString();
    });
    setCorrectionEditValues(values);
  }

  function cancelEditCorrection() {
    setEditingCorrectionId(null);
    setCorrectionError("");
  }

  async function rejectCorrection(suggestion) {
    setCorrectionError("");
    setCorrectionActingId(suggestion.id);
    try {
      const { error } = await supabase
        .from("school_edit_suggestions")
        .update({ status: "rejected", reviewed_by: user.id, reviewed_at: new Date().toISOString() })
        .eq("id", suggestion.id);
      if (error) throw error;
      loadCorrections();
    } catch (err) {
      setCorrectionError(err.message || "Could not reject this correction.");
    } finally {
      setCorrectionActingId(null);
    }
  }

  async function decideClaim(claim, decision) {
    setClaimError("");
    setClaimActingId(claim.id);
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const res = await fetch(`/api/claims/${claim.id}/decide`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token}` },
        body: JSON.stringify({ decision }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || "Could not process this claim.");
      loadClaims();
    } catch (err) {
      setClaimError(err.message || "Could not process this claim.");
    } finally {
      setClaimActingId(null);
    }
  }

  return (
    <div className="view">
      <div className="view-header">
        <div>
          <h1>Administrator Controls</h1>
          <p>Roles, security, and data governance</p>
        </div>
      </div>

      {canReview && (
        <div className="card" style={{ marginBottom: 14 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
            <h3 style={{ margin: 0 }}>School Claims — Pending ({pendingClaims.length})</h3>
            <div>
              {isOwner && (
                <Link href="/admin/business" className="btn btn-sm btn-gold" style={{ marginRight: 8 }}>
                  Business Dashboard
                </Link>
              )}
              <Link href="/admin/leads" className="btn btn-sm btn-primary" style={{ marginRight: 8 }}>
                College Outreach
              </Link>
              <Link href="/admin/data-quality" className="btn btn-sm btn-primary" style={{ marginRight: 8 }}>
                Data Quality Review
              </Link>
              <Link href="/admin/duplicates" className="btn btn-sm btn-primary" style={{ marginRight: 8 }}>
                Duplicate Detection &amp; Cleanup
              </Link>
              <Link href="/schools/new" className="btn btn-sm btn-primary" style={{ marginRight: 8 }}>
                Add School
              </Link>
              <Link href="/admin/bulk-add-schools" className="btn btn-sm btn-primary" style={{ marginRight: 8 }}>
                Bulk Add Schools (CSV)
              </Link>
              <Link href="/admin/bulk-update" className="btn btn-sm btn-primary" style={{ marginRight: 8 }}>
                Bulk Update Schools (CSV)
              </Link>
              <Link href="/admin/bulk-maxpreps" className="btn btn-sm btn-primary" style={{ marginRight: 8 }}>
                Bulk MaxPreps Discovery
              </Link>
              <Link href="/admin/bulk-athletics" className="btn btn-sm btn-primary" style={{ marginRight: 8 }}>
                Bulk Athletics Discovery
              </Link>
              <Link href="/admin/bulk-social" className="btn btn-sm btn-primary" style={{ marginRight: 8 }}>
                Bulk Social Media Discovery
              </Link>
              <Link href="/admin/batch-coach-info" className="btn btn-sm btn-primary" style={{ marginRight: 8 }}>
                Batch Coach-Info Discovery
              </Link>
              <Link href="/admin/batch-athletics" className="btn btn-sm btn-primary">
                Batch Athletics-URL Discovery
              </Link>
            </div>
          </div>
          {claimError && <div className="notice danger" style={{ marginBottom: 10 }}>{claimError}</div>}
          {loadingClaims ? (
            <div className="empty-state">Loading…</div>
          ) : pendingClaims.length ? (
            pendingClaims.map((claim) => (
              <div key={claim.id} className="log-item" style={{ paddingBottom: 12 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 8 }}>
                  <div>
                    <strong>{claim.schools?.name}</strong> — {claim.schools?.city}, {claim.schools?.state}
                    <div style={{ fontSize: 12, color: "#697386", marginTop: 2 }}>
                      Claimed {new Date(claim.created_at).toLocaleDateString()} by {claim.claimant?.full_name || "an unnamed account"}
                      {claim.claimant?.title ? ` (${claim.claimant.title})` : ""}
                      {claim.note ? ` — "${claim.note}"` : ""}
                    </div>
                    {(claim.schools?.hc_first_name || claim.schools?.hc_last_name) && (
                      <div style={{ fontSize: 12, color: "#697386", marginTop: 2 }}>
                        Listing currently shows: {claim.schools.hc_first_name} {claim.schools.hc_last_name}
                      </div>
                    )}
                  </div>
                  <div style={{ display: "flex", gap: 6 }}>
                    <Link href={`/schools/${claim.school_id}`} className="btn btn-sm">
                      Open Profile
                    </Link>
                    <button className="btn btn-sm btn-primary" disabled={claimActingId === claim.id} onClick={() => decideClaim(claim, "approve")}>
                      Approve
                    </button>
                    <button className="btn btn-sm btn-danger" disabled={claimActingId === claim.id} onClick={() => decideClaim(claim, "reject")}>
                      Reject
                    </button>
                  </div>
                </div>
              </div>
            ))
          ) : (
            <div className="empty-state">No pending claims. When an HS coach clicks "This is my school" on a profile, it'll show up here.</div>
          )}
        </div>
      )}

      {canReview && (
        <div className="card" style={{ marginBottom: 14 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
            <h3 style={{ margin: 0 }}>Pending Coach-Info Corrections ({pendingCorrections.length})</h3>
          </div>
          {correctionError && <div className="notice danger" style={{ marginBottom: 10 }}>{correctionError}</div>}
          {loadingCorrections ? (
            <div className="empty-state">Loading…</div>
          ) : pendingCorrections.length ? (
            pendingCorrections.map((suggestion) => (
              <div key={suggestion.id} className="log-item" style={{ paddingBottom: 12 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 8 }}>
                  <div>
                    <strong>{suggestion.schools?.name}</strong> — {suggestion.schools?.city}, {suggestion.schools?.state}
                    <div style={{ fontSize: 12, color: "#697386", marginTop: 2 }}>
                      Submitted {new Date(suggestion.created_at).toLocaleDateString()} by {suggestion.colleges?.name || "a coach"}
                      {suggestion.note ? ` — "${suggestion.note}"` : ""}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 6 }}>
                    {editingCorrectionId !== suggestion.id && (
                      <button className="btn btn-sm" disabled={correctionActingId === suggestion.id} onClick={() => startEditCorrection(suggestion)}>
                        Edit
                      </button>
                    )}
                    <button className="btn btn-sm btn-primary" disabled={correctionActingId === suggestion.id} onClick={() => approveCorrection(suggestion)}>
                      Approve
                    </button>
                    <button className="btn btn-sm btn-danger" disabled={correctionActingId === suggestion.id} onClick={() => rejectCorrection(suggestion)}>
                      Reject
                    </button>
                  </div>
                </div>

                {editingCorrectionId === suggestion.id ? (
                  <div style={{ background: "#f7f8fa", border: "1px solid #dde1e7", borderRadius: 8, padding: 10, marginTop: 8 }}>
                    <div className="grid grid-2" style={{ marginBottom: 8 }}>
                      {EDIT_FIELDS.map(([field, label]) => (
                        <div className="form-field" key={field} style={{ marginBottom: 0 }}>
                          <label>{label}</label>
                          <input
                            value={correctionEditValues[field] || ""}
                            onChange={(e) => setCorrectionEditValues((prev) => ({ ...prev, [field]: e.target.value }))}
                          />
                        </div>
                      ))}
                    </div>
                    {correctionError && <div className="notice danger" style={{ marginBottom: 8 }}>{correctionError}</div>}
                    <div style={{ display: "flex", gap: 8 }}>
                      <button
                        className="btn btn-sm btn-gold"
                        disabled={correctionActingId === suggestion.id}
                        onClick={() => approveCorrection(suggestion, correctionEditValues)}
                      >
                        {correctionActingId === suggestion.id ? "Saving…" : "Save & Approve"}
                      </button>
                      <button type="button" className="btn btn-sm" onClick={cancelEditCorrection} disabled={correctionActingId === suggestion.id}>
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="kv" style={{ gridTemplateColumns: "110px 1fr 1fr", marginTop: 8, fontSize: 12.5 }}>
                    <div className="k" />
                    <div className="k">Current</div>
                    <div className="k">Suggested</div>
                    {EDIT_FIELDS.map(([field, label]) => {
                      const suggested = suggestion[field];
                      if (suggested == null || suggested === "") return null;
                      const current = suggestion.schools?.[field] || "—";
                      const changed = suggested !== current;
                      return (
                        <Fragment key={field}>
                          <div className="k">{label}</div>
                          <div className="v" style={{ fontWeight: 400 }}>{current}</div>
                          <div className="v" style={{ color: changed ? "#1e7145" : undefined, fontWeight: changed ? 700 : 400 }}>{suggested}</div>
                        </Fragment>
                      );
                    })}
                  </div>
                )}
              </div>
            ))
          ) : (
            <div className="empty-state">No pending corrections. Coach-submitted edits from school profile pages will show up here for review.</div>
          )}
        </div>
      )}

      <div className="grid grid-2">
        <div className="card">
          <h3>Role Reference</h3>
          <div className="kv" style={{ gridTemplateColumns: "1fr 2fr" }}>
            {ROLE_TABLE.map(([role, description]) => (
              <Fragment key={role}>
                <div className="k">{role}</div>
                <div className="v" style={{ fontWeight: 400 }}>{description}</div>
              </Fragment>
            ))}
          </div>
        </div>
        <div className="card">
          <h3>Security &amp; Governance Status</h3>
          {SECURITY_CHECKLIST.map(([label, done]) => (
            <label key={label} style={{ display: "flex", gap: 8, alignItems: "center", padding: "5px 0", fontSize: 13, borderBottom: "1px solid #eef0f3" }}>
              <input type="checkbox" checked={done} disabled /> {label}
            </label>
          ))}
        </div>
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <h3>{college?.name || "Your College"} — Staff ({staff.length})</h3>
        {staff.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Role</th>
                  <th>Title</th>
                </tr>
              </thead>
              <tbody>
                {staff.map((s) => (
                  <tr key={s.id}>
                    <td>{s.full_name}</td>
                    <td>{s.role}</td>
                    <td>{s.title || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty-state">No staff records found.</div>
        )}
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <h3>Data Provenance</h3>
        <div className="kv">
          <div className="k">Source file</div>
          <div className="v">CSD_HS_Coaches_Database_8-9-26_MASTER.csv</div>
          <div className="k">Records live</div>
          <div className="v">{schoolStats?.total?.toLocaleString() || "…"}</div>
          <div className="k">Database</div>
          <div className="v">Supabase (managed Postgres)</div>
        </div>
      </div>
    </div>
  );
}
