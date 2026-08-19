"use client";
import { useState, useCallback, useRef } from "react";
import Link from "next/link";
import Papa from "papaparse";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { useAuth } from "@/lib/auth-context";

const ALLOWED_FIELDS = [
  "athlete_name",
  "grad_year",
  "position",
  "jersey_number",
  "height",
  "weight",
  "gpa",
  "athlete_email",
  "athlete_cell",
  "city",
  "state",
  "school_id",
  "school_name",
  "level_of_play",
  "hudl_url",
  "x_url",
  "coach_evaluation",
  "guardian_authorized",
  "guardian_first_name",
  "guardian_last_name",
  "guardian_email",
  "guardian_cell",
  "offers_received",
  "committed_to",
];

const IMPORT_BATCH_SIZE = 300;
const TRUE_VALUES = new Set(["true", "yes", "y", "1"]);

const HEADER_ALIASES = {
  athlete_name: ["athlete name", "name", "player name", "prospect name"],
  school_id: ["school id"],
  school_name: ["school", "school name", "high school", "hs", "hs name"],
  level_of_play: ["level of play", "level", "division", "lop"],
  position: ["position", "pos"],
  jersey_number: ["jersey", "jersey number", "jersey no", "number", "no", "jersey #"],
  height: ["height", "ht"],
  weight: ["weight", "wt"],
  gpa: ["gpa"],
  hudl_url: ["hudl url", "hudl", "hudl link", "film", "film link"],
  x_url: ["x url", "x", "twitter", "twitter url", "twitter link", "x link", "x (twitter) url"],
  athlete_email: ["athlete email", "email", "email address"],
  athlete_cell: ["athlete cell", "cell", "phone", "mobile", "cell phone", "phone number"],
  city: ["city"],
  state: ["state", "st"],
  coach_evaluation: ["coach evaluation", "evaluation", "notes", "comments", "coach notes"],
  guardian_authorized: ["guardian authorized", "guardian_authorized", "parent authorized", "guardian auth", "authorized"],
  guardian_first_name: ["guardian first name", "parent first name", "guardian_first_name"],
  guardian_last_name: ["guardian last name", "parent last name", "guardian_last_name"],
  guardian_email: ["guardian email", "parent email", "guardian_email"],
  guardian_cell: ["guardian cell", "guardian phone", "parent cell", "parent phone", "guardian_cell"],
  offers_received: ["offers received", "offers", "offer list"],
  committed_to: ["committed to", "commitment", "committed", "commit"],
  grad_year: ["graduation year", "grad year", "class of", "class", "grad"],
};

function normalizeHeaderText(v) {
  return String(v || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

const ALIAS_LOOKUP = (() => {
  const map = {};
  Object.entries(HEADER_ALIASES).forEach(([field, aliases]) => {
    map[normalizeHeaderText(field)] = field;
    aliases.forEach((alias) => {
      map[normalizeHeaderText(alias)] = field;
    });
  });
  return map;
})();

function resolveHeader(raw) {
  const normalized = normalizeHeaderText(raw);
  return ALIAS_LOOKUP[normalized] || normalized.replace(/\s+/g, "_");
}

function trimStr(v) {
  return v == null ? "" : String(v).trim();
}

const HIGH_SCHOOL_SUFFIXES = [
  "junior senior high school",
  "jr sr high school",
  "senior high school",
  "junior high school",
  "middle high school",
  "high school",
  "senior high",
  "junior high",
  "high",
  "hs",
];

function normalizeSchoolName(v) {
  let s = String(v || "").toLowerCase().replace(/['’.]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
  for (const suffix of HIGH_SCHOOL_SUFFIXES) {
    if (s === suffix) {
      s = "";
      break;
    }
    if (s.endsWith(" " + suffix)) {
      s = s.slice(0, s.length - suffix.length - 1).trim();
      break;
    }
  }
  return s.replace(/\s+/g, " ").trim();
}

export default function BulkAddProspectsPage() {
  const supabase = getSupabaseBrowserClient();
  const { user, profile } = useAuth();
  const fileInputRef = useRef(null);

  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const [fileName, setFileName] = useState("");

  const [readyRows, setReadyRows] = useState([]);
  const [skippedRows, setSkippedRows] = useState([]);
  const [warnings, setWarnings] = useState([]);
  const [checkingDuplicates, setCheckingDuplicates] = useState(false);
  const [confirmDuplicates, setConfirmDuplicates] = useState(false);

  const [importing, setImporting] = useState(false);
  const [importProgress, setImportProgress] = useState("");
  const [importError, setImportError] = useState("");
  const [importResult, setImportResult] = useState(null);

  const [exportingCurrent, setExportingCurrent] = useState(false);
  const [exportError, setExportError] = useState("");

  const canBulkAdd = profile?.role === "verifier" || profile?.role === "sysadmin";

  const fetchAllProspects = useCallback(async () => {
    const rows = [];
    let offset = 0;
    for (;;) {
      const { data, error } = await supabase
        .from("prospects")
        .select(
          "athlete_name,grad_year,position,jersey_number,height,weight,gpa,athlete_email,athlete_cell,city,state,level_of_play,hudl_url,x_url,coach_evaluation,guardian_authorized,guardian_first_name,guardian_last_name,guardian_email,guardian_cell,offers_received,committed_to,status,created_at,schools(name,city,state)"
        )
        .order("created_at", { ascending: false })
        .range(offset, offset + 999);
      if (error) throw error;
      rows.push(...(data || []));
      if (!data || data.length < 1000) break;
      offset += 1000;
    }
    return rows;
  }, [supabase]);

  async function exportCurrentProspects() {
    setExportError("");
    setExportingCurrent(true);
    try {
      const rows = await fetchAllProspects();
      const csv = Papa.unparse({
        fields: [
          "athlete_name",
          "grad_year",
          "school_name",
          "city",
          "state",
          "level_of_play",
          "position",
          "jersey_number",
          "height",
          "weight",
          "gpa",
          "athlete_email",
          "athlete_cell",
          "guardian_authorized",
          "guardian_first_name",
          "guardian_last_name",
          "guardian_email",
          "guardian_cell",
          "hudl_url",
          "x_url",
          "coach_evaluation",
          "offers_received",
          "committed_to",
          "status",
          "submitted_date",
        ],
        data: rows.map((r) => [
          r.athlete_name,
          r.grad_year || "",
          r.schools?.name || "",
          r.city || r.schools?.city || "",
          r.state || r.schools?.state || "",
          r.level_of_play || "",
          r.position || "",
          r.jersey_number || "",
          r.height || "",
          r.weight || "",
          r.gpa ?? "",
          r.athlete_email || "",
          r.athlete_cell || "",
          r.guardian_authorized ? "TRUE" : "FALSE",
          r.guardian_first_name || "",
          r.guardian_last_name || "",
          r.guardian_email || "",
          r.guardian_cell || "",
          r.hudl_url || "",
          r.x_url || "",
          r.coach_evaluation || "",
          r.offers_received || "",
          r.committed_to || "",
          r.status || "",
          r.created_at ? new Date(r.created_at).toISOString().slice(0, 10) : "",
        ]),
      });
      downloadBlob(csv, `csd_prospects_export_${new Date().toISOString().slice(0, 10)}.csv`);
    } catch (err) {
      setExportError(err.message || "Could not export prospects.");
    } finally {
      setExportingCurrent(false);
    }
  }

  function downloadTemplate() {
    const csv = Papa.unparse({
      fields: ALLOWED_FIELDS,
      data: [
        [
          "Jordan Smith",
          "2027",
          "WR",
          "8",
          `6'1"`,
          "185",
          "3.4",
          "jordan@email.com",
          "5555551234",
          "Austin",
          "TX",
          "",
          "Austin High School",
          "FBS",
          "https://www.hudl.com/profile/…",
          "https://x.com/username",
          "Great hands, top-end speed",
          "TRUE",
          "Pat",
          "Smith",
          "pat.smith@email.com",
          "5555559876",
          "",
          "",
        ],
      ],
    });
    downloadBlob(csv, "csd_prospect_template.csv");
  }

  function downloadBlob(csv, filename) {
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function resetPreview() {
    setReadyRows([]);
    setSkippedRows([]);
    setWarnings([]);
    setUploadError("");
    setImportResult(null);
    setImportError("");
    setFileName("");
    setConfirmDuplicates(false);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  // Duplicate-athlete check -- for every row that resolved to a real school,
  // fuzzy-match it against prospects already on file there (see
  // find_similar_prospects in Supabase). Run with a small concurrency cap so
  // a few hundred rows don't fire a few hundred requests all at once.
  async function annotateDuplicates(rows) {
    const CONCURRENCY = 6;
    const matches = new Array(rows.length).fill(null);
    let next = 0;
    async function worker() {
      while (next < rows.length) {
        const i = next++;
        const row = rows[i];
        if (!row.school_id) continue;
        try {
          const { data } = await supabase.rpc("find_similar_prospects", {
            p_school_id: row.school_id,
            p_athlete_name: row.athlete_name,
            p_grad_year: row.grad_year || null,
          });
          if (data && data.length) matches[i] = data[0];
        } catch (_) {
          // best-effort -- a failed check shouldn't block the import preview
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, rows.length) }, worker));
    return rows.map((row, i) => ({ ...row, possibleDuplicate: matches[i] }));
  }

  const fetchAllSchools = useCallback(async () => {
    const rows = [];
    let offset = 0;
    for (;;) {
      const { data, error } = await supabase.from("schools").select("id,name,city,state").order("id", { ascending: true }).range(offset, offset + 999);
      if (error) throw error;
      rows.push(...(data || []));
      if (!data || data.length < 1000) break;
      offset += 1000;
    }
    return rows;
  }, [supabase]);

  async function handleFileChange(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    resetPreview();
    setFileName(file.name);
    setUploading(true);
    setUploadError("");
    try {
      const text = await file.text();
      const parsed = Papa.parse(text, { header: true, skipEmptyLines: true });
      if (parsed.errors?.length) throw new Error(parsed.errors[0].message);

      const mappedRows = (parsed.data || []).map((row) => {
        const mapped = {};
        Object.keys(row).forEach((header) => {
          mapped[resolveHeader(header)] = row[header];
        });
        return mapped;
      });
      if (!mappedRows.length) throw new Error("The file has no data rows.");

      const schools = await fetchAllSchools();
      const byId = new Map(schools.map((s) => [String(s.id), s]));
      const byExactNameState = new Map();
      const byExactName = new Map();
      const byNormalizedNameState = new Map();
      const byNormalizedName = new Map();
      schools.forEach((s) => {
        const name = trimStr(s.name).toLowerCase();
        const state = trimStr(s.state).toUpperCase();
        const key = `${name}|${state}`;
        (byExactNameState.get(key) || byExactNameState.set(key, []).get(key)).push(s);
        (byExactName.get(name) || byExactName.set(name, []).get(name)).push(s);
        const normalized = normalizeSchoolName(s.name);
        const normKey = `${normalized}|${state}`;
        (byNormalizedNameState.get(normKey) || byNormalizedNameState.set(normKey, []).get(normKey)).push(s);
        (byNormalizedName.get(normalized) || byNormalizedName.set(normalized, []).get(normalized)).push(s);
      });

      const ready = [];
      const skipped = [];
      const rowWarnings = [];

      mappedRows.forEach((row, i) => {
        const label = row.athlete_name || `Row ${i + 2}`;
        const athleteName = trimStr(row.athlete_name);
        if (!athleteName) {
          skipped.push({ row: label, reason: "Missing athlete_name." });
          return;
        }

        let schoolId = null;
        const rowSchoolId = trimStr(row.school_id);
        const rowSchoolName = trimStr(row.school_name);
        const rowState = trimStr(row.state).toUpperCase();

        if (rowSchoolId && byId.has(rowSchoolId)) {
          schoolId = byId.get(rowSchoolId).id;
        } else if (rowSchoolName) {
          const normalized = normalizeSchoolName(rowSchoolName);
          let matches = [];
          if (rowState) {
            matches = byExactNameState.get(`${rowSchoolName.toLowerCase()}|${rowState}`) || [];
            if (!matches.length) matches = byNormalizedNameState.get(`${normalized}|${rowState}`) || [];
          } else {
            matches = byExactName.get(rowSchoolName.toLowerCase()) || [];
            if (!matches.length) matches = byNormalizedName.get(normalized) || [];
          }
          const displayName = rowState ? `${rowSchoolName}, ${rowState}` : rowSchoolName;
          if (matches.length === 1) {
            schoolId = matches[0].id;
          } else if (matches.length === 0) {
            rowWarnings.push(`${label}: no school matched "${displayName}" — prospect will import without a linked school.`);
          } else {
            rowWarnings.push(`${label}: multiple schools matched "${displayName}" — prospect will import without a linked school.`);
          }
        }

        const guardianAuthorized = TRUE_VALUES.has(trimStr(row.guardian_authorized).toLowerCase());
        let athleteEmail = trimStr(row.athlete_email) || null;
        let athleteCell = trimStr(row.athlete_cell) || null;
        let guardianEmail = trimStr(row.guardian_email) || null;
        let guardianCell = trimStr(row.guardian_cell) || null;
        if ((athleteEmail || athleteCell || guardianEmail || guardianCell) && !guardianAuthorized) {
          rowWarnings.push(`${label}: contact info removed — guardian_authorized was not marked TRUE.`);
          athleteEmail = null;
          athleteCell = null;
          guardianEmail = null;
          guardianCell = null;
        }

        ready.push({
          submitted_by: user.id,
          athlete_name: athleteName,
          grad_year: (row.grad_year && parseInt(trimStr(row.grad_year), 10)) || null,
          position: trimStr(row.position) || null,
          jersey_number: trimStr(row.jersey_number) || null,
          height: trimStr(row.height) || null,
          weight: trimStr(row.weight) || null,
          gpa: (row.gpa && parseFloat(trimStr(row.gpa))) || null,
          athlete_email: athleteEmail,
          athlete_cell: athleteCell,
          city: trimStr(row.city) || null,
          state: rowState || null,
          school_id: schoolId,
          level_of_play: trimStr(row.level_of_play) || null,
          hudl_url: trimStr(row.hudl_url) || null,
          x_url: trimStr(row.x_url) || null,
          coach_evaluation: trimStr(row.coach_evaluation) || null,
          guardian_authorized: guardianAuthorized,
          guardian_first_name: trimStr(row.guardian_first_name) || null,
          guardian_last_name: trimStr(row.guardian_last_name) || null,
          guardian_email: guardianEmail,
          guardian_cell: guardianCell,
          offers_received: trimStr(row.offers_received) || null,
          committed_to: trimStr(row.committed_to) || null,
          _label: label,
        });
      });

      setSkippedRows(skipped);
      setWarnings(rowWarnings);

      setCheckingDuplicates(true);
      const readyWithDuplicates = await annotateDuplicates(ready);
      setCheckingDuplicates(false);
      setReadyRows(readyWithDuplicates);
    } catch (err) {
      setUploadError(err.message || "Could not read this file.");
    } finally {
      setUploading(false);
    }
  }

  async function runImport() {
    setImporting(true);
    setImportError("");
    setImportResult(null);
    try {
      let count = 0;
      for (let i = 0; i < readyRows.length; i += IMPORT_BATCH_SIZE) {
        const batch = readyRows.slice(i, i + IMPORT_BATCH_SIZE).map(({ _label, possibleDuplicate, ...rest }) => rest);
        setImportProgress(`Importing ${i + 1}–${Math.min(i + IMPORT_BATCH_SIZE, readyRows.length)} of ${readyRows.length}…`);
        const { error } = await supabase.from("prospects").insert(batch);
        if (error) throw error;
        count += batch.length;
      }
      setImportResult({ count });
      setReadyRows([]);
    } catch (err) {
      setImportError(err.message || "Something went wrong importing these prospects.");
    } finally {
      setImporting(false);
      setImportProgress("");
    }
  }

  if (!canBulkAdd) {
    return (
      <div className="view">
        <div className="notice danger">Bulk prospect import is limited to Verification Staff and System Admins.</div>
      </div>
    );
  }

  const duplicateCount = readyRows.filter((r) => r.possibleDuplicate).length;

  return (
    <div className="view">
      <Link href="/prospects" className="btn btn-sm" style={{ marginBottom: 12, display: "inline-flex" }}>
        ← Back to Prospects
      </Link>
      <div className="view-header">
        <div>
          <h1>Bulk Add Prospects</h1>
          <p>Upload a CSV of prospect sheets from HS coaches to add many athletes at once.</p>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <h3>Export Current Prospects</h3>
        <p style={{ fontSize: 12.5, color: "#697386", marginTop: -4 }}>
          Download every prospect currently in the database as a CSV — school, level of play, contact info, guardian contact, offers/commitment, Hudl/X links, and coach evaluation notes included.
        </p>
        {exportError && <div className="notice danger" style={{ marginBottom: 10 }}>{exportError}</div>}
        <button className="btn btn-primary btn-sm" onClick={exportCurrentProspects} disabled={exportingCurrent}>
          {exportingCurrent ? "Exporting…" : "Download Prospects CSV"}
        </button>
      </div>

      <div className="grid grid-2" style={{ marginBottom: 14 }}>
        <div className="card">
          <h3>Step 1 — Download the template</h3>
          <p style={{ fontSize: 12.5, color: "#697386", marginTop: -4 }}>
            <code>athlete_name</code> is required. To link a prospect to a school, fill in <code>school_id</code> (preferred) or <code>school_name</code> + <code>state</code>. Set{" "}
            <code>guardian_authorized</code> to TRUE for any row that includes athlete or guardian contact info — otherwise that contact info is dropped on import. Column headers are
            flexible — plain-language headers like &quot;Athlete Name&quot;, &quot;School&quot;, or &quot;Level of Play&quot; are recognized automatically, so coaches can send their own
            sheets as-is.
          </p>
          <button className="btn btn-primary btn-sm" onClick={downloadTemplate}>
            Download CSV Template
          </button>
        </div>
        <div className="card">
          <h3>Step 2 — Upload your prospect list</h3>
          <p style={{ fontSize: 12.5, color: "#697386", marginTop: -4 }}>
            Any extra columns are ignored. You can re-upload as many times as you like — nothing is saved until you click Import.
          </p>
          {uploadError && <div className="notice danger" style={{ marginBottom: 10 }}>{uploadError}</div>}
          <input ref={fileInputRef} type="file" accept=".csv" onChange={handleFileChange} disabled={uploading} />
          {uploading && <div className="empty-state" style={{ marginTop: 8 }}>Reading {fileName}…</div>}
        </div>
      </div>

      {checkingDuplicates && (
        <div className="card" style={{ marginBottom: 14 }}>
          <div className="empty-state">Checking for possible duplicate athletes already on file…</div>
        </div>
      )}

      {(readyRows.length > 0 || skippedRows.length > 0) && !importResult && !checkingDuplicates && (
        <div className="card" style={{ marginBottom: 14 }}>
          <h3>Preview — {fileName}</h3>
          <div className="grid grid-4" style={{ marginBottom: 12 }}>
            <div className="stat-card">
              <div className="label">Ready to import</div>
              <div className="num">{readyRows.length}</div>
            </div>
            <div className="stat-card">
              <div className="label">Skipped (errors)</div>
              <div className="num">{skippedRows.length}</div>
              <div className="sub">missing athlete_name</div>
            </div>
            <div className="stat-card">
              <div className="label">Warnings</div>
              <div className="num">{warnings.length}</div>
              <div className="sub">school/contact info notes</div>
            </div>
            <div className="stat-card">
              <div className="label">Possible duplicates</div>
              <div className="num">{duplicateCount}</div>
              <div className="sub">already on file at that school</div>
            </div>
          </div>

          {importError && <div className="notice danger" style={{ marginBottom: 10 }}>{importError}</div>}

          {skippedRows.length > 0 && (
            <div className="notice danger" style={{ marginBottom: 12 }}>
              <strong>{skippedRows.length} row(s) skipped:</strong>
              <div style={{ maxHeight: 120, overflow: "auto", marginTop: 6 }}>
                {skippedRows.slice(0, 50).map((s, i) => (
                  <div key={i} style={{ fontSize: 12, padding: "3px 0" }}>{s.row}: {s.reason}</div>
                ))}
              </div>
            </div>
          )}

          {warnings.length > 0 && (
            <div className="notice" style={{ marginBottom: 12 }}>
              <strong>{warnings.length} note(s):</strong>
              <div style={{ maxHeight: 120, overflow: "auto", marginTop: 6 }}>
                {warnings.slice(0, 50).map((w, i) => (
                  <div key={i} style={{ fontSize: 12, padding: "3px 0" }}>{w}</div>
                ))}
              </div>
            </div>
          )}

          {readyRows.length > 0 && (
            <>
              <div className="table-wrap" style={{ marginBottom: 12, maxHeight: 360, overflow: "auto" }}>
                <table>
                  <thead>
                    <tr>
                      <th>Athlete</th>
                      <th>Grad Yr</th>
                      <th>Level</th>
                      <th>Position</th>
                      <th>City/State</th>
                      <th>Email</th>
                      <th>Cell</th>
                      <th>Guardian Auth.</th>
                      <th>Duplicate?</th>
                    </tr>
                  </thead>
                  <tbody>
                    {readyRows.slice(0, 500).map((r, i) => (
                      <tr key={i}>
                        <td><strong>{r.athlete_name}</strong></td>
                        <td>{r.grad_year || "—"}</td>
                        <td>{r.level_of_play || "—"}</td>
                        <td>{r.position || "—"}</td>
                        <td>{r.city || "—"}{r.state ? `, ${r.state}` : ""}</td>
                        <td>{r.athlete_email || "—"}</td>
                        <td>{r.athlete_cell || "—"}</td>
                        <td>{r.guardian_authorized ? "Yes" : "No"}</td>
                        <td>
                          {r.possibleDuplicate ? (
                            <span className="badge badge-not-contacted" title={`Similar to prospect #${r.possibleDuplicate.id}, submitted ${new Date(r.possibleDuplicate.created_at).toLocaleDateString()}`}>
                              Possible dup — {r.possibleDuplicate.athlete_name}
                              {r.possibleDuplicate.grad_year ? ` (${r.possibleDuplicate.grad_year})` : ""}
                            </span>
                          ) : (
                            "—"
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {readyRows.length > 500 && <div className="notice" style={{ marginBottom: 12 }}>Showing the first 500 of {readyRows.length}. All {readyRows.length} will be imported.</div>}

              {duplicateCount > 0 && (
                <div className="notice" style={{ marginBottom: 12 }}>
                  <strong>{duplicateCount} row{duplicateCount === 1 ? "" : "s"}</strong> look like they might already be on file — flagged &quot;Duplicate?&quot; above. Nothing is
                  blocked automatically; review them, then confirm below to import everything anyway.
                  <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12.5, marginTop: 8 }}>
                    <input type="checkbox" checked={confirmDuplicates} onChange={(e) => setConfirmDuplicates(e.target.checked)} />
                    I&apos;ve reviewed the flagged possible duplicates and want to import all {readyRows.length} rows anyway.
                  </label>
                </div>
              )}

              <button className="btn btn-gold" onClick={runImport} disabled={importing || (duplicateCount > 0 && !confirmDuplicates)}>
                {importing ? importProgress || "Importing…" : `Import ${readyRows.length} prospect${readyRows.length === 1 ? "" : "s"}`}
              </button>
            </>
          )}
        </div>
      )}

      {importResult && (
        <div className="notice info" style={{ marginBottom: 14 }}>
          Imported {importResult.count} prospect{importResult.count === 1 ? "" : "s"}. <Link href="/prospects">View the Prospects list</Link>.
        </div>
      )}
    </div>
  );
}
