"use client";
import { useEffect, useState, useCallback, useRef } from "react";
import Link from "next/link";
import Papa from "papaparse";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { useAuth } from "@/lib/auth-context";

const STATUS_OPTIONS = ["not_contacted", "contacted", "interested", "trial", "customer", "not_interested"];
const STATUS_LABEL = {
  not_contacted: "Not Contacted",
  contacted: "Contacted",
  interested: "Interested",
  trial: "Trial",
  customer: "Customer",
  not_interested: "Not Interested",
};
const STATUS_BADGE = {
  not_contacted: "badge-not-contacted",
  contacted: "badge-contacted",
  interested: "badge-unverified",
  trial: "badge-unverified",
  customer: "badge-public",
  not_interested: "badge-private",
};

const EMPTY_FORM = {
  college_name: "",
  division: "",
  state: "",
  coach_first_name: "",
  coach_last_name: "",
  title: "",
  email: "",
  mobile: "",
  office_phone: "",
  notes: "",
};

// Header synonyms for CSV import -- keeps this forgiving of whatever
// column names a real spreadsheet of leads happens to use.
const HEADER_MAP = {
  college_name: ["college", "college name", "school", "program", "institution"],
  division: ["division", "level"],
  state: ["state", "st"],
  coach_first_name: ["first name", "coach first name", "firstname"],
  coach_last_name: ["last name", "coach last name", "lastname"],
  title: ["title", "position"],
  email: ["email", "email address"],
  mobile: ["mobile", "cell", "cell phone", "phone"],
  office_phone: ["office", "office phone", "office number"],
  notes: ["notes", "note", "comments"],
};

function normalizeHeader(h) {
  const clean = String(h || "").trim().toLowerCase();
  for (const [field, synonyms] of Object.entries(HEADER_MAP)) {
    if (clean === field.replace(/_/g, " ") || synonyms.includes(clean)) return field;
  }
  return null;
}

function fmtPhone(v) {
  if (!v) return "";
  const digits = String(v).replace(/\D/g, "");
  return digits.length === 10 ? `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}` : v;
}

export default function CollegeLeadsPage() {
  const supabase = getSupabaseBrowserClient();
  const { user, profile } = useAuth();
  const canManage = profile?.role === "verifier" || profile?.role === "sysadmin";
  const fileInputRef = useRef(null);

  const [leads, setLeads] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");

  const [showAdd, setShowAdd] = useState(false);
  const [addForm, setAddForm] = useState(EMPTY_FORM);
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState("");

  const [editingId, setEditingId] = useState(null);
  const [editForm, setEditForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [editError, setEditError] = useState("");

  const [deletingId, setDeletingId] = useState(null);
  const [statusSavingId, setStatusSavingId] = useState(null);

  const [importing, setImporting] = useState(false);
  const [importRows, setImportRows] = useState([]);
  const [importSkipped, setImportSkipped] = useState(0);
  const [importError, setImportError] = useState("");
  const [applyingImport, setApplyingImport] = useState(false);
  const [importResult, setImportResult] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    const { data, error } = await supabase
      .from("college_leads")
      .select("*")
      .order("updated_at", { ascending: false });
    if (error) setLoadError(error.message);
    setLeads(data || []);
    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    load();
  }, [load]);

  function field(setter) {
    return (key, val) => setter((prev) => ({ ...prev, [key]: val }));
  }
  const setAddField = field(setAddForm);
  const setEditField = field(setEditForm);

  async function submitAdd(e) {
    e.preventDefault();
    setAddError("");
    if (!addForm.college_name.trim()) {
      setAddError("College name is required.");
      return;
    }
    setAdding(true);
    try {
      const payload = Object.fromEntries(
        Object.entries(addForm).map(([k, v]) => [k, v.trim() ? v.trim() : null])
      );
      const { error } = await supabase.from("college_leads").insert({ ...payload, created_by: user.id });
      if (error) throw error;
      setAddForm(EMPTY_FORM);
      setShowAdd(false);
      await load();
    } catch (err) {
      setAddError(err.message || "Could not add this lead.");
    } finally {
      setAdding(false);
    }
  }

  function startEdit(lead) {
    setEditingId(lead.id);
    setEditError("");
    setEditForm({
      college_name: lead.college_name || "",
      division: lead.division || "",
      state: lead.state || "",
      coach_first_name: lead.coach_first_name || "",
      coach_last_name: lead.coach_last_name || "",
      title: lead.title || "",
      email: lead.email || "",
      mobile: lead.mobile || "",
      office_phone: lead.office_phone || "",
      notes: lead.notes || "",
    });
  }

  async function saveEdit(e) {
    e.preventDefault();
    setEditError("");
    if (!editForm.college_name.trim()) {
      setEditError("College name is required.");
      return;
    }
    setSaving(true);
    try {
      const payload = Object.fromEntries(
        Object.entries(editForm).map(([k, v]) => [k, v.trim() ? v.trim() : null])
      );
      const { error } = await supabase
        .from("college_leads")
        .update({ ...payload, updated_at: new Date().toISOString() })
        .eq("id", editingId);
      if (error) throw error;
      setEditingId(null);
      await load();
    } catch (err) {
      setEditError(err.message || "Could not save changes.");
    } finally {
      setSaving(false);
    }
  }

  async function updateStatus(lead, newStatus) {
    setStatusSavingId(lead.id);
    try {
      await supabase
        .from("college_leads")
        .update({
          status: newStatus,
          last_contacted_at: newStatus === "contacted" && !lead.last_contacted_at ? new Date().toISOString().slice(0, 10) : lead.last_contacted_at,
          updated_at: new Date().toISOString(),
        })
        .eq("id", lead.id);
      await load();
    } finally {
      setStatusSavingId(null);
    }
  }

  async function deleteLead(id) {
    if (!confirm("Delete this lead? This cannot be undone.")) return;
    setDeletingId(id);
    try {
      await supabase.from("college_leads").delete().eq("id", id);
      await load();
    } finally {
      setDeletingId(null);
    }
  }

  function handleCsvFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setImportError("");
    setImportRows([]);
    setImportSkipped(0);
    setImportResult(null);
    setImporting(true);
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: (results) => {
        setImporting(false);
        if (results.errors?.length) {
          setImportError(results.errors[0].message);
          return;
        }
        const rawRows = results.data || [];
        if (!rawRows.length) {
          setImportError("The file has no data rows.");
          return;
        }
        const headerKeys = Object.keys(rawRows[0]);
        const mapping = {};
        headerKeys.forEach((h) => {
          const field = normalizeHeader(h);
          if (field) mapping[h] = field;
        });

        const rows = [];
        let skipped = 0;
        rawRows.forEach((raw) => {
          const row = {};
          Object.entries(raw).forEach(([h, v]) => {
            const field = mapping[h];
            if (field) row[field] = String(v || "").trim();
          });
          if (!row.college_name) {
            skipped += 1;
            return;
          }
          rows.push(row);
        });
        setImportRows(rows);
        setImportSkipped(skipped);
        if (!rows.length) setImportError("No rows had a recognizable college name column.");
      },
      error: (err) => {
        setImporting(false);
        setImportError(err.message || "Could not read this file.");
      },
    });
  }

  function cancelImport() {
    setImportRows([]);
    setImportSkipped(0);
    setImportError("");
    setImportResult(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function applyImport() {
    setApplyingImport(true);
    setImportError("");
    try {
      const payload = importRows.map((r) => ({
        college_name: r.college_name,
        division: r.division || null,
        state: r.state || null,
        coach_first_name: r.coach_first_name || null,
        coach_last_name: r.coach_last_name || null,
        title: r.title || null,
        email: r.email || null,
        mobile: r.mobile || null,
        office_phone: r.office_phone || null,
        notes: r.notes || null,
        created_by: user.id,
      }));
      const { error } = await supabase.from("college_leads").insert(payload);
      if (error) throw error;
      setImportResult({ count: payload.length });
      setImportRows([]);
      if (fileInputRef.current) fileInputRef.current.value = "";
      await load();
    } catch (err) {
      setImportError(err.message || "Could not import these rows.");
    } finally {
      setApplyingImport(false);
    }
  }

  if (!canManage) {
    return (
      <div className="view">
        <div className="notice danger">The college outreach list is limited to Verification Staff and System Admins.</div>
      </div>
    );
  }

  const filtered = leads.filter((l) => {
    if (statusFilter && l.status !== statusFilter) return false;
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      const hay = `${l.college_name} ${l.coach_first_name || ""} ${l.coach_last_name || ""} ${l.state || ""}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  const counts = STATUS_OPTIONS.reduce((acc, s) => {
    acc[s] = leads.filter((l) => l.status === s).length;
    return acc;
  }, {});

  return (
    <div className="view">
      <Link href="/admin" className="btn btn-sm" style={{ marginBottom: 12, display: "inline-flex" }}>
        ← Back to Admin
      </Link>
      <div className="view-header">
        <div>
          <h1>College Outreach</h1>
          <p>Your own sales pipeline — college programs and their coaches, whether or not they&apos;ve signed up yet. Not visible to customers.</p>
        </div>
        <button className="btn btn-gold" onClick={() => setShowAdd((v) => !v)}>
          {showAdd ? "Cancel" : "+ Add Lead"}
        </button>
      </div>

      <div className="grid grid-4" style={{ marginBottom: 14 }}>
        <div className="card stat-card">
          <div className="label">Total Leads</div>
          <div className="num">{leads.length}</div>
        </div>
        <div className="card stat-card">
          <div className="label">Interested</div>
          <div className="num">{counts.interested}</div>
        </div>
        <div className="card stat-card">
          <div className="label">Trial</div>
          <div className="num">{counts.trial}</div>
        </div>
        <div className="card stat-card">
          <div className="label">Customers</div>
          <div className="num">{counts.customer}</div>
        </div>
      </div>

      {showAdd && (
        <div className="card" style={{ marginBottom: 14 }}>
          <h3>Add a Lead</h3>
          {addError && <div className="notice danger" style={{ marginBottom: 10 }}>{addError}</div>}
          <form onSubmit={submitAdd}>
            <div className="grid grid-2" style={{ marginBottom: 8 }}>
              <div className="form-field">
                <label>College / Program</label>
                <input value={addForm.college_name} onChange={(e) => setAddField("college_name", e.target.value)} placeholder="e.g. Midwest State University" />
              </div>
              <div className="form-field">
                <label>Division</label>
                <input value={addForm.division} onChange={(e) => setAddField("division", e.target.value)} placeholder="D2, D3, NAIA, JUCO…" />
              </div>
              <div className="form-field">
                <label>State</label>
                <input value={addForm.state} onChange={(e) => setAddField("state", e.target.value)} placeholder="TX" />
              </div>
              <div className="form-field">
                <label>Title</label>
                <input value={addForm.title} onChange={(e) => setAddField("title", e.target.value)} placeholder="Recruiting Coordinator" />
              </div>
              <div className="form-field">
                <label>Coach First Name</label>
                <input value={addForm.coach_first_name} onChange={(e) => setAddField("coach_first_name", e.target.value)} />
              </div>
              <div className="form-field">
                <label>Coach Last Name</label>
                <input value={addForm.coach_last_name} onChange={(e) => setAddField("coach_last_name", e.target.value)} />
              </div>
              <div className="form-field">
                <label>Email</label>
                <input type="email" value={addForm.email} onChange={(e) => setAddField("email", e.target.value)} />
              </div>
              <div className="form-field">
                <label>Mobile</label>
                <input value={addForm.mobile} onChange={(e) => setAddField("mobile", e.target.value)} />
              </div>
              <div className="form-field">
                <label>Office Number</label>
                <input value={addForm.office_phone} onChange={(e) => setAddField("office_phone", e.target.value)} />
              </div>
            </div>
            <div className="form-field">
              <label>Notes</label>
              <input value={addForm.notes} onChange={(e) => setAddField("notes", e.target.value)} placeholder="How you connected, what they need…" />
            </div>
            <button className="btn btn-gold btn-sm" disabled={adding}>{adding ? "Adding…" : "Add Lead"}</button>
          </form>
        </div>
      )}

      <div className="card" style={{ marginBottom: 14 }}>
        <h3>Import from CSV</h3>
        <p style={{ fontSize: 12.5, color: "#697386", marginTop: -4 }}>
          Columns read (any order, flexible names): college/school, division, state, first name, last name, title, email, mobile/cell, office, notes. Only college name is required.
        </p>
        {importError && <div className="notice danger" style={{ marginBottom: 10 }}>{importError}</div>}
        {importResult && <div className="notice info" style={{ marginBottom: 10 }}>Imported {importResult.count} lead{importResult.count === 1 ? "" : "s"}.</div>}
        <input ref={fileInputRef} type="file" accept=".csv" onChange={handleCsvFile} disabled={importing} />
        {importing && <div className="empty-state" style={{ marginTop: 8 }}>Reading file…</div>}

        {importRows.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <div className="notice" style={{ marginBottom: 10 }}>
              {importRows.length} row{importRows.length === 1 ? "" : "s"} ready to import{importSkipped ? `, ${importSkipped} skipped (no recognizable college name)` : ""}.
            </div>
            <div className="table-wrap" style={{ marginBottom: 12, maxHeight: 280, overflow: "auto" }}>
              <table>
                <thead><tr><th>College</th><th>Coach</th><th>State</th><th>Email</th><th>Mobile</th></tr></thead>
                <tbody>
                  {importRows.slice(0, 100).map((r, i) => (
                    <tr key={i}>
                      <td>{r.college_name}</td>
                      <td>{[r.coach_first_name, r.coach_last_name].filter(Boolean).join(" ") || "—"}</td>
                      <td>{r.state || "—"}</td>
                      <td>{r.email || "—"}</td>
                      <td>{r.mobile || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {importRows.length > 100 && <div className="notice" style={{ margin: 8 }}>Showing first 100 of {importRows.length}. All will be imported.</div>}
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn btn-sm btn-gold" onClick={applyImport} disabled={applyingImport}>
                {applyingImport ? "Importing…" : `Import ${importRows.length} Lead${importRows.length === 1 ? "" : "s"}`}
              </button>
              <button className="btn btn-sm" onClick={cancelImport} disabled={applyingImport}>Cancel</button>
            </div>
          </div>
        )}
      </div>

      <div className="filters">
        <div className="field" style={{ minWidth: 220 }}>
          <label>Search</label>
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="College, coach, state…" />
        </div>
        <div className="field">
          <label>Status</label>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="">All</option>
            {STATUS_OPTIONS.map((s) => (
              <option key={s} value={s}>{STATUS_LABEL[s]} ({counts[s]})</option>
            ))}
          </select>
        </div>
      </div>

      {loadError && <div className="notice danger" style={{ marginBottom: 14 }}>{loadError}</div>}

      <div className="card">
        <h3>Leads ({filtered.length})</h3>
        {loading ? (
          <div className="empty-state">Loading…</div>
        ) : filtered.length === 0 ? (
          <div className="empty-state">No leads match. Add one above or import a CSV.</div>
        ) : (
          filtered.map((lead) => {
            const isEditing = editingId === lead.id;
            return (
              <div className="log-item" key={lead.id} style={{ paddingBottom: 12 }}>
                {isEditing ? (
                  <form onSubmit={saveEdit} style={{ background: "#f7f8fa", border: "1px solid #dde1e7", borderRadius: 8, padding: 10 }}>
                    {editError && <div className="notice danger" style={{ marginBottom: 8 }}>{editError}</div>}
                    <div className="grid grid-2" style={{ marginBottom: 8 }}>
                      <div className="form-field" style={{ marginBottom: 0 }}>
                        <label>College / Program</label>
                        <input value={editForm.college_name} onChange={(e) => setEditField("college_name", e.target.value)} />
                      </div>
                      <div className="form-field" style={{ marginBottom: 0 }}>
                        <label>Division</label>
                        <input value={editForm.division} onChange={(e) => setEditField("division", e.target.value)} />
                      </div>
                      <div className="form-field" style={{ marginBottom: 0 }}>
                        <label>State</label>
                        <input value={editForm.state} onChange={(e) => setEditField("state", e.target.value)} />
                      </div>
                      <div className="form-field" style={{ marginBottom: 0 }}>
                        <label>Title</label>
                        <input value={editForm.title} onChange={(e) => setEditField("title", e.target.value)} />
                      </div>
                      <div className="form-field" style={{ marginBottom: 0 }}>
                        <label>Coach First Name</label>
                        <input value={editForm.coach_first_name} onChange={(e) => setEditField("coach_first_name", e.target.value)} />
                      </div>
                      <div className="form-field" style={{ marginBottom: 0 }}>
                        <label>Coach Last Name</label>
                        <input value={editForm.coach_last_name} onChange={(e) => setEditField("coach_last_name", e.target.value)} />
                      </div>
                      <div className="form-field" style={{ marginBottom: 0 }}>
                        <label>Email</label>
                        <input type="email" value={editForm.email} onChange={(e) => setEditField("email", e.target.value)} />
                      </div>
                      <div className="form-field" style={{ marginBottom: 0 }}>
                        <label>Mobile</label>
                        <input value={editForm.mobile} onChange={(e) => setEditField("mobile", e.target.value)} />
                      </div>
                      <div className="form-field" style={{ marginBottom: 0 }}>
                        <label>Office Number</label>
                        <input value={editForm.office_phone} onChange={(e) => setEditField("office_phone", e.target.value)} />
                      </div>
                    </div>
                    <div className="form-field">
                      <label>Notes</label>
                      <input value={editForm.notes} onChange={(e) => setEditField("notes", e.target.value)} />
                    </div>
                    <div style={{ display: "flex", gap: 8 }}>
                      <button className="btn btn-sm btn-gold" disabled={saving}>{saving ? "Saving…" : "Save"}</button>
                      <button type="button" className="btn btn-sm" onClick={() => setEditingId(null)} disabled={saving}>Cancel</button>
                    </div>
                  </form>
                ) : (
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 8 }}>
                    <div>
                      <strong>{lead.college_name}</strong>
                      {lead.division ? ` — ${lead.division}` : ""}
                      {lead.state ? `, ${lead.state}` : ""}
                      <div style={{ fontSize: 12.5, color: "#3c4658", marginTop: 3 }}>
                        {[lead.coach_first_name, lead.coach_last_name].filter(Boolean).join(" ") || <span className="empty-state" style={{ padding: 0 }}>no coach name on file</span>}
                        {lead.title ? ` · ${lead.title}` : ""}
                      </div>
                      <div style={{ fontSize: 12, color: "#697386", marginTop: 2, display: "flex", gap: 10, flexWrap: "wrap" }}>
                        {lead.email && <span>✉️ {lead.email}</span>}
                        {lead.mobile && <span>📱 {fmtPhone(lead.mobile)}</span>}
                        {lead.office_phone && <span>☎️ {fmtPhone(lead.office_phone)} (office)</span>}
                        {!lead.email && !lead.mobile && !lead.office_phone && <span>No contact info on file</span>}
                      </div>
                      {lead.notes && <div style={{ fontSize: 12, color: "#3c4658", marginTop: 4 }}>📝 {lead.notes}</div>}
                      {lead.last_contacted_at && <div style={{ fontSize: 11, color: "#697386", marginTop: 2 }}>Last contacted {lead.last_contacted_at}</div>}
                    </div>
                    <div style={{ display: "flex", gap: 6, alignItems: "center", flexShrink: 0 }}>
                      <select
                        value={lead.status}
                        onChange={(e) => updateStatus(lead, e.target.value)}
                        disabled={statusSavingId === lead.id}
                        className={STATUS_BADGE[lead.status]}
                        style={{ border: "none", padding: "4px 6px", borderRadius: 20, fontWeight: 700, fontSize: 11 }}
                      >
                        {STATUS_OPTIONS.map((s) => (
                          <option key={s} value={s}>{STATUS_LABEL[s]}</option>
                        ))}
                      </select>
                      <button className="btn btn-sm" onClick={() => startEdit(lead)}>Edit</button>
                      <button className="btn btn-sm btn-danger" onClick={() => deleteLead(lead.id)} disabled={deletingId === lead.id}>
                        {deletingId === lead.id ? "…" : "Delete"}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
