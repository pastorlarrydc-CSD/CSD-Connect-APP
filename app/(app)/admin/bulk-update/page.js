"use client";
import { useState, useCallback, useRef } from "react";
import Link from "next/link";
import Papa from "papaparse";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { useAuth } from "@/lib/auth-context";

// Every editable school field, in display order. EDIT_FIELDS drives both
// the CSV upload's column matching and the "plus any of ..." help text
// below; SELECT_COLUMNS is the same list with "id" led in front, used to
// build a select() column string for the schools table.
const EDIT_FIELDS = [
  ["name", "School name"],
  ["school_type", "Type (Public/Private)"],
  ["addr1", "Address line 1"],
  ["addr2", "Address line 2"],
  ["city", "City"],
  ["county", "County"],
  ["state", "State"],
  ["zip", "Zip"],
  ["classification", "Classification"],
  ["phone", "Main phone"],
  ["website", "Website"],
  ["maxpreps_url", "MaxPreps URL"],
  ["athletics_url", "Athletics URL"],
  ["hc_first_name", "HC first name"],
  ["hc_last_name", "HC last name"],
  ["hc_email", "HC email"],
  ["hc_cell", "HC cell"],
  ["hc_office", "HC office"],
  ["x_twitter", "X (Twitter)"],
];
const SELECT_COLUMNS = ["id", ...EDIT_FIELDS.map(([field]) => field)];
const PAGE_SIZE = 1000;
const BATCH_SIZE = 300;

function trimStr(v) {
  return v == null ? "" : String(v).trim();
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

export default function BulkUpdatePage() {
  const supabase = getSupabaseBrowserClient();
  const { user, profile } = useAuth();
  const canReview = profile?.role === "verifier" || profile?.role === "sysadmin";

  const uploadInputRef = useRef(null);

  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState("");

  const [uploadParsing, setUploadParsing] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const [uploadFileName, setUploadFileName] = useState("");
  const [uploadPreview, setUploadPreview] = useState([]); // [{id,name,city,state,fields:[{field,label,old,new}]}]
  const [uploadUnchanged, setUploadUnchanged] = useState(0);
  const [uploadUnmatched, setUploadUnmatched] = useState([]); // [{row,reason}]
  const [uploadApplying, setUploadApplying] = useState(false);
  const [uploadApplyStatus, setUploadApplyStatus] = useState("");
  const [uploadApplyError, setUploadApplyError] = useState("");
  const [uploadApplyResult, setUploadApplyResult] = useState(null); // {schools, fields}

  const fetchAllSchools = useCallback(
    async (selectCols) => {
      const rows = [];
      let from = 0;
      for (;;) {
        const { data, error } = await supabase
          .from("schools")
          .select(selectCols)
          .order("id", { ascending: true })
          .range(from, from + PAGE_SIZE - 1);
        if (error) throw error;
        rows.push(...(data || []));
        if (!data || data.length < PAGE_SIZE) break;
        from += PAGE_SIZE;
      }
      return rows;
    },
    [supabase]
  );

  async function exportSchools() {
    setExportError("");
    setExporting(true);
    try {
      const rows = await fetchAllSchools([...SELECT_COLUMNS, "record_updated", "record_last_updated_at"].join(","));
      const csv = Papa.unparse({
        fields: ["school_id", ...SELECT_COLUMNS.slice(1), "record_updated", "record_last_updated_at"],
        data: rows.map((r) => [...SELECT_COLUMNS.map((field) => r[field]), r.record_updated ? "Yes" : "No", r.record_last_updated_at || ""]),
      });
      downloadBlob(csv, `csd_school_export_${new Date().toISOString().slice(0, 10)}.csv`);
    } catch (err) {
      setExportError(err.message || "Could not export schools.");
    } finally {
      setExporting(false);
    }
  }

  function resetUpload() {
    setUploadPreview([]);
    setUploadUnchanged(0);
    setUploadUnmatched([]);
    setUploadError("");
    setUploadApplyResult(null);
    setUploadApplyError("");
    setUploadFileName("");
    if (uploadInputRef.current) uploadInputRef.current.value = "";
  }

  // Reads the edited export (or any hand-built sheet) and matches each row
  // back to a school by school_id (preferred) or school_name + state (+
  // city to break ties among same-named schools). Any column not in
  // EDIT_FIELDS is ignored, and blank cells never overwrite existing data.
  async function handleUploadFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    resetUpload();
    setUploadFileName(file.name);
    setUploadParsing(true);
    try {
      const text = await file.text();
      const parsed = Papa.parse(text, { header: true, skipEmptyLines: true });
      if (parsed.errors?.length) throw new Error(parsed.errors[0].message);
      const rows = (parsed.data || []).map((row) => {
        const clean = {};
        Object.keys(row).forEach((k) => {
          clean[k.trim().toLowerCase()] = row[k];
        });
        return clean;
      });
      if (!rows.length) throw new Error("The file has no data rows.");

      const schools = await fetchAllSchools(SELECT_COLUMNS.join(","));
      const byId = new Map(schools.map((s) => [String(s.id), s]));
      const byNameState = new Map();
      schools.forEach((s) => {
        const key = `${trimStr(s.name).toLowerCase()}|${trimStr(s.state).toUpperCase()}`;
        if (!byNameState.has(key)) byNameState.set(key, []);
        byNameState.get(key).push(s);
      });

      const preview = [];
      const unmatched = [];
      let unchangedCount = 0;

      rows.forEach((row, idx) => {
        const rowLabel = row.school_name || row.name || `Row ${idx + 2}`;
        let school = null;
        const idVal = trimStr(row.school_id || row.id);
        if (idVal && byId.has(idVal)) {
          school = byId.get(idVal);
        } else {
          const nameVal = trimStr(row.school_name || row.name);
          const stateVal = trimStr(row.state).toUpperCase();
          if (nameVal && stateVal) {
            const key = `${nameVal.toLowerCase()}|${stateVal}`;
            let candidates = byNameState.get(key) || [];
            if (candidates.length > 1 && row.city) {
              const narrowed = candidates.filter((c) => trimStr(c.city).toLowerCase() === trimStr(row.city).toLowerCase());
              if (narrowed.length) candidates = narrowed;
            }
            if (candidates.length === 1) school = candidates[0];
            else if (candidates.length > 1) {
              unmatched.push({ row: rowLabel, reason: `${candidates.length} schools match "${nameVal}, ${stateVal}" — add a city or school_id column to disambiguate.` });
              return;
            }
          }
        }
        if (!school) {
          unmatched.push({ row: rowLabel, reason: idVal ? `No school found with id ${idVal}.` : "Could not match on school_id or school_name + state." });
          return;
        }

        const fields = [];
        EDIT_FIELDS.forEach(([field, label]) => {
          if (!(field in row)) return;
          const newVal = trimStr(row[field]);
          if (newVal === "") return;
          const oldVal = trimStr(school[field]);
          if (newVal !== oldVal) fields.push({ field, label, old: oldVal || "—", new: newVal });
        });
        if (fields.length) preview.push({ id: school.id, name: school.name, city: school.city, state: school.state, fields });
        else unchangedCount += 1;
      });

      setUploadPreview(preview);
      setUploadUnchanged(unchangedCount);
      setUploadUnmatched(unmatched);
    } catch (err) {
      setUploadError(err.message || "Could not read this file.");
    } finally {
      setUploadParsing(false);
    }
  }

  // Applies the previewed changes in batches: mark verified and log every
  // changed field to school_change_log, same bookkeeping as every other
  // write path in the app.
  async function applyUpload() {
    setUploadApplying(true);
    setUploadApplyError("");
    setUploadApplyResult(null);
    try {
      let applied = 0;
      const now = new Date().toISOString();
      for (let i = 0; i < uploadPreview.length; i += BATCH_SIZE) {
        const chunk = uploadPreview.slice(i, i + BATCH_SIZE);
        setUploadApplyStatus(`Applying ${i + 1}–${Math.min(i + BATCH_SIZE, uploadPreview.length)} of ${uploadPreview.length}…`);
        const upserts = chunk.map((row) => {
          const update = { id: row.id, verification_status: "verified", last_verified_at: now };
          row.fields.forEach((f) => {
            update[f.field] = f.new;
          });
          return update;
        });
        const { error } = await supabase.from("schools").upsert(upserts, { onConflict: "id" });
        if (error) throw error;

        const changes = [];
        chunk.forEach((row) => {
          row.fields.forEach((f) => {
            // A bulk upload that touches the coach's name is, in practice,
            // almost always recording a coach change (a season's worth of
            // hires dumped in from a spreadsheet) -- tag those two fields
            // the same way "Mark Coach Change" does on the Data Quality
            // Review page, so they show up correctly in Coach Change
            // History without anyone having to fix them one at a time.
            const isCoachName = f.field === "hc_first_name" || f.field === "hc_last_name";
            changes.push({
              school_id: row.id,
              field_name: f.field,
              old_value: f.old === "—" ? null : f.old,
              new_value: f.new,
              source: isCoachName ? "Head coach change (manual)" : "Bulk school update (CSV)",
              changed_by: user.id,
            });
          });
        });
        if (changes.length) {
          const { error: logError } = await supabase.from("school_change_log").insert(changes);
          if (logError) throw logError;
        }
        applied += chunk.length;
      }

      setUploadApplyResult({
        schools: applied,
        fields: uploadPreview.reduce((sum, row) => sum + row.fields.length, 0),
      });
      setUploadPreview([]);
      setUploadUnchanged(0);
    } catch (err) {
      setUploadApplyError(err.message || "Something went wrong applying these changes.");
    } finally {
      setUploadApplying(false);
      setUploadApplyStatus("");
    }
  }

  if (!canReview) {
    return (
      <div className="view">
        <div className="notice danger">Bulk updates are limited to Verification Staff and System Admins.</div>
      </div>
    );
  }

  const totalFieldsChanging = uploadPreview.reduce((sum, row) => sum + row.fields.length, 0);

  return (
    <div className="view">
      <Link href="/admin" className="btn btn-sm" style={{ marginBottom: 12, display: "inline-flex" }}>
        ← Back to Admin
      </Link>
      <div className="view-header">
        <div>
          <h1>Bulk Update Schools</h1>
          <p>Export the current database, edit any field in a spreadsheet, then re-upload to apply changes across many schools at once.</p>
        </div>
      </div>

      <div className="grid grid-2" style={{ marginBottom: 14 }}>
        <div className="card">
          <h3>Step 1 — Export current data</h3>
          <p style={{ fontSize: 12.5, color: "#697386", marginTop: -4 }}>
            Downloads every school with every editable field. Edit any column in Excel/Sheets — leave <code>school_id</code> untouched so we can match rows back up.
          </p>
          {exportError && <div className="notice danger" style={{ marginBottom: 10 }}>{exportError}</div>}
          <button className="btn btn-primary btn-sm" onClick={exportSchools} disabled={exporting}>
            {exporting ? "Exporting…" : "Download CSV"}
          </button>
        </div>

        <div className="card">
          <h3>Step 2 — Upload your edited file</h3>
          <p style={{ fontSize: 12.5, color: "#697386", marginTop: -4 }}>
            Columns read: <code>school_id</code> (preferred) or <code>school_name</code> + <code>state</code> (+ <code>city</code> to break ties), plus any of{" "}
            <code>{EDIT_FIELDS.map(([field]) => field).join(", ")}</code>. Blank cells are left unchanged.
          </p>
          <div className="notice" style={{ marginBottom: 10, fontSize: 12 }}>
            Renaming a school or moving it to a new state? Match that row on <code>school_id</code>, not <code>school_name</code> + <code>state</code> — the name/state columns are also used to
            find the row, so changing them in a name+state-matched row can cause a miss.
          </div>
          {uploadError && <div className="notice danger" style={{ marginBottom: 10 }}>{uploadError}</div>}
          <input ref={uploadInputRef} type="file" accept=".csv" onChange={handleUploadFile} disabled={uploadParsing} />
          {uploadParsing && <div className="empty-state" style={{ marginTop: 8 }}>Reading {uploadFileName}…</div>}
        </div>
      </div>

      {(uploadPreview.length > 0 || uploadUnmatched.length > 0 || uploadUnchanged > 0) && !uploadApplyResult && (
        <div className="card" style={{ marginBottom: 14 }}>
          <h3>Preview — {uploadFileName}</h3>
          <div className="grid grid-3" style={{ marginBottom: 12 }}>
            <div className="stat-card">
              <div className="label">Schools to update</div>
              <div className="num">{uploadPreview.length}</div>
              <div className="sub">{totalFieldsChanging} field{totalFieldsChanging === 1 ? "" : "s"} changing</div>
            </div>
            <div className="stat-card">
              <div className="label">Already up to date</div>
              <div className="num">{uploadUnchanged}</div>
              <div className="sub">no differences found</div>
            </div>
            <div className="stat-card">
              <div className="label">Unmatched rows</div>
              <div className="num">{uploadUnmatched.length}</div>
              <div className="sub">need school_id or name+state</div>
            </div>
          </div>

          {uploadApplyError && <div className="notice danger" style={{ marginBottom: 10 }}>{uploadApplyError}</div>}

          {uploadUnmatched.length > 0 && (
            <div className="notice danger" style={{ marginBottom: 12 }}>
              <strong>{uploadUnmatched.length} row(s) could not be matched:</strong>
              <div style={{ maxHeight: 140, overflow: "auto", marginTop: 6 }}>
                {uploadUnmatched.slice(0, 50).map((u, i) => (
                  <div key={i} style={{ fontSize: 12, padding: "3px 0" }}>{u.row}: {u.reason}</div>
                ))}
                {uploadUnmatched.length > 50 && <div style={{ fontSize: 12 }}>…and {uploadUnmatched.length - 50} more.</div>}
              </div>
            </div>
          )}

          {uploadPreview.length > 0 && (
            <>
              <div className="table-wrap" style={{ marginBottom: 12, maxHeight: 360, overflow: "auto" }}>
                <table>
                  <thead>
                    <tr>
                      <th>School</th>
                      <th>Field</th>
                      <th>Current</th>
                      <th>New</th>
                    </tr>
                  </thead>
                  <tbody>
                    {uploadPreview.slice(0, 500).flatMap((row) =>
                      row.fields.map((f, i) => (
                        <tr key={`${row.id}-${f.field}`}>
                          {i === 0 ? (
                            <td rowSpan={row.fields.length}>
                              <strong>{row.name}</strong>
                              <div style={{ color: "#697386", fontSize: 11.5 }}>{row.city}, {row.state}</div>
                            </td>
                          ) : null}
                          <td>{f.label}</td>
                          <td>{f.old}</td>
                          <td style={{ color: "#1e7145", fontWeight: 700 }}>{f.new}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
              {uploadPreview.length > 500 && (
                <div className="notice" style={{ marginBottom: 12 }}>
                  Showing the first 500 of {uploadPreview.length} schools. All {uploadPreview.length} will be applied.
                </div>
              )}
              <button className="btn btn-gold" onClick={applyUpload} disabled={uploadApplying}>
                {uploadApplying ? uploadApplyStatus || "Applying…" : `Apply ${uploadPreview.length} school update${uploadPreview.length === 1 ? "" : "s"}`}
              </button>
            </>
          )}
        </div>
      )}

      {uploadApplyResult && (
        <div className="notice info" style={{ marginBottom: 14 }}>
          Applied {uploadApplyResult.fields} field change{uploadApplyResult.fields === 1 ? "" : "s"} across {uploadApplyResult.schools} school{uploadApplyResult.schools === 1 ? "" : "s"}. Records
          are marked Verified and logged in the school change history.
        </div>
      )}
    </div>
  );
}
