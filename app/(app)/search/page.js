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

export default function SearchPage() {
  const supabase = getSupabaseBrowserClient();
  const router = useRouter();
  const [filters, setFilters] = useState({
    q: "",
    state: "",
    type: "",
    classification: "",
    confidence: "",
    hasEmail: false,
    hasCell: false,
    updated: false,
  });
  const [page, setPage] = useState(0);
  const [results, setResults] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState("");

  // A closed school is never a real recruiting target -- see the
  // add_school_closed_status migration. This is a discovery surface (any
  // signed-in college user, not just staff, uses this to find schools to
  // reach out to), so closed schools are excluded outright rather than
  // just badged, same as the Map and the public prospect-submission
  // search. A school already on a college's board/watchlist, or linked to
  // an existing prospect, still shows up fine on its own profile page --
  // this filter only affects this open-ended search.
  const runSearch = useCallback(async () => {
    setLoading(true);
    let query = supabase.from("schools").select("*", { count: "exact" }).eq("is_closed", false);
    if (filters.q) {
      const term = filters.q.trim();
      query = query.or(`name.ilike.%${term}%,city.ilike.%${term}%,hc_last_name.ilike.%${term}%,zip.ilike.%${term}%`);
    }
    if (filters.state) query = query.eq("state", filters.state);
    if (filters.type) query = query.eq("school_type", filters.type);
    if (filters.classification) query = query.ilike("classification", `%${filters.classification.trim()}%`);
    if (filters.confidence === "high") query = query.gte("confidence_score", 70);
    if (filters.confidence === "medium") query = query.gte("confidence_score", 40).lt("confidence_score", 70);
    if (filters.confidence === "low") query = query.lt("confidence_score", 40);
    if (filters.hasEmail) query = query.not("hc_email", "is", null).neq("hc_email", "");
    if (filters.hasCell) query = query.not("hc_cell", "is", null).neq("hc_cell", "");
    if (filters.updated) query = query.eq("record_updated", true);
    query = query.order("name", { ascending: true }).range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);

    const { data, count, error } = await query;
    if (!error) {
      setResults(data || []);
      setTotal(count || 0);
    }
    setLoading(false);
  }, [supabase, filters, page]);

  useEffect(() => {
    runSearch();
  }, [runSearch]);

  function updateFilter(key, value) {
    setFilters((prev) => ({ ...prev, [key]: value }));
    setPage(0);
  }

  // Downloads the ENTIRE database (all ~14.6k schools, not just the current
  // filtered/paged view) as a CSV -- pages through in chunks of 1000 rows
  // client-side, same pattern the admin bulk-update CSV export already
  // uses, rather than a server route that would have to hold everything in
  // one serverless invocation. Same is_closed exclusion as the on-screen
  // search above -- this is still a discovery/outreach-list export, so a
  // closed school doesn't belong in it.
  async function downloadDatabase() {
    setDownloadError("");
    setDownloading(true);
    try {
      const cols =
        "id,name,school_type,addr1,addr2,city,county,state,zip,classification,phone,website,hc_first_name,hc_last_name,hc_email,hc_cell,hc_office,x_twitter,verification_status,confidence_score,last_verified_at,record_updated,record_last_updated_at";
      const rows = [];
      let from = 0;
      for (;;) {
        const { data, error } = await supabase
          .from("schools")
          .select(cols)
          .eq("is_closed", false)
          .order("id", { ascending: true })
          .range(from, from + 999);
        if (error) throw error;
        rows.push(...(data || []));
        if (!data || data.length < 1000) break;
        from += 1000;
      }
      const csv = Papa.unparse({
        fields: [
          "school_id", "school_name", "type", "address_1", "address_2", "city", "county", "state", "zip",
          "classification", "phone", "website", "hc_first_name", "hc_last_name", "hc_email", "hc_cell", "hc_office",
          "x_twitter", "verification_status", "confidence_score", "last_verified_at", "record_updated",
          "record_last_updated_at",
        ],
        data: rows.map((r) => [
          r.id, r.name, r.school_type, r.addr1, r.addr2, r.city, r.county, r.state, r.zip, r.classification, r.phone,
          r.website, r.hc_first_name, r.hc_last_name, r.hc_email, r.hc_cell, r.hc_office, r.x_twitter,
          r.verification_status, r.confidence_score, r.last_verified_at, r.record_updated ? "Yes" : "No",
          r.record_last_updated_at || "",
        ]),
      });
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `csd-hs-database-${new Date().toISOString().slice(0, 10)}.csv`;
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

  return (
    <div className="view">
      <div className="view-header">
        <div>
          <h1>National High School Database</h1>
          <p>{total.toLocaleString()} schools · live query against production database</p>
        </div>
        <button className="btn btn-gold" onClick={downloadDatabase} disabled={downloading}>
          {downloading ? "Preparing download…" : "Download Full Database (CSV)"}
        </button>
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
          <label style={{ flexDirection: "row", gap: 5, textTransform: "none", fontWeight: 600, color: "#131a2b", alignItems: "center", display: "flex" }}>
            <input type="checkbox" checked={filters.hasEmail} onChange={(e) => updateFilter("hasEmail", e.target.checked)} /> Has email
          </label>
        </div>
        <div className="field">
          <label>&nbsp;</label>
          <label style={{ flexDirection: "row", gap: 5, textTransform: "none", fontWeight: 600, color: "#131a2b", alignItems: "center", display: "flex" }}>
            <input type="checkbox" checked={filters.hasCell} onChange={(e) => updateFilter("hasCell", e.target.checked)} /> Has cell
          </label>
        </div>
        <div className="field">
          <label>&nbsp;</label>
          <label style={{ flexDirection: "row", gap: 5, textTransform: "none", fontWeight: 600, color: "#131a2b", alignItems: "center", display: "flex" }}>
            <input type="checkbox" checked={filters.updated} onChange={(e) => updateFilter("updated", e.target.checked)} /> Recently updated
          </label>
        </div>
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
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={8}>
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
                    {s.hc_first_name} {s.hc_last_name}
                  </td>
                  <td>{s.hc_email || <span className="empty-state">none on file</span>}</td>
                  <td>{fmtPhone(s.hc_cell) || fmtPhone(s.hc_office) || <span className="empty-state">none on file</span>}</td>
                  <td>
                    <span style={{ fontWeight: 600, fontSize: 12.5, color: confidenceColor(s.confidence_score) }}>{s.confidence_score ?? 0}%</span>
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={8}>
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
