"use client";
import { useState, useEffect, useCallback, useRef } from "react";
import Link from "next/link";
import Papa from "papaparse";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { useAuth } from "@/lib/auth-context";
import { classifySchools, classifySchool, computeConfidenceScore } from "@/lib/dataQuality";

const PAGE_SIZE = 1000;
const DISPLAY_CAP = 200;
const BATCH_SIZE = 300;

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
  ["maxpreps_url", "MaxPreps URL"],
];

// A flag opened by the nightly Coach-Change Radar sweep always starts with
// this exact text (see app/api/cron/recheck-schools) -- used to tell those
// apart from flags a coach raised by hand from a school profile page.
const AUTOMATED_FLAG_PREFIX = "Automated nightly recheck";

// Every result code checkSchoolCoach/checkSchoolCoach can return (see
// lib/schoolRecheck.js), with how each shows up in the Coach-Change Radar
// report below -- label, filter option, and pill color.
const RADAR_RESULT_META = {
  confirmed: { label: "Confirmed", color: "#1a7f37", bg: "#e6f4ea" },
  confirmed_maxpreps: { label: "Confirmed (MaxPreps)", color: "#1a7f37", bg: "#e6f4ea" },
  not_found: { label: "Not found", color: "#b3261e", bg: "#fbe9e7" },
  fetch_error: { label: "Could not load", color: "#8a6100", bg: "#fff4dc" },
  no_website: { label: "No website on file", color: "#697386", bg: "#f0f1f4" },
  no_coach_on_file: { label: "No coach on file", color: "#697386", bg: "#f0f1f4" },
};

const RADAR_FILTERS = [
  { key: "all", label: "All results" },
  { key: "not_found", label: "Not found" },
  { key: "fetch_error", label: "Could not load" },
  { key: "no_website", label: "No website on file" },
  { key: "no_coach_on_file", label: "No coach on file" },
  { key: "confirmed", label: "Confirmed" },
  { key: "confirmed_maxpreps", label: "Confirmed (MaxPreps)" },
];

// Every "source" string that can end up on a school_change_log row touching
// hc_first_name/hc_last_name -- see the Coach Change History card below.
// Anything not listed here still shows up, just with a plain gray badge
// carrying the raw source text, so a new write path never goes missing.
const COACH_CHANGE_SOURCE_META = {
  "Head coach change (manual)": { label: "Marked coach change", color: "#0b5fff", bg: "#e8f0ff" },
  "Data quality review (quick fix)": { label: "Quick fix", color: "#697386", bg: "#f0f1f4" },
  "Coach-submitted correction (approved)": { label: "Coach-submitted (approved)", color: "#1a7f37", bg: "#e6f4ea" },
  "Coach-submitted correction (approved, edited by verifier)": { label: "Coach-submitted, edited", color: "#1a7f37", bg: "#e6f4ea" },
  "Bulk correction upload (Data Quality)": { label: "Bulk upload", color: "#8a6100", bg: "#fff4dc" },
  "Bulk school update (CSV)": { label: "Bulk update tool", color: "#8a6100", bg: "#fff4dc" },
};
const COACH_CHANGE_FIELD_LABELS = { hc_first_name: "First name", hc_last_name: "Last name" };

function fmtPhone(v) {
  if (!v) return "";
  const digits = String(v).replace(/\D/g, "");
  return digits.length === 10 ? `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}` : v;
}

// Same bands as the confidence-score readout on a school's profile page
// (app/(app)/schools/[id]/page.js) -- kept visually consistent so the
// color means the same thing everywhere it shows up.
function confidenceColor(score) {
  if (score >= 70) return "#1d7a4c";
  if (score >= 40) return "#a17a00";
  return "#b3312c";
}

export default function DataQualityPage() {
  const supabase = getSupabaseBrowserClient();
  const { user, profile } = useAuth();
  const canReview = profile?.role === "verifier" || profile?.role === "sysadmin";

  // Flagged-as-outdated queue -- loads automatically (unlike the full scan
  // below, which is opt-in) so stale records surface the moment someone
  // reports one, rather than waiting for the next manual scan. Populated by
  // both a coach's manual "flag as outdated" and the automated Coach-Change
  // Radar sweep, distinguished below by badge.
  const [flaggedQueue, setFlaggedQueue] = useState([]);
  const [loadingFlags, setLoadingFlags] = useState(true);
  const [flagActionId, setFlagActionId] = useState(null);
  const [flagActionError, setFlagActionError] = useState("");

  // Coach-Change Radar summary -- aggregate stats AND the underlying rows
  // from the nightly automated sweep's most recent run, pulled from
  // school_recheck_log (every row the sweep writes is tagged with a
  // "[Automated nightly sweep]" detail prefix so it can be told apart from
  // on-demand checks). radarRows backs both the browsable report table
  // below and the CSV export -- radarStats is just the summary card.
  const [radarStats, setRadarStats] = useState(null);
  const [radarRows, setRadarRows] = useState([]);
  const [loadingRadar, setLoadingRadar] = useState(true);
  const [radarFilter, setRadarFilter] = useState("all");
  const [radarExporting, setRadarExporting] = useState(false);
  const [radarExportError, setRadarExportError] = useState("");

  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState("");
  const [result, setResult] = useState(null); // { flagged, counts, totalFlagged, totalScanned }
  const [filter, setFilter] = useState("all");

  const [editingId, setEditingId] = useState(null);
  const [editValues, setEditValues] = useState({});
  const [saving, setSaving] = useState(null);
  const [saveError, setSaveError] = useState("");
  // Set only when the open editor was opened via "Mark Coach Change" rather
  // than plain "Quick Fix" -- holds the pre-change school row so the form
  // can show who the outgoing coach was and saveEdit can tag the write
  // distinctly in school_change_log (see COACH_CHANGE_SOURCE_META).
  const [coachChangeFrom, setCoachChangeFrom] = useState(null);
  const scannedAt = useRef(null);

  // MaxPreps URL auto-discovery -- only ever active for whichever single
  // row is currently being edited (editingId), same as editValues itself.
  const [discovering, setDiscovering] = useState(false);
  const [discoverError, setDiscoverError] = useState("");
  const [suggestions, setSuggestions] = useState([]);

  // "Find & Edit a School" -- a standalone lookup so any school can be
  // reopened for a Quick Fix at any time, not just ones currently flagged
  // or turned up by a scan. Shares editingId/editValues/saveEdit with the
  // other two lists above, so once a school shows up here, everything
  // (including MaxPreps discovery) works exactly the same way.
  const [schoolQuery, setSchoolQuery] = useState("");
  const [searchResults, setSearchResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [hasSearched, setHasSearched] = useState(false);

  // Data-quality scan CSV export/import -- lets Larry pull the whole
  // review queue into Excel/Sheets, fix records there, and bring the
  // corrections back in one batch instead of working the Quick Fix panel
  // row by row. Mirrors the matching + apply logic of the Bulk Update
  // Schools tool, scoped to whatever's currently in this queue.
  const [exportingIssues, setExportingIssues] = useState(false);
  const [exportIssuesError, setExportIssuesError] = useState("");
  const uploadInputRef = useRef(null);
  const [uploadFileName, setUploadFileName] = useState("");
  const [uploadParsing, setUploadParsing] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const [uploadPreview, setUploadPreview] = useState([]); // [{id,name,city,state,fields:[{field,label,old,new}]}]
  const [uploadUnchanged, setUploadUnchanged] = useState(0);
  const [uploadUnmatched, setUploadUnmatched] = useState([]); // [{row,reason}]
  const [uploadApplying, setUploadApplying] = useState(false);
  const [uploadApplyError, setUploadApplyError] = useState("");
  const [uploadApplyStatus, setUploadApplyStatus] = useState("");
  const [uploadApplyResult, setUploadApplyResult] = useState(null); // {schools, fields}

  // Coach Change History -- every hc_first_name/hc_last_name entry ever
  // written to school_change_log, however it got there (Quick Fix, the
  // "Mark Coach Change" button below, a bulk upload/update, or an approved
  // coach-submitted correction), grouped so a name change made in one save
  // shows as one entry instead of two.
  const [coachChanges, setCoachChanges] = useState([]);
  const [loadingCoachChanges, setLoadingCoachChanges] = useState(true);
  const [coachChangeExporting, setCoachChangeExporting] = useState(false);
  const [coachChangeExportError, setCoachChangeExportError] = useState("");

  const loadFlags = useCallback(async () => {
    if (!canReview) {
      setLoadingFlags(false);
      return;
    }
    setLoadingFlags(true);
    const { data } = await supabase
      .from("school_flags")
      .select("*, schools(id,name,city,state,hc_first_name,hc_last_name,hc_email,hc_cell,hc_office,maxpreps_url,website,verification_status,confidence_score), colleges:flagged_by_college_id(name)")
      .eq("status", "pending")
      .order("created_at", { ascending: true });
    setFlaggedQueue(data || []);
    setLoadingFlags(false);
  }, [supabase, canReview]);

  useEffect(() => {
    loadFlags();
  }, [loadFlags]);

  const loadRadarStats = useCallback(async () => {
    if (!canReview) {
      setLoadingRadar(false);
      return;
    }
    setLoadingRadar(true);
    // The sweep runs once a night; a 26-hour lookback comfortably covers
    // "last night's run" even if the schedule shifts slightly, without
    // pulling in more than one run's worth of rows.
    const since = new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString();
    const { data } = await supabase
      .from("school_recheck_log")
      .select("id, school_id, result, detail, website_checked, coach_name_checked, checked_at, schools(name,city,state)")
      .ilike("detail", "[Automated nightly sweep]%")
      .gte("checked_at", since)
      .order("checked_at", { ascending: false })
      .limit(2000);

    if (!data || data.length === 0) {
      setRadarStats({ checked: 0, lastRunAt: null, counts: {} });
      setRadarRows([]);
      setLoadingRadar(false);
      return;
    }
    const counts = {};
    data.forEach((row) => {
      counts[row.result] = (counts[row.result] || 0) + 1;
    });
    setRadarStats({ checked: data.length, lastRunAt: data[0].checked_at, counts });
    setRadarRows(data);
    setLoadingRadar(false);
  }, [supabase, canReview]);

  useEffect(() => {
    loadRadarStats();
  }, [loadRadarStats]);

  const loadCoachChanges = useCallback(async () => {
    if (!canReview) {
      setLoadingCoachChanges(false);
      return;
    }
    setLoadingCoachChanges(true);
    const { data } = await supabase
      .from("school_change_log")
      .select("id, school_id, field_name, old_value, new_value, source, changed_at, schools(name,city,state)")
      .in("field_name", ["hc_first_name", "hc_last_name"])
      .order("changed_at", { ascending: false })
      .limit(2000);

    // A single save writes hc_first_name and hc_last_name as separate rows
    // sharing the same changed_at (one insert statement, one transaction
    // timestamp) -- group them back into one entry per save.
    const groups = new Map();
    (data || []).forEach((row) => {
      const key = `${row.school_id}|${row.changed_at}`;
      if (!groups.has(key)) {
        groups.set(key, { school_id: row.school_id, schools: row.schools, changed_at: row.changed_at, source: row.source, fields: [] });
      }
      groups.get(key).fields.push(row);
    });
    setCoachChanges(Array.from(groups.values()).sort((a, b) => new Date(b.changed_at) - new Date(a.changed_at)));
    setLoadingCoachChanges(false);
  }, [supabase, canReview]);

  useEffect(() => {
    loadCoachChanges();
  }, [loadCoachChanges]);

  // Exports the full Coach Change History list (not capped to the ~100
  // shown on screen) -- one row per changed field, so "old value"/"new
  // value" stay in their own columns for a spreadsheet.
  function exportCoachChanges() {
    setCoachChangeExportError("");
    setCoachChangeExporting(true);
    try {
      const csv = Papa.unparse({
        fields: ["school_name", "city", "state", "field", "old_value", "new_value", "source", "changed_at"],
        data: coachChanges.flatMap((g) =>
          g.fields.map((f) => [
            g.schools?.name || "",
            g.schools?.city || "",
            g.schools?.state || "",
            COACH_CHANGE_FIELD_LABELS[f.field_name] || f.field_name,
            f.old_value || "",
            f.new_value || "",
            f.source || "",
            f.changed_at ? new Date(f.changed_at).toISOString() : "",
          ])
        ),
      });
      downloadBlob(csv, `coach_change_history_${new Date().toISOString().slice(0, 10)}.csv`);
    } catch (err) {
      setCoachChangeExportError(err.message || "Could not export this list.");
    } finally {
      setCoachChangeExporting(false);
    }
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

  // Exports whatever the report table below is currently filtered to --
  // "Not Found" for a coaches-not-found report, "Could Not Load" for a
  // report of websites the sweep couldn't even fetch, or "All results" for
  // the full list of every school checked in the last run.
  function exportRadarLog() {
    setRadarExportError("");
    setRadarExporting(true);
    try {
      const rows = radarFilter === "all" ? radarRows : radarRows.filter((r) => r.result === radarFilter);
      const csv = Papa.unparse({
        fields: ["school_name", "city", "state", "result", "website_checked", "coach_name_checked", "detail", "checked_at"],
        data: rows.map((r) => [
          r.schools?.name || "",
          r.schools?.city || "",
          r.schools?.state || "",
          RADAR_RESULT_META[r.result]?.label || r.result,
          r.website_checked || "",
          r.coach_name_checked || "",
          (r.detail || "").replace("[Automated nightly sweep] ", ""),
          r.checked_at ? new Date(r.checked_at).toISOString() : "",
        ]),
      });
      const suffix = radarFilter === "all" ? "all" : radarFilter;
      downloadBlob(csv, `coach_change_radar_${suffix}_${new Date().toISOString().slice(0, 10)}.csv`);
    } catch (err) {
      setRadarExportError(err.message || "Could not export this report.");
    } finally {
      setRadarExporting(false);
    }
  }

  // Exports every school currently in the review queue -- respecting the
  // active issue filter, but NOT capped to the ~200 rows shown on screen --
  // so the full problem list can be worked in a spreadsheet.
  function exportIssuesCsv() {
    if (!result) return;
    setExportIssuesError("");
    setExportingIssues(true);
    try {
      const rows = result.flagged.filter((r) => filter === "all" || r.issues.some((iss) => iss.code === filter));
      const csv = Papa.unparse({
        fields: ["school_id", "school_name", "city", "state", "issues", "hc_first_name", "hc_last_name", "hc_email", "hc_cell", "hc_office", "maxpreps_url"],
        data: rows.map((r) => [
          r.school.id,
          r.school.name || "",
          r.school.city || "",
          r.school.state || "",
          r.issues.filter((iss) => iss.actionable).map((iss) => iss.label).join("; "),
          r.school.hc_first_name || "",
          r.school.hc_last_name || "",
          r.school.hc_email || "",
          r.school.hc_cell || "",
          r.school.hc_office || "",
          r.school.maxpreps_url || "",
        ]),
      });
      const suffix = filter === "all" ? "all" : filter;
      downloadBlob(csv, `data_quality_issues_${suffix}_${new Date().toISOString().slice(0, 10)}.csv`);
    } catch (err) {
      setExportIssuesError(err.message || "Could not export this list.");
    } finally {
      setExportingIssues(false);
    }
  }

  const fetchAllSchools = useCallback(async () => {
    const rows = [];
    let from = 0;
    for (;;) {
      const { data, error } = await supabase
        .from("schools")
        .select("id,name,city,state,hc_first_name,hc_last_name,hc_email,hc_cell,hc_office,lat,lon,verification_status,maxpreps_url,website,confidence_score")
        .order("id", { ascending: true })
        .range(from, from + PAGE_SIZE - 1);
      if (error) throw error;
      rows.push(...(data || []));
      if (!data || data.length < PAGE_SIZE) break;
      from += PAGE_SIZE;
    }
    return rows;
  }, [supabase]);

  async function searchSchoolsByName(e) {
    e.preventDefault();
    const q = schoolQuery.trim();
    if (!q) return;
    setSearching(true);
    setSearchError("");
    setHasSearched(true);
    try {
      const { data, error } = await supabase
        .from("schools")
        .select("id,name,city,state,hc_first_name,hc_last_name,hc_email,hc_cell,hc_office,maxpreps_url,website,verification_status,confidence_score")
        .ilike("name", `%${q}%`)
        .order("name")
        .limit(25);
      if (error) throw error;
      setSearchResults(data || []);
    } catch (err) {
      setSearchError(err.message || "Could not search schools.");
    } finally {
      setSearching(false);
    }
  }

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

  // Reads a CSV exported from (and then edited in) this page -- or any
  // hand-built correction sheet -- and matches each row back to a school
  // by school_id (preferred) or school_name + state (+ city to break ties
  // among same-named schools), the same matching rule the Bulk Update
  // Schools tool uses so the two stay predictable together. Only the
  // Quick Fix fields (EDIT_FIELDS) are read; any other column is ignored,
  // and blank cells never overwrite existing data.
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

      const schools = await fetchAllSchools();
      const byId = new Map(schools.map((s) => [String(s.id), s]));
      const byNameState = new Map();
      schools.forEach((s) => {
        const key = `${(s.name || "").trim().toLowerCase()}|${(s.state || "").trim().toUpperCase()}`;
        if (!byNameState.has(key)) byNameState.set(key, []);
        byNameState.get(key).push(s);
      });

      const preview = [];
      const unmatched = [];
      let unchangedCount = 0;

      rows.forEach((row, idx) => {
        const label = row.school_name || row.name || `Row ${idx + 2}`;
        let school = null;
        const idVal = String(row.school_id || row.id || "").trim();
        if (idVal && byId.has(idVal)) {
          school = byId.get(idVal);
        } else {
          const nameVal = (row.school_name || row.name || "").trim();
          const stateVal = (row.state || "").trim().toUpperCase();
          if (nameVal && stateVal) {
            const key = `${nameVal.toLowerCase()}|${stateVal}`;
            let candidates = byNameState.get(key) || [];
            if (candidates.length > 1 && row.city) {
              const narrowed = candidates.filter((c) => (c.city || "").trim().toLowerCase() === row.city.trim().toLowerCase());
              if (narrowed.length) candidates = narrowed;
            }
            if (candidates.length === 1) school = candidates[0];
            else if (candidates.length > 1) {
              unmatched.push({ row: label, reason: `${candidates.length} schools match "${nameVal}, ${stateVal}" — add a city or school_id column to disambiguate.` });
              return;
            }
          }
        }
        if (!school) {
          unmatched.push({ row: label, reason: idVal ? `No school found with id ${idVal}.` : "Could not match on school_id or school_name + state." });
          return;
        }

        const fields = [];
        EDIT_FIELDS.forEach(([field, fieldLabel]) => {
          if (!(field in row)) return;
          const newVal = String(row[field] ?? "").trim();
          if (newVal === "") return;
          const oldVal = (school[field] || "").toString().trim();
          if (newVal !== oldVal) fields.push({ field, label: fieldLabel, old: oldVal || "—", new: newVal });
        });
        if (fields.length) preview.push({ id: school.id, name: school.name, city: school.city, state: school.state, fields, original: school });
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

  // Applies the previewed changes in batches, same bookkeeping as every
  // other write path on this page: mark verified, log each changed field
  // to school_change_log, clear any pending "possibly outdated" flags on
  // the schools touched, and fold the results back into the queue without
  // waiting on a full re-scan.
  async function applyUpload() {
    setUploadApplying(true);
    setUploadApplyError("");
    setUploadApplyResult(null);
    try {
      let applied = 0;
      const now = new Date().toISOString();
      const updatesById = new Map();
      for (let i = 0; i < uploadPreview.length; i += BATCH_SIZE) {
        const chunk = uploadPreview.slice(i, i + BATCH_SIZE);
        setUploadApplyStatus(`Applying ${i + 1}–${Math.min(i + BATCH_SIZE, uploadPreview.length)} of ${uploadPreview.length}…`);
        const upserts = chunk.map((row) => {
          const update = { id: row.id, verification_status: "verified", last_verified_at: now };
          row.fields.forEach((f) => {
            update[f.field] = f.new;
          });
          update.confidence_score = computeConfidenceScore({ ...row.original, ...update });
          updatesById.set(row.id, update);
          return update;
        });
        const { error } = await supabase.from("schools").upsert(upserts, { onConflict: "id" });
        if (error) throw error;

        const changes = [];
        chunk.forEach((row) => {
          row.fields.forEach((f) => {
            changes.push({
              school_id: row.id,
              field_name: f.field,
              old_value: f.old === "—" ? null : f.old,
              new_value: f.new,
              source: "Bulk correction upload (Data Quality)",
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

      const updatedIds = new Set(uploadPreview.map((row) => row.id));

      setResult((prev) => {
        if (!prev) return prev;
        const next = prev.flagged
          .map((r) => {
            if (!updatedIds.has(r.school.id)) return r;
            const merged = { ...r.school, ...updatesById.get(r.school.id) };
            const reclass = classifySchool(merged);
            return reclass.actionable ? { ...r, ...reclass, school: merged } : null;
          })
          .filter(Boolean);
        return { ...prev, flagged: next, totalFlagged: next.length };
      });
      setSearchResults((prev) => prev.map((s) => (updatedIds.has(s.id) ? { ...s, ...updatesById.get(s.id) } : s)));

      if (updatedIds.size) {
        await supabase
          .from("school_flags")
          .update({ status: "resolved", resolved_by: user.id, resolved_at: now })
          .in("school_id", Array.from(updatedIds))
          .eq("status", "pending");
        setFlaggedQueue((prev) => prev.filter((f) => !updatedIds.has(f.school_id)));
      }

      if (uploadPreview.some((row) => row.fields.some((f) => f.field === "hc_first_name" || f.field === "hc_last_name"))) {
        loadCoachChanges();
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

  function startEdit(school) {
    setEditingId(school.id);
    setCoachChangeFrom(null);
    setSaveError("");
    setDiscoverError("");
    setSuggestions([]);
    setEditValues({
      hc_first_name: school.hc_first_name || "",
      hc_last_name: school.hc_last_name || "",
      hc_email: school.hc_email || "",
      hc_cell: school.hc_cell || "",
      hc_office: school.hc_office || "",
      maxpreps_url: school.maxpreps_url || "",
    });
  }

  // Same editor as Quick Fix, but opened specifically to record a head
  // coach change: the coach fields start blank (rather than pre-filled
  // with the outgoing coach's info) so you're not left editing stale
  // values into the new coach's record, the form shows who's leaving, and
  // the save gets tagged "Head coach change (manual)" in school_change_log
  // so it shows up clearly in Coach Change History below.
  function startCoachChange(school) {
    setEditingId(school.id);
    setCoachChangeFrom(school);
    setSaveError("");
    setDiscoverError("");
    setSuggestions([]);
    setEditValues({
      hc_first_name: "",
      hc_last_name: "",
      hc_email: "",
      hc_cell: "",
      hc_office: "",
      maxpreps_url: school.maxpreps_url || "",
    });
  }

  function cancelEdit() {
    setEditingId(null);
    setCoachChangeFrom(null);
    setSaveError("");
    setDiscoverError("");
    setSuggestions([]);
  }

  // Asks Google's Programmable Search Engine (via our own API route, which
  // holds the actual key) where this school's MaxPreps page lives, rather
  // than scraping MaxPreps directly -- see app/api/schools/[id]/discover-
  // maxpreps for why. Only ever returns candidates for a human to pick
  // from; never writes maxpreps_url on its own.
  async function discoverMaxPreps(school) {
    setDiscovering(true);
    setDiscoverError("");
    setSuggestions([]);
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const res = await fetch(`/api/schools/${school.id}/discover-maxpreps`, {
        method: "POST",
        headers: { Authorization: `Bearer ${session?.access_token}` },
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Could not search for a MaxPreps page.");
      setSuggestions(json.candidates || []);
      if (!json.candidates?.length) setDiscoverError("No MaxPreps page turned up for this school. Try searching MaxPreps directly and paste the link in.");
    } catch (err) {
      setDiscoverError(err.message || "Could not search for a MaxPreps page.");
    } finally {
      setDiscovering(false);
    }
  }

  function pickSuggestion(link) {
    setEditValues((prev) => ({ ...prev, maxpreps_url: link }));
    setSuggestions([]);
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
      const isCoachChange = coachChangeFrom?.id === before.id;
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
            source: isCoachChange ? "Head coach change (manual)" : "Data quality review (quick fix)",
            changed_by: user.id,
          });
        }
      });
      // Redo the confidence score against the record as it will look right
      // after this write lands, so it always reflects what's actually on
      // file rather than whatever it was set to at the last edit (or, for
      // most schools, at the original bulk import).
      update.confidence_score = computeConfidenceScore({ ...before, ...update });

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
      // Also reflect the fix in the "Find & Edit a School" search results,
      // if this school is showing there -- a no-op otherwise.
      setSearchResults((prev) => prev.map((s) => (s.id === before.id ? { ...s, ...update } : s)));
      if (changes.some((c) => c.field_name === "hc_first_name" || c.field_name === "hc_last_name")) {
        loadCoachChanges();
      }
      setEditingId(null);
      setCoachChangeFrom(null);
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
      const schoolUpdate = { verification_status: "verified", last_verified_at: new Date().toISOString() };
      if (flag.schools) schoolUpdate.confidence_score = computeConfidenceScore({ ...flag.schools, ...schoolUpdate });
      const { error: schoolError } = await supabase.from("schools").update(schoolUpdate).eq("id", flag.school_id);
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
  const automatedPendingCount = flaggedQueue.filter((f) => (f.reason || "").startsWith(AUTOMATED_FLAG_PREFIX)).length;
  const confirmedTotal = (radarStats?.counts.confirmed || 0) + (radarStats?.counts.confirmed_maxpreps || 0);
  const radarFilteredRows = radarFilter === "all" ? radarRows : radarRows.filter((r) => r.result === radarFilter);

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
        <h3 style={{ marginBottom: 4 }}>Find &amp; Edit a School</h3>
        <p style={{ fontSize: 12.5, color: "#697386", marginTop: -2, marginBottom: 10 }}>
          Look up any school by name to open its Quick Fix editor — not just ones currently flagged or turned up by a scan. Use this to get back to a school you already fixed, or to add something (like a MaxPreps URL) you didn't have on hand the first time.
        </p>
        <form onSubmit={searchSchoolsByName} style={{ display: "flex", gap: 8, marginBottom: 10 }}>
          <input
            value={schoolQuery}
            onChange={(e) => setSchoolQuery(e.target.value)}
            placeholder="School name…"
            style={{ flex: 1 }}
          />
          <button className="btn btn-sm btn-gold" type="submit" disabled={searching || !schoolQuery.trim()}>
            {searching ? "Searching…" : "Search"}
          </button>
        </form>
        {searchError && <div className="notice danger" style={{ marginBottom: 10 }}>{searchError}</div>}
        {hasSearched && !searching && !searchError && searchResults.length === 0 && (
          <div className="empty-state">No schools matched &quot;{schoolQuery}&quot;.</div>
        )}
        {searchResults.map((s) => {
          const isEditing = editingId === s.id;
          return (
            <div className="log-item" key={s.id} style={{ paddingBottom: 12 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 8 }}>
                <div>
                  <strong>{s.name}</strong> — {s.city}, {s.state}
                  <span style={{ fontSize: 11, fontWeight: 600, color: confidenceColor(s.confidence_score ?? 0), marginLeft: 8 }}>
                    {s.confidence_score ?? 0}% confidence
                  </span>
                  <div style={{ fontSize: 12, color: "#697386", marginTop: 2 }}>
                    {[s.hc_first_name, s.hc_last_name].filter(Boolean).join(" ") || "no coach name"}
                    {s.hc_email ? ` · ${s.hc_email}` : ""}
                    {s.hc_cell ? ` · ${fmtPhone(s.hc_cell)}` : ""}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 6 }}>
                  <Link href={`/schools/${s.id}`} className="btn btn-sm">Open Profile</Link>
                  {!isEditing && (
                    <>
                      <button className="btn btn-sm btn-primary" onClick={() => startEdit(s)}>Quick Fix</button>
                      <button className="btn btn-sm" onClick={() => startCoachChange(s)}>Mark Coach Change</button>
                    </>
                  )}
                </div>
              </div>

              {isEditing && coachChangeFrom?.id === s.id && (
                <div className="notice" style={{ marginTop: 8, fontSize: 12.5 }}>
                  Recording a new head coach at <strong>{s.name}</strong>. Outgoing: {[coachChangeFrom.hc_first_name, coachChangeFrom.hc_last_name].filter(Boolean).join(" ") || "no name on file"}
                  {coachChangeFrom.hc_email ? ` · ${coachChangeFrom.hc_email}` : ""}
                  {coachChangeFrom.hc_cell ? ` · ${fmtPhone(coachChangeFrom.hc_cell)}` : ""}. Fields left blank below will be cleared, not carried over.
                </div>
              )}

              {isEditing && (
                <div style={{ background: "#f7f8fa", border: "1px solid #dde1e7", borderRadius: 8, padding: 10, marginTop: 8 }}>
                  <div className="grid grid-2" style={{ marginBottom: 8 }}>
                    {EDIT_FIELDS.map(([field, label]) => (
                      <div className="form-field" key={field} style={{ marginBottom: 0 }}>
                        <label>{label}</label>
                        <input value={editValues[field]} onChange={(e) => setEditValues((prev) => ({ ...prev, [field]: e.target.value }))} />
                      </div>
                    ))}
                  </div>
                  <div style={{ marginBottom: 8 }}>
                    <button type="button" className="btn btn-sm" disabled={discovering} onClick={() => discoverMaxPreps(s)}>
                      {discovering ? "Searching…" : "Find MaxPreps page"}
                    </button>
                    {discoverError && <div style={{ fontSize: 12, color: "#b3261e", marginTop: 6 }}>{discoverError}</div>}
                    {suggestions.length > 0 && (
                      <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 4 }}>
                        {suggestions.map((sugg) => (
                          <button
                            type="button"
                            key={sugg.link}
                            className="btn btn-sm"
                            style={{ textAlign: "left", justifyContent: "flex-start", whiteSpace: "normal" }}
                            onClick={() => pickSuggestion(sugg.link)}
                          >
                            {sugg.title} — <span style={{ color: "#697386" }}>{sugg.link}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  {saveError && <div className="notice danger" style={{ marginBottom: 8 }}>{saveError}</div>}
                  <div style={{ display: "flex", gap: 8 }}>
                    <button className="btn btn-sm btn-gold" disabled={saving === s.id} onClick={() => saveEdit(s)}>
                      {saving === s.id ? "Saving…" : coachChangeFrom?.id === s.id ? "Save Coach Change" : "Save & Mark Verified"}
                    </button>
                    <button type="button" className="btn btn-sm" onClick={cancelEdit} disabled={saving === s.id}>
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <h3 style={{ marginBottom: 4 }}>Coach-Change Radar</h3>
        <p style={{ fontSize: 12.5, color: "#697386", marginTop: -2, marginBottom: 10 }}>
          Every school with a website or MaxPreps URL on file gets an automated recheck on a nightly rolling schedule — a coach change surfaces here on its own, without anyone having to notice and flag it by hand.
        </p>
        {loadingRadar ? (
          <div className="empty-state">Loading…</div>
        ) : !radarStats || radarStats.checked === 0 ? (
          <div className="empty-state">No automated sweep activity in the last day. The nightly job runs once a day — check back after it&apos;s had a chance to run.</div>
        ) : (
          <div className="grid grid-4">
            <div className="card stat-card">
              <div className="label">Checked, Last Run</div>
              <div className="num">{radarStats.checked.toLocaleString()}</div>
              <div className="sub">{radarStats.lastRunAt ? new Date(radarStats.lastRunAt).toLocaleString() : ""}</div>
            </div>
            <div className="card stat-card">
              <div className="label">Confirmed</div>
              <div className="num">{confirmedTotal.toLocaleString()}</div>
              <div className="sub">{radarStats.counts.confirmed_maxpreps ? `${radarStats.counts.confirmed_maxpreps} via MaxPreps fallback` : "coach name matched on file"}</div>
            </div>
            <div className="card stat-card">
              <div className="label">Not Found</div>
              <div className="num">{(radarStats.counts.not_found || 0).toLocaleString()}</div>
              <div className="sub">needs 2 misses in a row to flag</div>
            </div>
            <div className="card stat-card">
              <div className="label">Automated Flags Pending</div>
              <div className="num">{automatedPendingCount.toLocaleString()}</div>
              <div className="sub">in the queue below</div>
            </div>
          </div>
        )}

        {radarStats && radarStats.checked > 0 && (
          <>
            <div className="filters" style={{ marginTop: 12 }}>
              {RADAR_FILTERS.map((f) => (
                <button
                  key={f.key}
                  className="btn btn-sm"
                  style={radarFilter === f.key ? { background: "#0b1f3a", color: "#fff", borderColor: "#0b1f3a" } : undefined}
                  onClick={() => setRadarFilter(f.key)}
                >
                  {f.label}
                  {f.key !== "all" && radarStats.counts[f.key] ? ` (${radarStats.counts[f.key]})` : ""}
                </button>
              ))}
              <button
                type="button"
                className="btn btn-sm"
                style={{ marginLeft: "auto" }}
                disabled={radarExporting || radarFilteredRows.length === 0}
                onClick={exportRadarLog}
              >
                {radarExporting ? "Exporting…" : "Download CSV"}
              </button>
            </div>
            {radarExportError && <div className="notice danger" style={{ marginTop: 8 }}>{radarExportError}</div>}

            <div style={{ marginTop: 10 }}>
              {radarFilteredRows.length === 0 ? (
                <div className="empty-state">Nothing matches this filter in last night&apos;s run.</div>
              ) : (
                <>
                  {radarFilteredRows.slice(0, DISPLAY_CAP).map((row) => {
                    const meta = RADAR_RESULT_META[row.result] || { label: row.result, color: "#42506b", bg: "#e8ebf0" };
                    return (
                      <div className="log-item" key={row.id} style={{ paddingBottom: 10 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 8 }}>
                          <div>
                            <strong>{row.schools?.name || `School #${row.school_id}`}</strong> — {row.schools?.city}, {row.schools?.state}
                            <span
                              style={{
                                marginLeft: 8,
                                fontSize: 11,
                                fontWeight: 600,
                                padding: "2px 8px",
                                borderRadius: 999,
                                color: meta.color,
                                background: meta.bg,
                              }}
                            >
                              {meta.label}
                            </span>
                            <div style={{ fontSize: 12, color: "#697386", marginTop: 2 }}>
                              {(row.detail || "").replace("[Automated nightly sweep] ", "")}
                            </div>
                          </div>
                          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
                            <Link href={`/schools/${row.school_id}`} className="btn btn-sm">Open Profile</Link>
                            <span style={{ fontSize: 11, color: "#9aa2b1", whiteSpace: "nowrap" }}>
                              {row.checked_at ? new Date(row.checked_at).toLocaleString() : ""}
                            </span>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                  {radarFilteredRows.length > DISPLAY_CAP && (
                    <div style={{ fontSize: 12, color: "#697386", marginTop: 6 }}>
                      Showing the first {DISPLAY_CAP} of {radarFilteredRows.length.toLocaleString()} — download the CSV for the full list.
                    </div>
                  )}
                </>
              )}
            </div>
          </>
        )}
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 8 }}>
          <div>
            <h3 style={{ marginBottom: 4 }}>Coach Change History</h3>
            <p style={{ fontSize: 12.5, color: "#697386", marginTop: -2, marginBottom: 0 }}>
              Every recorded head coach name change, however it was made — &quot;Mark Coach Change,&quot; a Quick Fix, a bulk upload, or an approved coach-submitted correction.
            </p>
          </div>
          <button className="btn btn-sm" onClick={exportCoachChanges} disabled={coachChangeExporting || coachChanges.length === 0}>
            {coachChangeExporting ? "Exporting…" : "Download CSV"}
          </button>
        </div>
        {coachChangeExportError && <div className="notice danger" style={{ marginTop: 10 }}>{coachChangeExportError}</div>}
        {loadingCoachChanges ? (
          <div className="empty-state" style={{ marginTop: 10 }}>Loading…</div>
        ) : coachChanges.length === 0 ? (
          <div className="empty-state" style={{ marginTop: 10 }}>No coach changes recorded yet.</div>
        ) : (
          <div style={{ maxHeight: 360, overflow: "auto", marginTop: 10 }}>
            {coachChanges.slice(0, 100).map((g) => {
              const meta = COACH_CHANGE_SOURCE_META[g.source] || { label: g.source || "Unknown source", color: "#697386", bg: "#f0f1f4" };
              return (
                <div className="log-item" key={`${g.school_id}|${g.changed_at}`} style={{ paddingBottom: 10 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 8 }}>
                    <div>
                      <strong>{g.schools?.name}</strong> — {g.schools?.city}, {g.schools?.state}
                      <span className="badge" style={{ marginLeft: 8, color: meta.color, background: meta.bg }}>{meta.label}</span>
                      <div style={{ marginTop: 4, fontSize: 12.5 }}>
                        {g.fields.map((f) => (
                          <div key={f.id}>
                            {COACH_CHANGE_FIELD_LABELS[f.field_name] || f.field_name}: <span style={{ color: "#697386" }}>{f.old_value || "—"}</span> → <strong>{f.new_value || "—"}</strong>
                          </div>
                        ))}
                      </div>
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
                      <Link href={`/schools/${g.school_id}`} className="btn btn-sm">Open Profile</Link>
                      <span style={{ fontSize: 11, color: "#9aa2b1", whiteSpace: "nowrap" }}>
                        {g.changed_at ? new Date(g.changed_at).toLocaleString() : ""}
                      </span>
                    </div>
                  </div>
                </div>
              );
            })}
            {coachChanges.length > 100 && (
              <div style={{ fontSize: 12, color: "#697386", marginTop: 6 }}>
                Showing the first 100 of {coachChanges.length.toLocaleString()} — download the CSV for the full list.
              </div>
            )}
          </div>
        )}
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <h3 style={{ marginBottom: 4 }}>Flagged as Possibly Outdated ({flaggedQueue.length})</h3>
        <p style={{ fontSize: 12.5, color: "#697386", marginTop: -2, marginBottom: 10 }}>
          Reported by coaches browsing the database, or raised automatically by Coach-Change Radar — surfaces here immediately, no scan needed.
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
            const isAutomated = (flag.reason || "").startsWith(AUTOMATED_FLAG_PREFIX);
            return (
              <div className="log-item" key={flag.id} style={{ paddingBottom: 12 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 8 }}>
                  <div>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                      <strong>{s?.name}</strong> — {s?.city}, {s?.state}
                      <span
                        className={isAutomated ? "badge badge-unverified" : "badge"}
                        style={isAutomated ? undefined : { background: "#e8ebf0", color: "#42506b" }}
                      >
                        {isAutomated ? "Automated · Coach-Change Radar" : "Manual flag"}
                      </span>
                      {s && (
                        <span style={{ fontSize: 11, fontWeight: 600, color: confidenceColor(s.confidence_score ?? 0) }}>
                          {s.confidence_score ?? 0}% confidence
                        </span>
                      )}
                    </div>
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
                      <>
                        <button className="btn btn-sm btn-primary" onClick={() => startEdit(s)}>Quick Fix</button>
                        <button className="btn btn-sm" onClick={() => startCoachChange(s)}>Mark Coach Change</button>
                      </>
                    )}
                    <button className="btn btn-sm" disabled={flagActionId === flag.id} onClick={() => confirmAccurate(flag)}>
                      {flagActionId === flag.id ? "Saving…" : "Confirm accurate"}
                    </button>
                  </div>
                </div>

                {isEditing && s && coachChangeFrom?.id === s.id && (
                  <div className="notice" style={{ marginTop: 8, fontSize: 12.5 }}>
                    Recording a new head coach at <strong>{s.name}</strong>. Outgoing: {[coachChangeFrom.hc_first_name, coachChangeFrom.hc_last_name].filter(Boolean).join(" ") || "no name on file"}
                    {coachChangeFrom.hc_email ? ` · ${coachChangeFrom.hc_email}` : ""}
                    {coachChangeFrom.hc_cell ? ` · ${fmtPhone(coachChangeFrom.hc_cell)}` : ""}. Fields left blank below will be cleared, not carried over.
                  </div>
                )}

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
                    <div style={{ marginBottom: 8 }}>
                      <button type="button" className="btn btn-sm" disabled={discovering} onClick={() => discoverMaxPreps(s)}>
                        {discovering ? "Searching…" : "Find MaxPreps page"}
                      </button>
                      {discoverError && <div style={{ fontSize: 12, color: "#b3261e", marginTop: 6 }}>{discoverError}</div>}
                      {suggestions.length > 0 && (
                        <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 4 }}>
                          {suggestions.map((sugg) => (
                            <button
                              type="button"
                              key={sugg.link}
                              className="btn btn-sm"
                              style={{ textAlign: "left", justifyContent: "flex-start", whiteSpace: "normal" }}
                              onClick={() => pickSuggestion(sugg.link)}
                            >
                              {sugg.title} — <span style={{ color: "#697386" }}>{sugg.link}</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                    {saveError && <div className="notice danger" style={{ marginBottom: 8 }}>{saveError}</div>}
                    <div style={{ display: "flex", gap: 8 }}>
                      <button className="btn btn-sm btn-gold" disabled={saving === s.id} onClick={() => saveEdit(s)}>
                        {saving === s.id ? "Saving…" : coachChangeFrom?.id === s.id ? "Save Coach Change" : "Save & Mark Verified"}
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
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 8, marginBottom: 4 }}>
              <h3 style={{ marginBottom: 4 }}>
                Review Queue {visibleTotal > DISPLAY_CAP ? `— showing top ${DISPLAY_CAP} of ${visibleTotal}` : `(${visibleTotal})`}
              </h3>
              <button className="btn btn-sm" onClick={exportIssuesCsv} disabled={exportingIssues || result.flagged.length === 0}>
                {exportingIssues ? "Exporting…" : "Download CSV"}
              </button>
            </div>
            {exportIssuesError && <div className="notice danger" style={{ marginBottom: 10 }}>{exportIssuesError}</div>}

            <div style={{ background: "#f7f8fa", border: "1px solid #dde1e7", borderRadius: 8, padding: 10, marginBottom: 14 }}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>Upload corrected CSV</div>
              <p style={{ fontSize: 12.5, color: "#697386", marginTop: 0, marginBottom: 8 }}>
                Edit the downloaded file in Excel or Sheets, then re-upload it here to apply corrections in bulk. Matches rows on <code>school_id</code> (preferred) or <code>school_name</code> + <code>state</code> (+ <code>city</code> to break ties). Reads <code>hc_first_name, hc_last_name, hc_email, hc_cell, hc_office, maxpreps_url</code> — blank cells are left unchanged, and any other column is ignored.
              </p>
              <input ref={uploadInputRef} type="file" accept=".csv" onChange={handleUploadFile} disabled={uploadParsing || uploadApplying} />
              {uploadParsing && <div className="empty-state" style={{ marginTop: 8 }}>Reading {uploadFileName}…</div>}
              {uploadError && <div className="notice danger" style={{ marginTop: 8 }}>{uploadError}</div>}

              {uploadApplyResult && (
                <div className="notice" style={{ marginTop: 8 }}>
                  Applied {uploadApplyResult.fields} field{uploadApplyResult.fields === 1 ? "" : "s"} across {uploadApplyResult.schools} school{uploadApplyResult.schools === 1 ? "" : "s"}.
                </div>
              )}

              {(uploadPreview.length > 0 || uploadUnmatched.length > 0 || uploadUnchanged > 0) && (
                <div style={{ marginTop: 10 }}>
                  <div className="grid grid-3" style={{ marginBottom: 10 }}>
                    <div className="stat-card">
                      <div className="label">Schools to update</div>
                      <div className="num">{uploadPreview.length}</div>
                      <div className="sub">{uploadPreview.reduce((sum, r) => sum + r.fields.length, 0)} field(s) changing</div>
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
                    <div className="notice danger" style={{ marginBottom: 10 }}>
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
                      <div style={{ maxHeight: 260, overflow: "auto", marginBottom: 10 }}>
                        {uploadPreview.slice(0, 100).map((row) => (
                          <div key={row.id} style={{ fontSize: 12.5, padding: "6px 0", borderBottom: "1px solid #eee" }}>
                            <strong>{row.name}</strong> — {row.city}, {row.state}
                            <div style={{ color: "#697386", marginTop: 2 }}>
                              {row.fields.map((f) => `${f.label}: "${f.old}" → "${f.new}"`).join("  ·  ")}
                            </div>
                          </div>
                        ))}
                        {uploadPreview.length > 100 && <div style={{ fontSize: 12, color: "#697386", marginTop: 6 }}>…and {uploadPreview.length - 100} more.</div>}
                      </div>
                      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                        <button className="btn btn-sm btn-gold" onClick={applyUpload} disabled={uploadApplying}>
                          {uploadApplying ? "Applying…" : `Apply ${uploadPreview.length} Change${uploadPreview.length === 1 ? "" : "s"}`}
                        </button>
                        <button type="button" className="btn btn-sm" onClick={resetUpload} disabled={uploadApplying}>
                          Cancel
                        </button>
                        {uploadApplyStatus && <span style={{ fontSize: 12, color: "#697386" }}>{uploadApplyStatus}</span>}
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>

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
                        <span style={{ fontSize: 11, fontWeight: 600, color: confidenceColor(s.confidence_score ?? 0), marginLeft: 8 }}>
                          {s.confidence_score ?? 0}% confidence
                        </span>
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
                          <>
                            <button className="btn btn-sm btn-primary" onClick={() => startEdit(s)}>Quick Fix</button>
                            <button className="btn btn-sm" onClick={() => startCoachChange(s)}>Mark Coach Change</button>
                          </>
                        )}
                      </div>
                    </div>

                    {isEditing && coachChangeFrom?.id === s.id && (
                      <div className="notice" style={{ marginTop: 8, fontSize: 12.5 }}>
                        Recording a new head coach at <strong>{s.name}</strong>. Outgoing: {[coachChangeFrom.hc_first_name, coachChangeFrom.hc_last_name].filter(Boolean).join(" ") || "no name on file"}
                        {coachChangeFrom.hc_email ? ` · ${coachChangeFrom.hc_email}` : ""}
                        {coachChangeFrom.hc_cell ? ` · ${fmtPhone(coachChangeFrom.hc_cell)}` : ""}. Fields left blank below will be cleared, not carried over.
                      </div>
                    )}

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
                        <div style={{ marginBottom: 8 }}>
                          <button type="button" className="btn btn-sm" disabled={discovering} onClick={() => discoverMaxPreps(s)}>
                            {discovering ? "Searching…" : "Find MaxPreps page"}
                          </button>
                          {discoverError && <div style={{ fontSize: 12, color: "#b3261e", marginTop: 6 }}>{discoverError}</div>}
                          {suggestions.length > 0 && (
                            <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 4 }}>
                              {suggestions.map((sugg) => (
                                <button
                                  type="button"
                                  key={sugg.link}
                                  className="btn btn-sm"
                                  style={{ textAlign: "left", justifyContent: "flex-start", whiteSpace: "normal" }}
                                  onClick={() => pickSuggestion(sugg.link)}
                                >
                                  {sugg.title} — <span style={{ color: "#697386" }}>{sugg.link}</span>
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                        <div style={{ display: "flex", gap: 8 }}>
                          <button className="btn btn-sm btn-gold" disabled={saving === s.id} onClick={() => saveEdit(s)}>
                            {saving === s.id ? "Saving…" : coachChangeFrom?.id === s.id ? "Save Coach Change" : "Save & Mark Verified"}
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
