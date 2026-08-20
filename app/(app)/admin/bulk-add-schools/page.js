"use client";
import { useState, useCallback, useRef } from "react";
import Link from "next/link";
import Papa from "papaparse";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { useAuth } from "@/lib/auth-context";

const ALLOWED_FIELDS = [
  "name",
  "state",
  "school_type",
  "addr1",
  "addr2",
  "city",
  "county",
  "zip",
  "classification",
  "phone",
  "website",
  "hc_first_name",
  "hc_last_name",
  "hc_email",
  "hc_cell",
  "hc_office",
  "x_twitter",
];

const IMPORT_BATCH_SIZE = 300;

const HEADER_ALIASES = {
  name: ["school name", "high school", "hs", "hs name", "school"],
  state: ["state", "st"],
  school_type: ["school type", "type", "public private"],
  addr1: ["address", "address line 1", "address 1", "street", "street address"],
  addr2: ["address line 2", "address 2", "suite"],
  city: ["city"],
  county: ["county"],
  zip: ["zip", "zip code", "postal code"],
  classification: ["classification", "class", "division"],
  phone: ["phone", "main phone", "school phone", "phone number"],
  website: ["website", "url", "web site", "site"],
  hc_first_name: ["hc first name", "head coach first name", "coach first name"],
  hc_last_name: ["hc last name", "head coach last name", "coach last name"],
  hc_email: ["hc email", "head coach email", "coach email", "email"],
  hc_cell: ["hc cell", "head coach cell", "coach cell", "cell", "phone cell"],
  hc_office: ["hc office", "head coach office", "coach office", "office"],
  x_twitter: ["x twitter", "x (twitter)", "twitter", "x"],
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

export default function BulkAddSchoolsPage() {
  const supabase = getSupabaseBrowserClient();
  const { user, profile } = useAuth();
  const fileInputRef = useRef(null);

  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const [fileName, setFileName] = useState("");

  const [readyRows, setReadyRows] = useState([]);
  const [skippedRows, setSkippedRows] = useState([]);
  const [confirmDuplicates, setConfirmDuplicates] = useState(false);

  const [importing, setImporting] = useState(false);
  const [importProgress, setImportProgress] = useState("");
  const [importError, setImportError] = useState("");
  const [importResult, setImportResult] = useState(null);

  const canBulkAdd = profile?.role === "verifier" || profile?.role === "sysadmin";

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

  function downloadTemplate() {
    const csv = Papa.unparse({
      fields: ALLOWED_FIELDS,
      data: [
        [
          "Example High School",
          "TX",
          "Public",
          "123 Main St",
          "",
          "Austin",
          "Travis",
          "78701",
          "5A",
          "5125551234",
          "www.exampleisd.org/highschool",
          "Pat",
          "Coach",
          "pcoach@exampleisd.org",
          "5125555678",
          "5125551234",
          "https://x.com/exampleHSfb",
        ],
      ],
    });
    downloadBlob(csv, "csd_new_schools_template.csv");
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
    setUploadError("");
    setImportResult(null);
    setImportError("");
    setFileName("");
    setConfirmDuplicates(false);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

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

      // Pull every school already on file so we can flag rows that look
      // like they already exist -- matched on normalized name + state, the
      // same fuzzy match the prospect bulk-add tool uses for schools.
      const existingSchools = await fetchAllSchools();
      const existingByKey = new Map();
      existingSchools.forEach((s) => {
        const key = `${normalizeSchoolName(s.name)}|${trimStr(s.state).toUpperCase()}`;
        (existingByKey.get(key) || existingByKey.set(key, []).get(key)).push(s);
      });

      const ready = [];
      const skipped = [];
      const seenInFile = new Map();

      mappedRows.forEach((row, i) => {
        const label = row.name || `Row ${i + 2}`;
        const name = trimStr(row.name);
        const state = trimStr(row.state).toUpperCase();

        if (!name) {
          skipped.push({ row: label, reason: "Missing school name." });
          return;
        }
        if (!state) {
          skipped.push({ row: label, reason: "Missing state." });
          return;
        }

        const key = `${normalizeSchoolName(name)}|${state}`;
        let duplicateOf = null;
        const existingMatches = existingByKey.get(key);
        if (existingMatches && existingMatches.length) {
          duplicateOf = { kind: "database", school: existingMatches[0] };
        } else if (seenInFile.has(key)) {
          duplicateOf = { kind: "file", label: seenInFile.get(key) };
        }
        seenInFile.set(key, label);

        ready.push({
          name,
          state,
          school_type: trimStr(row.school_type) || null,
          addr1: trimStr(row.addr1) || null,
          addr2: trimStr(row.addr2) || null,
          city: trimStr(row.city) || null,
          county: trimStr(row.county) || null,
          zip: trimStr(row.zip) || null,
          classification: trimStr(row.classification) || null,
          phone: trimStr(row.phone) || null,
          website: trimStr(row.website) || null,
          hc_first_name: trimStr(row.hc_first_name) || null,
          hc_last_name: trimStr(row.hc_last_name) || null,
          hc_email: trimStr(row.hc_email) || null,
          hc_cell: trimStr(row.hc_cell) || null,
          hc_office: trimStr(row.hc_office) || null,
          x_twitter: trimStr(row.x_twitter) || null,
          _label: label,
          _city: trimStr(row.city),
          possibleDuplicate: duplicateOf,
        });
      });

      setSkippedRows(skipped);
      setReadyRows(ready);
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
      const now = new Date().toISOString();
      for (let i = 0; i < readyRows.length; i += IMPORT_BATCH_SIZE) {
        const batch = readyRows.slice(i, i + IMPORT_BATCH_SIZE).map(({ _label, _city, possibleDuplicate, ...rest }) => ({
          ...rest,
          verification_status: "verified",
          confidence_score: 70,
          last_verified_at: now,
          source: "Bulk-added by staff (CSV)",
        }));
        setImportProgress(`Importing ${i + 1}–${Math.min(i + IMPORT_BATCH_SIZE, readyRows.length)} of ${readyRows.length}…`);
        const { data: inserted, error } = await supabase.from("schools").insert(batch).select("id,name");
        if (error) throw error;

        const logs = (inserted || []).map((s) => ({
          school_id: s.id,
          field_name: "created",
          old_value: null,
          new_value: s.name,
          source: "Bulk-added by staff (CSV)",
          changed_by: user.id,
        }));
        if (logs.length) {
          const { error: logErr } = await supabase.from("school_change_log").insert(logs);
          if (logErr) throw logErr;
        }
        count += batch.length;
      }
      setImportResult({ count });
      setReadyRows([]);
    } catch (err) {
      setImportError(err.message || "Something went wrong importing these schools.");
    } finally {
      setImporting(false);
      setImportProgress("");
    }
  }

  if (!canBulkAdd) {
    return (
      <div className="view">
        <div className="notice danger">Bulk adding schools is limited to Verification Staff and System Admins.</div>
      </div>
    );
  }

  const duplicateCount = readyRows.filter((r) => r.possibleDuplicate).length;

  return (
    <div className="view">
      <Link href="/admin" className="btn btn-sm" style={{ marginBottom: 12, display: "inline-flex" }}>
        ← Back to Admin
      </Link>
      <div className="view-header">
        <div>
          <h1>Bulk Add Schools</h1>
          <p>Upload a CSV of new high schools to add many at once. This tool only creates new schools — to edit schools already on file, use Bulk Update Schools instead.</p>
        </div>
      </div>

      <div className="grid grid-2" style={{ marginBottom: 14 }}>
        <div className="card">
          <h3>Step 1 — Download the template</h3>
          <p style={{ fontSize: 12.5, color: "#697386", marginTop: -4 }}>
            <code>name</code> and <code>state</code> are required for every row. Column headers are flexible — plain-language headers like &quot;School Name&quot; or &quot;Head Coach
            Email&quot; are recognized automatically.
          </p>
          <button className="btn btn-primary btn-sm" onClick={downloadTemplate}>
            Download CSV Template
          </button>
        </div>
        <div className="card">
          <h3>Step 2 — Upload your new school list</h3>
          <p style={{ fontSize: 12.5, color: "#697386", marginTop: -4 }}>
            Any extra columns are ignored. You can re-upload as many times as you like — nothing is saved until you click Import.
          </p>
          {uploadError && <div className="notice danger" style={{ marginBottom: 10 }}>{uploadError}</div>}
          <input ref={fileInputRef} type="file" accept=".csv" onChange={handleFileChange} disabled={uploading} />
          {uploading && <div className="empty-state" style={{ marginTop: 8 }}>Reading {fileName}…</div>}
        </div>
      </div>

      {(readyRows.length > 0 || skippedRows.length > 0) && !importResult && (
        <div className="card" style={{ marginBottom: 14 }}>
          <h3>Preview — {fileName}</h3>
          <div className="grid grid-3" style={{ marginBottom: 12 }}>
            <div className="stat-card">
              <div className="label">Ready to import</div>
              <div className="num">{readyRows.length}</div>
            </div>
            <div className="stat-card">
              <div className="label">Skipped (errors)</div>
              <div className="num">{skippedRows.length}</div>
              <div className="sub">missing name or state</div>
            </div>
            <div className="stat-card">
              <div className="label">Possible duplicates</div>
              <div className="num">{duplicateCount}</div>
              <div className="sub">name + state already seen</div>
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

          {readyRows.length > 0 && (
            <>
              <div className="table-wrap" style={{ marginBottom: 12, maxHeight: 360, overflow: "auto" }}>
                <table>
                  <thead>
                    <tr>
                      <th>School</th>
                      <th>City/State</th>
                      <th>Classification</th>
                      <th>Head Coach</th>
                      <th>Website</th>
                      <th>Duplicate?</th>
                    </tr>
                  </thead>
                  <tbody>
                    {readyRows.slice(0, 500).map((r, i) => (
                      <tr key={i}>
                        <td><strong>{r.name}</strong></td>
                        <td>{r._city || "—"}{r.state ? `, ${r.state}` : ""}</td>
                        <td>{r.classification || "—"}</td>
                        <td>{[r.hc_first_name, r.hc_last_name].filter(Boolean).join(" ") || "—"}</td>
                        <td>{r.website || "—"}</td>
                        <td>
                          {r.possibleDuplicate?.kind === "database" ? (
                            <span className="badge badge-not-contacted" title={`Matches school #${r.possibleDuplicate.school.id} already on file`}>
                              Already on file — {r.possibleDuplicate.school.name}
                            </span>
                          ) : r.possibleDuplicate?.kind === "file" ? (
                            <span className="badge badge-not-contacted" title="Another row in this same file has the same name + state">
                              Duplicate row in file ({r.possibleDuplicate.label})
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
                  <strong>{duplicateCount} row{duplicateCount === 1 ? "" : "s"}</strong> look like they might already exist — flagged &quot;Duplicate?&quot; above. Nothing is blocked
                  automatically; review them, then confirm below to import everything anyway. Importing a true duplicate creates a second, separate school record.
                  <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12.5, marginTop: 8 }}>
                    <input type="checkbox" checked={confirmDuplicates} onChange={(e) => setConfirmDuplicates(e.target.checked)} />
                    I&apos;ve reviewed the flagged possible duplicates and want to import all {readyRows.length} rows anyway.
                  </label>
                </div>
              )}

              <button className="btn btn-gold" onClick={runImport} disabled={importing || (duplicateCount > 0 && !confirmDuplicates)}>
                {importing ? importProgress || "Importing…" : `Import ${readyRows.length} school${readyRows.length === 1 ? "" : "s"}`}
              </button>
            </>
          )}
        </div>
      )}

      {importResult && (
        <div className="notice info" style={{ marginBottom: 14 }}>
          Imported {importResult.count} school{importResult.count === 1 ? "" : "s"}. <Link href="/search">View the National High School Database</Link>.
        </div>
      )}
    </div>
  );
}
