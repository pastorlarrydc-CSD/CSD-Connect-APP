"use client";
import { useEffect, useState, useCallback, useRef } from "react";
import Link from "next/link";
import Papa from "papaparse";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { useAuth } from "@/lib/auth-context";

const PAGE_SIZE = 50;
const IMPORT_CHUNK = 500;

// Canonical division labels -- matches the values already on file from the
// August 2026 College Coaches Database import (see college_leads rows).
// Used for BOTH the browse filter and the Add/Edit form's Division select,
// so every lead lands in one of these buckets instead of free-typed
// variants ("D2" vs "NCAA DII") that would silently fall outside the filter.
const DIVISIONS = ["FBS", "FCS", "NCAA DII", "NCAA DIII", "NAIA", "JC", "JC-CCCAA"];

// Mirrors the classify_college_lead_role() Postgres trigger (see the
// add_lead_role_and_position_classification migration) which auto-fills
// these from the free-text "title" column on import/add whenever they're
// left blank. Keeping the option lists here in sync with the trigger's
// CASE branches is what makes the filter dropdowns and the auto-detected
// values line up.
const ROLE_CATEGORIES = [
  "Head Coach",
  "Recruiting Coordinator",
  "Coordinator",
  "Recruiting & Player Personnel Staff",
  "Position Coach",
  "Operations/Support Staff",
  "Other",
];
const POSITION_TAGS = [
  "Quarterbacks",
  "Running Backs",
  "Wide Receivers",
  "Tight Ends",
  "Offensive Line",
  "Defensive Line",
  "Linebackers",
  "Defensive Backs",
  "Special Teams",
];

// college_leads.state stores full state names (from the CSV import), not
// two-letter codes like the schools table does -- so this list has to be
// the spelled-out names or the filter values would never match.
const US_STATES = [
  "Alabama", "Alaska", "Arizona", "Arkansas", "California", "Colorado", "Connecticut", "Delaware",
  "District of Columbia", "Florida", "Georgia", "Hawaii", "Idaho", "Illinois", "Indiana", "Iowa", "Kansas",
  "Kentucky", "Louisiana", "Maine", "Maryland", "Massachusetts", "Michigan", "Minnesota", "Mississippi",
  "Missouri", "Montana", "Nebraska", "Nevada", "New Hampshire", "New Jersey", "New Mexico", "New York",
  "North Carolina", "North Dakota", "Ohio", "Oklahoma", "Oregon", "Pennsylvania", "Rhode Island",
  "South Carolina", "South Dakota", "Tennessee", "Texas", "Utah", "Vermont", "Virginia", "Washington",
  "West Virginia", "Wisconsin", "Wyoming",
];

const SORT_OPTIONS = [
  { value: "updated_desc", label: "Recently Updated" },
  { value: "college_asc", label: "College Name (A-Z)" },
  { value: "state_asc", label: "State" },
  { value: "callback_asc", label: "Next Callback" },
  { value: "stale_first", label: "Longest Since Contact" },
];

// "30+ days" and "60+ days" etc. also pull in leads that have NEVER been
// contacted (last_contacted_at is null) -- those are at least as stale as
// any dated one, so they belong in every one of these buckets.
const CONTACT_RECENCY_OPTIONS = [
  { value: "", label: "All" },
  { value: "never", label: "Never Contacted" },
  { value: "30", label: "30+ Days Since Contact" },
  { value: "60", label: "60+ Days Since Contact" },
  { value: "90", label: "90+ Days Since Contact" },
];

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
  next_callback_at: "",
  role_category: "",
  position_tags: [],
};

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function fmtDate(d) {
  if (!d) return "";
  return new Date(d + "T00:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

// Overdue / due-today / due-this-week badge for a lead's next_callback_at.
// Plain date-string math (YYYY-MM-DD) avoids timezone drift from parsing
// into a Date and comparing.
function callbackBadge(nextCallbackAt) {
  if (!nextCallbackAt) return null;
  const today = todayISO();
  if (nextCallbackAt < today) {
    const days = Math.round((new Date(today) - new Date(nextCallbackAt)) / 86400000);
    return { label: `Overdue ${days}d`, tone: "danger" };
  }
  if (nextCallbackAt === today) return { label: "Due today", tone: "today" };
  const weekOut = new Date();
  weekOut.setDate(weekOut.getDate() + 7);
  if (nextCallbackAt <= weekOut.toISOString().slice(0, 10)) return { label: `Due ${fmtDate(nextCallbackAt)}`, tone: "week" };
  return { label: `Due ${fmtDate(nextCallbackAt)}`, tone: "later" };
}
const BADGE_STYLE = {
  danger: { background: "#fbe4e1", color: "#b3312c" },
  today: { background: "#fff1c2", color: "#8a6400" },
  week: { background: "#e3ecff", color: "#2246b3" },
  later: { background: "#eef0f4", color: "#697386" },
};

// Whole days between a YYYY-MM-DD date string and today -- same
// plain-string-math approach as callbackBadge, to avoid timezone drift.
function daysSince(dateStr) {
  if (!dateStr) return null;
  return Math.round((new Date(todayISO()) - new Date(dateStr)) / 86400000);
}

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

// Shared checkbox-pill picker for position_tags -- used by both the Add
// Lead form and LeadRow's edit form so a coach who works with more than one
// position group (e.g. "Running Backs" + "Special Teams") can be tagged
// with both, without duplicating this markup in two places.
function PositionTagsPicker({ value, onChange }) {
  const selected = Array.isArray(value) ? value : [];
  function toggle(tag) {
    onChange(selected.includes(tag) ? selected.filter((t) => t !== tag) : [...selected, tag]);
  }
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
      {POSITION_TAGS.map((tag) => {
        const active = selected.includes(tag);
        return (
          <label
            key={tag}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 4,
              fontSize: 11.5,
              fontWeight: 600,
              color: active ? "#2246b3" : "#3c4658",
              background: active ? "#e3ecff" : "#f7f8fa",
              border: `1px solid ${active ? "#2246b3" : "#dde1e7"}`,
              borderRadius: 20,
              padding: "3px 9px",
              cursor: "pointer",
            }}
          >
            <input type="checkbox" checked={active} onChange={() => toggle(tag)} style={{ margin: 0 }} />
            {tag}
          </label>
        );
      })}
    </div>
  );
}

// One row's worth of UI -- shared between the "Due for a Callback" panel
// and the main paginated list, so status changes, edits, and the
// notes/call-log panel work identically in both places. Deliberately a
// top-level component (not nested inside CollegeLeadsPage) so its identity
// stays stable across renders -- a component defined inside another
// component's body gets a new function identity every render, which would
// make React remount this row (and its inputs, losing focus mid-keystroke)
// every time any state in the page changed.
function LeadRow({
  lead,
  isEditing,
  isExpanded,
  editForm,
  setEditField,
  editError,
  saving,
  onSaveEdit,
  onCancelEdit,
  statusSavingId,
  onUpdateStatus,
  onToggleNotes,
  onStartEdit,
  onDelete,
  deletingId,
  noteError,
  newNoteText,
  setNewNoteText,
  newNoteCallback,
  setNewNoteCallback,
  savingNote,
  onAddNote,
  notesLoading,
  notes,
}) {
  const badge = callbackBadge(lead.next_callback_at);
  return (
    <div className="log-item" style={{ paddingBottom: 12 }}>
      {isEditing ? (
        <form onSubmit={onSaveEdit} style={{ background: "#f7f8fa", border: "1px solid #dde1e7", borderRadius: 8, padding: 10 }}>
          {editError && <div className="notice danger" style={{ marginBottom: 8 }}>{editError}</div>}
          <div className="grid grid-2" style={{ marginBottom: 8 }}>
            <div className="form-field" style={{ marginBottom: 0 }}>
              <label>College / Program</label>
              <input value={editForm.college_name} onChange={(e) => setEditField("college_name", e.target.value)} />
            </div>
            <div className="form-field" style={{ marginBottom: 0 }}>
              <label>Division</label>
              <select value={editForm.division} onChange={(e) => setEditField("division", e.target.value)}>
                <option value="">Select…</option>
                {DIVISIONS.map((d) => (
                  <option key={d} value={d}>{d}</option>
                ))}
              </select>
            </div>
            <div className="form-field" style={{ marginBottom: 0 }}>
              <label>State</label>
              <select value={editForm.state} onChange={(e) => setEditField("state", e.target.value)}>
                <option value="">Select…</option>
                {US_STATES.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
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
            <div className="form-field" style={{ marginBottom: 0 }}>
              <label>Next Callback</label>
              <input type="date" value={editForm.next_callback_at} onChange={(e) => setEditField("next_callback_at", e.target.value)} />
            </div>
            <div className="form-field" style={{ marginBottom: 0 }}>
              <label>Role</label>
              <select value={editForm.role_category} onChange={(e) => setEditField("role_category", e.target.value)}>
                <option value="">Auto-detect from title</option>
                {ROLE_CATEGORIES.map((r) => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </select>
            </div>
          </div>
          <div className="form-field">
            <label>Position(s) Coached</label>
            <PositionTagsPicker value={editForm.position_tags} onChange={(tags) => setEditField("position_tags", tags)} />
          </div>
          <div className="form-field">
            <label>Notes</label>
            <input value={editForm.notes} onChange={(e) => setEditField("notes", e.target.value)} />
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn btn-sm btn-gold" disabled={saving}>{saving ? "Saving…" : "Save"}</button>
            <button type="button" className="btn btn-sm" onClick={onCancelEdit} disabled={saving}>Cancel</button>
          </div>
        </form>
      ) : (
        <>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 8 }}>
            <div>
              <strong>{lead.college_name}</strong>
              {lead.division ? ` — ${lead.division}` : ""}
              {lead.state ? `, ${lead.state}` : ""}
              {badge && (
                <span
                  style={{
                    marginLeft: 8,
                    fontSize: 11,
                    fontWeight: 700,
                    padding: "2px 7px",
                    borderRadius: 20,
                    ...BADGE_STYLE[badge.tone],
                  }}
                >
                  📞 {badge.label}
                </span>
              )}
              <div style={{ fontSize: 12.5, color: "#3c4658", marginTop: 3 }}>
                {[lead.coach_first_name, lead.coach_last_name].filter(Boolean).join(" ") || <span className="empty-state" style={{ padding: 0 }}>no coach name on file</span>}
                {lead.title ? ` · ${lead.title}` : ""}
              </div>
              {(lead.role_category || (lead.position_tags && lead.position_tags.length > 0)) && (
                <div style={{ marginTop: 4, display: "flex", gap: 5, flexWrap: "wrap" }}>
                  {lead.role_category && (
                    <span style={{ fontSize: 10.5, fontWeight: 700, padding: "2px 7px", borderRadius: 20, background: "#eef0f4", color: "#3c4658" }}>
                      {lead.role_category}
                    </span>
                  )}
                  {(lead.position_tags || []).map((tag) => (
                    <span key={tag} style={{ fontSize: 10.5, fontWeight: 700, padding: "2px 7px", borderRadius: 20, background: "#e3ecff", color: "#2246b3" }}>
                      {tag}
                    </span>
                  ))}
                </div>
              )}
              <div style={{ fontSize: 12, color: "#697386", marginTop: 2, display: "flex", gap: 10, flexWrap: "wrap" }}>
                {lead.email && <span>✉️ {lead.email}</span>}
                {lead.mobile && <span>📱 {fmtPhone(lead.mobile)}</span>}
                {lead.office_phone && <span>☎️ {fmtPhone(lead.office_phone)} (office)</span>}
                {!lead.email && !lead.mobile && !lead.office_phone && <span>No contact info on file</span>}
              </div>
              {lead.notes && <div style={{ fontSize: 12, color: "#3c4658", marginTop: 4 }}>📝 {lead.notes}</div>}
              {lead.last_contacted_at ? (
                (() => {
                  const d = daysSince(lead.last_contacted_at);
                  const stale = d >= 60;
                  return (
                    <div style={{ fontSize: 11, color: stale ? "#b3312c" : "#697386", fontWeight: stale ? 700 : 400, marginTop: 2 }}>
                      Last contacted {fmtDate(lead.last_contacted_at)} ({d}d ago){stale ? " — going cold" : ""}
                    </div>
                  );
                })()
              ) : (
                <div style={{ fontSize: 11, color: "#b3312c", fontWeight: 700, marginTop: 2 }}>Never contacted</div>
              )}
            </div>
            <div style={{ display: "flex", gap: 6, alignItems: "center", flexShrink: 0 }}>
              <select
                value={lead.status}
                onChange={(e) => onUpdateStatus(lead, e.target.value)}
                disabled={statusSavingId === lead.id}
                className={STATUS_BADGE[lead.status]}
                style={{ border: "none", padding: "4px 6px", borderRadius: 20, fontWeight: 700, fontSize: 11 }}
              >
                {STATUS_OPTIONS.map((s) => (
                  <option key={s} value={s}>{STATUS_LABEL[s]}</option>
                ))}
              </select>
              <button className="btn btn-sm" onClick={() => onToggleNotes(lead.id)}>{isExpanded ? "Hide Notes" : "Notes & Calls"}</button>
              <button className="btn btn-sm" onClick={() => onStartEdit(lead)}>Edit</button>
              <button className="btn btn-sm btn-danger" onClick={() => onDelete(lead.id)} disabled={deletingId === lead.id}>
                {deletingId === lead.id ? "…" : "Delete"}
              </button>
            </div>
          </div>
          {isExpanded && (
            <div style={{ marginTop: 10, background: "#f7f8fa", border: "1px solid #dde1e7", borderRadius: 8, padding: 10 }}>
              {noteError && <div className="notice danger" style={{ marginBottom: 8 }}>{noteError}</div>}
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10, alignItems: "flex-end" }}>
                <div className="form-field" style={{ marginBottom: 0, flex: "1 1 240px" }}>
                  <label>New note</label>
                  <input
                    placeholder="What happened on this call / email…"
                    value={newNoteText}
                    onChange={(e) => setNewNoteText(e.target.value)}
                  />
                </div>
                <div className="form-field" style={{ marginBottom: 0 }}>
                  <label>Set next callback (optional)</label>
                  <input type="date" value={newNoteCallback} onChange={(e) => setNewNoteCallback(e.target.value)} />
                </div>
                <button className="btn btn-sm btn-gold" onClick={() => onAddNote(lead.id)} disabled={savingNote}>
                  {savingNote ? "Saving…" : "Save Note"}
                </button>
              </div>
              {notesLoading ? (
                <div className="empty-state">Loading…</div>
              ) : (notes || []).length === 0 ? (
                <div className="empty-state">No notes yet — log your first call above.</div>
              ) : (
                (notes || []).map((n) => (
                  <div key={n.id} style={{ fontSize: 12.5, padding: "6px 0", borderBottom: "1px solid #e5e8ee" }}>
                    <div style={{ color: "#697386", fontSize: 11 }}>
                      {new Date(n.created_at).toLocaleString(undefined, {
                        month: "short",
                        day: "numeric",
                        year: "numeric",
                        hour: "numeric",
                        minute: "2-digit",
                      })}
                    </div>
                    <div>{n.note}</div>
                  </div>
                ))
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default function CollegeLeadsPage() {
  const supabase = getSupabaseBrowserClient();
  const { user, profile } = useAuth();
  const canManage = profile?.role === "verifier" || profile?.role === "sysadmin";
  const fileInputRef = useRef(null);

  const [leads, setLeads] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  // Pipeline totals shown in the stat cards -- counted with head:true
  // queries against the whole table (not the current filter/page), so they
  // stay accurate no matter what's being searched or filtered below.
  const [stats, setStats] = useState({ total: 0, interested: 0, trial: 0, customer: 0 });

  // searchInput updates instantly as Larry types (so the box feels
  // responsive); search is the debounced value actually sent to Supabase,
  // so a fast typist doesn't fire a query on every keystroke against 9,000+
  // rows.
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const searchDebounceRef = useRef(null);
  function handleSearchInput(v) {
    setSearchInput(v);
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    searchDebounceRef.current = setTimeout(() => {
      setSearch(v);
      setPage(0);
    }, 300);
  }

  const [statusFilter, setStatusFilter] = useState("");
  const [divisionFilter, setDivisionFilter] = useState("");
  const [roleFilter, setRoleFilter] = useState("");
  const [positionFilter, setPositionFilter] = useState("");
  const [stateFilter, setStateFilter] = useState("");
  const [hasEmailFilter, setHasEmailFilter] = useState(false);
  const [hasPhoneFilter, setHasPhoneFilter] = useState(false);
  const [recencyFilter, setRecencyFilter] = useState(""); // "" | "never" | "30" | "60" | "90"
  const [sortBy, setSortBy] = useState("updated_desc");
  const [callbackFilter, setCallbackFilter] = useState(""); // "" | "due" | "week"

  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState("");

  // Saved filter presets -- lets the team jump straight back to a named
  // combination (e.g. "TX Recruiting Coordinators, not yet contacted")
  // instead of re-picking every dropdown. Backed by lead_filter_presets.
  const [presets, setPresets] = useState([]);
  const [selectedPresetId, setSelectedPresetId] = useState("");
  const [presetName, setPresetName] = useState("");
  const [savingPreset, setSavingPreset] = useState(false);
  const [presetError, setPresetError] = useState("");

  // Due-for-a-callback panel -- counts for the pills, and the actual
  // overdue/today leads shown inline (capped) so the most urgent calls are
  // visible without an extra click.
  const [dueCounts, setDueCounts] = useState({ overdue: 0, today: 0, week: 0 });
  const [dueItems, setDueItems] = useState([]);
  const [dueLoading, setDueLoading] = useState(true);

  // Notes/call log -- one lead expanded at a time, notes lazy-loaded on
  // expand rather than fetched for every row on the page.
  const [expandedNotesId, setExpandedNotesId] = useState(null);
  const [notesByLead, setNotesByLead] = useState({});
  const [notesLoading, setNotesLoading] = useState(false);
  const [newNoteText, setNewNoteText] = useState("");
  const [newNoteCallback, setNewNoteCallback] = useState("");
  const [savingNote, setSavingNote] = useState(false);
  const [noteError, setNoteError] = useState("");

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
  const [importProgress, setImportProgress] = useState(0);

  // Applies every filter/search condition shared between the on-screen list
  // and the "Export Filtered (CSV)" button, so the two can never drift out
  // of sync with each other. Sorting and pagination are added separately by
  // each caller since export doesn't page.
  const applyLeadsFilters = useCallback(
    (query) => {
      if (statusFilter) query = query.eq("status", statusFilter);
      if (divisionFilter) query = query.eq("division", divisionFilter);
      if (roleFilter) query = query.eq("role_category", roleFilter);
      if (positionFilter) query = query.contains("position_tags", [positionFilter]);
      if (stateFilter) query = query.eq("state", stateFilter);
      if (hasEmailFilter) query = query.not("email", "is", null);
      if (hasPhoneFilter) query = query.or("mobile.not.is.null,office_phone.not.is.null");
      if (recencyFilter === "never") {
        query = query.is("last_contacted_at", null);
      } else if (recencyFilter) {
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - parseInt(recencyFilter, 10));
        const cutoffISO = cutoff.toISOString().slice(0, 10);
        query = query.or(`last_contacted_at.is.null,last_contacted_at.lte.${cutoffISO}`);
      }
      if (callbackFilter === "due") query = query.lte("next_callback_at", todayISO());
      else if (callbackFilter === "week") {
        const weekOut = new Date();
        weekOut.setDate(weekOut.getDate() + 7);
        query = query.not("next_callback_at", "is", null).lte("next_callback_at", weekOut.toISOString().slice(0, 10));
      }
      if (search.trim()) {
        const q = search.trim().replace(/[%,()]/g, "");
        query = query.or(
          `college_name.ilike.%${q}%,coach_first_name.ilike.%${q}%,coach_last_name.ilike.%${q}%,state.ilike.%${q}%,email.ilike.%${q}%,title.ilike.%${q}%`
        );
      }
      return query;
    },
    [statusFilter, divisionFilter, roleFilter, positionFilter, stateFilter, hasEmailFilter, hasPhoneFilter, recencyFilter, callbackFilter, search]
  );

  // Server-side filtered + paginated fetch -- previously this loaded the
  // entire table with a plain .select("*") and filtered/counted in the
  // browser, which silently capped at Supabase's 1000-row default and, even
  // fixed, would mean shipping and re-rendering 9,000+ leads on every
  // keystroke. Filtering, counting, and paging all happen in Postgres now;
  // the browser only ever holds one page (PAGE_SIZE rows) at a time.
  const loadLeads = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    let query = supabase.from("college_leads").select("*", { count: "exact" });
    query = applyLeadsFilters(query);
    // A callback filter forces soonest-due-first sort (that's the whole
    // point of that view); otherwise honor whatever the Sort dropdown says.
    if (callbackFilter) {
      query = query.order("next_callback_at", { ascending: true });
    } else if (sortBy === "college_asc") {
      query = query.order("college_name", { ascending: true });
    } else if (sortBy === "state_asc") {
      query = query.order("state", { ascending: true, nullsFirst: false });
    } else if (sortBy === "callback_asc") {
      query = query.order("next_callback_at", { ascending: true, nullsFirst: false });
    } else if (sortBy === "stale_first") {
      // Nulls (never contacted) sort first -- those are at least as
      // overdue for a call as the oldest dated one.
      query = query.order("last_contacted_at", { ascending: true, nullsFirst: true });
    } else {
      query = query.order("updated_at", { ascending: false });
    }
    query = query.range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);
    const { data, error, count } = await query;
    if (error) setLoadError(error.message);
    setLeads(data || []);
    setTotal(count || 0);
    setLoading(false);
  }, [supabase, applyLeadsFilters, sortBy, callbackFilter, page]);

  const loadStats = useCallback(async () => {
    const [{ count: totalCount }, { count: interestedCount }, { count: trialCount }, { count: customerCount }] = await Promise.all([
      supabase.from("college_leads").select("*", { count: "exact", head: true }),
      supabase.from("college_leads").select("*", { count: "exact", head: true }).eq("status", "interested"),
      supabase.from("college_leads").select("*", { count: "exact", head: true }).eq("status", "trial"),
      supabase.from("college_leads").select("*", { count: "exact", head: true }).eq("status", "customer"),
    ]);
    setStats({ total: totalCount || 0, interested: interestedCount || 0, trial: trialCount || 0, customer: customerCount || 0 });
  }, [supabase]);

  // Counts + the actual overdue/today leads for the "Due for a Callback"
  // panel. Independent of the main list's filters/page so it always shows
  // the true urgent list.
  const loadDue = useCallback(async () => {
    setDueLoading(true);
    const today = todayISO();
    const weekOut = new Date();
    weekOut.setDate(weekOut.getDate() + 7);
    const weekOutISO = weekOut.toISOString().slice(0, 10);
    const [{ count: overdueCount }, { count: todayCount }, { count: weekCount }, { data: items }] = await Promise.all([
      supabase.from("college_leads").select("*", { count: "exact", head: true }).lt("next_callback_at", today),
      supabase.from("college_leads").select("*", { count: "exact", head: true }).eq("next_callback_at", today),
      supabase.from("college_leads").select("*", { count: "exact", head: true }).gt("next_callback_at", today).lte("next_callback_at", weekOutISO),
      supabase.from("college_leads").select("*").lte("next_callback_at", today).order("next_callback_at", { ascending: true }).limit(12),
    ]);
    setDueCounts({ overdue: overdueCount || 0, today: todayCount || 0, week: weekCount || 0 });
    setDueItems(items || []);
    setDueLoading(false);
  }, [supabase]);

  const refreshAll = useCallback(async () => {
    await Promise.all([loadLeads(), loadStats(), loadDue()]);
  }, [loadLeads, loadStats, loadDue]);

  useEffect(() => {
    loadLeads();
  }, [loadLeads]);

  useEffect(() => {
    loadStats();
  }, [loadStats]);

  useEffect(() => {
    loadDue();
  }, [loadDue]);

  const loadPresets = useCallback(async () => {
    const { data } = await supabase.from("lead_filter_presets").select("*").order("name", { ascending: true });
    setPresets(data || []);
  }, [supabase]);

  useEffect(() => {
    loadPresets();
  }, [loadPresets]);

  // Downloads every lead matching the CURRENT filters/search (not just the
  // visible page) as a CSV, paging through in chunks of 1000 client-side --
  // same pattern as the national database export on the Search page. Reuses
  // applyLeadsFilters so this can never fall out of sync with what's shown
  // on screen.
  async function exportFilteredCsv() {
    setExportError("");
    setExporting(true);
    try {
      const rows = [];
      let from = 0;
      for (;;) {
        let query = supabase.from("college_leads").select("*");
        query = applyLeadsFilters(query);
        query = query.order("college_name", { ascending: true }).range(from, from + 999);
        const { data, error } = await query;
        if (error) throw error;
        rows.push(...(data || []));
        if (!data || data.length < 1000) break;
        from += 1000;
      }
      if (!rows.length) {
        setExportError("No leads match the current filters.");
        return;
      }
      const csv = Papa.unparse({
        fields: [
          "college_name", "division", "state", "role_category", "position_tags", "coach_first_name",
          "coach_last_name", "title", "email", "mobile", "office_phone", "status", "next_callback_at",
          "last_contacted_at", "notes",
        ],
        data: rows.map((r) => [
          r.college_name, r.division, r.state, r.role_category, (r.position_tags || []).join("; "),
          r.coach_first_name, r.coach_last_name, r.title, r.email, r.mobile, r.office_phone,
          STATUS_LABEL[r.status] || r.status, r.next_callback_at || "", r.last_contacted_at || "", r.notes || "",
        ]),
      });
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `csd-college-leads-${todayISO()}.csv`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setExportError(err.message || "Could not export these leads.");
    } finally {
      setExporting(false);
    }
  }

  // Captures every filter/sort/search control as one JSON blob -- callback
  // panel state and page number are deliberately left out since those are
  // transient view toggles, not part of "the filter combination."
  async function savePreset() {
    setPresetError("");
    if (!presetName.trim()) return;
    setSavingPreset(true);
    try {
      const filters = {
        search, statusFilter, divisionFilter, roleFilter, positionFilter, stateFilter,
        hasEmailFilter, hasPhoneFilter, recencyFilter, sortBy,
      };
      const { error } = await supabase.from("lead_filter_presets").insert({
        name: presetName.trim(),
        filters,
        created_by: user.id,
      });
      if (error) throw error;
      setPresetName("");
      await loadPresets();
    } catch (err) {
      setPresetError(err.message || "Could not save this filter.");
    } finally {
      setSavingPreset(false);
    }
  }

  function applyPreset(id) {
    setSelectedPresetId(id);
    if (!id) return;
    const preset = presets.find((p) => p.id === id);
    if (!preset) return;
    const f = preset.filters || {};
    setSearchInput(f.search || "");
    setSearch(f.search || "");
    setStatusFilter(f.statusFilter || "");
    setDivisionFilter(f.divisionFilter || "");
    setRoleFilter(f.roleFilter || "");
    setPositionFilter(f.positionFilter || "");
    setStateFilter(f.stateFilter || "");
    setHasEmailFilter(!!f.hasEmailFilter);
    setHasPhoneFilter(!!f.hasPhoneFilter);
    setRecencyFilter(f.recencyFilter || "");
    setSortBy(f.sortBy || "updated_desc");
    setPage(0);
  }

  async function deletePreset(id) {
    if (!confirm("Delete this saved filter?")) return;
    await supabase.from("lead_filter_presets").delete().eq("id", id);
    if (selectedPresetId === id) setSelectedPresetId("");
    await loadPresets();
  }

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
      // position_tags is an array (no .trim()), everything else is a
      // plain text field -- handle both without crashing on the array.
      const payload = Object.fromEntries(
        Object.entries(addForm).map(([k, v]) => [k, Array.isArray(v) ? (v.length ? v : null) : v.trim() ? v.trim() : null])
      );
      const { error } = await supabase.from("college_leads").insert({ ...payload, created_by: user.id });
      if (error) throw error;
      setAddForm(EMPTY_FORM);
      setShowAdd(false);
      setPage(0);
      await refreshAll();
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
      next_callback_at: lead.next_callback_at || "",
      role_category: lead.role_category || "",
      position_tags: lead.position_tags || [],
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
        Object.entries(editForm).map(([k, v]) => [k, Array.isArray(v) ? (v.length ? v : null) : v.trim() ? v.trim() : null])
      );
      const { error } = await supabase
        .from("college_leads")
        .update({ ...payload, updated_at: new Date().toISOString() })
        .eq("id", editingId);
      if (error) throw error;
      setEditingId(null);
      await refreshAll();
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
      await refreshAll();
    } finally {
      setStatusSavingId(null);
    }
  }

  async function deleteLead(id) {
    if (!confirm("Delete this lead? This cannot be undone.")) return;
    setDeletingId(id);
    try {
      await supabase.from("college_leads").delete().eq("id", id);
      await refreshAll();
    } finally {
      setDeletingId(null);
    }
  }

  async function toggleNotes(leadId) {
    if (expandedNotesId === leadId) {
      setExpandedNotesId(null);
      return;
    }
    setExpandedNotesId(leadId);
    setNoteError("");
    setNewNoteText("");
    setNewNoteCallback("");
    if (!notesByLead[leadId]) {
      setNotesLoading(true);
      const { data, error } = await supabase
        .from("lead_notes")
        .select("*")
        .eq("lead_id", leadId)
        .order("created_at", { ascending: false });
      if (!error) setNotesByLead((prev) => ({ ...prev, [leadId]: data || [] }));
      setNotesLoading(false);
    }
  }

  // Adding a note and setting the next callback date are the same everyday
  // action ("talked to him, follow up Tuesday"), so one small form does
  // both -- the callback date is optional.
  async function addNote(leadId) {
    setNoteError("");
    if (!newNoteText.trim()) {
      setNoteError("Write a note before saving.");
      return;
    }
    setSavingNote(true);
    try {
      const { error: noteErr } = await supabase.from("lead_notes").insert({
        lead_id: leadId,
        note: newNoteText.trim(),
        written_by: user.id,
      });
      if (noteErr) throw noteErr;

      if (newNoteCallback) {
        const { error: cbErr } = await supabase
          .from("college_leads")
          .update({ next_callback_at: newNoteCallback, updated_at: new Date().toISOString() })
          .eq("id", leadId);
        if (cbErr) throw cbErr;
      }

      const { data } = await supabase
        .from("lead_notes")
        .select("*")
        .eq("lead_id", leadId)
        .order("created_at", { ascending: false });
      setNotesByLead((prev) => ({ ...prev, [leadId]: data || [] }));
      setNewNoteText("");
      setNewNoteCallback("");
      await refreshAll();
    } catch (err) {
      setNoteError(err.message || "Could not save this note.");
    } finally {
      setSavingNote(false);
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
    setImportProgress(0);
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
    // Insert in chunks rather than one giant request -- a single insert of
    // several thousand rows risks hitting a request-size/timeout limit and,
    // worse, gives no way to tell a full success from a silent partial one.
    // Chunking means a failure part-way through stops cleanly with an exact
    // count of what made it in, instead of leaving that ambiguous.
    let inserted = 0;
    try {
      for (let i = 0; i < payload.length; i += IMPORT_CHUNK) {
        const chunk = payload.slice(i, i + IMPORT_CHUNK);
        const { error } = await supabase.from("college_leads").insert(chunk);
        if (error) {
          throw new Error(
            `Stopped after ${inserted.toLocaleString()} of ${payload.length.toLocaleString()} rows: ${error.message}`
          );
        }
        inserted += chunk.length;
        setImportProgress(inserted);
      }
      setImportResult({ count: inserted });
      setImportRows([]);
      if (fileInputRef.current) fileInputRef.current.value = "";
      setPage(0);
      await refreshAll();
    } catch (err) {
      setImportError(err.message || "Could not import these rows.");
      if (inserted > 0) await refreshAll();
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

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

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
          <div className="num">{stats.total.toLocaleString()}</div>
        </div>
        <div className="card stat-card">
          <div className="label">Interested</div>
          <div className="num">{stats.interested.toLocaleString()}</div>
        </div>
        <div className="card stat-card">
          <div className="label">Trial</div>
          <div className="num">{stats.trial.toLocaleString()}</div>
        </div>
        <div className="card stat-card">
          <div className="label">Customers</div>
          <div className="num">{stats.customer.toLocaleString()}</div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
          <h3 style={{ margin: 0 }}>📞 Due for a Callback</h3>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <button
              className="btn btn-sm"
              style={{ ...(callbackFilter === "due" ? { background: "#131a2b", color: "#fff" } : {}) }}
              onClick={() => {
                setCallbackFilter((f) => (f === "due" ? "" : "due"));
                setPage(0);
              }}
            >
              Overdue + Today ({(dueCounts.overdue + dueCounts.today).toLocaleString()})
            </button>
            <button
              className="btn btn-sm"
              style={{ ...(callbackFilter === "week" ? { background: "#131a2b", color: "#fff" } : {}) }}
              onClick={() => {
                setCallbackFilter((f) => (f === "week" ? "" : "week"));
                setPage(0);
              }}
            >
              This Week ({dueCounts.week.toLocaleString()})
            </button>
          </div>
        </div>
        {dueLoading ? (
          <div className="empty-state">Loading…</div>
        ) : dueItems.length === 0 ? (
          <div className="empty-state">Nothing overdue or due today — you&apos;re caught up.</div>
        ) : (
          <div style={{ marginTop: 8 }}>
            {dueItems.map((lead) => (
              <LeadRow
                key={lead.id}
                lead={lead}
                isEditing={editingId === lead.id}
                isExpanded={expandedNotesId === lead.id}
                editForm={editForm}
                setEditField={setEditField}
                editError={editError}
                saving={saving}
                onSaveEdit={saveEdit}
                onCancelEdit={() => setEditingId(null)}
                statusSavingId={statusSavingId}
                onUpdateStatus={updateStatus}
                onToggleNotes={toggleNotes}
                onStartEdit={startEdit}
                onDelete={deleteLead}
                deletingId={deletingId}
                noteError={noteError}
                newNoteText={newNoteText}
                setNewNoteText={setNewNoteText}
                newNoteCallback={newNoteCallback}
                setNewNoteCallback={setNewNoteCallback}
                savingNote={savingNote}
                onAddNote={addNote}
                notesLoading={notesLoading}
                notes={notesByLead[lead.id]}
              />
            ))}
            {dueCounts.overdue + dueCounts.today > dueItems.length && (
              <div className="notice" style={{ marginTop: 8 }}>
                +{(dueCounts.overdue + dueCounts.today - dueItems.length).toLocaleString()} more overdue/today — use the filter above to see all of them below.
              </div>
            )}
          </div>
        )}
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
                <select value={addForm.division} onChange={(e) => setAddField("division", e.target.value)}>
                  <option value="">Select…</option>
                  {DIVISIONS.map((d) => (
                    <option key={d} value={d}>{d}</option>
                  ))}
                </select>
              </div>
              <div className="form-field">
                <label>State</label>
                <select value={addForm.state} onChange={(e) => setAddField("state", e.target.value)}>
                  <option value="">Select…</option>
                  {US_STATES.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
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
              <div className="form-field">
                <label>Next Callback</label>
                <input type="date" value={addForm.next_callback_at} onChange={(e) => setAddField("next_callback_at", e.target.value)} />
              </div>
              <div className="form-field">
                <label>Role</label>
                <select value={addForm.role_category} onChange={(e) => setAddField("role_category", e.target.value)}>
                  <option value="">Auto-detect from title</option>
                  {ROLE_CATEGORIES.map((r) => (
                    <option key={r} value={r}>{r}</option>
                  ))}
                </select>
              </div>
            </div>
            <div className="form-field">
              <label>Position(s) Coached</label>
              <PositionTagsPicker value={addForm.position_tags} onChange={(tags) => setAddField("position_tags", tags)} />
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
                {applyingImport
                  ? `Importing… ${importProgress.toLocaleString()} / ${importRows.length.toLocaleString()}`
                  : `Import ${importRows.length.toLocaleString()} Lead${importRows.length === 1 ? "" : "s"}`}
              </button>
              <button className="btn btn-sm" onClick={cancelImport} disabled={applyingImport}>Cancel</button>
            </div>
          </div>
        )}
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <h3 style={{ marginTop: 0 }}>Saved Filters</h3>
        {presetError && <div className="notice danger" style={{ marginBottom: 10 }}>{presetError}</div>}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
          <div className="field" style={{ minWidth: 220 }}>
            <label>Apply a saved filter</label>
            <select value={selectedPresetId} onChange={(e) => applyPreset(e.target.value)}>
              <option value="">Choose…</option>
              {presets.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>
          {selectedPresetId && (
            <button type="button" className="btn btn-sm btn-danger" onClick={() => deletePreset(selectedPresetId)}>
              Delete Selected
            </button>
          )}
          <div className="field" style={{ minWidth: 220, flex: "1 1 220px" }}>
            <label>Save the filters below as…</label>
            <input value={presetName} onChange={(e) => setPresetName(e.target.value)} placeholder="e.g. TX Recruiting Coordinators" />
          </div>
          <button type="button" className="btn btn-sm btn-gold" onClick={savePreset} disabled={savingPreset || !presetName.trim()}>
            {savingPreset ? "Saving…" : "Save Current Filters"}
          </button>
        </div>
      </div>

      <div className="filters">
        <div className="field" style={{ minWidth: 220 }}>
          <label>Search</label>
          <input value={searchInput} onChange={(e) => handleSearchInput(e.target.value)} placeholder="College, coach, state, email…" />
        </div>
        <div className="field">
          <label>Division</label>
          <select
            value={divisionFilter}
            onChange={(e) => {
              setDivisionFilter(e.target.value);
              setPage(0);
            }}
          >
            <option value="">All</option>
            {DIVISIONS.map((d) => (
              <option key={d} value={d}>{d}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Status</label>
          <select
            value={statusFilter}
            onChange={(e) => {
              setStatusFilter(e.target.value);
              setPage(0);
            }}
          >
            <option value="">All</option>
            {STATUS_OPTIONS.map((s) => (
              <option key={s} value={s}>{STATUS_LABEL[s]}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Role</label>
          <select
            value={roleFilter}
            onChange={(e) => {
              setRoleFilter(e.target.value);
              setPage(0);
            }}
          >
            <option value="">All</option>
            {ROLE_CATEGORIES.map((r) => (
              <option key={r} value={r}>{r}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Position</label>
          <select
            value={positionFilter}
            onChange={(e) => {
              setPositionFilter(e.target.value);
              setPage(0);
            }}
          >
            <option value="">All</option>
            {POSITION_TAGS.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>State</label>
          <select
            value={stateFilter}
            onChange={(e) => {
              setStateFilter(e.target.value);
              setPage(0);
            }}
          >
            <option value="">All</option>
            {US_STATES.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Contact Recency</label>
          <select
            value={recencyFilter}
            onChange={(e) => {
              setRecencyFilter(e.target.value);
              setPage(0);
            }}
          >
            {CONTACT_RECENCY_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Sort</label>
          <select value={sortBy} onChange={(e) => setSortBy(e.target.value)} disabled={!!callbackFilter} title={callbackFilter ? "Sort is set to soonest-due while a callback filter is active" : undefined}>
            {SORT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>&nbsp;</label>
          <label style={{ flexDirection: "row", gap: 5, textTransform: "none", fontWeight: 600, color: "#131a2b", alignItems: "center", display: "flex" }}>
            <input
              type="checkbox"
              checked={hasEmailFilter}
              onChange={(e) => {
                setHasEmailFilter(e.target.checked);
                setPage(0);
              }}
            />
            Has email
          </label>
        </div>
        <div className="field">
          <label>&nbsp;</label>
          <label style={{ flexDirection: "row", gap: 5, textTransform: "none", fontWeight: 600, color: "#131a2b", alignItems: "center", display: "flex" }}>
            <input
              type="checkbox"
              checked={hasPhoneFilter}
              onChange={(e) => {
                setHasPhoneFilter(e.target.checked);
                setPage(0);
              }}
            />
            Has phone
          </label>
        </div>
      </div>

      {loadError && <div className="notice danger" style={{ marginBottom: 14 }}>{loadError}</div>}

      <div className="card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
          <h3 style={{ margin: 0 }}>Leads ({total.toLocaleString()})</h3>
          <button className="btn btn-sm" onClick={exportFilteredCsv} disabled={exporting}>
            {exporting ? "Exporting…" : "Export Filtered (CSV)"}
          </button>
        </div>
        {exportError && <div className="notice danger" style={{ marginTop: 10 }}>{exportError}</div>}
        {loading ? (
          <div className="empty-state">Loading…</div>
        ) : leads.length === 0 ? (
          <div className="empty-state">No leads match. Add one above, import a CSV, or clear a filter.</div>
        ) : (
          leads.map((lead) => (
            <LeadRow
              key={lead.id}
              lead={lead}
              isEditing={editingId === lead.id}
              isExpanded={expandedNotesId === lead.id}
              editForm={editForm}
              setEditField={setEditField}
              editError={editError}
              saving={saving}
              onSaveEdit={saveEdit}
              onCancelEdit={() => setEditingId(null)}
              statusSavingId={statusSavingId}
              onUpdateStatus={updateStatus}
              onToggleNotes={toggleNotes}
              onStartEdit={startEdit}
              onDelete={deleteLead}
              deletingId={deletingId}
              noteError={noteError}
              newNoteText={newNoteText}
              setNewNoteText={setNewNoteText}
              newNoteCallback={newNoteCallback}
              setNewNoteCallback={setNewNoteCallback}
              savingNote={savingNote}
              onAddNote={addNote}
              notesLoading={notesLoading}
              notes={notesByLead[lead.id]}
            />
          ))
        )}
        {!loading && total > 0 && (
          <div className="pager">
            <span>
              Showing {total ? page * PAGE_SIZE + 1 : 0}-{Math.min(page * PAGE_SIZE + PAGE_SIZE, total)} of {total.toLocaleString()}
            </span>
            <div style={{ display: "flex", gap: 6 }}>
              <button className="btn btn-sm" disabled={page <= 0} onClick={() => setPage((p) => p - 1)}>
                Prev
              </button>
              <button className="btn btn-sm" disabled={page + 1 >= totalPages} onClick={() => setPage((p) => p + 1)}>
                Next
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
