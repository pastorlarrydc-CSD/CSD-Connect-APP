"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import Papa from "papaparse";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { useAuth } from "@/lib/auth-context";
import {
  mapRow,
  categorizeRow,
  categorizeAgainstSchool,
  matchKey,
  DIFF_FIELDS,
  ALL_FIELDS,
  BUCKET_LABELS,
} from "@/lib/importReconcile";
import { NEEDS_REVIEW_CLEAR_FIELDS } from "@/lib/needsReview";

const PAGE_SIZE = 1000;
const BATCH_SIZE = 300;

// Tab order -- the buckets that need a human decision come first, the
// read-only/no-action buckets last.
const BUCKET_ORDER = ["needs_verification", "conflict", "new_info", "new_school", "exact_match", "skipped"];

const SCHOOL_SELECT_COLUMNS = [
  "id",
  "name",
  "state",
  "is_closed",
  ...DIFF_FIELDS.map(([f]) => f),
].join(",");

function downloadBlob(text, filename) {
  const blob = new Blob([text], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export default function ImportReconcilePage() {
  const supabase = getSupabaseBrowserClient();
  const { user, profile } = useAuth();
  const canReview = profile?.role === "verifier" || profile?.role === "sysadmin";
  const fileInputRef = useRef(null);

  const [batches, setBatches] = useState([]);
  const [loadingBatches, setLoadingBatches] = useState(true);
  const [batchesError, setBatchesError] = useState("");

  // Upload/preview (before anything is saved to the database).
  const [fileName, setFileName] = useState("");
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const [preview, setPreview] = useState(null); // { rows, columnMapping, summary }
  const [committing, setCommitting] = useState(false);
  const [commitError, setCommitError] = useState("");

  // Review screen (an opened, already-saved batch).
  const [selectedBatch, setSelectedBatch] = useState(null);
  const [rows, setRows] = useState([]);
  const [loadingRows, setLoadingRows] = useState(false);
  const [activeBucket, setActiveBucket] = useState("needs_verification");
  const [rowBusy, setRowBusy] = useState({}); // { [rowId]: true } while an action is in flight
  const [rowError, setRowError] = useState({}); // { [rowId]: message }
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkStatus, setBulkStatus] = useState("");
  const [bulkError, setBulkError] = useState("");
  const [conflictSelections, setConflictSelections] = useState({}); // { [rowId]: { [field]: bool } }
  const [verificationRunId, setVerificationRunId] = useState(null);
  // A ref, not just the state above -- state updates aren't visible until
  // the next render, so a tight sequential loop (sendAllAmbiguousToVerification)
  // reading verificationRunId from a stale closure would create a brand new
  // run on every single row instead of reusing the first one. The ref reads
  // back its own most recent write immediately; verificationRunId state is
  // kept in sync alongside it purely for the banner below.
  const verificationRunIdRef = useRef(null);

  const loadBatches = useCallback(async () => {
    setLoadingBatches(true);
    setBatchesError("");
    try {
      const { data, error } = await supabase.from("import_batches").select("*").order("created_at", { ascending: false }).limit(50);
      if (error) throw error;
      setBatches(data || []);
    } catch (err) {
      setBatchesError(err.message || "Could not load import batches.");
    } finally {
      setLoadingBatches(false);
    }
  }, [supabase]);

  useEffect(() => {
    loadBatches();
  }, [loadBatches]);

  const fetchAllSchools = useCallback(async () => {
    const out = [];
    let from = 0;
    for (;;) {
      const { data, error } = await supabase.from("schools").select(SCHOOL_SELECT_COLUMNS).order("id", { ascending: true }).range(from, from + PAGE_SIZE - 1);
      if (error) throw error;
      out.push(...(data || []));
      if (!data || data.length < PAGE_SIZE) break;
      from += PAGE_SIZE;
    }
    return out;
  }, [supabase]);

  function downloadTemplate() {
    const fields = ALL_FIELDS.map(([f]) => f).filter((f) => f !== "school_id");
    const csv = Papa.unparse({
      fields,
      data: [
        [
          "Example High School",
          "TX",
          "Austin",
          "Public",
          "123 Main St",
          "",
          "Travis",
          "78701",
          "5A",
          "5125551234",
          "www.exampleisd.org/highschool",
          "www.exampleisd.org/highschool/athletics",
          "",
          "Pat",
          "Coach",
          "pcoach@exampleisd.org",
          "5125555678",
          "5125551234",
          "https://x.com/exampleHSfb",
          "Sam Director",
          "sdirector@exampleisd.org",
        ],
      ],
    });
    downloadBlob(csv, "csd_import_reconcile_template.csv");
  }

  function resetUpload() {
    setPreview(null);
    setUploadError("");
    setCommitError("");
    setFileName("");
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function handleFileChange(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    resetUpload();
    setFileName(file.name);
    setUploading(true);
    try {
      const text = await file.text();
      const parsed = Papa.parse(text, { header: true, skipEmptyLines: true });
      if (parsed.errors?.length) throw new Error(parsed.errors[0].message);
      const rawRows = parsed.data || [];
      if (!rawRows.length) throw new Error("The file has no data rows.");

      const schools = await fetchAllSchools();
      const existingById = new Map(schools.map((s) => [String(s.id), s]));
      const existingByKey = new Map();
      schools.forEach((s) => {
        const key = matchKey(s.name, s.state);
        if (!existingByKey.has(key)) existingByKey.set(key, []);
        existingByKey.get(key).push(s);
      });

      let columnMapping = {};
      const seenInFile = new Map();
      const built = rawRows.map((raw, i) => {
        const { mapped, columnMapping: thisMapping } = mapRow(raw);
        if (i === 0) columnMapping = thisMapping;
        const result = categorizeRow(mapped, { existingById, existingByKey });

        let duplicateInFile = false;
        if (result.bucket === "new_school" && mapped.name && mapped.state) {
          const key = matchKey(mapped.name, mapped.state);
          if (seenInFile.has(key)) duplicateInFile = true;
          seenInFile.set(key, true);
        }

        return {
          row_index: i + 2, // +1 for 0-index, +1 for the header row
          label: mapped.name || `Row ${i + 2}`,
          raw_row: raw,
          mapped_data: mapped,
          ...result,
          duplicate_in_file: duplicateInFile,
        };
      });

      const summary = {};
      BUCKET_ORDER.forEach((b) => {
        summary[b] = built.filter((r) => r.bucket === b).length;
      });

      setPreview({ rows: built, columnMapping, summary });
    } catch (err) {
      setUploadError(err.message || "Could not read this file.");
    } finally {
      setUploading(false);
    }
  }

  async function commitBatch() {
    if (!preview) return;
    setCommitting(true);
    setCommitError("");
    try {
      const { data: batchRow, error: batchErr } = await supabase
        .from("import_batches")
        .insert({ file_name: fileName, status: "reviewing", column_mapping: preview.columnMapping, row_count: preview.rows.length, uploaded_by: user.id })
        .select()
        .single();
      if (batchErr) throw batchErr;

      for (let i = 0; i < preview.rows.length; i += BATCH_SIZE) {
        const chunk = preview.rows.slice(i, i + BATCH_SIZE).map((r) => ({
          batch_id: batchRow.id,
          row_index: r.row_index,
          raw_row: r.raw_row,
          mapped_data: r.mapped_data,
          match_school_id: r.match_school_id,
          match_confidence: r.match_confidence,
          bucket: r.bucket,
          diff: r.diff,
        }));
        const { error: insertErr } = await supabase.from("import_batch_rows").insert(chunk);
        if (insertErr) throw insertErr;
      }

      resetUpload();
      await loadBatches();
      await openBatch(batchRow.id);
    } catch (err) {
      setCommitError(err.message || "Could not save this import batch.");
    } finally {
      setCommitting(false);
    }
  }

  async function openBatch(batchId) {
    setLoadingRows(true);
    setBulkError("");
    setRowError({});
    setVerificationRunId(null);
    verificationRunIdRef.current = null;
    try {
      const { data: batchRow, error: batchErr } = await supabase.from("import_batches").select("*").eq("id", batchId).single();
      if (batchErr) throw batchErr;
      setSelectedBatch(batchRow);

      const out = [];
      let from = 0;
      for (;;) {
        const { data, error } = await supabase.from("import_batch_rows").select("*").eq("batch_id", batchId).order("row_index", { ascending: true }).range(from, from + PAGE_SIZE - 1);
        if (error) throw error;
        out.push(...(data || []));
        if (!data || data.length < PAGE_SIZE) break;
        from += PAGE_SIZE;
      }
      setRows(out);
      const firstNonEmpty = BUCKET_ORDER.find((b) => out.some((r) => r.bucket === b && r.resolution === "pending")) || BUCKET_ORDER.find((b) => out.some((r) => r.bucket === b)) || "exact_match";
      setActiveBucket(firstNonEmpty);
    } catch (err) {
      setBatchesError(err.message || "Could not open this import batch.");
    } finally {
      setLoadingRows(false);
    }
  }

  function closeReview() {
    setSelectedBatch(null);
    setRows([]);
    setRowError({});
    loadBatches();
  }

  function patchRow(id, patch) {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }

  async function markCloseBatch() {
    if (!selectedBatch) return;
    const { error } = await supabase.from("import_batches").update({ status: "done" }).eq("id", selectedBatch.id);
    if (!error) {
      setSelectedBatch((b) => ({ ...b, status: "done" }));
      loadBatches();
    }
  }

  // ---- Field-level apply (new_info + conflict rows) --------------------

  async function applyRowFields(row, fieldsToApply) {
    setRowBusy((p) => ({ ...p, [row.id]: true }));
    setRowError((p) => ({ ...p, [row.id]: null }));
    try {
      const now = new Date().toISOString();
      // Reviewing an import row and applying it is the same "someone just
      // fixed it" signal Quick Fix and batch-tool Apply already clear
      // needs_review for (lib/needsReview.js) -- a school landing here via
      // a bounce-recovery CSV shouldn't keep sitting in the Needs Review
      // queue once its fields are actually applied.
      const update = { verification_status: "verified", last_verified_at: now, ...NEEDS_REVIEW_CLEAR_FIELDS };
      const logs = [];
      fieldsToApply.forEach((f) => {
        update[f.field] = f.new;
        const isCoachName = f.field === "hc_first_name" || f.field === "hc_last_name";
        logs.push({
          school_id: row.match_school_id,
          field_name: f.field,
          old_value: f.old || null,
          new_value: f.new,
          source: isCoachName ? "Head coach change (manual)" : "Import & Reconcile (CSV)",
          changed_by: user.id,
        });
      });

      const { error: updErr } = await supabase.from("schools").update(update).eq("id", row.match_school_id);
      if (updErr) throw updErr;
      if (logs.length) {
        const { error: logErr } = await supabase.from("school_change_log").insert(logs);
        if (logErr) throw logErr;
      }

      const { error: rowErr } = await supabase.from("import_batch_rows").update({ resolution: "applied", resolved_at: now, resolved_by: user.id }).eq("id", row.id);
      if (rowErr) throw rowErr;

      patchRow(row.id, { resolution: "applied", resolved_at: now, resolved_by: user.id });
    } catch (err) {
      setRowError((p) => ({ ...p, [row.id]: err.message || "Could not apply this row." }));
    } finally {
      setRowBusy((p) => ({ ...p, [row.id]: false }));
    }
  }

  async function skipRow(row) {
    setRowBusy((p) => ({ ...p, [row.id]: true }));
    try {
      const now = new Date().toISOString();
      const { error } = await supabase.from("import_batch_rows").update({ resolution: "skipped", resolved_at: now, resolved_by: user.id }).eq("id", row.id);
      if (error) throw error;
      patchRow(row.id, { resolution: "skipped", resolved_at: now, resolved_by: user.id });
    } catch (err) {
      setRowError((p) => ({ ...p, [row.id]: err.message || "Could not skip this row." }));
    } finally {
      setRowBusy((p) => ({ ...p, [row.id]: false }));
    }
  }

  async function applyAllNewInfo() {
    const pending = rows.filter((r) => r.bucket === "new_info" && r.resolution === "pending");
    if (!pending.length) return;
    setBulkBusy(true);
    setBulkError("");
    try {
      for (let i = 0; i < pending.length; i += BATCH_SIZE) {
        const chunk = pending.slice(i, i + BATCH_SIZE);
        setBulkStatus(`Applying ${i + 1}–${Math.min(i + BATCH_SIZE, pending.length)} of ${pending.length}…`);
        for (const row of chunk) {
          // eslint-disable-next-line no-await-in-loop
          await applyRowFields(row, row.diff || []);
        }
      }
    } catch (err) {
      setBulkError(err.message || "Something went wrong applying these rows.");
    } finally {
      setBulkBusy(false);
      setBulkStatus("");
    }
  }

  function getSelection(row) {
    if (conflictSelections[row.id]) return conflictSelections[row.id];
    const initial = {};
    (row.diff || []).forEach((f) => {
      initial[f.field] = f.kind === "fill";
    });
    return initial;
  }

  function toggleField(row, field) {
    setConflictSelections((prev) => {
      const current = prev[row.id] || getSelection(row);
      return { ...prev, [row.id]: { ...current, [field]: !current[field] } };
    });
  }

  async function applyConflictRow(row) {
    const sel = getSelection(row);
    const fieldsToApply = (row.diff || []).filter((f) => sel[f.field]);
    if (!fieldsToApply.length) {
      await skipRow(row);
      return;
    }
    await applyRowFields(row, fieldsToApply);
  }

  // ---- New school bucket -------------------------------------------------

  async function addRowAsNewSchool(row) {
    setRowBusy((p) => ({ ...p, [row.id]: true }));
    setRowError((p) => ({ ...p, [row.id]: null }));
    try {
      const now = new Date().toISOString();
      const insertRow = { verification_status: "verified", confidence_score: 70, last_verified_at: now, source: "Import & Reconcile (CSV)" };
      ALL_FIELDS.forEach(([field]) => {
        if (field === "school_id") return;
        if (row.mapped_data[field]) insertRow[field] = row.mapped_data[field];
      });
      const { data: inserted, error } = await supabase.from("schools").insert(insertRow).select("id,name").single();
      if (error) throw error;

      const { error: logErr } = await supabase
        .from("school_change_log")
        .insert({ school_id: inserted.id, field_name: "created", old_value: null, new_value: inserted.name, source: "Import & Reconcile (CSV)", changed_by: user.id });
      if (logErr) throw logErr;

      const { error: rowErr } = await supabase
        .from("import_batch_rows")
        .update({ resolution: "applied", match_school_id: inserted.id, resolved_at: now, resolved_by: user.id })
        .eq("id", row.id);
      if (rowErr) throw rowErr;

      patchRow(row.id, { resolution: "applied", match_school_id: inserted.id, resolved_at: now, resolved_by: user.id });
    } catch (err) {
      setRowError((p) => ({ ...p, [row.id]: err.message || "Could not add this school." }));
    } finally {
      setRowBusy((p) => ({ ...p, [row.id]: false }));
    }
  }

  async function addAllNewSchools() {
    const pending = rows.filter((r) => r.bucket === "new_school" && r.resolution === "pending");
    if (!pending.length) return;
    setBulkBusy(true);
    setBulkError("");
    try {
      for (let i = 0; i < pending.length; i++) {
        setBulkStatus(`Adding ${i + 1} of ${pending.length}…`);
        // eslint-disable-next-line no-await-in-loop
        await addRowAsNewSchool(pending[i]);
      }
    } catch (err) {
      setBulkError(err.message || "Something went wrong adding these schools.");
    } finally {
      setBulkBusy(false);
      setBulkStatus("");
    }
  }

  // ---- Needs-verification bucket: hand off to Batch Coach-Info Discovery -

  async function ensureVerificationRun() {
    if (verificationRunIdRef.current) return verificationRunIdRef.current;
    const { data: runRow, error } = await supabase
      .from("coach_info_batch_runs")
      .insert({ status: "collecting", state_filter: null, requested_count: 0, created_by: user.id, candidate_mode: "csv_upload" })
      .select()
      .single();
    if (error) throw error;
    verificationRunIdRef.current = runRow.id;
    setVerificationRunId(runRow.id);
    return runRow.id;
  }

  async function sendToVerification(row, schoolId) {
    setRowBusy((p) => ({ ...p, [row.id]: true }));
    setRowError((p) => ({ ...p, [row.id]: null }));
    try {
      const runId = await ensureVerificationRun();
      const { data: item, error: itemErr } = await supabase.from("coach_info_batch_items").insert({ batch_run_id: runId, school_id: schoolId }).select().single();
      if (itemErr) throw itemErr;

      const { count } = await supabase.from("coach_info_batch_items").select("id", { count: "exact", head: true }).eq("batch_run_id", runId);
      await supabase.from("coach_info_batch_runs").update({ requested_count: count || 0 }).eq("id", runId);

      const now = new Date().toISOString();
      const { error: rowErr } = await supabase
        .from("import_batch_rows")
        .update({ resolution: "sent_to_verification", match_school_id: schoolId, match_confidence: "sent_to_ai", coach_info_batch_item_id: item.id, resolved_at: now, resolved_by: user.id })
        .eq("id", row.id);
      if (rowErr) throw rowErr;

      patchRow(row.id, { resolution: "sent_to_verification", match_school_id: schoolId, coach_info_batch_item_id: item.id, resolved_at: now, resolved_by: user.id });
    } catch (err) {
      setRowError((p) => ({ ...p, [row.id]: err.message || "Could not send this row to verification." }));
    } finally {
      setRowBusy((p) => ({ ...p, [row.id]: false }));
    }
  }

  async function markRowAsNewSchoolInstead(row) {
    setRowBusy((p) => ({ ...p, [row.id]: true }));
    try {
      const { error } = await supabase.from("import_batch_rows").update({ bucket: "new_school", match_school_id: null, diff: null }).eq("id", row.id);
      if (error) throw error;
      patchRow(row.id, { bucket: "new_school", match_school_id: null, diff: null });
    } catch (err) {
      setRowError((p) => ({ ...p, [row.id]: err.message || "Could not move this row." }));
    } finally {
      setRowBusy((p) => ({ ...p, [row.id]: false }));
    }
  }

  // Best-guess candidate: prefers a candidate whose city matches the CSV
  // row's city (when the CSV gave one), otherwise the first candidate --
  // convenient for plowing through a long list, while every row it touches
  // still goes through the same AI/web-search identity check the "Suggest
  // Coach Info" button uses before anything is written.
  function bestGuessCandidate(row) {
    const candidates = row.candidates || [];
    const city = (row.mapped_data?.city || "").trim().toLowerCase();
    if (city) {
      const match = candidates.find((c) => (c.city || "").trim().toLowerCase() === city);
      if (match) return match;
    }
    return candidates[0] || null;
  }

  async function sendAllAmbiguousToVerification() {
    const pending = rows.filter((r) => r.bucket === "needs_verification" && r.resolution === "pending" && r.candidates?.length);
    if (!pending.length) return;
    setBulkBusy(true);
    setBulkError("");
    try {
      for (let i = 0; i < pending.length; i++) {
        const best = bestGuessCandidate(pending[i]);
        if (!best) continue;
        setBulkStatus(`Sending ${i + 1} of ${pending.length}…`);
        // eslint-disable-next-line no-await-in-loop
        await sendToVerification(pending[i], best.id);
      }
    } catch (err) {
      setBulkError(err.message || "Something went wrong sending these rows to verification.");
    } finally {
      setBulkBusy(false);
      setBulkStatus("");
    }
  }

  async function markAllReviewed(bucket) {
    const pending = rows.filter((r) => r.bucket === bucket && r.resolution === "pending");
    if (!pending.length) return;
    setBulkBusy(true);
    setBulkError("");
    try {
      const now = new Date().toISOString();
      for (let i = 0; i < pending.length; i += BATCH_SIZE) {
        const chunk = pending.slice(i, i + BATCH_SIZE);
        const { error } = await supabase
          .from("import_batch_rows")
          .update({ resolution: "skipped", resolved_at: now, resolved_by: user.id })
          .in("id", chunk.map((r) => r.id));
        if (error) throw error;
        chunk.forEach((r) => patchRow(r.id, { resolution: "skipped", resolved_at: now, resolved_by: user.id }));
      }
    } catch (err) {
      setBulkError(err.message || "Something went wrong.");
    } finally {
      setBulkBusy(false);
    }
  }

  if (!canReview) {
    return (
      <div className="view">
        <div className="notice danger">Import &amp; Reconcile is limited to Verification Staff and System Admins.</div>
      </div>
    );
  }

  // ---- Review screen -------------------------------------------------

  if (selectedBatch) {
    const bucketRows = rows.filter((r) => r.bucket === activeBucket);
    const pendingInBucket = bucketRows.filter((r) => r.resolution === "pending");
    const totalPending = rows.filter((r) => r.resolution === "pending").length;

    return (
      <div className="view">
        <button className="btn btn-sm" style={{ marginBottom: 12 }} onClick={closeReview}>
          ← Back to Import &amp; Reconcile
        </button>
        <div className="view-header">
          <div>
            <h1>{selectedBatch.file_name}</h1>
            <p>
              {rows.length} row{rows.length === 1 ? "" : "s"} · {totalPending} still pending · uploaded {new Date(selectedBatch.created_at).toLocaleString()}
              {selectedBatch.status === "done" ? " · Closed" : ""}
            </p>
          </div>
          {selectedBatch.status !== "done" && (
            <button className="btn btn-sm btn-primary" onClick={markCloseBatch} disabled={loadingRows}>
              Close this batch
            </button>
          )}
        </div>

        {bulkError && <div className="notice danger" style={{ marginBottom: 12 }}>{bulkError}</div>}
        {verificationRunId && (
          <div className="notice info" style={{ marginBottom: 12 }}>
            Rows sent to verification are queued in a new Batch Coach-Info Discovery run.{" "}
            <Link href="/admin/batch-coach-info">Go fetch sources and submit it</Link> when you&apos;re done triaging.
          </div>
        )}

        {loadingRows ? (
          <div className="empty-state">Loading…</div>
        ) : (
          <>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
              {BUCKET_ORDER.map((b) => {
                const count = rows.filter((r) => r.bucket === b).length;
                const pending = rows.filter((r) => r.bucket === b && r.resolution === "pending").length;
                if (!count) return null;
                return (
                  <button
                    key={b}
                    className={`btn btn-sm ${activeBucket === b ? "btn-gold" : ""}`}
                    onClick={() => setActiveBucket(b)}
                  >
                    {BUCKET_LABELS[b]} ({pending ? `${pending}/` : ""}
                    {count})
                  </button>
                );
              })}
            </div>

            {activeBucket === "needs_verification" && pendingInBucket.length > 0 && (
              <div className="card" style={{ marginBottom: 14 }}>
                <p style={{ marginTop: 0, fontSize: 12.5, color: "#697386" }}>
                  These rows match more than one school with the same name in that state — the exact ambiguity the same-name-school fix in the AI lookup hardens against. Pick the right
                  school per row, or let the AI/web-search verification queue settle it (it independently confirms which school is which before anything is saved).
                </p>
                <button className="btn btn-sm btn-gold" onClick={sendAllAmbiguousToVerification} disabled={bulkBusy}>
                  {bulkBusy ? bulkStatus || "Sending…" : `Send all ${pendingInBucket.length} to AI verification (best guess by city)`}
                </button>{" "}
                <button className="btn btn-sm" onClick={() => markAllReviewed("needs_verification")} disabled={bulkBusy}>
                  Skip all
                </button>
              </div>
            )}

            {activeBucket === "new_info" && pendingInBucket.length > 0 && (
              <div className="card" style={{ marginBottom: 14 }}>
                <p style={{ marginTop: 0, fontSize: 12.5, color: "#697386" }}>
                  Every field below is currently blank on file — applying these can&apos;t overwrite anything that&apos;s already there.
                </p>
                <button className="btn btn-sm btn-gold" onClick={applyAllNewInfo} disabled={bulkBusy}>
                  {bulkBusy ? bulkStatus || "Applying…" : `Apply all ${pendingInBucket.length} rows`}
                </button>
              </div>
            )}

            {activeBucket === "new_school" && pendingInBucket.length > 0 && (
              <div className="card" style={{ marginBottom: 14 }}>
                <button className="btn btn-sm btn-gold" onClick={addAllNewSchools} disabled={bulkBusy}>
                  {bulkBusy ? bulkStatus || "Adding…" : `Add all ${pendingInBucket.length} new schools`}
                </button>
              </div>
            )}

            {(activeBucket === "exact_match" || activeBucket === "skipped") && pendingInBucket.length > 0 && (
              <div className="card" style={{ marginBottom: 14 }}>
                <button className="btn btn-sm" onClick={() => markAllReviewed(activeBucket)} disabled={bulkBusy}>
                  Mark all {pendingInBucket.length} reviewed
                </button>
              </div>
            )}

            <div className="card">
              {bucketRows.length === 0 ? (
                <div className="empty-state">No rows in this bucket.</div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {bucketRows.map((row) => (
                    <RowCard
                      key={row.id}
                      row={row}
                      busy={!!rowBusy[row.id]}
                      error={rowError[row.id]}
                      selection={activeBucket === "conflict" ? getSelection(row) : null}
                      onToggleField={(field) => toggleField(row, field)}
                      onApplyNewInfo={() => applyRowFields(row, row.diff || [])}
                      onApplyConflict={() => applyConflictRow(row)}
                      onSkip={() => skipRow(row)}
                      onAddNewSchool={() => addRowAsNewSchool(row)}
                      onPickCandidate={(candidate) => sendToVerification(row, candidate.id)}
                      onMarkNewSchool={() => markRowAsNewSchoolInstead(row)}
                    />
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    );
  }

  // ---- Landing screen: upload + batch list ----------------------------

  return (
    <div className="view">
      <Link href="/admin" className="btn btn-sm" style={{ marginBottom: 12, display: "inline-flex" }}>
        ← Back to Admin
      </Link>
      <div className="view-header">
        <div>
          <h1>Import &amp; Reconcile</h1>
          <p>
            Upload a coach-submitted or scraped spreadsheet, get it automatically matched against every school on file, and triage it in one screen instead of retyping it by hand. Rows
            that can&apos;t be safely auto-matched go straight into Batch Coach-Info Discovery for AI/web-search verification.
          </p>
        </div>
      </div>

      <div className="grid grid-2" style={{ marginBottom: 14 }}>
        <div className="card">
          <h3>Step 1 — Download the template (optional)</h3>
          <p style={{ fontSize: 12.5, color: "#697386", marginTop: -4 }}>
            <code>name</code> and <code>state</code> are required. Column headers are flexible — plain-language headers like &quot;Head Coach Email&quot; or &quot;Athletic Director&quot;
            are recognized automatically, and any column this tool doesn&apos;t recognize is just ignored.
          </p>
          <button className="btn btn-primary btn-sm" onClick={downloadTemplate}>
            Download CSV Template
          </button>
        </div>
        <div className="card">
          <h3>Step 2 — Upload a sheet</h3>
          <p style={{ fontSize: 12.5, color: "#697386", marginTop: -4 }}>Nothing is saved until you review the preview and click Save &amp; Start Reviewing.</p>
          {uploadError && <div className="notice danger" style={{ marginBottom: 10 }}>{uploadError}</div>}
          <input ref={fileInputRef} type="file" accept=".csv" onChange={handleFileChange} disabled={uploading} />
          {uploading && <div className="empty-state" style={{ marginTop: 8 }}>Reading {fileName}…</div>}
        </div>
      </div>

      {preview && (
        <div className="card" style={{ marginBottom: 14 }}>
          <h3>Preview — {fileName}</h3>
          <div className="grid grid-3" style={{ marginBottom: 12 }}>
            {BUCKET_ORDER.map((b) => (
              <div className="stat-card" key={b}>
                <div className="label">{BUCKET_LABELS[b]}</div>
                <div className="num">{preview.summary[b] || 0}</div>
              </div>
            ))}
          </div>
          {commitError && <div className="notice danger" style={{ marginBottom: 10 }}>{commitError}</div>}
          <button className="btn btn-gold" onClick={commitBatch} disabled={committing}>
            {committing ? "Saving…" : `Save & Start Reviewing (${preview.rows.length} rows)`}
          </button>
        </div>
      )}

      <div className="card">
        <h3>Recent imports</h3>
        {batchesError && <div className="notice danger" style={{ marginBottom: 10 }}>{batchesError}</div>}
        {loadingBatches ? (
          <div className="empty-state">Loading…</div>
        ) : batches.length === 0 ? (
          <div className="empty-state">No imports yet — upload a sheet above to get started.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>File</th>
                  <th>Rows</th>
                  <th>Status</th>
                  <th>Uploaded</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {batches.map((b) => (
                  <tr key={b.id}>
                    <td>{b.file_name}</td>
                    <td>{b.row_count}</td>
                    <td>{b.status === "done" ? "Closed" : "Reviewing"}</td>
                    <td>{new Date(b.created_at).toLocaleString()}</td>
                    <td>
                      <button className="btn btn-sm btn-primary" onClick={() => openBatch(b.id)}>
                        Open
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function RowCard({ row, busy, error, selection, onToggleField, onApplyNewInfo, onApplyConflict, onSkip, onAddNewSchool, onPickCandidate, onMarkNewSchool }) {
  const resolved = row.resolution !== "pending";
  const m = row.mapped_data || {};
  const locationLabel = [m.city, m.state].filter(Boolean).join(", ");

  return (
    <div className="log-item" style={{ opacity: resolved ? 0.6 : 1 }}>
      <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
        <div>
          <strong>{row.label || m.name || `Row ${row.row_index}`}</strong>
          {locationLabel && <span style={{ color: "#697386", fontSize: 12.5 }}> — {locationLabel}</span>}
          {row.duplicate_in_file && (
            <span className="badge badge-not-contacted" style={{ marginLeft: 8 }} title="Another row in this same file has the same name + state">
              Duplicate row in file
            </span>
          )}
        </div>
        {resolved && (
          <span style={{ fontSize: 12, color: "#697386" }}>
            {row.resolution === "applied" ? "Applied" : row.resolution === "sent_to_verification" ? "Sent to AI verification" : "Skipped"}
          </span>
        )}
      </div>

      {error && <div className="notice danger" style={{ marginTop: 8, fontSize: 12.5 }}>{error}</div>}

      {row.skip_reason && <div style={{ fontSize: 12.5, color: "#a94442", marginTop: 6 }}>{row.skip_reason}</div>}

      {row.candidates && row.candidates.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <div style={{ fontSize: 12.5, color: "#697386", marginBottom: 6 }}>Matches more than one school on file — which one is this row about?</div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {row.candidates.map((c) => (
              <button key={c.id} className="btn btn-sm" disabled={busy || resolved} onClick={() => onPickCandidate(c)}>
                {c.name} — {c.city}, {c.state} → send to AI
              </button>
            ))}
            <button className="btn btn-sm" disabled={busy || resolved} onClick={onMarkNewSchool}>
              None of these — it&apos;s a new school
            </button>
          </div>
        </div>
      )}

      {row.diff && row.diff.length > 0 && (
        <div className="table-wrap" style={{ marginTop: 8 }}>
          <table>
            <thead>
              <tr>
                {selection && <th></th>}
                <th>Field</th>
                <th>On file</th>
                <th>From sheet</th>
              </tr>
            </thead>
            <tbody>
              {row.diff.map((f) => (
                <tr key={f.field}>
                  {selection && (
                    <td>
                      <input type="checkbox" checked={!!selection[f.field]} disabled={busy || resolved} onChange={() => onToggleField(f.field)} />
                    </td>
                  )}
                  <td>{f.label}</td>
                  <td>{f.old || "—"}</td>
                  <td style={{ color: f.kind === "overwrite" ? "#b8860b" : "#1e7145", fontWeight: 700 }}>{f.new}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {row.bucket === "new_school" && !row.candidates && (
        <div className="table-wrap" style={{ marginTop: 8 }}>
          <table>
            <tbody>
              {DIFF_FIELDS.filter(([f]) => m[f]).map(([f, label]) => (
                <tr key={f}>
                  <td>{label}</td>
                  <td>{m[f]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!resolved && (
        <div style={{ marginTop: 10, display: "flex", gap: 8 }}>
          {row.bucket === "new_info" && (
            <button className="btn btn-sm btn-gold" disabled={busy} onClick={onApplyNewInfo}>
              Apply
            </button>
          )}
          {row.bucket === "conflict" && (
            <button className="btn btn-sm btn-gold" disabled={busy} onClick={onApplyConflict}>
              Apply selected
            </button>
          )}
          {row.bucket === "new_school" && (
            <button className="btn btn-sm btn-gold" disabled={busy} onClick={onAddNewSchool}>
              Add as new school
            </button>
          )}
          {row.bucket !== "needs_verification" && (
            <button className="btn btn-sm" disabled={busy} onClick={onSkip}>
              Skip
            </button>
          )}
        </div>
      )}
    </div>
  );
}
