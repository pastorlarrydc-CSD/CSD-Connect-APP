"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  trimStr,
} from "@/lib/importReconcile";
import { NEEDS_REVIEW_CLEAR_FIELDS } from "@/lib/needsReview";
import { buildSchoolIndex, buildSheetIndex, evaluateGuard, indexAddSchool, indexUpdateSchool, rowKeyFor } from "@/lib/importGuard";

const PAGE_SIZE = 1000;
const BATCH_SIZE = 300;

// Case-insensitive/trimmed match -- same normalization the dead_email_schools
// view uses (lower(trim(...))) to decide whether a school's current hc_email
// still equals its latest hard-bounce address. Mirrors the identical helper
// in app/(app)/schools/[id]/page.js.
function normEmail(v) {
  return (v || "").trim().toLowerCase();
}

// Fields the live AI coach-info lookup (see runAiLookup below) is allowed
// to fill. Deliberately the coach/AD identity fields only -- the same ones
// the school profile page's own "Suggest Coach Info (AI)" button offers --
// not the school-identity fields (city, address, classification, etc.)
// that tool was never meant to guess at.
const AI_LOOKUP_FIELDS = ["hc_first_name", "hc_last_name", "hc_email", "hc_cell", "hc_office", "hc_twitter", "ad_name", "ad_email"];

// Columns the "Open Profile" quick-edit drawer (see SchoolProfileDrawer
// below) fetches fresh whenever it opens -- deliberately DIFF_FIELDS plus
// just enough identity/status context to orient the reviewer (name, state,
// is_closed, verification_status, last_verified_at, needs_review), not
// every column on the schools table. The drawer's whole reason for
// existing is "make quick edits without leaving this screen" -- scoping it
// to exactly the fields this page already diffs against the sheet keeps it
// tightly tied to what's actually being reviewed here, rather than
// reproducing the school profile page's full edit form. Anything outside
// that scope (social handles, "not available" flags, coach radar history)
// is still one click away via the drawer's "Open full profile" link.
const PROFILE_DRAWER_COLUMNS = ["id", "name", "state", "is_closed", "verification_status", "last_verified_at", "needs_review", ...DIFF_FIELDS.map(([f]) => f)].join(",");

// Groups DIFF_FIELDS into the same three sections the school profile page
// itself uses, purely for the drawer's layout -- DIFF_FIELDS stays the
// single source of truth for field names/labels (imported above), this
// just orders them for display.
const PROFILE_FIELD_GROUPS = [
  { title: "School info", fields: ["city", "school_type", "addr1", "addr2", "county", "zip", "classification", "phone", "website", "athletics_url", "maxpreps_url"] },
  { title: "Head coach", fields: ["hc_first_name", "hc_last_name", "hc_email", "hc_cell", "hc_office", "hc_twitter"] },
  { title: "Athletic director", fields: ["ad_name", "ad_email"] },
];

// Tab order -- the buckets that need a human decision come first, the
// read-only/no-action buckets last.
const BUCKET_ORDER = ["needs_verification", "conflict", "new_info", "new_school", "exact_match", "skipped"];

// "How was this sheet verified?" -- picked once per sheet, before it is saved.
// A sheet that somebody actually checked (own research, or sent by the coach/
// school itself) is applied the way this tool always has been: the school is
// marked Verified. A scraped list or AI output that nobody checked is still
// applied (the data is useful), but the school is left Not Verified and put
// on the Needs Review list instead -- so a mass import can no longer stamp
// thousands of schools "Verified" on the strength of a sheet nobody
// confirmed (the 10/5 paste-match problem). The pick is saved on the batch
// (import_batches.source_trust) and added to every change-log source line
// so the Database screen's "How verified" filter can tell them apart.
// A null source_trust (batches saved before this existed) behaves as trusted.
const SOURCE_TRUST_OPTIONS = [
  { value: "own_research", label: "My own research — I checked it", trusted: true, short: "Own research", suffix: " [sheet source: own research]" },
  { value: "coach_submitted", label: "Submitted by the coach or school", trusted: true, short: "Coach-submitted", suffix: " [sheet source: coach-submitted]" },
  { value: "scraped_list", label: "Scraped or third-party list — not independently checked", trusted: false, short: "Scraped list (unchecked)", suffix: " [unchecked sheet: scraped list]" },
  { value: "ai_unchecked", label: "AI-generated or AI-pasted — not independently checked", trusted: false, short: "AI output (unchecked)", suffix: " [unchecked sheet: AI-generated]" },
];

function trustInfo(value) {
  return SOURCE_TRUST_OPTIONS.find((o) => o.value === value) || { value: null, label: "Not recorded (older import)", trusted: true, short: "Not recorded", suffix: "" };
}

const GUARD_RANK = { red: 0, yellow: 1, none: 2 };
const REDBTN = { background: "#b3261e", borderColor: "#b3261e", color: "#fff" };

// Traffic-light tag on every pending row in the three tabs that write to the
// database. GREEN = nothing at all to look at (safe to apply -- exactly the
// rows "Apply all safe" takes). YELLOW = fine to apply, but a human should
// glance first (replaces a value on file, clears fields, guessed email,
// duplicate row, or a "worth a second look" warning). RED = a possible
// mix-up (email/cell already belongs to another coach's school) -- the
// keyboard flow will NOT apply these without Shift+A.
const FLOW_BUCKETS = ["new_info", "conflict", "new_school"];
const TAG_STYLE = {
  green: { label: "Safe", color: "#1e7145", bg: "#e6f4ec", border: "#b9dfc8", dot: "#2e9e5b" },
  yellow: { label: "Check", color: "#7a5a00", bg: "#fff8e5", border: "#ecd9a4", dot: "#d9a400" },
  red: { label: "Possible mix-up", color: "#8c1d18", bg: "#fdeceb", border: "#e8b4b0", dot: "#b3261e" },
  checking: { label: "Checking…", color: "#697386", bg: "#f1f3f6", border: "#d9dde4", dot: "#9aa3b2" },
};

// How many live AI lookups run at once in "Run AI on N rows". Each one is a
// real web-search + Anthropic call (up to ~20s), so a small pool -- not all
// of them at once -- keeps it fast without hammering the API.
const AI_LOOKUP_CONCURRENCY = 4;

const CHANGE_FILTERS = [
  ["all", "Any change"],
  ["coach", "Coach name changing"],
  ["email", "Email"],
  ["phone", "Phone / cell / office"],
];

function rowState(row) {
  return String(row?.mapped_data?.state || "").trim().toUpperCase();
}

function rowMatchesFilters(row, stateFilter, changeFilter) {
  if (stateFilter !== "all" && rowState(row) !== stateFilter) return false;
  if (changeFilter === "all") return true;
  const fields = new Set(((row.diff && row.diff.length ? row.diff.map((f) => f.field) : null) || ["hc_first_name", "hc_last_name", "hc_email", "hc_cell", "hc_office"].filter((f) => row.mapped_data?.[f])));
  if (changeFilter === "coach") return fields.has("hc_first_name") || fields.has("hc_last_name");
  if (changeFilter === "email") return fields.has("hc_email");
  if (changeFilter === "phone") return fields.has("hc_cell") || fields.has("hc_office");
  return true;
}

function rowTag(row, guard, indexReady) {
  if (!row || row.resolution !== "pending" || !FLOW_BUCKETS.includes(row.bucket)) return null;
  if (!indexReady) return { level: "checking", reasons: ["The mix-up safety check is still loading"] };
  const reasons = [];
  (guard?.items || []).forEach((it) => reasons.push(it.text));
  if (guard?.level === "red") return { level: "red", reasons };
  const diff = row.diff || [];
  if (diff.some((f) => f.kind === "clear")) reasons.push("The coach is changing -- some fields would be cleared");
  if (diff.some((f) => f.kind === "overwrite")) reasons.push("Replaces a value already on file");
  if (diff.some((f) => f.source === "ai" && f.estimated)) reasons.push("Includes a guessed (not confirmed) email");
  if (row.duplicate_in_file) reasons.push("Another row in this file has the same school");
  if (guard?.level === "yellow" || reasons.length) return { level: "yellow", reasons };
  return { level: "green", reasons: [] };
}

const SCHOOL_SELECT_COLUMNS = [
  "id",
  "name",
  "state",
  "is_closed",
  ...DIFF_FIELDS.map(([f]) => f),
].join(",");

// Larry asked for this page to "stay open" across a navigation away and
// back -- the review screen on an opened batch was resetting to the batch
// list on every same-tab remount, and worse, an AI-parsed preview that
// hadn't been saved yet (see handlePasteParse) was lost outright, with no
// way to recover it short of re-pasting and re-parsing. Same session-scoped
// "where was I" caching Data Quality already uses (SCAN_CACHE_KEY,
// QUICKFIX_CACHE_KEY, etc.) -- see the two effects below for how it's read
// and written, and readImportReconcileCache's comment for the restore
// approach.
const IMPORT_RECONCILE_CACHE_KEY = "csd_import_reconcile_cache_v1";

// Reads IMPORT_RECONCILE_CACHE_KEY synchronously, for use as a useState
// lazy initializer for `preview`/`fileName` below -- the uncommitted-preview
// half of this cache needs no network call to restore, so it's read the
// same race-free way Data Quality's PAGE_TAB_CACHE_KEY is (see that
// constant's own comment for why an effect-based restore of state a write
// effect also touches on mount is the wrong approach). `selectedBatch`
// can't be restored this way -- reopening a saved batch needs a fetch --
// so that half is restored via a plain mount effect further down instead,
// the same way Data Quality's SCAN_CACHE_KEY restores its own bigger,
// already-local `result` object.
function readImportReconcileCache() {
  try {
    const raw = sessionStorage.getItem(IMPORT_RECONCILE_CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

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

  // Upload/preview (before anything is saved to the database). fileName and
  // preview are lazy-initialized from IMPORT_RECONCILE_CACHE_KEY (see that
  // constant's comment) so an uncommitted AI-parsed or CSV preview survives
  // a same-tab remount instead of being lost with no way to recover it.
  const [fileName, setFileName] = useState(() => readImportReconcileCache()?.fileName || "");
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const [preview, setPreview] = useState(() => readImportReconcileCache()?.preview || null); // { rows, columnMapping, summary }
  const [committing, setCommitting] = useState(false);
  const [commitError, setCommitError] = useState("");
  // "How was this sheet verified?" -- empty until the reviewer picks one;
  // Save & Start Reviewing stays disabled until then (see SOURCE_TRUST_OPTIONS).
  const [sourceTrust, setSourceTrust] = useState("");

  // Cross-school safety check (lib/importGuard.js): an index of every school
  // on file, loaded in the background when a batch opens. A ref (mutated in
  // place after each apply so the next row sees it) plus a version counter
  // to tell React when to recompute the warnings.
  const schoolIndexRef = useRef(null);
  const [indexVersion, setIndexVersion] = useState(0);
  const [indexLoading, setIndexLoading] = useState(false);
  const [indexError, setIndexError] = useState("");

  // "Paste research text (AI-parsed)" -- an alternative to Step 2's CSV
  // upload, not a separate tool. See handlePasteParse below: it produces
  // the exact same `preview` shape handleFileChange does, so everything
  // from here down (the preview card, commitBatch, and the whole review
  // screen) is unmodified and shared between both entry points.
  const [pasteText, setPasteText] = useState("");
  const [parsingPaste, setParsingPaste] = useState(false);
  const [pasteError, setPasteError] = useState("");

  // Review screen (an opened, already-saved batch).
  const [selectedBatch, setSelectedBatch] = useState(null);
  const [rows, setRows] = useState([]);
  const [loadingRows, setLoadingRows] = useState(false);
  const [activeBucket, setActiveBucket] = useState("needs_verification");
  const [rowBusy, setRowBusy] = useState({}); // { [rowId]: true } while an action is in flight
  const [rowError, setRowError] = useState({}); // { [rowId]: message }
  const [bulkBusy, setBulkBusy] = useState(false);
  // Undo (whole batch): armed = the "are you sure" step is showing.
  const [undoBusy, setUndoBusy] = useState(false);
  const [undoArmed, setUndoArmed] = useState(false);
  const [undoNote, setUndoNote] = useState(null); // { kind: "info" | "danger", text }
  const [bulkStatus, setBulkStatus] = useState("");
  const [bulkError, setBulkError] = useState("");
  const [conflictSelections, setConflictSelections] = useState({}); // { [rowId]: { [field]: bool } }
  const [aiNote, setAiNote] = useState({}); // { [rowId]: "AI added 2 suggested fields..." } -- set by runAiLookup, cleared per-row on its next run

  // One-at-a-time keyboard review ("flow mode") + traffic-light filter.
  const [flowOn, setFlowOn] = useState(false);
  const [flowCursor, setFlowCursor] = useState(0);
  const [flowHint, setFlowHint] = useState("");
  const [tagFilter, setTagFilter] = useState("all"); // all | green | yellow | red
  const [stateFilter, setStateFilter] = useState("all"); // all | two-letter state
  const [changeFilter, setChangeFilter] = useState("all"); // all | coach | email | phone
  const [aiBulkRunning, setAiBulkRunning] = useState(false);
  const aiStopRef = useRef(false);
  const flowHandlersRef = useRef(null);
  const flowCardRef = useRef(null);
  const flowInFlightRef = useRef(null); // row id of a keyboard action still running -- stops a double-tap applying twice

  // "Open Profile" quick-edit drawer -- see openProfile/saveProfileEdit
  // below. profileDrawer holds which row/school it's open for; null means
  // closed. Kept as plain component state, not sessionStorage-cached like
  // the rest of this page's "where was I" state -- it's meant to be a
  // quick in-and-out edit, not something that needs to survive a
  // navigation away and back the way an open batch or an uncommitted
  // preview does.
  const [profileDrawer, setProfileDrawer] = useState(null); // { rowId, schoolId }
  const [profileSchool, setProfileSchool] = useState(null); // last-fetched/last-saved school row
  const [profileValues, setProfileValues] = useState({}); // draft edits, keyed by DIFF_FIELDS field names
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileJustSaved, setProfileJustSaved] = useState(false);
  const [profileError, setProfileError] = useState("");
  const [profileAiBusy, setProfileAiBusy] = useState(false);
  const [profileAiNote, setProfileAiNote] = useState("");

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

  // Restores an open review screen on mount -- the other half of
  // IMPORT_RECONCILE_CACHE_KEY, the one that needs a fetch (openBatch) so it
  // can't be a plain useState lazy initializer the way fileName/preview
  // above are. Only acts when there's no cached preview to restore instead
  // (a preview always means the batch below it hasn't been saved yet, so it
  // takes priority -- see the write effect's own priority for why the two
  // never really coexist in practice). openBatch always picks its own
  // "first bucket with pending work" default for activeBucket, so the
  // cached bucket -- if it's still a real tab -- is applied right after,
  // overriding that default with wherever Larry actually was.
  useEffect(() => {
    const cached = readImportReconcileCache();
    if (!cached?.selectedBatchId || cached.preview) return;
    openBatch(cached.selectedBatchId).then(() => {
      if (cached.activeBucket && BUCKET_ORDER.includes(cached.activeBucket)) setActiveBucket(cached.activeBucket);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keeps IMPORT_RECONCILE_CACHE_KEY in sync with whichever half of the page
  // is actually live. Guards on "nothing to restore yet" (mirroring Data
  // Quality's SCAN_CACHE_KEY write effect) rather than firing unconditionally
  // on every render: on the very first mount, before the restore effect
  // above has had a chance to run its async openBatch fetch, selectedBatch
  // is still null here -- if preview is ALSO empty (nothing was cached for
  // it either), writing now would clobber a cached selectedBatchId before
  // it's ever read back. Once either half becomes real (a fresh preview, an
  // opened batch, or the restore completing), this fires normally.
  useEffect(() => {
    if (!preview && !selectedBatch) return;
    try {
      sessionStorage.setItem(
        IMPORT_RECONCILE_CACHE_KEY,
        JSON.stringify({
          // Only one half is ever meaningful at a time -- the landing
          // screen's uncommitted preview, or an opened batch's review
          // screen -- so the other is always nulled out here rather than
          // left stale from whichever came before it.
          preview: selectedBatch ? null : preview,
          fileName: selectedBatch ? null : fileName,
          selectedBatchId: selectedBatch?.id ?? null,
          activeBucket: selectedBatch ? activeBucket : null,
        })
      );
    } catch {
      // Storage full/unavailable -- this tab just won't survive a
      // navigation away and back. Not worth surfacing an error for.
    }
  }, [preview, selectedBatch, fileName, activeBucket]);

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
    setSourceTrust("");
    if (fileInputRef.current) fileInputRef.current.value = "";
    // Explicit clear rather than waiting for the write effect to catch up --
    // starting a fresh upload/paste (or successfully committing one, which
    // also calls this) means whatever was cached before is done with, so
    // there's nothing to protect a stale copy of.
    try {
      sessionStorage.removeItem(IMPORT_RECONCILE_CACHE_KEY);
    } catch {
      // Storage unavailable -- nothing to clean up.
    }
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

  // Alternative to handleFileChange above: instead of a CSV, a reviewer
  // pastes free-text research (their own -- see lib/bulkPasteParse.js's
  // system prompt, which explicitly never searches or verifies, only
  // structures). The AI-parse API route returns rows already in canonical
  // field form, so from here it's the SAME matching pass handleFileChange
  // runs -- same fetchAllSchools/existingByKey construction, same
  // categorizeRow() call, same duplicate_in_file check -- just skipping the
  // CSV-header-mapping step, which doesn't apply here. That's deliberate:
  // a pasted school gets the identical same-name-school ambiguity handling
  // and conflict-vs-new-info bucketing a CSV row gets, with no separate
  // backstop logic needed in this function.
  async function handlePasteParse() {
    const text = pasteText.trim();
    if (!text) {
      setPasteError("Paste some research text first.");
      return;
    }
    resetUpload();
    setParsingPaste(true);
    setPasteError("");
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const res = await fetch("/api/admin/bulk-parse", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token}` },
        body: JSON.stringify({ text }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Could not parse this text.");
      const parsedSchools = json.schools || [];
      if (!parsedSchools.length) throw new Error("Didn't find any school with both a name and a state in that text.");

      const schools = await fetchAllSchools();
      const existingById = new Map(schools.map((s) => [String(s.id), s]));
      const existingByKey = new Map();
      schools.forEach((s) => {
        const key = matchKey(s.name, s.state);
        if (!existingByKey.has(key)) existingByKey.set(key, []);
        existingByKey.get(key).push(s);
      });

      const seenInFile = new Map();
      const built = parsedSchools.map((s, i) => {
        const { source_excerpt, notes, ...mapped } = s;
        const result = categorizeRow(mapped, { existingById, existingByKey });

        let duplicateInFile = false;
        if (result.bucket === "new_school" && mapped.name && mapped.state) {
          const key = matchKey(mapped.name, mapped.state);
          if (seenInFile.has(key)) duplicateInFile = true;
          seenInFile.set(key, true);
        }

        return {
          row_index: i + 1,
          label: mapped.name || `School ${i + 1}`,
          raw_row: s, // kept whole (including source_excerpt/notes) for the audit trail and for RowCard's "AI parsing note" display below
          mapped_data: mapped,
          ...result,
          duplicate_in_file: duplicateInFile,
        };
      });

      const summary = {};
      BUCKET_ORDER.forEach((b) => {
        summary[b] = built.filter((r) => r.bucket === b).length;
      });

      setFileName(`Pasted research (AI-parsed) — ${new Date().toLocaleString()}`);
      setPreview({ rows: built, columnMapping: { _source: "ai_paste_parse" }, summary });
    } catch (err) {
      setPasteError(err.message || "Could not parse this text.");
    } finally {
      setParsingPaste(false);
    }
  }

  async function commitBatch() {
    if (!preview) return;
    if (!sourceTrust) {
      setCommitError("Pick how this sheet was verified first.");
      return;
    }
    setCommitting(true);
    setCommitError("");
    try {
      const { data: batchRow, error: batchErr } = await supabase
        .from("import_batches")
        .insert({ file_name: fileName, status: "reviewing", column_mapping: preview.columnMapping, row_count: preview.rows.length, uploaded_by: user.id, source_trust: sourceTrust })
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
    // Safety-check index -- loaded in the background so the batch itself
    // opens right away; until it finishes, "Apply all" buttons wait.
    schoolIndexRef.current = null;
    setIndexError("");
    setIndexLoading(true);
    fetchAllSchools()
      .then((list) => {
        schoolIndexRef.current = buildSchoolIndex(list);
        setIndexVersion((v) => v + 1);
      })
      .catch((err) => setIndexError(err.message || "Could not load the school list for the safety check."))
      .finally(() => setIndexLoading(false));
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
    setFlowOn(false);
    setFlowHint("");
    setTagFilter("all");
    setStateFilter("all");
    setChangeFilter("all");
    loadBatches();
    // Explicit clear -- clicking "Back to Import & Reconcile" is a
    // deliberate "I'm done with this batch for now" action, so a later
    // navigation away and back should land on the plain batch list, not
    // silently reopen the batch Larry just chose to leave.
    try {
      sessionStorage.removeItem(IMPORT_RECONCILE_CACHE_KEY);
    } catch {
      // Storage unavailable -- nothing to clean up.
    }
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

  // Dead Email Recovery tie-in, same semantics as the school profile page's
  // findConfirmableBounce/stampBounceConfirmed (app/(app)/schools/[id]/
  // page.js) -- Larry asked for Import & Reconcile to close the same loop:
  // a row reviewed and applied/saved here, for a school that's currently
  // sitting in Dead Email Recovery (dead_email_schools view -- current
  // hc_email still matches its latest hard bounce), should record that a
  // human looked at it. If the email ending up on file is a genuinely new
  // address, nothing extra is needed -- the view already drops that school
  // on its own the moment hc_email no longer matches the bounce, and the
  // ordinary school_change_log entry already documents the fix. If the
  // email ending up on file is STILL the bounced one (reviewed and
  // confirmed, not changed), this stamps manually_confirmed_at/by so Dead
  // Email Recovery shows it as checked instead of leaving it looking
  // never-touched. oldHcEmail/newHcEmail must both be the live, current
  // on-file value as of right before the write -- this tool's `row.diff`
  // only carries fields that differ from the sheet, so a fresh read is
  // needed to know the current value for a field that ISN'T in the diff.
  async function findConfirmableBounce(schoolId, oldHcEmail, newHcEmail) {
    try {
      const { data: latestBounce } = await supabase
        .from("email_bounce_events")
        .select("id, bounced_email")
        .eq("school_id", schoolId)
        .eq("email_field", "hc_email")
        .order("detected_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (latestBounce && normEmail(latestBounce.bounced_email) === normEmail(oldHcEmail) && normEmail(newHcEmail) === normEmail(latestBounce.bounced_email)) {
        return latestBounce;
      }
      return null;
    } catch (err) {
      console.error("Could not check email_bounce_events for Dead Email Recovery tie-in", err);
      return null;
    }
  }

  async function stampBounceConfirmed(bounceRow, nowIso) {
    if (!bounceRow) return;
    const { error } = await supabase
      .from("email_bounce_events")
      .update({ manually_confirmed_at: nowIso, manually_confirmed_by: user.id })
      .eq("id", bounceRow.id);
    if (error) console.error("Could not stamp manually_confirmed_at/by on the bounce event", error);
  }

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
      //
      // coach_radar_reviewed_at -- same "a human just confirmed this coach
      // info" signal as the school profile page's Quick Fix save and Mark
      // Verified button (app/(app)/schools/[id]/page.js), which both set
      // this too. Without it, a row applied here (whether from an
      // uploaded CSV or a Bulk Paste & Parse paste -- someone's own
      // already-done research, reviewed field-by-field before Apply) was
      // still fair game for tonight's Coach-Change Radar sweep, which
      // checks the school's OWN WEBSITE, not this database -- so a school
      // whose site genuinely doesn't list the coach by name would get
      // flagged again as "not found" the very next run, even though the
      // data just applied here is accurate. Setting it here excludes the
      // school from that sweep for COACH_RADAR_REVIEW_EXCLUSION_MONTHS,
      // exactly like every other manual-verification path already does.
      //
      // Sheet-trust (see SOURCE_TRUST_OPTIONS): a sheet nobody checked still
      // gets its data applied, but the school is NOT marked Verified -- it is
      // left Not Verified and put on the Needs Review list, with no
      // last_verified_at / coach_radar_reviewed_at stamp, so it can't pass
      // for a confirmed record. It also doesn't resolve Data Quality flags or
      // confirm a bounced email below, since nobody actually confirmed
      // anything.
      const trust = trustInfo(selectedBatch?.source_trust);
      const update = trust.trusted
        ? { verification_status: "verified", last_verified_at: now, coach_radar_reviewed_at: now, ...NEEDS_REVIEW_CLEAR_FIELDS }
        : {
            verification_status: "not_verified",
            needs_review: true,
            needs_review_note: `Applied from an unchecked sheet (${trust.short}) on ${now.slice(0, 10)} - confirm before trusting.`,
            needs_review_marked_at: now,
            needs_review_marked_by: user.id,
          };
      const logs = [];
      fieldsToApply.forEach((f) => {
        update[f.field] = f.new;
        const isCoachName = f.field === "hc_first_name" || f.field === "hc_last_name";
        logs.push({
          school_id: row.match_school_id,
          field_name: f.field,
          old_value: f.old || null,
          new_value: f.new,
          source:
            (f.kind === "clear"
              ? "Import & Reconcile (cleared -- stale contact left by a departed coach)"
              : isCoachName
              ? "Head coach change (manual)"
              : "Import & Reconcile (CSV)") + trust.suffix,
          changed_by: user.id,
        });
      });

      // Dead Email Recovery tie-in -- see findConfirmableBounce above. A
      // fresh read of the live hc_email, since row.diff only carries fields
      // that differ from the sheet -- if hc_email isn't in fieldsToApply,
      // it's unchanged, and we need the real current value (not a possibly
      // stale one from whenever this row was first categorized) to know
      // whether it still matches the bounce.
      const hcEmailChange = fieldsToApply.find((f) => f.field === "hc_email");
      let bounceConfirm = null;
      if (!trust.trusted) {
        // Unchecked sheet -- nobody confirmed this address, so don't stamp
        // the bounce as manually confirmed.
      } else if (hcEmailChange) {
        bounceConfirm = await findConfirmableBounce(row.match_school_id, hcEmailChange.old || null, hcEmailChange.new);
      } else {
        const { data: currentRow } = await supabase.from("schools").select("hc_email").eq("id", row.match_school_id).maybeSingle();
        const currentHcEmail = currentRow?.hc_email || null;
        bounceConfirm = await findConfirmableBounce(row.match_school_id, currentHcEmail, currentHcEmail);
        if (bounceConfirm) {
          logs.push({
            school_id: row.match_school_id,
            field_name: "hc_email",
            old_value: currentHcEmail,
            new_value: currentHcEmail,
            source: `Import & Reconcile (CSV) -- confirmed same address, no better option found (Claude, ${now.slice(0, 10)})${trust.suffix}`,
            changed_by: user.id,
          });
        }
      }

      // Undo snapshot: what these columns held a moment ago (and which
      // Data Quality flags are about to be resolved), saved on the row so the
      // whole batch can be put back later. Best-effort -- a row without one
      // can still be undone from the change log (see undoAppliedRow).
      let undoSnapshot = null;
      try {
        const cols = Object.keys(update);
        const { data: beforeRow } = await supabase.from("schools").select(cols.join(",")).eq("id", row.match_school_id).maybeSingle();
        let flagIds = [];
        if (trust.trusted) {
          const { data: pendingFlags } = await supabase.from("school_flags").select("id").eq("school_id", row.match_school_id).eq("status", "pending");
          flagIds = (pendingFlags || []).map((x) => x.id);
        }
        if (beforeRow) {
          undoSnapshot = { v: 1, fields: fieldsToApply.map((f) => f.field), before: beforeRow, wrote: Object.fromEntries(cols.map((c) => [c, update[c]])), flags: flagIds };
        }
      } catch (_) {
        undoSnapshot = null;
      }

      const { error: updErr } = await supabase.from("schools").update(update).eq("id", row.match_school_id);
      if (updErr) throw updErr;
      if (logs.length) {
        const { error: logErr } = await supabase.from("school_change_log").insert(logs);
        if (logErr) throw logErr;
      }
      await stampBounceConfirmed(bounceConfirm, now);

      // Also clear any pending "possibly outdated" flags on this school
      // (school_flags -- the automated Coach-Change Radar / coach-submitted
      // queue that drives Data Quality's "Flagged as Possibly Outdated" list
      // and Today's List). Every other "a human just fixed this" path
      // already does this (saveEdit/markVerified/bulk-verify in
      // data-quality/page.js) -- this was the one apply path in the app that
      // didn't, which is why a school fixed here kept reappearing on Today's
      // List forever even after a refresh: the flag itself was never
      // resolved in the database.
      //
      // This call used to be fire-and-forget: if it failed for any reason
      // (an expired/refreshing auth token, a dropped connection, a race
      // from clicking Apply twice), the error was silently swallowed --
      // the row above still got marked "applied" with no sign anything
      // was wrong, so the flag could stay 'pending' forever with nobody
      // finding out until it turned up stuck on Today's List (Eastern
      // Hancock HS, Eastlake HS). Now we check the result, retry once,
      // and if it still didn't take, say so on the row instead of quietly
      // pretending it worked.
      let flagWarning = null;
      for (let attempt = 0; trust.trusted && attempt < 2; attempt++) {
        const { error: flagErr } = await supabase
          .from("school_flags")
          .update({ status: "resolved", resolved_by: user.id, resolved_at: now })
          .eq("school_id", row.match_school_id)
          .eq("status", "pending");
        if (!flagErr) {
          flagWarning = null;
          break;
        }
        flagWarning = flagErr.message || "Could not clear this school's Data Quality flag.";
        if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 600));
      }

      const { error: rowErr } = await supabase.from("import_batch_rows").update({ resolution: "applied", resolved_at: now, resolved_by: user.id, undo_snapshot: undoSnapshot }).eq("id", row.id);
      if (rowErr) throw rowErr;

      patchRow(row.id, { resolution: "applied", resolved_at: now, resolved_by: user.id, undo_snapshot: undoSnapshot });
      // Keep the safety-check index current so the NEXT row sees that this
      // school now owns these values.
      if (schoolIndexRef.current) {
        indexUpdateSchool(schoolIndexRef.current, row.match_school_id, update);
        setIndexVersion((v) => v + 1);
      }
      if (flagWarning) {
        setRowError((p) => ({
          ...p,
          [row.id]: `Saved -- but couldn't clear its Data Quality flag (${flagWarning}). It may still show on Today's List; open Data Quality and resolve it there.`,
        }));
      }
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

  // ---- Undo ---------------------------------------------------------------

  const undoNorm = (v) => String(v == null ? "" : v).trim();

  // Puts ONE applied row's school back the way it was before the apply.
  // Safe by design: a school that someone has edited since is left alone
  // (reported, not overwritten), and every restore is logged in
  // school_change_log. Returns { status: "restored" | "changed_since" |
  // "cannot" | "error", note }.
  async function undoAppliedRow(row) {
    try {
      if (row.resolution !== "applied" || !row.match_school_id) return { status: "cannot", note: "This row isn't applied." };
      if (row.bucket === "new_school") {
        return { status: "cannot", note: "This row added a brand-new school. Undo doesn't remove schools -- if it was a mistake, fix or close it on the school's own page." };
      }
      const schoolId = row.match_school_id;
      const snap = row.undo_snapshot && row.undo_snapshot.before && row.undo_snapshot.wrote ? row.undo_snapshot : null;
      let restore = {};
      let undoLogs = [];
      let limited = false;

      if (snap) {
        const fields = snap.fields || [];
        const { data: cur, error: curErr } = await supabase.from("schools").select(fields.join(",") || "id").eq("id", schoolId).maybeSingle();
        if (curErr || !cur) throw curErr || new Error("School not found.");
        const moved = fields.filter((f) => undoNorm(cur[f]) !== undoNorm(snap.wrote[f]));
        if (moved.length) return { status: "changed_since", note: `Edited since this batch applied (${moved.join(", ")}) -- left as it is now.` };
        restore = { ...snap.before };
        fields.forEach((f) => {
          if (undoNorm(snap.before[f]) !== undoNorm(snap.wrote[f])) {
            undoLogs.push({ school_id: schoolId, field_name: f, old_value: snap.wrote[f] || null, new_value: snap.before[f] || null, source: "Import & Reconcile - batch undo", changed_by: user.id });
          }
        });
      } else {
        // Applied before undo existed: rebuild from the change log. Only the
        // data fields come back -- verification stamps can't be known, so
        // they're left as they are.
        limited = true;
        if (!row.resolved_at) return { status: "cannot", note: "No record of when this row was applied." };
        const t = new Date(row.resolved_at).getTime();
        const { data: logRows, error: logQErr } = await supabase
          .from("school_change_log")
          .select("field_name,old_value,new_value,source,changed_at")
          .eq("school_id", schoolId)
          .eq("changed_by", row.resolved_by)
          .gte("changed_at", new Date(t - 90000).toISOString())
          .lte("changed_at", new Date(t + 90000).toISOString())
          .order("changed_at", { ascending: true });
        if (logQErr) throw logQErr;
        const mine = (logRows || []).filter((l) => /Import & Reconcile/.test(l.source || "") || /^Head coach change \(manual\)/.test(l.source || ""));
        const byField = new Map();
        mine.forEach((l) => {
          if (undoNorm(l.old_value) === undoNorm(l.new_value)) return; // a "confirmed same" entry, nothing to undo
          const e = byField.get(l.field_name);
          if (!e) byField.set(l.field_name, { first: l.old_value, last: l.new_value });
          else e.last = l.new_value;
        });
        if (!byField.size) return { status: "cannot", note: "No saved record of what this row changed, so it can't be undone." };
        const fields = [...byField.keys()];
        const { data: cur, error: curErr } = await supabase.from("schools").select(fields.join(",")).eq("id", schoolId).maybeSingle();
        if (curErr || !cur) throw curErr || new Error("School not found.");
        const moved = fields.filter((f) => undoNorm(cur[f]) !== undoNorm(byField.get(f).last));
        if (moved.length) return { status: "changed_since", note: `Edited since this batch applied (${moved.join(", ")}) -- left as it is now.` };
        fields.forEach((f) => {
          const e = byField.get(f);
          restore[f] = e.first == null || e.first === "" ? null : e.first;
          undoLogs.push({ school_id: schoolId, field_name: f, old_value: e.last || null, new_value: e.first || null, source: "Import & Reconcile - batch undo (from change log)", changed_by: user.id });
        });
      }

      const { error: updErr } = await supabase.from("schools").update(restore).eq("id", schoolId);
      if (updErr) throw updErr;
      if (undoLogs.length) {
        const { error: logErr } = await supabase.from("school_change_log").insert(undoLogs);
        if (logErr) throw logErr;
      }
      // Re-open the Data Quality flags this apply resolved (best effort).
      if (snap && Array.isArray(snap.flags) && snap.flags.length) {
        const { error: flagErr } = await supabase.from("school_flags").update({ status: "pending", resolved_by: null, resolved_at: null }).in("id", snap.flags).eq("status", "resolved");
        if (flagErr) console.error("Could not re-open flags during undo", flagErr);
      }
      const { error: rowErr } = await supabase.from("import_batch_rows").update({ resolution: "pending", resolved_at: null, resolved_by: null, undo_snapshot: null }).eq("id", row.id);
      if (rowErr) throw rowErr;
      patchRow(row.id, { resolution: "pending", resolved_at: null, resolved_by: null, undo_snapshot: null });
      if (schoolIndexRef.current) {
        indexUpdateSchool(schoolIndexRef.current, schoolId, restore);
        setIndexVersion((v) => v + 1);
      }
      return { status: "restored", note: limited ? "Restored from the change log (verification stamps left as they are)." : "Restored." };
    } catch (err) {
      return { status: "error", note: err.message || "Could not undo this row." };
    }
  }

  async function undoOneRow(row) {
    setRowBusy((p) => ({ ...p, [row.id]: true }));
    setRowError((p) => ({ ...p, [row.id]: null }));
    const result = await undoAppliedRow(row);
    if (result.status !== "restored") setRowError((p) => ({ ...p, [row.id]: result.note }));
    setRowBusy((p) => ({ ...p, [row.id]: false }));
  }

  async function undoWholeBatch() {
    const targets = rows.filter((r) => r.resolution === "applied" && r.bucket !== "new_school" && r.match_school_id);
    if (!targets.length) return;
    setUndoBusy(true);
    setUndoArmed(false);
    setUndoNote(null);
    const tally = { restored: 0, changed_since: 0, cannot: 0, error: 0 };
    let next = 0;
    async function worker() {
      while (next < targets.length) {
        const row = targets[next++];
        // eslint-disable-next-line no-await-in-loop
        const r = await undoAppliedRow(row);
        tally[r.status] = (tally[r.status] || 0) + 1;
        if (r.status !== "restored") setRowError((p) => ({ ...p, [row.id]: r.note }));
        setUndoNote({ kind: "info", text: `Undoing… ${tally.restored + tally.changed_since + tally.cannot + tally.error} of ${targets.length}` });
      }
    }
    await Promise.all([worker(), worker(), worker()]);
    const bits = [`${tally.restored} put back`];
    if (tally.changed_since) bits.push(`${tally.changed_since} left alone because someone edited them since`);
    if (tally.cannot) bits.push(`${tally.cannot} couldn't be undone`);
    if (tally.error) bits.push(`${tally.error} failed`);
    setUndoNote({ kind: tally.error || tally.cannot ? "danger" : "info", text: `Undo finished: ${bits.join(", ")}. Restored rows are back to Pending so you can review them again. Rows that added a new school are never undone here.` });
    setUndoBusy(false);
  }

  // "Apply all" only touches rows with NO safety warning -- a row whose email
  // or cell already belongs to another school (red) or that has anything
  // worth a second look (yellow) stays pending for a one-by-one decision.
  // Waits for the school list to finish loading first: without it there is
  // nothing to check against, and "safe" would just be a guess.
  function safeRowsOf(bucket) {
    return rows.filter((r) => r.bucket === bucket && r.resolution === "pending" && (guards[r.id]?.level || "none") === "none");
  }

  async function applyAllNewInfo() {
    if (!schoolIndexRef.current) {
      setBulkError("Still loading the school list for the safety check — try again in a few seconds.");
      return;
    }
    const pending = safeRowsOf("new_info");
    if (!pending.length) return;
    setBulkError("");
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
      // "fill" (nothing on file yet) and "clear" (see buildDiff in
      // lib/importReconcile.js -- a stale personal cell left over from a
      // departed coach) both default to checked. An "overwrite" of a
      // field that already had a different value still needs a human to
      // actively opt in, same as always.
      initial[f.field] = f.kind === "fill" || f.kind === "clear";
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

  // ---- AI Coach Info lookup (live, per-row) ------------------------------
  //
  // Larry's ask: when a pasted/uploaded row comes up short on coach info
  // (most often the email -- see e.g. a row whose sheet only offered a
  // guessed "district profile template" address, which the parser
  // correctly left out of the diff table entirely rather than show it as
  // real), he had to leave this review screen, open that school's profile
  // page, and click its own "Suggest Coach Info (AI)" button one school at
  // a time. This calls that EXACT SAME live route
  // (/api/schools/[id]/discover-coach-info -- one web-search-backed
  // Anthropic call, no DB write of its own) straight from the row's card
  // here, so working a batch never means leaving this screen.
  //
  // Deliberately conservative about what it's allowed to touch: a field
  // only gets an AI-sourced diff row when NEITHER the sheet nor what's
  // currently on file has anything there (oldVal blank AND no existing
  // diff entry for that field already) -- it only fills genuine gaps, it
  // never second-guesses a value the sheet or the database already
  // supplies. The school's CURRENT row is fetched fresh here (not
  // whatever was cached when this batch was originally parsed, which
  // could be stale by now) so "oldVal blank" reflects reality today.
  //
  // Added fields are tagged { source: "ai" } (row.diff is a plain jsonb
  // array, so this rides along harmlessly for entries buildDiff() itself
  // produces, which never set it) purely so RowCard can badge them
  // differently from what the sheet itself supplied.
  async function runAiLookup(row) {
    if (!row.match_school_id) return;
    setRowBusy((p) => ({ ...p, [row.id]: true }));
    setRowError((p) => ({ ...p, [row.id]: null }));
    setAiNote((p) => ({ ...p, [row.id]: null }));
    try {
      const [schoolRes, sessionRes] = await Promise.all([
        supabase.from("schools").select(SCHOOL_SELECT_COLUMNS).eq("id", row.match_school_id).single(),
        supabase.auth.getSession(),
      ]);
      if (schoolRes.error) throw schoolRes.error;
      const school = schoolRes.data;

      const res = await fetch(`/api/schools/${row.match_school_id}/discover-coach-info`, {
        method: "POST",
        headers: { Authorization: `Bearer ${sessionRes.data?.session?.access_token}` },
      });
      const suggestion = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(suggestion.error || "AI lookup didn't return a result for this school.");

      const existingFields = new Set((row.diff || []).map((f) => f.field));
      const added = [];
      AI_LOOKUP_FIELDS.forEach((field) => {
        if (existingFields.has(field)) return; // sheet (or an earlier AI run) already covers this field
        if (trimStr(school[field])) return; // already on file -- not a gap
        const suggested = trimStr(suggestion[field]);
        if (!suggested) return; // AI didn't find anything for this field either
        const label = (DIFF_FIELDS.find(([f]) => f === field) || [])[1] || field;
        // hc_email_estimated -- the model flagged this as a GUESSED pattern
        // (first.last@domain) rather than an email it actually saw written
        // down somewhere, the exact same "likely district profile template"
        // problem Larry's own screenshot showed the sheet parser already
        // declining to surface as real. Worth adding here still (it's a
        // starting point better than nothing), but tagged so the row makes
        // clear it's a guess, not a confirmed address, same distinction
        // normalizeSuggestion already downgrades confidence for.
        const estimated = field === "hc_email" && suggestion.hc_email_estimated === true;
        added.push({ field, label, old: "", new: suggested, kind: "fill", source: "ai", confidence: suggestion.confidence, estimated });
      });

      if (!added.length) {
        setAiNote((p) => ({ ...p, [row.id]: `AI lookup ran but didn't find anything new here${suggestion.confidence ? ` (confidence: ${suggestion.confidence})` : ""}.` }));
        return;
      }

      const newDiff = [...(row.diff || []), ...added];
      const { error: rowErr } = await supabase.from("import_batch_rows").update({ diff: newDiff }).eq("id", row.id);
      if (rowErr) throw rowErr;
      patchRow(row.id, { diff: newDiff });

      // Conflict-bucket rows are checkbox-gated (getSelection/toggleField) --
      // auto-check the fields AI just added so "Apply selected" picks them
      // up immediately, same as every other "fill" field already defaults
      // to checked. new_info-bucket rows have no checkboxes at all
      // (onApplyNewInfo applies the whole diff unconditionally), so nothing
      // extra is needed there.
      if (row.bucket === "conflict") {
        const current = conflictSelections[row.id] || getSelection(row);
        const nextSelection = { ...current };
        added.forEach((f) => {
          nextSelection[f.field] = true;
        });
        setConflictSelections((prev) => ({ ...prev, [row.id]: nextSelection }));
      }

      setAiNote((p) => ({
        ...p,
        [row.id]: `AI added ${added.length} suggested field${added.length > 1 ? "s" : ""} — ${added.map((f) => f.label).join(", ")}${
          suggestion.confidence ? ` (confidence: ${suggestion.confidence})` : ""
        }. Review it below, then Apply.`,
      }));
    } catch (err) {
      setRowError((p) => ({ ...p, [row.id]: err.message || "AI lookup failed for this row." }));
    } finally {
      setRowBusy((p) => ({ ...p, [row.id]: false }));
    }
  }

  // Runs runAiLookup across a whole set of rows, a few at a time
  // (AI_LOOKUP_CONCURRENCY). Each lookup is a real web-search + Anthropic
  // call (up to ~20s), so a small pool is ~4x faster than one-by-one
  // without racing dozens of slow requests at once. Every lookup only
  // fills blank fields on its OWN row and writes its OWN row's diff, so
  // running them side by side can't collide. A Stop button lets the pool
  // finish the lookups already running and skip the rest. Shares
  // bulkBusy/bulkStatus with the other bulk actions so two bulk operations
  // can't overlap.
  async function runAiLookupOnRows(targetRows) {
    if (!targetRows.length) return;
    setBulkBusy(true);
    setAiBulkRunning(true);
    aiStopRef.current = false;
    setBulkError("");
    let next = 0;
    let done = 0;
    const total = targetRows.length;
    try {
      setBulkStatus(`Running AI lookups… 0 of ${total} done`);
      const worker = async () => {
        while (!aiStopRef.current) {
          const i = next;
          next += 1;
          if (i >= total) return;
          // eslint-disable-next-line no-await-in-loop
          await runAiLookup(targetRows[i]);
          done += 1;
          setBulkStatus(`Running AI lookups… ${done} of ${total} done`);
        }
      };
      await Promise.all(Array.from({ length: Math.min(AI_LOOKUP_CONCURRENCY, total) }, () => worker()));
      if (aiStopRef.current && done < total) setBulkError(`Stopped after ${done} of ${total} lookups. The rest were left alone -- run it again any time.`);
    } catch (err) {
      setBulkError(err.message || "Something went wrong running AI lookup on these rows.");
    } finally {
      setBulkBusy(false);
      setAiBulkRunning(false);
      setBulkStatus("");
    }
  }

  // ---- "Open Profile" quick-edit drawer ----------------------------------
  //
  // Larry's ask: reviewing a row here that needs a real fix (not just
  // applying/rejecting the sheet's proposed values) meant leaving this
  // screen entirely -- open the school's profile page in another tab,
  // find the right fields, edit, save, then come back and re-find your
  // place in the batch. This opens a slide-over panel right on top of the
  // parsing screen instead: the row list, active tab, and scroll position
  // behind it never move, so "quick edits" really are quick.
  //
  // Deliberately its own small set of functions rather than reusing Data
  // Quality's saveEdit -- that function is entangled with page state this
  // page doesn't have (flaggedQueue, searchResults, coachChangeFrom). Same
  // underlying write semantics though (verified + last_verified_at +
  // coach_radar_reviewed_at + NEEDS_REVIEW_CLEAR_FIELDS + a
  // school_change_log row per changed field + best-effort school_flags
  // resolution), so a fix made here counts the same as any other manual
  // verification everywhere else in the app.
  async function openProfile(row) {
    if (!row.match_school_id) return;
    setProfileDrawer({ rowId: row.id, schoolId: row.match_school_id });
    setProfileSchool(null);
    setProfileValues({});
    setProfileError("");
    setProfileAiNote("");
    setProfileJustSaved(false);
    setProfileLoading(true);
    try {
      const { data, error } = await supabase.from("schools").select(PROFILE_DRAWER_COLUMNS).eq("id", row.match_school_id).single();
      if (error) throw error;
      setProfileSchool(data);
      const initial = {};
      DIFF_FIELDS.forEach(([f]) => {
        initial[f] = data[f] || "";
      });
      setProfileValues(initial);
    } catch (err) {
      setProfileError(err.message || "Could not load this school.");
    } finally {
      setProfileLoading(false);
    }
  }

  function closeProfile() {
    setProfileDrawer(null);
    setProfileSchool(null);
    setProfileValues({});
    setProfileError("");
    setProfileAiNote("");
    setProfileJustSaved(false);
  }

  function updateProfileField(field, value) {
    setProfileValues((prev) => ({ ...prev, [field]: value }));
    setProfileJustSaved(false);
  }

  async function saveProfileEdit() {
    if (!profileDrawer || !profileSchool) return;
    setProfileSaving(true);
    setProfileError("");
    try {
      const now = new Date().toISOString();
      const update = { verification_status: "verified", last_verified_at: now, coach_radar_reviewed_at: now, ...NEEDS_REVIEW_CLEAR_FIELDS };
      const logs = [];
      DIFF_FIELDS.forEach(([field]) => {
        const newVal = trimStr(profileValues[field]) || null;
        const oldVal = profileSchool[field] || null;
        if (newVal !== oldVal) {
          update[field] = newVal;
          logs.push({
            school_id: profileSchool.id,
            field_name: field,
            old_value: oldVal,
            new_value: newVal,
            source: "Import & Reconcile (Quick Edit from parsing screen)",
            changed_by: user.id,
          });
        }
      });

      // Dead Email Recovery tie-in -- see findConfirmableBounce above.
      // profileSchool was fetched fresh when this drawer opened, so its
      // hc_email is the live current value -- safe to use directly, unlike
      // applyRowFields above (which only has row.diff to go on). A school
      // with an open bounce on hc_email, where the value ending up on file
      // is still that bounced address, means this Save is the "I looked and
      // it's still right" case.
      const oldHcEmail = profileSchool.hc_email || null;
      const effectiveNewHcEmail = Object.prototype.hasOwnProperty.call(update, "hc_email") ? update.hc_email : oldHcEmail;
      const bounceConfirm = await findConfirmableBounce(profileSchool.id, oldHcEmail, effectiveNewHcEmail);
      if (bounceConfirm && !Object.prototype.hasOwnProperty.call(update, "hc_email")) {
        logs.push({
          school_id: profileSchool.id,
          field_name: "hc_email",
          old_value: oldHcEmail,
          new_value: oldHcEmail,
          source: `Import & Reconcile (Quick Edit from parsing screen) -- confirmed same address, no better option found (Claude, ${now.slice(0, 10)})`,
          changed_by: user.id,
        });
      }

      if (!logs.length) {
        // Nothing actually changed and there's no bounce to confirm either
        // -- still worth a visible "Saved" so a click on Save isn't
        // silently a no-op, but no point writing an identical row or an
        // empty change-log entry.
        setProfileJustSaved(true);
        return;
      }

      const { error: updErr } = await supabase.from("schools").update(update).eq("id", profileSchool.id);
      if (updErr) throw updErr;
      const { error: logErr } = await supabase.from("school_change_log").insert(logs);
      if (logErr) throw logErr;
      await stampBounceConfirmed(bounceConfirm, now);

      // Same best-effort retry (and same "say so instead of pretending it
      // worked" rule) as applyRowFields above.
      let flagWarning = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        const { error: flagErr } = await supabase
          .from("school_flags")
          .update({ status: "resolved", resolved_by: user.id, resolved_at: now })
          .eq("school_id", profileSchool.id)
          .eq("status", "pending");
        if (!flagErr) {
          flagWarning = null;
          break;
        }
        flagWarning = flagErr.message || "Could not clear this school's Data Quality flag.";
        if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 600));
      }

      const updatedSchool = { ...profileSchool, ...update };
      setProfileSchool(updatedSchool);
      setProfileJustSaved(true);
      setProfileError(flagWarning ? `Saved -- but couldn't clear this school's Data Quality flag (${flagWarning}). It may still show on Today's List.` : "");

      // Re-check this row against the sheet with the freshly-saved school,
      // right now, without waiting for a reload -- Larry asked for this
      // specifically. categorizeAgainstSchool is the exact same function
      // categorizeRow itself calls once a row is matched to a school, so
      // this row's new bucket/diff is decided the identical way every
      // other row's already was; a conflict that this edit just resolved
      // drops off the diff table and the row can move tabs on its own
      // (e.g. Conflict -> Already up to date).
      const targetRow = rows.find((r) => r.id === profileDrawer.rowId);
      if (targetRow) {
        const recheck = categorizeAgainstSchool(targetRow.mapped_data, updatedSchool);
        const { error: rowErr } = await supabase.from("import_batch_rows").update({ bucket: recheck.bucket, diff: recheck.diff }).eq("id", targetRow.id);
        if (!rowErr) {
          patchRow(targetRow.id, { bucket: recheck.bucket, diff: recheck.diff });
          // Old checkbox selections were computed against the old diff --
          // drop them so the conflict bucket (if the row is still there)
          // recomputes fresh defaults against the new one instead of
          // mixing stale and new field keys.
          setConflictSelections((prev) => {
            if (!(targetRow.id in prev)) return prev;
            const next = { ...prev };
            delete next[targetRow.id];
            return next;
          });
        }
      }
    } catch (err) {
      setProfileError(err.message || "Could not save this school.");
    } finally {
      setProfileSaving(false);
    }
  }

  // Same live route the row-level "Suggest Coach Info (AI)" button and the
  // school profile page's own button call -- run from inside the drawer so
  // a reviewer who's already in here to fix something else doesn't have to
  // back out to the row card to also run AI lookup. Only fills fields
  // still blank in the DRAFT (profileValues), same "never second-guess a
  // real value" rule runAiLookup follows.
  async function runProfileAiLookup() {
    if (!profileDrawer || !profileSchool) return;
    setProfileAiBusy(true);
    setProfileError("");
    setProfileAiNote("");
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const res = await fetch(`/api/schools/${profileSchool.id}/discover-coach-info`, {
        method: "POST",
        headers: { Authorization: `Bearer ${session?.access_token}` },
      });
      const suggestion = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(suggestion.error || "AI lookup didn't return a result for this school.");

      let filled = 0;
      setProfileValues((prev) => {
        const next = { ...prev };
        AI_LOOKUP_FIELDS.forEach((field) => {
          if (trimStr(next[field])) return; // already filled in the draft -- not a gap
          const suggested = trimStr(suggestion[field]);
          if (!suggested) return;
          next[field] = suggested;
          filled += 1;
        });
        return next;
      });

      setProfileAiNote(
        filled
          ? `AI filled ${filled} blank field${filled > 1 ? "s" : ""}${suggestion.confidence ? ` (confidence: ${suggestion.confidence})` : ""}${
              suggestion.hc_email_estimated ? " -- the email is a guessed pattern, worth a quick sanity check" : ""
            }. Review below, then Save.`
          : `AI lookup ran but didn't find anything new for a field that's still blank${suggestion.confidence ? ` (confidence: ${suggestion.confidence})` : ""}.`
      );
    } catch (err) {
      setProfileError(err.message || "AI lookup failed for this school.");
    } finally {
      setProfileAiBusy(false);
    }
  }

  // ---- New school bucket -------------------------------------------------

  async function addRowAsNewSchool(row) {
    setRowBusy((p) => ({ ...p, [row.id]: true }));
    setRowError((p) => ({ ...p, [row.id]: null }));
    try {
      const now = new Date().toISOString();
      // See the coach_radar_reviewed_at comment in applyRowFields above --
      // same reasoning applies to a brand-new school added here: it's
      // already fresh, human-reviewed data, no need for tonight's sweep to
      // immediately re-check it.
      const trust = trustInfo(selectedBatch?.source_trust);
      const insertRow = trust.trusted
        ? { verification_status: "verified", confidence_score: 70, last_verified_at: now, coach_radar_reviewed_at: now, source: "Import & Reconcile (CSV)" }
        : {
            // Unchecked sheet -- add the school, but Not Verified and on the
            // Needs Review list (see applyRowFields).
            verification_status: "not_verified",
            needs_review: true,
            needs_review_note: `Added from an unchecked sheet (${trust.short}) on ${now.slice(0, 10)} - confirm before trusting.`,
            needs_review_marked_at: now,
            needs_review_marked_by: user.id,
            source: "Import & Reconcile (CSV)",
          };
      ALL_FIELDS.forEach(([field]) => {
        if (field === "school_id") return;
        if (row.mapped_data[field]) insertRow[field] = row.mapped_data[field];
      });
      const { data: inserted, error } = await supabase.from("schools").insert(insertRow).select("id,name").single();
      if (error) throw error;

      const { error: logErr } = await supabase
        .from("school_change_log")
        .insert({ school_id: inserted.id, field_name: "created", old_value: null, new_value: inserted.name, source: "Import & Reconcile (CSV)" + trust.suffix, changed_by: user.id });
      if (logErr) throw logErr;

      const { error: rowErr } = await supabase
        .from("import_batch_rows")
        .update({ resolution: "applied", match_school_id: inserted.id, resolved_at: now, resolved_by: user.id })
        .eq("id", row.id);
      if (rowErr) throw rowErr;

      patchRow(row.id, { resolution: "applied", match_school_id: inserted.id, resolved_at: now, resolved_by: user.id });
      if (schoolIndexRef.current) {
        indexAddSchool(schoolIndexRef.current, { ...insertRow, id: inserted.id, name: inserted.name });
        setIndexVersion((v) => v + 1);
      }
    } catch (err) {
      setRowError((p) => ({ ...p, [row.id]: err.message || "Could not add this school." }));
    } finally {
      setRowBusy((p) => ({ ...p, [row.id]: false }));
    }
  }

  async function addAllNewSchools() {
    if (!schoolIndexRef.current) {
      setBulkError("Still loading the school list for the safety check — try again in a few seconds.");
      return;
    }
    const pending = safeRowsOf("new_school");
    if (!pending.length) return;
    setBulkError("");
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

  // Safety warnings per pending row (lib/importGuard.js) -- recomputed when
  // rows change, a conflict checkbox changes, or the index changes (after
  // each apply). Empty until the school list has loaded.
  const guards = useMemo(() => {
    const out = {};
    const index = schoolIndexRef.current;
    if (!index || !selectedBatch) return out;
    const sheet = buildSheetIndex(rows);
    rows.forEach((r) => {
      if (r.resolution !== "pending") return;
      if (r.bucket !== "new_info" && r.bucket !== "conflict" && r.bucket !== "new_school") return;
      const m = r.mapped_data || {};
      let fields;
      let base = {};
      let state = m.state || "";
      if (r.bucket === "new_school") {
        fields = ["hc_first_name", "hc_last_name", "hc_email", "hc_cell", "hc_office"].filter((f) => m[f]).map((f) => ({ field: f, new: m[f], kind: "fill" }));
      } else {
        const sel = r.bucket === "conflict" ? getSelection(r) : null;
        fields = (r.diff || []).filter((f) => !sel || sel[f.field]);
        const onFile = index.byId.get(String(r.match_school_id));
        if (onFile) {
          base = onFile;
          state = onFile.state || state;
        }
      }
      out[r.id] = evaluateGuard(index, sheet, { schoolId: r.bucket === "new_school" ? null : r.match_school_id, rowKey: rowKeyFor(r), state, base, fields });
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, selectedBatch, indexVersion, conflictSelections]);

  // ---- Flow mode (one row at a time, keyboard-driven) ---------------------
  // Pending rows of the open tab, in the same order as the list (red first),
  // narrowed by the traffic-light filter. Hooks live up here, above the early
  // returns below, so their order never changes between renders.
  const indexReadyNow = !!schoolIndexRef.current && !indexLoading;
  const flowRows = useMemo(() => {
    if (!selectedBatch || !FLOW_BUCKETS.includes(activeBucket)) return [];
    const ready = !!schoolIndexRef.current && !indexLoading;
    return rows
      .filter((r) => r.bucket === activeBucket && r.resolution === "pending")
      .filter((r) => tagFilter === "all" || rowTag(r, guards[r.id], ready)?.level === tagFilter)
      .filter((r) => rowMatchesFilters(r, stateFilter, changeFilter))
      .sort((a, b) => GUARD_RANK[guards[a.id]?.level || "none"] - GUARD_RANK[guards[b.id]?.level || "none"]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, selectedBatch, activeBucket, tagFilter, stateFilter, changeFilter, guards, indexLoading, indexVersion]);

  const flowIdx = Math.min(flowCursor, Math.max(flowRows.length - 1, 0));
  const flowRow = flowOn ? flowRows[flowIdx] || null : null;

  useEffect(() => {
    setFlowCursor(0);
    setFlowHint("");
  }, [activeBucket, tagFilter, stateFilter, changeFilter, flowOn]);

  useEffect(() => {
    if (flowOn && flowCardRef.current && typeof flowCardRef.current.scrollIntoView === "function") {
      flowCardRef.current.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [flowOn, flowRow?.id]);

  // Rebuilt on every render so the key handler below always sees the
  // current row and current state (no stale closures).
  useEffect(() => {
    const row = flowRow;
    flowHandlersRef.current = {
      active: !!row && !profileDrawer && !bulkBusy && !undoBusy,
      next: () => setFlowCursor(Math.min(flowIdx + 1, Math.max(flowRows.length - 1, 0))),
      prev: () => setFlowCursor(Math.max(flowIdx - 1, 0)),
      apply: (force) => {
        if (!row || rowBusy[row.id]) return;
        const tag = rowTag(row, guards[row.id], indexReadyNow);
        if (!tag || tag.level === "checking") {
          setFlowHint("Still loading the mix-up safety check -- give it a few seconds.");
          return;
        }
        if (tag.level === "red" && !force) {
          setFlowHint("This row is a possible mix-up. Press Shift+A to apply it anyway, or S to skip.");
          return;
        }
        if (flowInFlightRef.current === row.id) return;
        setFlowHint("");
        flowInFlightRef.current = row.id;
        let job = null;
        if (row.bucket === "new_info") job = applyRowFields(row, row.diff || []);
        else if (row.bucket === "conflict") job = applyConflictRow(row);
        else if (row.bucket === "new_school") job = addRowAsNewSchool(row);
        Promise.resolve(job).finally(() => {
          if (flowInFlightRef.current === row.id) flowInFlightRef.current = null;
        });
      },
      skip: () => {
        if (!row || rowBusy[row.id] || flowInFlightRef.current === row.id) return;
        setFlowHint("");
        flowInFlightRef.current = row.id;
        Promise.resolve(skipRow(row)).finally(() => {
          if (flowInFlightRef.current === row.id) flowInFlightRef.current = null;
        });
      },
      edit: () => {
        if (!row || !row.match_school_id) {
          setFlowHint("This row isn't matched to a school yet, so there's no profile to edit.");
          return;
        }
        openProfile(row);
      },
      ai: () => {
        if (!row || rowBusy[row.id]) return;
        if (!row.match_school_id || row.bucket === "new_school") {
          setFlowHint("AI lookup works on rows matched to an existing school.");
          return;
        }
        setFlowHint("");
        runAiLookup(row);
      },
    };
  });

  useEffect(() => {
    function onKey(e) {
      const h = flowHandlersRef.current;
      if (!h || !h.active) return;
      if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
      const t = e.target;
      const tagName = (t?.tagName || "").toUpperCase();
      const inputType = (t?.type || "").toLowerCase();
      if (tagName === "TEXTAREA" || tagName === "SELECT" || t?.isContentEditable) return;
      if (tagName === "INPUT" && inputType !== "checkbox" && inputType !== "radio") return;
      const k = e.key;
      if (k === "a" || k === "A") {
        e.preventDefault();
        h.apply(e.shiftKey);
      } else if (k === "s" || k === "S") {
        e.preventDefault();
        h.skip();
      } else if (k === "e" || k === "E") {
        e.preventDefault();
        h.edit();
      } else if (k === "l" || k === "L") {
        e.preventDefault();
        h.ai();
      } else if (k === "ArrowRight" || k === "j" || k === "J") {
        e.preventDefault();
        h.next();
      } else if (k === "ArrowLeft" || k === "k" || k === "K") {
        e.preventDefault();
        h.prev();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!canReview) {
    return (
      <div className="view">
        <div className="notice danger">Import &amp; Reconcile is limited to Verification Staff and System Admins.</div>
      </div>
    );
  }

  // ---- Review screen -------------------------------------------------

  if (selectedBatch) {
    const bucketRowsRaw = rows.filter((r) => r.bucket === activeBucket);
    // Rows with a safety warning float to the top of the tabs that write to
    // the database (red first), so the risky ones are the first thing seen.
    const bucketRows =
      activeBucket === "new_info" || activeBucket === "conflict" || activeBucket === "new_school"
        ? [...bucketRowsRaw].sort((a, b) => GUARD_RANK[guards[a.id]?.level || "none"] - GUARD_RANK[guards[b.id]?.level || "none"])
        : bucketRowsRaw;
    const batchTrust = trustInfo(selectedBatch.source_trust);
    const indexReady = !!schoolIndexRef.current && !indexLoading;
    const safeNewInfo = rows.filter((r) => r.bucket === "new_info" && r.resolution === "pending" && (guards[r.id]?.level || "none") === "none");
    const safeNewSchools = rows.filter((r) => r.bucket === "new_school" && r.resolution === "pending" && (guards[r.id]?.level || "none") === "none");
    const pendingInBucket = bucketRows.filter((r) => r.resolution === "pending");
    const totalPending = rows.filter((r) => r.resolution === "pending").length;
    // Rows this tab's "Run AI on all rows missing email" bulk button will
    // touch -- matched to a school (so there's somewhere to attach the
    // lookup) and with no hc_email anywhere in the diff yet, whether
    // because the sheet never had one or the parser flagged a guessed
    // address as too unreliable to surface (see runAiLookup's comment).
    // Cheap client-side filter using only what's already loaded -- the
    // per-row on-file check still happens fresh inside runAiLookup itself.
    const missingEmailInBucket = pendingInBucket.filter((r) => r.match_school_id && !(r.diff || []).some((f) => f.field === "hc_email"));

    const undoableCount = rows.filter((r) => r.resolution === "applied" && r.bucket !== "new_school" && r.match_school_id).length;

    // Traffic-light counts for the open tab (before the filter is applied).
    const tagCounts = { green: 0, yellow: 0, red: 0, checking: 0 };
    if (FLOW_BUCKETS.includes(activeBucket)) {
      pendingInBucket.forEach((r) => {
        const t = rowTag(r, guards[r.id], indexReady);
        if (t) tagCounts[t.level] += 1;
      });
    }
    const showFlowTools = FLOW_BUCKETS.includes(activeBucket) && pendingInBucket.length > 0;
    const filtersActive = tagFilter !== "all" || stateFilter !== "all" || changeFilter !== "all";
    const listRows =
      !filtersActive || !FLOW_BUCKETS.includes(activeBucket)
        ? bucketRows
        : bucketRows.filter((r) => r.resolution === "pending" && (tagFilter === "all" || rowTag(r, guards[r.id], indexReady)?.level === tagFilter) && rowMatchesFilters(r, stateFilter, changeFilter));
    const stateCounts = {};
    if (FLOW_BUCKETS.includes(activeBucket)) pendingInBucket.forEach((r) => { const st = rowState(r); if (st) stateCounts[st] = (stateCounts[st] || 0) + 1; });
    const stateOptions = Object.keys(stateCounts).sort();
    const flowShown = flowOn && FLOW_BUCKETS.includes(activeBucket);
    const flowActionLabel = flowRow ? (flowRow.bucket === "new_school" ? "Add school" : flowRow.bucket === "conflict" ? "Apply checked" : "Apply") : "Apply";

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
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            {undoableCount > 0 &&
              (undoArmed ? (
                <>
                  <span style={{ fontSize: 12.5, color: "#b3261e" }}>Put {undoableCount} applied row{undoableCount === 1 ? "" : "s"} back the way they were?</span>
                  <button className="btn btn-sm" style={{ background: "#b3261e", color: "#fff", borderColor: "#b3261e" }} onClick={undoWholeBatch} disabled={undoBusy}>
                    Yes, undo them
                  </button>
                  <button className="btn btn-sm" onClick={() => setUndoArmed(false)} disabled={undoBusy}>
                    Cancel
                  </button>
                </>
              ) : (
                <button
                  className="btn btn-sm"
                  onClick={() => setUndoArmed(true)}
                  disabled={undoBusy || bulkBusy}
                  title="Restores every school this batch changed to how it was before -- skipping any school someone has edited since. Logged in each school's history."
                >
                  {undoBusy ? "Undoing…" : `Undo ${undoableCount} applied row${undoableCount === 1 ? "" : "s"}`}
                </button>
              ))}
            {selectedBatch.status !== "done" && (
              <button className="btn btn-sm btn-primary" onClick={markCloseBatch} disabled={loadingRows}>
                Close this batch
              </button>
            )}
          </div>
        </div>
        {undoNote && (
          <div className={`notice ${undoNote.kind === "danger" ? "danger" : "info"}`} style={{ marginBottom: 12 }}>
            {undoNote.text}
          </div>
        )}

        {!batchTrust.trusted && (
          <div className="notice danger" style={{ marginBottom: 12 }}>
            <strong>Unchecked sheet ({batchTrust.short}).</strong> Rows you apply from this batch are saved, but the school is left <strong>Not Verified</strong> and put on the Needs Review
            list — nothing here is stamped Verified.
          </div>
        )}
        {batchTrust.trusted && batchTrust.value && (
          <div style={{ fontSize: 12, color: "#697386", marginBottom: 10 }}>Sheet source: {batchTrust.label}</div>
        )}
        {indexLoading && <div className="notice info" style={{ marginBottom: 12 }}>Loading every school for the duplicate / mix-up safety check… the &quot;Apply all&quot; buttons unlock when it finishes.</div>}
        {indexError && <div className="notice danger" style={{ marginBottom: 12 }}>Safety check unavailable: {indexError} Reopen this batch to retry; &quot;Apply all&quot; stays locked until it loads.</div>}
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
                  {indexReady && pendingInBucket.length > safeNewInfo.length && (
                    <>
                      {" "}
                      <strong style={{ color: "#b3261e" }}>
                        {pendingInBucket.length - safeNewInfo.length} row{pendingInBucket.length - safeNewInfo.length > 1 ? "s have" : " has"} a safety warning
                      </strong>{" "}
                      (shown first, below) and {pendingInBucket.length - safeNewInfo.length > 1 ? "are" : "is"} left out of &quot;Apply all&quot; — review {pendingInBucket.length - safeNewInfo.length > 1 ? "them" : "it"} one at a time.
                    </>
                  )}
                </p>
                <button className="btn btn-sm btn-gold" onClick={applyAllNewInfo} disabled={bulkBusy || !indexReady || safeNewInfo.length === 0}>
                  {bulkBusy ? bulkStatus || "Applying…" : !indexReady ? "Checking for mix-ups…" : `Apply all ${safeNewInfo.length} safe row${safeNewInfo.length === 1 ? "" : "s"}`}
                </button>{" "}
                {missingEmailInBucket.length > 0 && (
                  <button className="btn btn-sm" onClick={() => runAiLookupOnRows(missingEmailInBucket)} disabled={bulkBusy} title="Runs the live AI coach-info lookup on every row in this tab with no email yet, and drops any real gaps it fills straight into each row's table below">
                    {bulkBusy ? bulkStatus || "Running…" : `Run AI on ${missingEmailInBucket.length} row${missingEmailInBucket.length > 1 ? "s" : ""} missing email`}
                  </button>
                )}
              </div>
            )}

            {activeBucket === "conflict" && indexReady && bucketRowsRaw.some((r) => r.resolution === "pending" && (guards[r.id]?.level || "none") !== "none") && (
              <div className="notice danger" style={{ marginBottom: 14 }}>
                {bucketRowsRaw.filter((r) => r.resolution === "pending" && (guards[r.id]?.level || "none") !== "none").length} row(s) here have a safety warning for the fields currently checked
                (shown first). Conflict rows are always applied one at a time.
              </div>
            )}

            {activeBucket === "conflict" && missingEmailInBucket.length > 0 && (
              <div className="card" style={{ marginBottom: 14 }}>
                <p style={{ marginTop: 0, fontSize: 12.5, color: "#697386" }}>
                  {missingEmailInBucket.length} row{missingEmailInBucket.length > 1 ? "s" : ""} here still {missingEmailInBucket.length > 1 ? "have" : "has"} no coach email on the sheet or on
                  file. Run the AI lookup on all of them at once instead of opening each school&apos;s profile — anything it finds drops straight into that row&apos;s table below, already
                  checked, ready for you to review and Apply.
                </p>
                <button className="btn btn-sm" onClick={() => runAiLookupOnRows(missingEmailInBucket)} disabled={bulkBusy}>
                  {bulkBusy ? bulkStatus || "Running…" : `Run AI on ${missingEmailInBucket.length} row${missingEmailInBucket.length > 1 ? "s" : ""} missing email`}
                </button>
              </div>
            )}

            {activeBucket === "new_school" && pendingInBucket.length > 0 && (
              <div className="card" style={{ marginBottom: 14 }}>
                {indexReady && pendingInBucket.length > safeNewSchools.length && (
                  <p style={{ marginTop: 0, fontSize: 12.5, color: "#b3261e" }}>
                    <strong>
                      {pendingInBucket.length - safeNewSchools.length} new school{pendingInBucket.length - safeNewSchools.length > 1 ? "s have" : " has"} a safety warning
                    </strong>{" "}
                    (shown first, below) and {pendingInBucket.length - safeNewSchools.length > 1 ? "are" : "is"} left out of &quot;Add all&quot;.
                  </p>
                )}
                <button className="btn btn-sm btn-gold" onClick={addAllNewSchools} disabled={bulkBusy || !indexReady || safeNewSchools.length === 0}>
                  {bulkBusy ? bulkStatus || "Adding…" : !indexReady ? "Checking for mix-ups…" : `Add all ${safeNewSchools.length} safe new school${safeNewSchools.length === 1 ? "" : "s"}`}
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

            {showFlowTools && (
              <div className="card" style={{ marginBottom: 14 }}>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                  <span style={{ fontSize: 12.5, color: "#697386" }}>Show:</span>
                  {[
                    ["all", `All (${pendingInBucket.length})`, null],
                    ["green", `Safe (${tagCounts.green})`, "green"],
                    ["yellow", `Check (${tagCounts.yellow})`, "yellow"],
                    ["red", `Possible mix-up (${tagCounts.red})`, "red"],
                  ].map(([key, label, lvl]) => (
                    <button key={key} className={`btn btn-sm ${tagFilter === key ? "btn-gold" : ""}`} onClick={() => setTagFilter(key)}>
                      {lvl && <span style={{ display: "inline-block", width: 9, height: 9, borderRadius: "50%", background: TAG_STYLE[lvl].dot, marginRight: 6 }} />}
                      {label}
                    </button>
                  ))}
                  {tagCounts.checking > 0 && <span style={{ fontSize: 12, color: "#697386" }}>Safety check loading…</span>}
                  {stateOptions.length > 1 && (
                    <select value={stateFilter} onChange={(e) => setStateFilter(e.target.value)} style={{ fontSize: 12.5, padding: "3px 6px" }} title="Only show rows for one state">
                      <option value="all">All states</option>
                      {stateOptions.map((st) => (
                        <option key={st} value={st}>
                          {st} ({stateCounts[st]})
                        </option>
                      ))}
                    </select>
                  )}
                  <select value={changeFilter} onChange={(e) => setChangeFilter(e.target.value)} style={{ fontSize: 12.5, padding: "3px 6px" }} title="Only show rows that change a certain kind of field">
                    {CHANGE_FILTERS.map(([v, label]) => (
                      <option key={v} value={v}>
                        {label}
                      </option>
                    ))}
                  </select>
                  {filtersActive && (
                    <button className="btn btn-sm" onClick={() => { setTagFilter("all"); setStateFilter("all"); setChangeFilter("all"); }}>
                      Clear filters
                    </button>
                  )}
                  {aiBulkRunning && (
                    <button className="btn btn-sm" style={REDBTN} onClick={() => { aiStopRef.current = true; setBulkStatus("Stopping after the lookups already running…"); }}>
                      Stop AI lookups
                    </button>
                  )}
                  <span style={{ flex: 1 }} />
                  <button className={`btn btn-sm ${flowOn ? "" : "btn-primary"}`} onClick={() => setFlowOn(!flowOn)}>
                    {flowOn ? "Show full list" : "Review one at a time (keyboard)"}
                  </button>
                </div>
                {!flowOn && (
                  <p style={{ margin: "8px 0 0", fontSize: 12, color: "#697386" }}>
                    One-at-a-time mode shows a single row with big keys: <strong>A</strong> apply · <strong>S</strong> skip · <strong>E</strong> edit profile · <strong>L</strong> AI lookup ·{" "}
                    <strong>← →</strong> move. Possible mix-ups need <strong>Shift+A</strong>.
                  </p>
                )}
              </div>
            )}

            {flowShown && (
              <div className="card" ref={flowCardRef}>
                {flowRows.length === 0 ? (
                  <div className="empty-state">
                    {pendingInBucket.length === 0 ? "Nothing left to review in this tab." : "No pending rows match this filter."}{" "}
                    {filtersActive && (
                      <button className="btn btn-sm" onClick={() => { setTagFilter("all"); setStateFilter("all"); setChangeFilter("all"); }}>
                        Show all
                      </button>
                    )}
                  </div>
                ) : (
                  <>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
                      <strong>
                        Row {flowIdx + 1} of {flowRows.length}
                      </strong>
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", fontSize: 12 }}>
                        {[
                          ["A", flowActionLabel],
                          ["S", "Skip"],
                          ["E", "Edit profile"],
                          ["L", "AI lookup"],
                          ["← →", "Move"],
                        ].map(([k, label]) => (
                          <span key={k} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                            <kbd style={{ border: "1px solid #c9ced8", borderBottomWidth: 2, borderRadius: 4, padding: "1px 6px", background: "#f6f7f9", fontFamily: "inherit", fontWeight: 700 }}>{k}</kbd>
                            {label}
                          </span>
                        ))}
                      </div>
                    </div>
                    {flowHint && <div className="notice danger" style={{ marginBottom: 10, fontSize: 12.5 }}>{flowHint}</div>}
                    <RowCard
                      key={flowRow.id}
                      row={flowRow}
                      tag={rowTag(flowRow, guards[flowRow.id], indexReady)}
                      busy={!!rowBusy[flowRow.id]}
                      error={rowError[flowRow.id]}
                      aiNote={aiNote[flowRow.id]}
                      guard={guards[flowRow.id] || null}
                      selection={activeBucket === "conflict" ? getSelection(flowRow) : null}
                      onToggleField={(field) => toggleField(flowRow, field)}
                      onApplyNewInfo={() => applyRowFields(flowRow, flowRow.diff || [])}
                      onApplyConflict={() => applyConflictRow(flowRow)}
                      onSkip={() => skipRow(flowRow)}
                      onAddNewSchool={() => addRowAsNewSchool(flowRow)}
                      onPickCandidate={(candidate) => sendToVerification(flowRow, candidate.id)}
                      onMarkNewSchool={() => markRowAsNewSchoolInstead(flowRow)}
                      onRunAiLookup={flowRow.match_school_id ? () => runAiLookup(flowRow) : null}
                      onOpenProfile={flowRow.match_school_id ? () => openProfile(flowRow) : null}
                      onUndo={null}
                    />
                  </>
                )}
              </div>
            )}

            {!flowShown && (
            <div className="card">
              {listRows.length === 0 ? (
                <div className="empty-state">{bucketRows.length === 0 ? "No rows in this bucket." : "No rows match this filter."}</div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {listRows.map((row) => (
                    <RowCard
                      key={row.id}
                      row={row}
                      tag={rowTag(row, guards[row.id], indexReady)}
                      busy={!!rowBusy[row.id]}
                      error={rowError[row.id]}
                      aiNote={aiNote[row.id]}
                      guard={guards[row.id] || null}
                      selection={activeBucket === "conflict" ? getSelection(row) : null}
                      onToggleField={(field) => toggleField(row, field)}
                      onApplyNewInfo={() => applyRowFields(row, row.diff || [])}
                      onApplyConflict={() => applyConflictRow(row)}
                      onSkip={() => skipRow(row)}
                      onAddNewSchool={() => addRowAsNewSchool(row)}
                      onPickCandidate={(candidate) => sendToVerification(row, candidate.id)}
                      onMarkNewSchool={() => markRowAsNewSchoolInstead(row)}
                      onRunAiLookup={row.match_school_id ? () => runAiLookup(row) : null}
                      onOpenProfile={row.match_school_id ? () => openProfile(row) : null}
                      onUndo={row.resolution === "applied" && row.bucket !== "new_school" && row.match_school_id ? () => undoOneRow(row) : null}
                    />
                  ))}
                </div>
              )}
            </div>
            )}
          </>
        )}

        <SchoolProfileDrawer
          open={!!profileDrawer}
          loading={profileLoading}
          saving={profileSaving}
          justSaved={profileJustSaved}
          error={profileError}
          aiBusy={profileAiBusy}
          aiNote={profileAiNote}
          school={profileSchool}
          values={profileValues}
          row={profileDrawer ? rows.find((r) => r.id === profileDrawer.rowId) : null}
          onChange={updateProfileField}
          onClose={closeProfile}
          onSave={saveProfileEdit}
          onRunAi={runProfileAiLookup}
        />
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

      <div className="card" style={{ marginBottom: 14 }}>
        <h3>Or paste research text (AI-parsed)</h3>
        <p style={{ fontSize: 12.5, color: "#697386", marginTop: -4 }}>
          Paste any research you&apos;ve already done — one school or several, in whatever shape it&apos;s in. The AI only structures what you pasted into rows below; it never
          searches the web or adds anything you didn&apos;t already write. Everything it finds still runs through the exact same matching and conflict checks as a CSV upload
          before anything is saved — nothing is applied automatically.
        </p>
        {pasteError && <div className="notice danger" style={{ marginBottom: 10 }}>{pasteError}</div>}
        <textarea
          value={pasteText}
          onChange={(e) => setPasteText(e.target.value)}
          placeholder="Paste research for one or more schools here…"
          rows={8}
          style={{ width: "100%", fontFamily: "inherit", fontSize: 13, padding: 10, marginBottom: 10, boxSizing: "border-box" }}
          disabled={parsingPaste}
        />
        <button className="btn btn-primary btn-sm" onClick={handlePasteParse} disabled={parsingPaste || !pasteText.trim()}>
          {parsingPaste ? "Parsing…" : "Parse with AI"}
        </button>
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
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontWeight: 700, marginBottom: 6 }}>How was this sheet verified?</div>
            <p style={{ fontSize: 12.5, color: "#697386", margin: "0 0 8px" }}>
              This decides what Apply does. A checked sheet marks schools <strong>Verified</strong>. An unchecked sheet still saves its data, but leaves each school{" "}
              <strong>Not Verified</strong> and adds it to Needs Review — so nothing gets a Verified stamp that nobody confirmed.
            </p>
            {SOURCE_TRUST_OPTIONS.map((o) => (
              <label key={o.value} style={{ display: "block", fontSize: 13, marginBottom: 4, cursor: "pointer" }}>
                <input type="radio" name="source_trust" value={o.value} checked={sourceTrust === o.value} onChange={() => setSourceTrust(o.value)} style={{ marginRight: 8 }} />
                {o.label}
                {!o.trusted && <span style={{ color: "#b3261e", fontSize: 11.5 }}> — applies as Not Verified</span>}
              </label>
            ))}
          </div>
          {commitError && <div className="notice danger" style={{ marginBottom: 10 }}>{commitError}</div>}
          <button className="btn btn-gold" onClick={commitBatch} disabled={committing || !sourceTrust}>
            {committing ? "Saving…" : !sourceTrust ? "Pick how it was verified to continue" : `Save & Start Reviewing (${preview.rows.length} rows)`}
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
                  <th>Source</th>
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
                    <td>{trustInfo(b.source_trust).short}</td>
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

function RowCard({ row, tag, busy, error, aiNote, guard, selection, onToggleField, onApplyNewInfo, onApplyConflict, onSkip, onAddNewSchool, onPickCandidate, onMarkNewSchool, onRunAiLookup, onOpenProfile, onUndo }) {
  const resolved = row.resolution !== "pending";
  const m = row.mapped_data || {};
  const locationLabel = [m.city, m.state].filter(Boolean).join(", ");

  return (
    <div className="log-item" style={{ opacity: resolved ? 0.6 : 1 }}>
      <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
        <div>
          {tag && (
            <span
              title={tag.reasons.length ? tag.reasons.join("\n") : "Nothing unusual -- safe to apply"}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
                marginRight: 8,
                padding: "1px 8px",
                borderRadius: 10,
                fontSize: 11,
                fontWeight: 700,
                color: TAG_STYLE[tag.level].color,
                background: TAG_STYLE[tag.level].bg,
                border: `1px solid ${TAG_STYLE[tag.level].border}`,
              }}
            >
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: TAG_STYLE[tag.level].dot }} />
              {TAG_STYLE[tag.level].label}
            </span>
          )}
          <strong>{row.label || m.name || `Row ${row.row_index}`}</strong>
          {locationLabel && <span style={{ color: "#697386", fontSize: 12.5 }}> — {locationLabel}</span>}
          {row.duplicate_in_file && (
            <span className="badge badge-not-contacted" style={{ marginLeft: 8 }} title="Another row in this same file has the same name + state">
              Duplicate row in file
            </span>
          )}
          {onOpenProfile && (
            <button
              type="button"
              className="btn btn-sm"
              style={{ marginLeft: 8, padding: "1px 8px", fontSize: 11.5 }}
              onClick={onOpenProfile}
              title="Open this school's profile right here to make a quick edit, without leaving this screen"
            >
              Open Profile ↗
            </button>
          )}
        </div>
        {resolved && (
          <span style={{ fontSize: 12, color: "#697386" }}>
            {row.resolution === "applied" ? "Applied" : row.resolution === "sent_to_verification" ? "Sent to AI verification" : "Skipped"}
            {onUndo && (
              <button
                type="button"
                className="btn btn-sm"
                style={{ marginLeft: 8, padding: "1px 8px", fontSize: 11.5 }}
                disabled={busy}
                onClick={onUndo}
                title="Put this school back the way it was before this row was applied"
              >
                {busy ? "…" : "Undo"}
              </button>
            )}
          </span>
        )}
      </div>

      {row.raw_row?.notes && (
        <div style={{ fontSize: 12, color: "#8a6d3b", marginTop: 6 }}>
          ⚠️ AI parsing note: {row.raw_row.notes}
        </div>
      )}
      {row.raw_row?.source_excerpt && (
        <div style={{ fontSize: 11.5, color: "#697386", marginTop: 4, fontStyle: "italic" }}>
          Parsed from: &quot;{row.raw_row.source_excerpt}&quot;
        </div>
      )}

      {error && <div className="notice danger" style={{ marginTop: 8, fontSize: 12.5 }}>{error}</div>}

      {aiNote && <div style={{ fontSize: 12, color: "#1c5fb3", marginTop: 6 }}>🤖 {aiNote}</div>}

      {row.skip_reason && <div style={{ fontSize: 12.5, color: "#a94442", marginTop: 6 }}>{row.skip_reason}</div>}

      {!resolved && guard && guard.items.length > 0 && (
        <div
          style={{
            marginTop: 8,
            padding: "8px 10px",
            borderRadius: 6,
            fontSize: 12.5,
            border: `1px solid ${guard.level === "red" ? "#e8b4b0" : "#ecd9a4"}`,
            background: guard.level === "red" ? "#fdeceb" : "#fff8e5",
            color: guard.level === "red" ? "#8c1d18" : "#7a5a00",
          }}
        >
          <strong>{guard.level === "red" ? "⛔ Possible mix-up — check before applying" : "⚠️ Worth a second look"}</strong>
          <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
            {guard.items.map((it, i) => (
              <li key={i}>{it.text}</li>
            ))}
          </ul>
        </div>
      )}

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
                  <td style={{ color: f.kind === "overwrite" ? "#b8860b" : f.kind === "clear" ? "#b3261e" : "#1e7145", fontWeight: 700 }}>
                    {f.kind === "clear" ? "(will be cleared)" : f.new}
                    {f.source === "ai" && f.estimated && (
                      <span
                        className="badge"
                        style={{ marginLeft: 6, fontSize: 10, fontWeight: 700, color: "#b8860b", background: "#fff4dc" }}
                        title="The AI didn't find this address written down anywhere -- it's a guessed first.last@domain pattern, not a confirmed email. Worth a quick sanity check before applying."
                      >
                        AI guess
                      </span>
                    )}
                    {f.source === "ai" && !f.estimated && (
                      <span
                        className="badge"
                        style={{ marginLeft: 6, fontSize: 10, fontWeight: 700, color: "#1c5fb3", background: "#e7effc" }}
                        title={`Found by the live AI coach-info lookup, not the original sheet${f.confidence ? ` — confidence: ${f.confidence}` : ""}`}
                      >
                        AI{f.confidence ? ` · ${f.confidence}` : ""}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {row.diff.some((f) => f.kind === "clear") && (
            <div style={{ fontSize: 11.5, color: "#b3261e", marginTop: 6 }}>
              ⚠️ The coach is changing on this row. This sheet doesn&apos;t give a new value for the field(s) marked &quot;will be cleared&quot; above, so
              they&apos;re being cleared instead of left pointing at the departed coach — uncheck it if you know this one actually still applies.
            </div>
          )}
          {selection &&
            (() => {
              // Every "overwrite" field (gold text above -- something already
              // on file that this sheet disagrees with) starts UNCHECKED,
              // deliberately -- Larry asked for exactly this backstop when
              // this tool was built, so a bulk apply can never silently
              // replace a value already on file without a human choosing to.
              // But nothing on screen ever said so: the row just shows the
              // sheet's value in gold next to an empty checkbox, which reads
              // as "here's what this is" rather than "this won't be saved
              // unless you check it." That's exactly the bug Larry reported --
              // he'd paste a corrected email, see it right there in the
              // preview table, and assume it had gone in, when really it was
              // sitting unchecked the whole time (this is also the single
              // biggest source of the 1,600+ name/email mismatches found
              // across the database -- a coach-name overwrite gets checked
              // and applied, the email overwrite next to it doesn't).
              // Naming the unchecked fields explicitly, with a one-click way
              // to check them all, closes that gap without changing the
              // underlying safety behavior at all.
              const uncheckedOverwrites = row.diff.filter((f) => f.kind === "overwrite" && !selection[f.field]);
              if (!uncheckedOverwrites.length) return null;
              return (
                <div style={{ fontSize: 11.5, color: "#b8860b", marginTop: 6 }}>
                  ⚠️ {uncheckedOverwrites.length} field{uncheckedOverwrites.length > 1 ? "s" : ""} won&apos;t be saved unless checked:{" "}
                  {uncheckedOverwrites.map((f) => f.label).join(", ")} — the value shown is only what your sheet says, not what&apos;s been applied.{" "}
                  <button
                    type="button"
                    className="btn btn-sm"
                    style={{ marginLeft: 6, padding: "1px 8px", fontSize: 11 }}
                    disabled={busy}
                    onClick={() => uncheckedOverwrites.forEach((f) => onToggleField(f.field))}
                  >
                    Check all {uncheckedOverwrites.length}
                  </button>
                </div>
              );
            })()}
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
            <button className="btn btn-sm btn-gold" disabled={busy} onClick={onApplyNewInfo} style={guard?.level === "red" ? REDBTN : undefined}>
              {guard?.level === "red" ? "Apply anyway" : "Apply"}
            </button>
          )}
          {row.bucket === "conflict" && (
            <button className="btn btn-sm btn-gold" disabled={busy} onClick={onApplyConflict} style={guard?.level === "red" ? REDBTN : undefined}>
              {guard?.level === "red" ? "Apply selected anyway" : "Apply selected"}
            </button>
          )}
          {row.bucket === "new_school" && (
            <button className="btn btn-sm btn-gold" disabled={busy} onClick={onAddNewSchool} style={guard?.level === "red" ? REDBTN : undefined}>
              {guard?.level === "red" ? "Add anyway" : "Add as new school"}
            </button>
          )}
          {onRunAiLookup && (row.bucket === "new_info" || row.bucket === "conflict") && (
            <button className="btn btn-sm" disabled={busy} onClick={onRunAiLookup} title="Live web-search + AI lookup for this school's coach info -- fills genuine gaps only, never overwrites what the sheet or database already has">
              {busy ? "Looking…" : "Suggest Coach Info (AI)"}
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

// Slide-over "Open Profile" quick-edit drawer -- see openProfile/
// saveProfileEdit/runProfileAiLookup in the page component above for the
// data side of this. Purely a rendering component: every field's value and
// every action are handed down as props so the parsing screen underneath
// it (row list, active tab, scroll position) never has to know this is
// open, and never re-renders because of anything happening in here except
// the one row this drawer is editing.
function SchoolProfileDrawer({ open, loading, saving, justSaved, error, aiBusy, aiNote, school, values, row, onChange, onClose, onSave, onRunAi }) {
  if (!open) return null;

  const sheet = row?.mapped_data || {};
  const locationLabel = school ? [school.city, school.state].filter(Boolean).join(", ") : "";

  return (
    <>
      <div
        onClick={onClose}
        style={{ position: "fixed", inset: 0, background: "rgba(20, 24, 33, 0.35)", zIndex: 999 }}
      />
      <div
        style={{
          position: "fixed",
          top: 0,
          right: 0,
          bottom: 0,
          width: "min(480px, 100vw)",
          background: "#fff",
          zIndex: 1000,
          boxShadow: "-6px 0 28px rgba(20, 24, 33, 0.22)",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div style={{ padding: "16px 20px", borderBottom: "1px solid #e3e6eb", display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
          <div>
            <div style={{ fontSize: 11, color: "#697386", textTransform: "uppercase", letterSpacing: 0.4 }}>Quick Edit</div>
            <h3 style={{ margin: "2px 0 0" }}>{school ? school.name : "Loading…"}</h3>
            {locationLabel && <div style={{ fontSize: 12.5, color: "#697386" }}>{locationLabel}</div>}
            {school && (
              <div style={{ marginTop: 6, display: "flex", gap: 6, flexWrap: "wrap" }}>
                <span className={`badge ${school.verification_status === "verified" ? "badge-contacted" : "badge-not-contacted"}`}>
                  {school.verification_status === "verified" ? "Verified" : school.verification_status || "Not verified"}
                </span>
                {school.needs_review && <span className="badge badge-not-contacted">Needs review</span>}
                {school.is_closed && <span className="badge badge-not-contacted">Closed</span>}
              </div>
            )}
          </div>
          <button type="button" className="btn btn-sm" onClick={onClose} title="Close (your place in the batch is unchanged)">
            ✕
          </button>
        </div>

        <div style={{ padding: "16px 20px", overflowY: "auto", flex: 1 }}>
          {loading && <div className="empty-state">Loading this school…</div>}

          {!loading && school && (
            <>
              {school.id && (
                <div style={{ marginBottom: 12 }}>
                  <Link href={`/schools/${school.id}`} target="_blank" style={{ fontSize: 12.5 }}>
                    Open full profile (new tab) ↗
                  </Link>
                  <span style={{ fontSize: 11.5, color: "#8a94a6" }}> — for social handles, &quot;not available&quot; flags, and coach-radar history</span>
                </div>
              )}

              {error && <div className="notice danger" style={{ marginBottom: 10, fontSize: 12.5 }}>{error}</div>}
              {justSaved && !error && <div className="notice info" style={{ marginBottom: 10, fontSize: 12.5 }}>✓ Saved</div>}

              <div style={{ marginBottom: 12 }}>
                <button type="button" className="btn btn-sm" disabled={aiBusy} onClick={onRunAi} title="Live web-search + AI lookup for this school's coach/AD info -- fills genuine gaps in the fields below only">
                  {aiBusy ? "Looking…" : "Suggest Coach Info (AI)"}
                </button>
                {aiNote && <div style={{ fontSize: 12, color: "#1c5fb3", marginTop: 6 }}>🤖 {aiNote}</div>}
              </div>

              {PROFILE_FIELD_GROUPS.map((group) => (
                <div key={group.title} style={{ marginBottom: 16 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: "#42485a", marginBottom: 6 }}>{group.title}</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {group.fields.map((field) => {
                      const label = (DIFF_FIELDS.find(([f]) => f === field) || [])[1] || field;
                      const current = values[field] || "";
                      const sheetVal = trimStr(sheet[field]);
                      const showHint = sheetVal && sheetVal !== current;
                      return (
                        <div className="form-field" key={field} style={{ marginBottom: 0 }}>
                          <label>{label}</label>
                          <input value={current} onChange={(e) => onChange(field, e.target.value)} style={{ width: "100%", boxSizing: "border-box" }} />
                          {showHint && (
                            <div style={{ fontSize: 11.5, color: "#8a6d3b", marginTop: 3 }}>
                              Sheet says: {sheetVal}{" "}
                              <button
                                type="button"
                                className="btn btn-sm"
                                style={{ padding: "0px 6px", fontSize: 10.5, marginLeft: 2 }}
                                onClick={() => onChange(field, sheetVal)}
                              >
                                Use this
                              </button>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </>
          )}
        </div>

        {!loading && school && (
          <div style={{ padding: "14px 20px", borderTop: "1px solid #e3e6eb", display: "flex", gap: 8 }}>
            <button className="btn btn-sm btn-gold" disabled={saving} onClick={onSave}>
              {saving ? "Saving…" : justSaved ? "Save Again" : "Save & Mark Verified"}
            </button>
            <button type="button" className="btn btn-sm" onClick={onClose} disabled={saving}>
              {justSaved ? "Close" : "Cancel"}
            </button>
          </div>
        )}
      </div>
    </>
  );
}
