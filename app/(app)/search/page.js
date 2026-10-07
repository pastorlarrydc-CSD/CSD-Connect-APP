"use client";
import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import Papa from "papaparse";

const PAGE_SIZE = 25;
const US_STATES = [
  "AL", "AK", "AS", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL", "GA", "HI", "ID", "IL", "IN", "IA", "KS", "KY",
  "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK",
  "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY",
];

// Which date the date filter / date sort works on. Each maps to a column
// on the school_database_view (schools + the verification-meta columns).
const DATE_FIELDS = {
  verified: { col: "last_verified_at", label: "Last verified" },
  updated: { col: "record_last_updated_at", label: "Last updated (any edit)" },
  coach: { col: "last_coach_change_at", label: "Last coach change" },
};

const DATE_PRESETS = [
  { value: "", label: "Any date" },
  { value: "today", label: "Today" },
  { value: "d7", label: "Last 7 days" },
  { value: "d30", label: "Last 30 days" },
  { value: "d90", label: "Last 90 days" },
  { value: "older90", label: "Older than 90 days" },
  { value: "never", label: "Never (no date)" },
  { value: "custom", label: "Custom range..." },
];

// "How was this record last checked?" -- derived in the database from the
// change log (see school_verification_meta). A paste-match only means the
// pasted list agreed with our own database; it is NOT an independent check.
const METHODS = {
  independent_web: { label: "Independent web check", color: "#1d7a4c", bg: "#e3f4ea" },
  staff_list: { label: "Staff / list verified", color: "#1f4fa3", bg: "#e4ecfa" },
  manual_edit: { label: "Manual edit", color: "#4a5568", bg: "#edf0f4" },
  ai_batch: { label: "AI batch lookup", color: "#6b3fa0", bg: "#f0e9f8" },
  paste_match: { label: "Paste-match only", color: "#a15c00", bg: "#fdf0d8" },
  import_only: { label: "Import only", color: "#8a94a6", bg: "#f2f4f7" },
};

const EMPTY_FILTERS = {
  q: "",
  state: "",
  type: "",
  classification: "",
  confidence: "",
  hasEmail: false,
  hasCell: false,
  updated: false,
  dateField: "verified",
  datePreset: "",
  dateFrom: "",
  dateTo: "",
  method: "",
  sort: "name",
};

function fmtPhone(v) {
  if (!v) return "";
  const digits = v.replace(/\D/g, "");
  return digits.length === 10 ? `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}` : v;
}

function confidenceColor(score) {
  const n = score ?? 0;
  if (n >= 70) return "#1d7a4c";
  if (n >= 40) return "#a17a00";
  return "#b3312c";
}

function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function fmtAge(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (days <= 0) return "today";
  if (days === 1) return "1 day ago";
  if (days < 60) return `${days} days ago`;
  if (days < 365) return `${Math.round(days / 30)} mo ago`;
  return `${(days / 365).toFixed(1)} yr ago`;
}

function startOfLocalDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

// Turns the preset / custom dates into a { gte, lte, lt, isNull } spec.
function dateSpec(f) {
  const now = new Date();
  const daysAgo = (n) => new Date(now.getTime() - n * 86400000).toISOString();
  switch (f.datePreset) {
    case "today":
      return { gte: startOfLocalDay(now).toISOString() };
    case "d7":
      return { gte: daysAgo(7) };
    case "d30":
      return { gte: daysAgo(30) };
    case "d90":
      return { gte: daysAgo(90) };
    case "older90":
      return { lt: daysAgo(90) };
    case "never":
      return { isNull: true };
    case "custom": {
      const spec = {};
      if (f.dateFrom) spec.gte = new Date(`${f.dateFrom}T00:00:00`).toISOString();
      if (f.dateTo) spec.lte = new Date(`${f.dateTo}T23:59:59.999`).toISOString();
      return spec;
    }
    default:
      return null;
  }
}

function MethodBadge({ method }) {
  const m = METHODS[method] || METHODS.import_only;
  return (
    <span
      style={{
        display: "inline-block",
        fontSize: 11,
        fontWeight: 600,
        padding: "1px 7px",
        borderRadius: 10,
        color: m.color,
        background: m.bg,
        whiteSpace: "nowrap",
      }}
    >
      {m.label}
    </span>
  );
}

export default function SearchPage() {
  const supabase = getSupabaseBrowserClient();
  const router = useRouter();
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [page, setPage] = useState(0);
  const [results, setResults] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState("");

  // Applies every on-screen filter to a query against school_database_view.
  // Shared by the on-screen search and the "download these results" export so
  // the two can never disagree.
  //
  // A closed school is never a real recruiting target -- see the
  // add_school_closed_status migration. This is a discovery surface (any
  // signed-in college user, not just staff, uses this to find schools to
  // reach out to), so closed schools are excluded outright rather than
  // just badged, same as the Map and the public prospect-submission
  // search.
  const applyFilters = useCallback((query, f) => {
    query = query.eq("is_closed", false);
    if (f.q) {
      const term = f.q.trim();
      query = query.or(`name.ilike.%${term}%,city.ilike.%${term}%,hc_last_name.ilike.%${term}%,zip.ilike.%${term}%`);
    }
    if (f.state) query = query.eq("state", f.state);
    if (f.type) query = query.eq("school_type", f.type);
    if (f.classification) query = query.ilike("classification", `%${f.classification.trim()}%`);
    if (f.confidence === "high") query = query.gte("confidence_score", 70);
    if (f.confidence === "medium") query = query.gte("confidence_score", 40).lt("confidence_score", 70);
    if (f.confidence === "low") query = query.lt("confidence_score", 40);
    if (f.hasEmail) query = query.not("hc_email", "is", null).neq("hc_email", "");
    if (f.hasCell) query = query.not("hc_cell", "is", null).neq("hc_cell", "");
    if (f.updated) query = query.eq("record_updated", true);
    if (f.method) query = query.eq("verification_method", f.method);
    const spec = dateSpec(f);
    if (spec) {
      const col = DATE_FIELDS[f.dateField].col;
      if (spec.isNull) query = query.is(col, null);
      if (spec.gte) query = query.gte(col, spec.gte);
      if (spec.lt) query = query.lt(col, spec.lt);
      if (spec.lte) query = query.lte(col, spec.lte);
    }
    return query;
  }, []);

  const runSearch = useCallback(async () => {
    setLoading(true);
    let query = applyFilters(supabase.from("school_database_view").select("*", { count: "exact" }), filters);
    if (filters.sort === "date_asc" || filters.sort === "date_desc") {
      const col = DATE_FIELDS[filters.dateField].col;
      query = query.order(col, { ascending: filters.sort === "date_asc", nullsFirst: false }).order("name", { ascending: true });
    } else {
      query = query.order("name", { ascending: true });
    }
    query = query.range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);

    const { data, count, error } = await query;
    if (!error) {
      setResults(data || []);
      setTotal(count || 0);
    }
    setLoading(false);
  }, [supabase, filters, page, applyFilters]);

  useEffect(() => {
    runSearch();
  }, [runSearch]);

  function updateFilter(key, value) {
    setFilters((prev) => ({ ...prev, [key]: value }));
    setPage(0);
  }

  // Replaces several filters at once (used by the quick-view buttons).
  function applyQuickView(patch) {
    setFilters({ ...EMPTY_FILTERS, ...patch });
    setPage(0);
  }

  function clearFilters() {
    setFilters(EMPTY_FILTERS);
    setPage(0);
  }

  // Downloads a CSV by paging through in chunks of 1000 rows client-side,
  // same pattern the admin bulk-update CSV export already uses, rather than
  // a server route that would have to hold everything in one serverless
  // invocation. onlyFiltered = false exports the ENTIRE database (all ~14.6k
  // schools); true exports just what the on-screen filters match. Same
  // is_closed exclusion as the on-screen search -- this is still a
  // discovery/outreach-list export, so a closed school doesn't belong in it.
  async function downloadDatabase(onlyFiltered) {
    setDownloadError("");
    setDownloading(true);
    try {
      const cols =
        "id,name,school_type,addr1,addr2,city,county,state,zip,classification,phone,website,hc_first_name,hc_last_name,hc_email,hc_cell,hc_office,hc_twitter,verification_status,confidence_score,last_verified_at,record_updated,record_last_updated_at,last_coach_change_at,verification_method";
      const rows = [];
      let from = 0;
      for (;;) {
        let q = supabase.from("school_database_view").select(cols);
        q = onlyFiltered ? applyFilters(q, filters) : q.eq("is_closed", false);
        const { data, error } = await q.order("id", { ascending: true }).range(from, from + 999);
        if (error) throw error;
        rows.push(...(data || []));
        if (!data || data.length < 1000) break;
        from += 1000;
      }
      const csv = Papa.unparse({
        fields: [
          "school_id", "school_name", "type", "address_1", "address_2", "city", "county", "state", "zip",
          "classification", "phone", "website", "hc_first_name", "hc_last_name", "hc_email", "hc_cell", "hc_office",
          "hc_twitter", "verification_status", "confidence_score", "last_verified_at", "record_updated",
          "record_last_updated_at", "last_coach_change_at", "how_verified",
        ],
        data: rows.map((r) => [
          r.id, r.name, r.school_type, r.addr1, r.addr2, r.city, r.county, r.state, r.zip, r.classification, r.phone,
          r.website, r.hc_first_name, r.hc_last_name, r.hc_email, r.hc_cell, r.hc_office, r.hc_twitter,
          r.verification_status, r.confidence_score, r.last_verified_at, r.record_updated ? "Yes" : "No",
          r.record_last_updated_at || "", r.last_coach_change_at || "",
          (METHODS[r.verification_method] || METHODS.import_only).label,
        ]),
      });
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `csd-hs-${onlyFiltered ? "filtered" : "database"}-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setDownloadError(err.message || "Could not export the database.");
    } finally {
      setDownloading(false);
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const dateFieldLabel = DATE_FIELDS[filters.dateField].label;
  const anyFilter =
    JSON.stringify({ ...filters, dateField: "", sort: "" }) !== JSON.stringify({ ...EMPTY_FILTERS, dateField: "", sort: "" }) ||
    filters.sort !== "name";
  const checkboxLabelStyle = {
    flexDirection: "row",
    gap: 5,
    textTransform: "none",
    fontWeight: 600,
    color: "#131a2b",
    alignItems: "center",
    display: "flex",
  };
  const quickBtnStyle = { fontSize: 12 };

  return (
    <div className="view">
      <div className="view-header">
        <div>
          <h1>National High School Database</h1>
          <p>{total.toLocaleString()} schools · live query against production database</p>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button className="btn" onClick={() => downloadDatabase(true)} disabled={downloading}>
            {downloading ? "Preparing download…" : "Download These Results (CSV)"}
          </button>
          <button className="btn btn-gold" onClick={() => downloadDatabase(false)} disabled={downloading}>
            {downloading ? "Preparing download…" : "Download Full Database (CSV)"}
          </button>
        </div>
      </div>
      {downloadError && <div className="notice danger" style={{ marginBottom: 14 }}>{downloadError}</div>}
      <div className="filters">
        <div className="field" style={{ minWidth: 220 }}>
          <label>Keyword</label>
          <input
            placeholder="School, city, coach last name, zip"
            value={filters.q}
            onChange={(e) => updateFilter("q", e.target.value)}
          />
        </div>
        <div className="field">
          <label>State</label>
          <select value={filters.state} onChange={(e) => updateFilter("state", e.target.value)}>
            <option value="">All</option>
            {US_STATES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Type</label>
          <select value={filters.type} onChange={(e) => updateFilter("type", e.target.value)}>
            <option value="">All</option>
            <option value="Public">Public</option>
            <option value="Private">Private</option>
          </select>
        </div>
        <div className="field">
          <label>Classification</label>
          <input
            placeholder="e.g. 4A, D2, GRP 1"
            value={filters.classification}
            onChange={(e) => updateFilter("classification", e.target.value)}
          />
        </div>
        <div className="field">
          <label>Confidence</label>
          <select value={filters.confidence} onChange={(e) => updateFilter("confidence", e.target.value)}>
            <option value="">All</option>
            <option value="high">High (70%+)</option>
            <option value="medium">Medium (40-69%)</option>
            <option value="low">Low (&lt;40%)</option>
          </select>
        </div>
        <div className="field">
          <label>&nbsp;</label>
          <label style={checkboxLabelStyle}>
            <input type="checkbox" checked={filters.hasEmail} onChange={(e) => updateFilter("hasEmail", e.target.checked)} /> Has email
          </label>
        </div>
        <div className="field">
          <label>&nbsp;</label>
          <label style={checkboxLabelStyle}>
            <input type="checkbox" checked={filters.hasCell} onChange={(e) => updateFilter("hasCell", e.target.checked)} /> Has cell
          </label>
        </div>
        <div className="field">
          <label>&nbsp;</label>
          <label style={checkboxLabelStyle}>
            <input type="checkbox" checked={filters.updated} onChange={(e) => updateFilter("updated", e.target.checked)} /> Recently updated
          </label>
        </div>

        <div style={{ flexBasis: "100%", height: 0 }} />

        <div className="field">
          <label>Date to filter by</label>
          <select value={filters.dateField} onChange={(e) => updateFilter("dateField", e.target.value)}>
            {Object.entries(DATE_FIELDS).map(([k, v]) => (
              <option key={k} value={k}>
                {v.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>When</label>
          <select value={filters.datePreset} onChange={(e) => updateFilter("datePreset", e.target.value)}>
            {DATE_PRESETS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
        {filters.datePreset === "custom" && (
          <>
            <div className="field">
              <label>From</label>
              <input type="date" value={filters.dateFrom} onChange={(e) => updateFilter("dateFrom", e.target.value)} />
            </div>
            <div className="field">
              <label>To</label>
              <input type="date" value={filters.dateTo} onChange={(e) => updateFilter("dateTo", e.target.value)} />
            </div>
          </>
        )}
        <div className="field">
          <label>How it was last checked</label>
          <select value={filters.method} onChange={(e) => updateFilter("method", e.target.value)}>
            <option value="">All</option>
            {Object.entries(METHODS).map(([k, v]) => (
              <option key={k} value={k}>
                {v.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Sort by</label>
          <select value={filters.sort} onChange={(e) => updateFilter("sort", e.target.value)}>
            <option value="name">School name (A-Z)</option>
            <option value="date_desc">{dateFieldLabel}: newest first</option>
            <option value="date_asc">{dateFieldLabel}: oldest first</option>
          </select>
        </div>
        <div className="field">
          <label>&nbsp;</label>
          <button className="btn btn-sm" onClick={clearFilters} disabled={!anyFilter}>
            Clear filters
          </button>
        </div>
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", margin: "10px 0 14px" }}>
        <span style={{ fontSize: 12, color: "#697386", fontWeight: 600 }}>Quick views:</span>
        <button
          className="btn btn-sm"
          style={quickBtnStyle}
          onClick={() => applyQuickView({ method: "paste_match" })}
          title="Records marked verified only because a pasted list matched our own database -- not an independent check"
        >
          Paste-match only (needs a real check)
        </button>
        <button
          className="btn btn-sm"
          style={quickBtnStyle}
          onClick={() => applyQuickView({ dateField: "verified", datePreset: "older90", sort: "date_asc" })}
        >
          Not verified in 90+ days
        </button>
        <button
          className="btn btn-sm"
          style={quickBtnStyle}
          onClick={() => applyQuickView({ dateField: "verified", datePreset: "never" })}
        >
          Never verified
        </button>
        <button
          className="btn btn-sm"
          style={quickBtnStyle}
          onClick={() => applyQuickView({ method: "import_only" })}
          title="Coach info never re-checked since the original import"
        >
          Never re-checked since import
        </button>
        <button
          className="btn btn-sm"
          style={quickBtnStyle}
          onClick={() => applyQuickView({ dateField: "verified", datePreset: "d7", sort: "date_desc" })}
        >
          Verified in last 7 days
        </button>
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>School</th>
              <th>City / State</th>
              <th>Type</th>
              <th>Class</th>
              <th>Head Coach</th>
              <th>Email</th>
              <th>Cell / Office</th>
              <th>Confidence</th>
              <th>Last Verified</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={9}>
                  <div className="empty-state">Loading…</div>
                </td>
              </tr>
            ) : results.length ? (
              results.map((s) => (
                <tr key={s.id} onClick={() => router.push(`/schools/${s.id}`)}>
                  <td>
                    <strong>{s.name}</strong>
                    {s.record_updated && (
                      <span
                        className="badge badge-not-contacted"
                        style={{ marginLeft: 6 }}
                        title={s.record_last_updated_at ? `Updated ${new Date(s.record_last_updated_at).toLocaleDateString()}` : "Updated since import"}
                      >
                        Updated
                      </span>
                    )}
                    <div style={{ color: "#697386", fontSize: 11.5 }}>{s.county} County</div>
                  </td>
                  <td>
                    {s.city}, {s.state} {s.zip}
                  </td>
                  <td>
                    <span className={`badge ${s.school_type === "Public" ? "badge-public" : "badge-private"}`}>{s.school_type}</span>
                  </td>
                  <td>{s.classification || "—"}</td>
                  <td>
                    {s.hc_first_name || s.hc_last_name ? (
                      `${s.hc_first_name || ""} ${s.hc_last_name || ""}`.trim()
                    ) : (
                      <span className="empty-state">Head Coach Unassigned</span>
                    )}
                  </td>
                  <td>{s.hc_email || <span className="empty-state">none on file</span>}</td>
                  <td>{fmtPhone(s.hc_cell) || fmtPhone(s.hc_office) || <span className="empty-state">none on file</span>}</td>
                  <td>
                    <span style={{ fontWeight: 600, fontSize: 12.5, color: confidenceColor(s.confidence_score) }}>{s.confidence_score ?? 0}%</span>
                  </td>
                  <td title={s.last_check_source || ""}>
                    {s.last_verified_at ? (
                      <div style={{ fontSize: 12.5, fontWeight: 600 }}>
                        {fmtDate(s.last_verified_at)}
                        <span style={{ color: "#697386", fontWeight: 400 }}> · {fmtAge(s.last_verified_at)}</span>
                      </div>
                    ) : (
                      <div style={{ fontSize: 12.5, color: "#8a94a6" }}>Never</div>
                    )}
                    <div style={{ marginTop: 2 }}>
                      <MethodBadge method={s.verification_method} />
                    </div>
                    {s.last_coach_change_at && (
                      <div style={{ color: "#697386", fontSize: 11, marginTop: 2 }}>
                        Coach changed {fmtDate(s.last_coach_change_at)}
                      </div>
                    )}
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={9}>
                  <div className="empty-state">No schools match these filters.</div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
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
      </div>
    </div>
  );
}
