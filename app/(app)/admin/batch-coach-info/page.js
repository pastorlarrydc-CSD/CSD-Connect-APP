"use client";
import { useState, useEffect, useCallback, useRef, Suspense } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import Link from "next/link";
import Papa from "papaparse";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { useAuth } from "@/lib/auth-context";

// Overnight Coach-Info Batch API job -- see the batch-coach-info-discovery
// spec doc in the project for the full plan this implements. Turns the
// one-school-at-a-time "Suggest Coach Info (AI)" button into a real batch
// job that can run against hundreds of schools at once, using Anthropic's
// discounted (50% off) Batch API instead of live one-at-a-time calls.
//
// Four stages, matching the spec exactly:
//  1. Prep   -- fetch each school's athletics/website page + a web search,
//               save the assembled source text (fetch-item route, driven
//               here with a few requests in flight at once).
//  2. Submit -- bundle every "ready" item into one Anthropic Batch API
//               submission (submit route).
//  3. Wait   -- Anthropic processes asynchronously; check back later
//               (check-status route, polled by hand -- no auto-refresh).
//  4. Collect -- once Anthropic reports the batch "ended", download and
//               parse its results into a review queue (collect route).
//
// Same non-authoritative contract as every other discovery tool in this
// app: nothing here ever writes to the schools table until a human clicks
// Apply on a specific school's suggestion below.
const PRIORITY_STATES = ["TX", "FL", "GA", "CA", "OH", "IN"];
const TARGET_COUNTS = [100, 300, 500, 1000];
const DEFAULT_TARGET_COUNT = 300;
// Staleness choices for "re_verify" mode -- "never reviewed" schools are
// always included regardless of this number; this only controls how old a
// PAST review has to be before a school is eligible to be re-included. See
// startRun's re_verify branch and school_review_status (the same Postgres
// view the Needs-Review dashboard reads) for what "reviewed" means here:
// hc_first_name/hc_last_name/hc_email/hc_cell/hc_office specifically
// touched via school_change_log, not just "has a value on file."
const STALE_DAY_OPTIONS = [90, 180, 365];
const DEFAULT_STALE_DAYS = 180;
const FETCH_CONCURRENCY = 8; // matches the weekly automated cron's own concurrency (app/api/cron/weekly-coach-info-batch) -- this manual page used to run at 3, well under what the same fetch/search calls handle fine unattended, which just meant a longer wait staring at this tab for a same-size run
// Applying a suggestion is just two small DB writes (no web fetch, no AI
// call) -- can safely run more of these in parallel than the page-fetching
// step above, which is why bulk-apply uses its own higher concurrency.
const APPLY_CONCURRENCY = 5;
// ad_name/ad_email are the Athletic Director fallback contact -- a separate
// pair of fields from the hc_* head-coach ones, captured by the same AI
// lookup alongside them (see lib/coachInfoLookup.js's SYSTEM_PROMPT).
// Included here so they show up in the changed-fields diff below and get
// written on Apply exactly like every other suggested field.
const SUGGESTION_FIELDS = ["hc_first_name", "hc_last_name", "hc_email", "hc_office", "hc_cell", "hc_twitter", "hc_facebook", "ad_name", "ad_email"];
const FIELD_LABELS = {
  hc_first_name: "First name",
  hc_last_name: "Last name",
  hc_email: "Email",
  hc_office: "Office phone",
  hc_cell: "Cell",
  hc_twitter: "Twitter / X",
  hc_facebook: "Facebook",
  ad_name: "Athletic Director",
  ad_email: "AD email",
};

const ITEM_SELECT =
  "id,batch_run_id,school_id,fetch_status,suggestion,suggestion_error,review_status,school:schools(id,name,city,state,hc_first_name,hc_last_name,hc_email,hc_cell,hc_office,hc_twitter,hc_facebook,ad_name,ad_email,athletics_url,website,verification_status,last_verified_at)";

async function runWithConcurrency(items, limit, worker) {
  let next = 0;
  async function runNext() {
    const i = next++;
    if (i >= items.length) return;
    await worker(items[i], i);
    return runNext();
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runNext));
}

// Quick Fix drafts survive navigating away from this page and back --
// Larry's ask: clicking "Open" (or any other link) to check something on a
// school's own record, or switching to a different admin page entirely,
// shouldn't blow away an in-progress edit. sessionStorage (not localStorage)
// on purpose: a draft is a working scratchpad, not something that should
// follow a reviewer to their next login days later -- it survives
// navigation within the tab but clears when the tab/browser closes. One key
// for the whole page (not scoped per run) so it can be read back
// synchronously the instant this component remounts, before the run list
// has even loaded -- the alternative (keying by run id) would need
// selectedRunId resolved first, which only this page's own run happens to
// be recoverable from the URL that early. The stored runId is carried along
// anyway so a restored draft can be told apart from one belonging to a run
// that's no longer open, if that's ever needed; today it's harmless either
// way since the editor only actually renders once its itemId shows up in
// whichever run's rows are on screen. See the editingId/editDraft useState
// initializers and the persistence effect below for how this gets read back
// on remount and kept in sync.
const QUICK_FIX_STORAGE_KEY = "csdQuickFix:coachInfo";
function readStoredQuickFix() {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(QUICK_FIX_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

function StatusBadge({ status }) {
  const labels = {
    collecting: ["Fetching sources", "#697386"],
    submitted: ["Submitted to Anthropic", "#2f5fa8"],
    processing: ["Processing", "#2f5fa8"],
    ready: ["Ready to collect", "#8a6100"],
    collected: ["Ready for review", "#1e7145"],
    error: ["Error", "#b3261e"],
  };
  const [label, color] = labels[status] || [status, "#697386"];
  return (
    <span className="badge" style={{ color, background: `${color}1a`, fontWeight: 600 }}>
      {label}
    </span>
  );
}

// Days between now and a timestamp, floored -- used by WaitingBadge below so
// a run sitting "ready to collect" (or still processing) for a while doesn't
// quietly get forgotten under newer runs.
function daysSince(dateStr) {
  if (!dateStr) return null;
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / 86400000);
}

// Short, scannable "when" label for a reviewed_at timestamp -- Larry's ask
// was specifically to be able to look at an already-reviewed row and tell
// he already completed it. Relative for anything in the last week (today/
// yesterday/Nd ago, reusing daysSince above), falling back to a short
// absolute date beyond that so it doesn't turn into "47d ago" clutter for
// an old run someone's re-opened.
function fmtReviewedRelative(dateStr) {
  if (!dateStr) return "";
  const days = daysSince(dateStr);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// Label + color for the reviewed-status badge. confirmed_no_data reads as
// a positive outcome (green, same as Applied) -- it means someone looked
// and confirmed there's genuinely nothing there, not that the row got
// passed over the way an actual Skip does. Previously this fell through
// to the plain "Skipped" label/color for every non-"applied" status,
// which mislabeled a confirmed-no-data row -- fixed here alongside adding
// the date.
function reviewedBadgeInfo(status) {
  if (status === "applied") return { label: "✓ Applied", color: "#1e7145" };
  if (status === "confirmed_no_data") return { label: "✓ No data available", color: "#1e7145" };
  return { label: "Skipped", color: "#697386" };
}

function WaitingBadge({ run }) {
  if (run.status === "ready") {
    const days = daysSince(run.ready_at);
    if (days === null || days < 1) return null;
    const stale = days >= 3;
    const color = stale ? "#b3261e" : "#8a6100";
    return (
      <span
        className="badge"
        title="Anthropic batch finished and has been waiting to be collected"
        style={{ color, background: `${color}1a`, fontWeight: 600, marginLeft: 6 }}
      >
        ⏳ waiting {days}d
      </span>
    );
  }
  if (run.status === "submitted" || run.status === "processing") {
    const days = daysSince(run.submitted_at);
    if (days === null || days < 2) return null;
    return (
      <span
        className="badge"
        title="Still processing at Anthropic"
        style={{ color: "#697386", background: "#69738619", fontWeight: 600, marginLeft: 6 }}
      >
        {days}d in progress
      </span>
    );
  }
  return null;
}

// True when a school in this run got marked verification_status="verified"
// AFTER this run was created -- i.e. it was handled through some other
// channel (Needs-Review, a Quick Fix on a different batch tool, a manual
// edit) while this run sat open, making its row here redundant work. Most
// candidate-selection modes already exclude verified schools up front (see
// startRun's .neq("verification_status", "verified")), so this only ever
// fires for a school verified DURING the run's lifetime, or for a
// "re_verify" mode run (which deliberately skips that exclusion since its
// whole point is re-checking stale-but-verified schools -- comparing against
// created_at here is what keeps that case from being flagged as if it were
// new, unexpected overlap instead of the re_verify mode working as designed).
// Scoped to pending rows only -- an applied/skipped row already has its own
// outcome, there's nothing left for this badge to add.
function wasVerifiedElsewhere(item, run) {
  const s = item?.school;
  if (!s || !run) return false;
  if (item.review_status !== "pending") return false;
  if (s.verification_status !== "verified") return false;
  if (!s.last_verified_at) return false;
  return new Date(s.last_verified_at).getTime() > new Date(run.created_at).getTime();
}

// Which run is open, the confidence tier, the search text, and "show
// already-reviewed" all used to live in plain useState -- fine for normal
// in-app clicking around, but a real page reload (the browser discarding a
// backgrounded tab to free memory, hitting refresh, coming back to a
// bookmarked/pasted link) wipes plain component state completely, dropping
// a reviewer right back at an unfiltered, unsearched, first-open-run view
// with no way to get back to where they were except redoing every click.
// Mirroring these four into the URL (see the syncing useEffect below) means
// the URL itself IS the saved view -- a reload re-reads its own address bar
// on the way back up instead of guessing, and the exact same filtered/
// searched screen a reviewer was just looking at survives coming back to
// it. useSearchParams requires a Suspense boundary around the page (see
// BatchCoachInfoPage at the bottom) -- same pattern already used by
// app/(app)/prospects/compare/page.js for the same reason.
function BatchCoachInfoPageInner() {
  const supabase = getSupabaseBrowserClient();
  const { user, profile } = useAuth();
  const canReview = profile?.role === "verifier" || profile?.role === "sysadmin";
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [runs, setRuns] = useState([]);
  const [loadingRuns, setLoadingRuns] = useState(true);
  // How many still-pending suggestions each run has, from
  // coach_info_batch_run_pending (see loadRuns) -- drives "Hide finished
  // runs" below. Keyed by run id; a run with no entry has nothing pending.
  const [runPendingCounts, setRunPendingCounts] = useState({});
  // Latest reviewed_at across a run's items, keyed by run id -- shown as
  // "last worked" on each run row (see loadRuns) so Larry can tell which
  // run he was most recently in without opening each one.
  const [runLastWorked, setRunLastWorked] = useState({});
  // On by default -- once a run has nothing left to review, it stays in
  // this list forever otherwise, and a reviewer has to scroll past every
  // finished run to find the ones still needing work.
  const [hideCompletedRuns, setHideCompletedRuns] = useState(true);
  // Seeded from ?run= on first render so a reload reopens the same run
  // instead of falling back to "auto-select the newest one" -- see the
  // auto-select effect below, which only fires when this is still null.
  const [selectedRunId, setSelectedRunId] = useState(() => {
    const fromUrl = Number(searchParams.get("run"));
    return Number.isFinite(fromUrl) && fromUrl > 0 ? fromUrl : null;
  });
  const [items, setItems] = useState([]);
  const [loadingItems, setLoadingItems] = useState(false);

  // "no_name" (default): the original targeting -- schools with no head
  // coach name on file at all. "missing_email": a school already HAS a
  // coach name but is missing just the email (and often phone/socials) --
  // a much smaller, much closer-to-done pool that the original targeting
  // never touched (it required BOTH name fields blank). "missing_cell":
  // the same idea as missing_email, targeting hc_cell instead -- added so
  // "still need a cell number" can be worked as its own queue instead of
  // being buried inside the general no-name sweep. Since the coach's name
  // is already known in both of these modes, fetch-item passes
  // contactOnly:true and gets buildSearchQuery's name-targeted query
  // (lib/coachInfoLookup.js) instead of the generic "who is the coach"
  // search, so it's more likely to actually surface contact info. Every
  // other mode -- and the single-school button -- gets the open query by
  // default, precisely so a wrong or stale on-file name can still be
  // caught rather than re-confirmed.
  // "re_verify": the odd one out -- every other mode excludes any school
  // this tool has EVER touched before (see startRun's excludedIds below).
  // re_verify is specifically FOR re-including those schools once their
  // info is old enough to be worth a fresh look, using the exact same
  // school_review_status view (and "reviewed" definition) the Needs-Review
  // dashboard uses, scoped by staleDays below. Gets the same open query as
  // "no_name" (not contactOnly) since the whole point is to catch a name
  // that's since gone stale or wrong, not just confirm what's on file.
  // candidateMode and the scope picker below can seed from ?state=&mode= --
  // set when this page is opened via a "Focus →" link from State Progress
  // (/admin/state-progress), so the run this starts targets exactly the
  // gap Larry just looked at instead of the usual "priority states, no
  // coach name" default. Read once on mount; doesn't fight with the
  // run/confidence/q/reviewed persistence above, since these three aren't
  // part of that URL-sync effect.
  const stateFromUrl = searchParams.get("state");
  const modeFromUrl = searchParams.get("mode");
  const [candidateMode, setCandidateMode] = useState(
    ["no_name", "missing_email", "missing_cell"].includes(modeFromUrl) ? modeFromUrl : "no_name"
  ); // "no_name" | "missing_email" | "missing_cell" | "re_verify"
  const [scopeMode, setScopeMode] = useState(stateFromUrl ? "all" : "priority"); // "priority" | "all"
  const [customStates, setCustomStates] = useState(stateFromUrl || PRIORITY_STATES.join(", "));
  // A state deep-link means "clear this whole state" -- 1000 (the largest
  // option) comfortably covers any single state's real gap today. See
  // state_data_coverage.
  const [targetCount, setTargetCount] = useState(stateFromUrl ? 1000 : DEFAULT_TARGET_COUNT);
  // Only used by "re_verify" mode -- a school last reviewed more than this
  // many days ago is eligible to be re-included; never-reviewed schools are
  // always eligible regardless of this number.
  const [staleDays, setStaleDays] = useState(DEFAULT_STALE_DAYS);
  // Off by default so this tool keeps pulling from its full existing pool
  // (athletics URL OR just a general website) unless asked not to. On, it
  // narrows to schools that already have an Athletics URL specifically --
  // an athletics/staff page tends to read cleaner for the model than a
  // school's general homepage, so results skew more accurate at the cost
  // of a smaller candidate pool per run. In "missing_email" mode a URL
  // isn't required at all by default (the name-targeted search alone is
  // often enough), so this only narrows the pool further if turned on.
  const [requireAthletics, setRequireAthletics] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");

  const [fetching, setFetching] = useState(false);
  const [fetchProgress, setFetchProgress] = useState({ done: 0, total: 0 });

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");

  const [checkingStatus, setCheckingStatus] = useState(false);
  const [statusError, setStatusError] = useState("");
  const [lastCheckedStatus, setLastCheckedStatus] = useState("");

  const [collecting, setCollecting] = useState(false);
  const [collectError, setCollectError] = useState("");

  const [applyingId, setApplyingId] = useState(null);
  const [reviewError, setReviewError] = useState("");
  // These three (plus selectedRunId above) are seeded from the URL and kept
  // synced back to it -- see the syncing useEffect below.
  const [showReviewed, setShowReviewed] = useState(() => searchParams.get("reviewed") === "1");
  // Confidence filter -- lets a reviewer work through one tier at a time
  // (e.g. clear every "medium" row after Apply All High-Confidence has
  // taken care of the high ones) instead of scrolling a single mixed list.
  // "all" shows everything, same as before this existed.
  const [confidenceFilter, setConfidenceFilter] = useState(() => {
    const fromUrl = searchParams.get("confidence");
    return ["all", "high", "medium", "low", "reviewed"].includes(fromUrl) ? fromUrl : "all";
  }); // "all" | "high" | "medium" | "low" | "reviewed" -- "reviewed" is a quick-jump filter to the
  // already-reviewed rows (only meaningful, and only shown as a tab, while showReviewed is on --
  // see the reset-on-uncheck logic below) so Larry doesn't have to scroll past every pending row
  // to find the ones with a reviewed-date badge.
  // Free-text filter on school name/city -- useful once a run's list runs
  // into the hundreds and a reviewer wants to jump straight to one school
  // (e.g. checking whether a specific school they were just asked about
  // already has a suggestion queued) instead of scanning the whole table.
  const [searchQuery, setSearchQuery] = useState(() => searchParams.get("q") || "");
  // Bulk-apply: lets a reviewer clear every high-confidence suggestion in a
  // run with one click instead of clicking Apply on each one individually --
  // see bulkApplyHighConfidence below.
  const [bulkApplying, setBulkApplying] = useState(false);
  const [bulkProgress, setBulkProgress] = useState({ done: 0, total: 0 });
  // Bulk-skip: same idea for suggestions with nothing to apply at all --
  // see bulkSkipNoChanges below.
  const [bulkSkipping, setBulkSkipping] = useState(false);
  // CSV mass-review round-trip: Export to CSV already dumps every pending
  // suggestion as one current/suggested pair per field, wide-open for
  // editing in Excel -- this is the other half, re-uploading that (possibly
  // hand-corrected) sheet to apply everything at once instead of clicking
  // Apply on each row on screen. Built for exactly the workflow of scanning
  // hundreds of AI suggestions in a spreadsheet instead of one at a time --
  // see applySuggestionFromCsv below for exactly what a re-upload can and
  // can't change, and why.
  const [csvImporting, setCsvImporting] = useState(false);
  const [csvImportError, setCsvImportError] = useState("");
  const [csvImportProgress, setCsvImportProgress] = useState({ done: 0, total: 0 });
  const [csvImportResult, setCsvImportResult] = useState(null); // {applied, noChange, unmatched, alreadyReviewed, failures}
  const [focusedIndex, setFocusedIndex] = useState(0);
  // The AI's one-paragraph reasoning/notes for each suggestion is collapsed
  // by default (Larry's own words: reading a full paragraph per row on a
  // 100+-item run is "extremely time consuming") -- a row shows just the
  // field-by-field old-value -> new-value summary (or "No changes
  // suggested") plus a "Why?" toggle; clicking it reveals the AI's notes
  // for that one row without reloading anything. Tracked as a Set of item
  // ids rather than a boolean per item so this stays a single small piece
  // of state instead of touching the items array itself.
  const [expandedNotes, setExpandedNotes] = useState(() => new Set());
  function toggleNotes(itemId) {
    setExpandedNotes((prev) => {
      const next = new Set(prev);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });
  }

  // Inline "Quick Fix" editor -- Larry's ask: fix a wrong field on the
  // suggestion (or fill in one the AI missed) without leaving this page for
  // the school's own record. Only one row open at a time (editingId), with
  // its draft values kept separately from item.suggestion so typing doesn't
  // mutate the AI's original output -- Cancel just drops the draft. Seeded
  // with the suggested value where there is one, falling back to what's
  // already on file, so every field always starts as *something* real
  // rather than blank.
  // Seeded synchronously from sessionStorage -- available at first render,
  // before the run list or items have even loaded, so a draft in progress
  // is back on screen the instant this page remounts. Only reads on mount,
  // by design -- the persistence effect below is what keeps it saved as it
  // changes.
  const [editingId, setEditingId] = useState(() => readStoredQuickFix()?.itemId ?? null);
  const [editDraft, setEditDraft] = useState(() => readStoredQuickFix()?.draft || {});
  const [savingEdit, setSavingEdit] = useState(false);
  const [editError, setEditError] = useState("");

  // Undo toast -- a Quick Fix save is a hand-typed correction with no review
  // step of its own (unlike Apply, which is at least confirming an AI
  // suggestion someone already looked at), so a wrong keystroke deserves a
  // quick way back out without having to find the school's own record.
  // Single-slot on purpose (one toast at a time, the most recent save) --
  // auto-clears after 8s via undoTimeoutRef, cleared/reset on every new save
  // so an old timer can't null out a toast for a save that just happened.
  const [undoToast, setUndoToast] = useState(null);
  const undoTimeoutRef = useRef(null);
  useEffect(() => () => clearTimeout(undoTimeoutRef.current), []);

  // Keeps sessionStorage in lockstep with the editor -- open/type a field/
  // cancel/save all flow through editingId/editDraft, so mirroring just
  // those two into storage (instead of scattering setItem/removeItem calls
  // across openEdit/updateDraftField/cancelEdit/saveEdit) covers every path
  // that changes them, including the toggle-closed case in openEdit. The
  // run id rides along purely as a label for anyone debugging a stale
  // entry -- restoring never depends on it.
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      if (editingId !== null) {
        window.sessionStorage.setItem(QUICK_FIX_STORAGE_KEY, JSON.stringify({ runId: selectedRunId, itemId: editingId, draft: editDraft }));
      } else {
        window.sessionStorage.removeItem(QUICK_FIX_STORAGE_KEY);
      }
    } catch (_) {
      // Storage can throw in a private tab with site data blocked -- a lost
      // draft on save/cancel isn't worth surfacing an error over.
    }
  }, [editingId, editDraft, selectedRunId]);

  function draftFromItem(item) {
    const s = item.school || {};
    const sug = item.suggestion || {};
    const draft = {};
    SUGGESTION_FIELDS.forEach((f) => {
      draft[f] = (sug[f] || s[f] || "").toString();
    });
    return draft;
  }

  function openEdit(item) {
    if (editingId === item.id) {
      setEditingId(null);
      return;
    }
    setEditingId(item.id);
    setEditDraft(draftFromItem(item));
    setEditError("");
  }

  function cancelEdit() {
    setEditingId(null);
    setEditDraft({});
    setEditError("");
  }

  function updateDraftField(field, value) {
    setEditDraft((prev) => ({ ...prev, [field]: value }));
  }

  // Reuses applySuggestionFromCsv's write path below -- it already takes a
  // plain {field: value} object instead of item.suggestion and handles the
  // same verified/estimated-email nuance a hand-typed correction should get
  // too (typing a real email over a pattern-estimated guess IS a human
  // confirming it, so that case still marks the record verified). This is
  // the same logic a CSV re-upload runs per row, just driven from the
  // inline inputs instead of a spreadsheet cell.
  async function saveEdit(item) {
    setSavingEdit(true);
    setEditError("");
    // Snapshot exactly what's on file right now, before this write --
    // undoQuickFixSave below restores from this, not from item.suggestion,
    // so Undo always gets back to the real prior state even if the draft
    // only touched one of the nine fields.
    const previousSchool = { ...(item.school || {}) };
    const previousReviewStatus = item.review_status;
    const effectiveFields = {};
    SUGGESTION_FIELDS.forEach((f) => {
      const v = (editDraft[f] || "").trim();
      if (v) effectiveFields[f] = v;
    });
    const result = await applySuggestionFromCsv(item, effectiveFields);
    if (result.ok) {
      setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, review_status: result.changed ? "applied" : "skipped" } : i)));
      setEditingId(null);
      setEditDraft({});
      if (result.changed) {
        clearTimeout(undoTimeoutRef.current);
        const toastId = Date.now();
        setUndoToast({ id: toastId, itemId: item.id, schoolName: previousSchool.name, previousSchool, previousReviewStatus });
        undoTimeoutRef.current = setTimeout(() => {
          setUndoToast((cur) => (cur && cur.id === toastId ? null : cur));
        }, 8000);
      }
    } else {
      setEditError(result.error);
    }
    setSavingEdit(false);
  }

  // Reverts a Quick Fix save back to exactly what was on file before it --
  // restores every suggestion field (plus verification_status/
  // last_verified_at) to the snapshot saveEdit took beforehand, logs one
  // school_change_log row per field actually reverted (current -> restored,
  // source "Quick Fix Undo") so the audit trail shows the correction AND the
  // undo rather than silently erasing the first entry, and puts the batch
  // item back to review_status="pending" (or whatever it was before, on the
  // rare chance it wasn't pending) so it's back in the working queue.
  async function undoQuickFixSave() {
    if (!undoToast) return;
    const { itemId, previousSchool, previousReviewStatus } = undoToast;
    setReviewError("");
    try {
      const current = items.find((i) => i.id === itemId)?.school || {};
      const restore = {};
      const changes = [];
      SUGGESTION_FIELDS.forEach((f) => {
        const priorVal = previousSchool[f] || null;
        const curVal = current[f] || null;
        if (priorVal !== curVal) {
          restore[f] = priorVal;
          changes.push({ school_id: previousSchool.id, field_name: f, old_value: curVal, new_value: priorVal, source: "Quick Fix Undo -- reverted to pre-save value", changed_by: user.id });
        }
      });
      restore.verification_status = previousSchool.verification_status ?? null;
      restore.last_verified_at = previousSchool.last_verified_at ?? null;
      const { error: updateErr } = await supabase.from("schools").update(restore).eq("id", previousSchool.id);
      if (updateErr) throw updateErr;
      if (changes.length > 0) {
        const { error: logErr } = await supabase.from("school_change_log").insert(changes);
        if (logErr) throw logErr;
      }
      const { error: itemErr } = await supabase
        .from("coach_info_batch_items")
        .update({ review_status: previousReviewStatus, reviewed_at: null, reviewed_by: null })
        .eq("id", itemId);
      if (itemErr) throw itemErr;
      setItems((prev) => prev.map((i) => (i.id === itemId ? { ...i, review_status: previousReviewStatus, school: { ...i.school, ...restore } } : i)));
      setUndoToast(null);
      clearTimeout(undoTimeoutRef.current);
    } catch (err) {
      setReviewError(err.message || "Could not undo this save.");
    }
  }

  const selectedRun = runs.find((r) => r.id === selectedRunId) || null;

  const readyCount = items.filter((i) => i.fetch_status === "ready").length;
  const pendingFetchCount = items.filter((i) => i.fetch_status === "pending").length;
  const noContentCount = items.filter((i) => i.fetch_status === "no_content").length;
  const suggestedItems = items.filter((i) => i.suggestion);
  const pendingReview = suggestedItems.filter((i) => i.review_status === "pending");
  const reviewedItems = suggestedItems.filter((i) => i.review_status !== "pending");
  // Quick same-day progress count for the summary line below -- "today"
  // uses the same daysSince semantics as WaitingBadge elsewhere on this
  // page (within the last 24 hours, not strictly the same calendar day).
  const reviewedTodayCount = reviewedItems.filter((i) => i.reviewed_at && daysSince(i.reviewed_at) === 0).length;
  // Pending only -- once confirmed via confirmNoDataAvailable, review_status
  // moves to "confirmed_no_data" (folding into reviewedItems below) even
  // though suggestion_error is still set on the row, so this must check both
  // or a confirmed row would keep showing up in the "Confirm no data
  // available" section forever.
  const failedItems = suggestedItems.filter((i) => i.suggestion_error && i.review_status === "pending");
  const highConfidencePendingCount = pendingReview.filter((i) => i.suggestion?.confidence === "high").length;

  // Whether a run still has something actionable left -- a run that's not
  // "collected" yet is always still open (nothing to hide, it's mid-flight).
  // For a "collected" run: the one currently on screen uses the live
  // pendingReview count above (so it doesn't vanish out from under a
  // reviewer clearing the last few rows -- runPendingCounts only refreshes
  // on the next loadRuns), every other run uses the count fetched from
  // coach_info_batch_run_pending.
  function isRunOpen(r) {
    if (r.status !== "collected") return true;
    if (r.id === selectedRunId) return pendingReview.length > 0;
    return (runPendingCounts[r.id] || 0) > 0;
  }
  const openRunsCount = runs.filter(isRunOpen).length;
  const visibleRunsList = hideCompletedRuns ? runs.filter(isRunOpen) : runs;
  // Suggestions where every field already matches what's on file -- the
  // coach was confirmed but nothing new turned up (no email, phone, or
  // social found anywhere), regardless of confidence tier. Skip never
  // writes to the schools table or school_change_log the way Apply does,
  // so clearing all of these in one click carries none of the risk Apply
  // All High-Confidence has to guard against -- there's nothing here TO
  // get wrong. Same field-by-field diff the table below uses per row.
  const noChangesPendingItems = pendingReview.filter((i) => {
    const s = i.school;
    const sug = i.suggestion;
    if (!s || !sug) return false;
    return !SUGGESTION_FIELDS.some((f) => {
      const suggested = (sug[f] || "").trim();
      return suggested && suggested !== (s[f] || "");
    });
  });
  const noChangesPendingCount = noChangesPendingItems.length;
  // Pending rows whose school already got verified through some other
  // channel since this run started -- see wasVerifiedElsewhere above.
  const verifiedElsewhereItems = pendingReview.filter((i) => wasVerifiedElsewhere(i, selectedRun));

  // Matches a row against the current search box -- school name, city, OR
  // a coach's name/email, case-insensitive, same loose substring match a
  // reviewer would expect from a quick filter box. Checks both the coach
  // already on file (s.hc_*) and the AI's suggested coach (sug.hc_*), so
  // typing a name finds the row whether that name is the old value, the
  // new value, or (the common case) both -- a reviewer spot-checking
  // against a source they already have open (a conference site, a text
  // from a colleague) can jump straight to that coach's row instead of
  // scrolling to find their school.
  function matchesSearch(item) {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return true;
    const s = item.school;
    const sug = item.suggestion;
    const haystack = [
      s?.name,
      s?.city,
      s?.hc_first_name,
      s?.hc_last_name,
      s?.hc_email,
      s?.hc_twitter,
      s?.hc_facebook,
      sug?.hc_first_name,
      sug?.hc_last_name,
      sug?.hc_email,
      sug?.hc_twitter,
      sug?.hc_facebook,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return haystack.includes(q);
  }

  // Base row set the table renders from -- everything still pending, or
  // (with "Show already-reviewed" checked) every suggested item -- with
  // the confidence tier and search box both applied on top. Computed once
  // here rather than inline in the JSX so the on-screen counts next to
  // each confidence button, the rendered rows, and the keyboard-nav
  // targets below can never quietly disagree about what's actually
  // visible.
  const reviewBaseRowsUnsorted = (showReviewed ? suggestedItems : pendingReview).filter((i) => !i.suggestion_error);
  // With "Show already-reviewed" on, keep the still-pending rows up front
  // (they're the ones actually needing a decision) and sort the reviewed
  // ones newest-first by reviewed_at -- Larry's ask: whatever he just
  // finished should surface at the top instead of sitting wherever it
  // happened to land in the original fetch order.
  const reviewBaseRows = showReviewed
    ? [
        ...reviewBaseRowsUnsorted.filter((i) => i.review_status === "pending"),
        ...reviewBaseRowsUnsorted.filter((i) => i.review_status !== "pending").sort((a, b) => new Date(b.reviewed_at || 0) - new Date(a.reviewed_at || 0)),
      ]
    : reviewBaseRowsUnsorted;
  const confidenceCounts = {
    all: reviewBaseRows.length,
    high: reviewBaseRows.filter((i) => i.suggestion?.confidence === "high").length,
    medium: reviewBaseRows.filter((i) => i.suggestion?.confidence === "medium").length,
    low: reviewBaseRows.filter((i) => i.suggestion?.confidence === "low").length,
    // Count of already-reviewed rows within the current base set -- only
    // non-zero (and only rendered as a tab) while showReviewed is on, since
    // reviewBaseRows excludes reviewed items otherwise.
    reviewed: reviewBaseRows.filter((i) => i.review_status !== "pending").length,
  };
  const visibleRows = reviewBaseRows.filter((i) => {
    // "reviewed" isn't a confidence tier -- it's a shortcut to the
    // already-reviewed rows so Larry can jump straight to the ones with a
    // reviewed-date badge instead of scrolling past every pending row first.
    const tierMatch = confidenceFilter === "reviewed" ? i.review_status !== "pending" : confidenceFilter === "all" || i.suggestion?.confidence === confidenceFilter;
    return tierMatch && matchesSearch(i);
  });

  // Keyboard-nav targets mirror the table's own row filter (pendingReview,
  // minus suggestion_error items, with the same confidence/search filters
  // the visible table uses) so the focused row always lines up with what's
  // actually on screen -- reviewed rows are excluded here regardless of
  // "Show already-reviewed" since there's nothing left to apply/skip on one.
  const keyboardTargets = pendingReview.filter(
    (i) => !i.suggestion_error && (confidenceFilter === "all" || i.suggestion?.confidence === confidenceFilter) && matchesSearch(i)
  );
  const clampedFocusedIndex = keyboardTargets.length === 0 ? 0 : Math.min(focusedIndex, keyboardTargets.length - 1);
  const focusedItem = keyboardTargets[clampedFocusedIndex] || null;

  // Keyboard shortcuts for the review queue -- Up/Down move focus between
  // pending rows, A applies the focused row, S skips it, E opens/closes the
  // inline Quick Fix editor on the focused row, Escape backs out of it.
  // Escape is checked before the "typing into a field" bail-out below so it
  // still works while an edit input is focused (that's the whole point --
  // canceling out of the editor you're typing in); every other shortcut
  // still requires focus to be off any form field. Only active while this
  // run is at the "collected" review stage and nothing's mid-flight.
  useEffect(() => {
    function onKeyDown(e) {
      if (selectedRun?.status !== "collected") return;
      if (bulkApplying || bulkSkipping || applyingId) return;
      if (e.key === "Escape" && editingId !== null) {
        e.preventDefault();
        cancelEdit();
        return;
      }
      const tag = document.activeElement?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      if (e.key === "ArrowDown") {
        e.preventDefault();
        setFocusedIndex((prev) => (keyboardTargets.length === 0 ? 0 : Math.min(prev + 1, keyboardTargets.length - 1)));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setFocusedIndex((prev) => Math.max(prev - 1, 0));
      } else if (e.key === "a" || e.key === "A") {
        if (focusedItem) {
          e.preventDefault();
          applyItem(focusedItem);
        }
      } else if (e.key === "s" || e.key === "S") {
        if (focusedItem) {
          e.preventDefault();
          skipItem(focusedItem);
        }
      } else if (e.key === "e" || e.key === "E") {
        if (focusedItem) {
          e.preventDefault();
          openEdit(focusedItem);
        }
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedRun?.status, bulkApplying, bulkSkipping, applyingId, focusedItem, keyboardTargets.length, editingId]);

  // Narrowing the confidence filter or typing a search query changes which
  // rows count as keyboard-nav targets -- reset focus to the top of the new
  // list rather than leaving it pointed at an index that may now be a
  // completely different (or nonexistent) row.
  useEffect(() => {
    setFocusedIndex(0);
  }, [confidenceFilter, searchQuery]);

  // Keeps the URL's query string in lockstep with the four pieces of state
  // that define "what this reviewer is currently looking at" -- which run,
  // which confidence tier, the search text, and whether reviewed rows are
  // showing. router.replace (not push) so scrolling through search
  // keystrokes or clicking between confidence tabs doesn't spam the
  // browser's back-button history with a new entry per change -- it just
  // keeps the CURRENT url accurate. scroll:false stops Next.js from
  // jumping the page back to top on every sync. This is what makes the
  // reload-survival above actually work: the URL only helps if it's always
  // current, not just set once on load.
  useEffect(() => {
    const params = new URLSearchParams();
    if (selectedRunId) params.set("run", String(selectedRunId));
    if (confidenceFilter !== "all") params.set("confidence", confidenceFilter);
    if (searchQuery.trim()) params.set("q", searchQuery);
    if (showReviewed) params.set("reviewed", "1");
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [selectedRunId, confidenceFilter, searchQuery, showReviewed, pathname, router]);

  const loadRuns = useCallback(async () => {
    setLoadingRuns(true);
    const { data } = await supabase.from("coach_info_batch_runs").select("*").order("created_at", { ascending: false }).limit(30);
    setRuns(data || []);
    // How many suggestions each run still has waiting on a decision --
    // reads coach_info_batch_run_pending, a small Postgres view that
    // counts pending, actually-has-a-suggestion items per run (same
    // "reviewed" bar suggestedItems/pendingReview use below), so "Hide
    // finished runs" doesn't need to pull every item row for every run
    // client-side just to figure out which ones are done.
    const ids = (data || []).map((r) => r.id);
    if (ids.length) {
      const [{ data: pendingRows }, { data: reviewedRows }] = await Promise.all([
        supabase.from("coach_info_batch_run_pending").select("batch_run_id,pending_count").in("batch_run_id", ids),
        // Last-worked date per run -- just the two columns needed to find
        // the max reviewed_at client-side, cheap even for a run with a
        // thousand items, and avoids needing a dedicated view the way the
        // pending-count query above does (that one aggregates database-wide
        // per run; this one only ever looks at these 30 runs' own rows).
        supabase.from("coach_info_batch_items").select("batch_run_id,reviewed_at").in("batch_run_id", ids).not("reviewed_at", "is", null),
      ]);
      const counts = {};
      (pendingRows || []).forEach((row) => {
        counts[row.batch_run_id] = row.pending_count;
      });
      setRunPendingCounts(counts);
      const lastWorked = {};
      (reviewedRows || []).forEach((row) => {
        const cur = lastWorked[row.batch_run_id];
        if (!cur || new Date(row.reviewed_at) > new Date(cur)) lastWorked[row.batch_run_id] = row.reviewed_at;
      });
      setRunLastWorked(lastWorked);
    } else {
      setRunPendingCounts({});
      setRunLastWorked({});
    }
    setLoadingRuns(false);
  }, [supabase]);

  useEffect(() => {
    loadRuns();
  }, [loadRuns]);

  // Auto-selects a run the first time the page loads, instead of requiring
  // a click into the run list every single visit -- picks the newest run
  // that's actually ready to review (status "collected") since that's what
  // a reviewer opens this page to do most of the time, falling back to the
  // single newest run of any status (so a run still collecting/submitted is
  // visible rather than an empty screen) if none are collected yet. Only
  // fires while nothing is already selected -- never overrides a run the
  // reviewer has deliberately opened.
  useEffect(() => {
    if (selectedRunId || runs.length === 0) return;
    const newestCollected = runs.find((r) => r.status === "collected");
    setSelectedRunId((newestCollected || runs[0]).id);
  }, [runs, selectedRunId]);

  const loadItems = useCallback(
    async (runId) => {
      if (!runId) return;
      setLoadingItems(true);
      const { data } = await supabase.from("coach_info_batch_items").select(ITEM_SELECT).eq("batch_run_id", runId).order("id");
      // A school can get verified through a completely different channel --
      // Needs-Review, a Quick Fix on another batch tool, a manual profile
      // edit, even this same tool's Apply on a DIFFERENT run -- any time
      // after this run was created. wasVerifiedElsewhere() below already
      // flags that with a badge, but a reviewer still had to notice it and
      // click Skip (or Skip All) by hand in every run it happened to be
      // sitting in, including ones they might never reopen. Auto-skip those
      // rows the moment a run's items load instead, so a school verified
      // once stops asking for review anywhere else it's still pending.
      const run = runs.find((r) => r.id === runId);
      const staleIds = run ? (data || []).filter((i) => wasVerifiedElsewhere(i, run)).map((i) => i.id) : [];
      if (staleIds.length > 0) {
        const now = new Date().toISOString();
        await supabase.from("coach_info_batch_items").update({ review_status: "skipped", reviewed_at: now, reviewed_by: user.id }).in("id", staleIds);
        (data || []).forEach((i) => {
          if (staleIds.includes(i.id)) {
            i.review_status = "skipped";
            i.reviewed_at = now;
            i.reviewed_by = user.id;
          }
        });
      }
      setItems(data || []);
      setLoadingItems(false);
    },
    [supabase, runs, user]
  );

  useEffect(() => {
    if (selectedRunId) loadItems(selectedRunId);
  }, [selectedRunId, loadItems]);

  function openRun(runId) {
    setSelectedRunId(runId);
    setEditingId(null);
    setEditError("");
    setCreateError("");
    setSubmitError("");
    setStatusError("");
    setCollectError("");
    setReviewError("");
    setFocusedIndex(0);
  }

  async function startRun() {
    setCreateError("");
    setCreating(true);
    try {
      const states = scopeMode === "priority" ? PRIORITY_STATES : customStates.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);

      let schoolsData;

      if (candidateMode === "re_verify") {
        // The odd one out: every other mode below excludes any school this
        // tool has ever touched (see the excludedIds block in the else
        // branch) -- re_verify's whole purpose is to go back and re-include
        // exactly those schools once enough time has passed that their info
        // is worth a fresh look, so it does NOT apply that exclusion.
        //
        // Reads school_review_status -- the same Postgres view the
        // Needs-Review dashboard (/admin/needs-review) reads -- so both
        // tools agree on one definition of "reviewed": hc_first_name/
        // hc_last_name/hc_email/hc_cell/hc_office specifically touched via
        // school_change_log, not just "has a value on file" (99%+ of
        // schools already have SOMETHING from the original import that was
        // never actually re-checked). never_reviewed schools are always
        // eligible; previously-reviewed ones need days_since_review >=
        // staleDays. Oldest/never-checked first, same ordering the
        // dashboard uses.
        let viewQuery = supabase
          .from("school_review_status")
          .select("id,name,city,state")
          .or(`never_reviewed.eq.true,days_since_review.gte.${staleDays}`)
          .order("never_reviewed", { ascending: false })
          .order("days_since_review", { ascending: false, nullsFirst: true })
          .limit(targetCount * 3);
        if (scopeMode !== "all" || states.length) {
          viewQuery = viewQuery.in("state", states);
        }
        const { data: rawReviewRows, error: viewErr } = await viewQuery;
        if (viewErr) throw viewErr;
        schoolsData = rawReviewRows || [];

        // school_review_status doesn't carry athletics_url/website (it's
        // scoped to the coach-contact fields), so requireAthletics needs a
        // second, narrower lookup against the real schools table -- same
        // "athletics URL specifically" check the other modes use -- rather
        // than duplicating those columns into the view.
        if (requireAthletics && schoolsData.length) {
          const { data: withAthletics, error: athErr } = await supabase
            .from("schools")
            .select("id")
            .in("id", schoolsData.map((s) => s.id))
            .not("athletics_url", "is", null)
            .neq("athletics_url", "");
          if (athErr) throw athErr;
          const athleticsIds = new Set((withAthletics || []).map((r) => r.id));
          schoolsData = schoolsData.filter((s) => athleticsIds.has(s.id));
        }

        schoolsData = schoolsData.slice(0, targetCount);
        if (!schoolsData || schoolsData.length === 0) {
          setCreateError(
            `No schools matched -- everyone in this scope was reviewed within the last ${staleDays} days (or requireAthletics narrowed the pool to nothing). Try a shorter staleness window, a wider state scope, or turning off "Require an Athletics URL."`
          );
          return;
        }
      } else {
        // Excludes every school that's EVER gone through this tool before --
        // applied, skipped, or a suggestion that errored out -- not just ones
        // sitting in a still-open run. Without this, clicking Apply or Skip
        // didn't stop a school from coming right back the next time someone
        // clicked "Start Run": nothing marked it as already looked at, so the
        // same "no email/social found anywhere" schools kept resurfacing.
        // Over-fetches 3x and filters client-side (same approach the weekly
        // cron uses) rather than a giant SQL "not in" list, which Supabase
        // struggles with once this table has thousands of rows across many
        // runs. The single-school "Suggest Coach Info (AI)" button on a
        // school's own profile page is unaffected -- that's still there any
        // time someone wants to force a fresh look at one specific school.
        // (re_verify above is the other, run-level way to force another
        // look -- at a whole stale slice of schools at once.)
        const { data: touchedRows, error: touchedErr } = await supabase.from("coach_info_batch_items").select("school_id");
        if (touchedErr) throw touchedErr;
        const excludedIds = new Set((touchedRows || []).map((r) => r.school_id));

        let query = supabase
          .from("schools")
          .select("id,name,city,state")
          // Closed/discontinued schools will never have a real coach to
          // find -- see lib/dataQuality.js.
          .eq("is_closed", false)
          // Skip schools Larry has already marked reviewed/confirmed-accurate
          // (verification_status = "verified") even if a name/email field
          // above still reads blank -- a human already looked at this
          // record, so it shouldn't come back through an automated sweep.
          // Deliberately NOT applied to the re_verify branch above -- that
          // mode's whole point is going back and re-checking schools that
          // WERE reviewed but have gone stale (see its own comment), so
          // filtering out verified schools there would defeat it. Also
          // doesn't affect the single-school "Suggest Coach Info (AI)"
          // button on a school's own profile.
          .neq("verification_status", "verified")
          .order("id", { ascending: true })
          .limit(targetCount * 3);

        if (candidateMode === "missing_email") {
          // Coach's name is already on file -- just the email is missing.
          // The opposite condition from "no_name" below (De Morgan's on the
          // same blank checks): both name fields present, email blank.
          query = query
            .not("hc_first_name", "is", null)
            .neq("hc_first_name", "")
            .not("hc_last_name", "is", null)
            .neq("hc_last_name", "")
            .or("hc_email.is.null,hc_email.eq.");
        } else if (candidateMode === "missing_cell") {
          // Same idea as missing_email, targeting hc_cell instead -- name
          // known, cell blank.
          query = query
            .not("hc_first_name", "is", null)
            .neq("hc_first_name", "")
            .not("hc_last_name", "is", null)
            .neq("hc_last_name", "")
            .or("hc_cell.is.null,hc_cell.eq.");
        } else {
          query = query.or("hc_first_name.is.null,hc_first_name.eq.").or("hc_last_name.is.null,hc_last_name.eq.");
        }

        // requireAthletics narrows the source pool to just Athletics URL.
        // Outside that, "no_name" mode keeps the looser "athletics OR general
        // website" check this tool has always used (a page to search from is
        // essential when the coach isn't known yet); "missing_email"/
        // "missing_cell" modes don't require a URL at all by default -- the
        // name-targeted search alone is usually enough to find contact info,
        // and requiring a URL here would needlessly shrink an already-small
        // candidate pool.
        if (requireAthletics) {
          query = query.not("athletics_url", "is", null).neq("athletics_url", "");
        } else if (candidateMode !== "missing_email" && candidateMode !== "missing_cell") {
          query = query.or("athletics_url.not.is.null,website.not.is.null");
        }

        if (scopeMode !== "all" || states.length) {
          query = query.in("state", states);
        }

        const { data: rawSchoolsData, error: schoolsErr } = await query;
        if (schoolsErr) throw schoolsErr;
        schoolsData = (rawSchoolsData || []).filter((s) => !excludedIds.has(s.id)).slice(0, targetCount);
        if (!schoolsData || schoolsData.length === 0) {
          setCreateError(
            candidateMode === "missing_email"
              ? "No schools matched -- everyone with a coach name on file in this scope already has an email, or has already been through this tool before."
              : candidateMode === "missing_cell"
              ? "No schools matched -- everyone with a coach name on file in this scope already has a cell number, or has already been through this tool before."
              : "No schools matched -- everyone missing coach info in this scope has already been through this tool before, or has no website/athletics URL on file to search from."
          );
          return;
        }
      }

      const { data: runRow, error: runErr } = await supabase
        .from("coach_info_batch_runs")
        .insert({
          status: "collecting",
          state_filter: scopeMode === "all" && states.length === 0 ? null : states,
          requested_count: schoolsData.length,
          created_by: user.id,
          candidate_mode: candidateMode,
        })
        .select()
        .single();
      if (runErr) throw runErr;

      const itemRows = schoolsData.map((s) => ({ batch_run_id: runRow.id, school_id: s.id }));
      const { error: itemsErr } = await supabase.from("coach_info_batch_items").insert(itemRows);
      if (itemsErr) throw itemsErr;

      await loadRuns();
      openRun(runRow.id);
    } catch (err) {
      setCreateError(err.message || "Could not start a new batch run.");
    } finally {
      setCreating(false);
    }
  }

  async function fetchSources() {
    const toFetch = items.filter((i) => i.fetch_status === "pending");
    if (!toFetch.length) return;
    setFetching(true);
    setFetchProgress({ done: 0, total: toFetch.length });
    let done = 0;
    await runWithConcurrency(toFetch, FETCH_CONCURRENCY, async (item) => {
      try {
        const {
          data: { session },
        } = await supabase.auth.getSession();
        const res = await fetch("/api/admin/batch-coach-info/fetch-item", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token}` },
          body: JSON.stringify({ itemId: item.id }),
        });
        const json = await res.json().catch(() => ({}));
        const newStatus = res.ok ? json.fetch_status : "error";
        setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, fetch_status: newStatus } : i)));
      } catch (_) {
        setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, fetch_status: "error" } : i)));
      } finally {
        done++;
        setFetchProgress({ done, total: toFetch.length });
      }
    });
    setFetching(false);
  }

  async function submitRun() {
    if (!selectedRun) return;
    setSubmitting(true);
    setSubmitError("");
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const res = await fetch(`/api/admin/batch-coach-info/${selectedRun.id}/submit`, {
        method: "POST",
        headers: { Authorization: `Bearer ${session?.access_token}` },
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Could not submit this run.");
      await loadRuns();
    } catch (err) {
      setSubmitError(err.message || "Could not submit this run.");
    } finally {
      setSubmitting(false);
    }
  }

  async function checkStatus() {
    if (!selectedRun) return;
    setCheckingStatus(true);
    setStatusError("");
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const res = await fetch(`/api/admin/batch-coach-info/${selectedRun.id}/check-status`, {
        headers: { Authorization: `Bearer ${session?.access_token}` },
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Could not check this run's status.");
      setLastCheckedStatus(json.processing_status || "");
      await loadRuns();
    } catch (err) {
      setStatusError(err.message || "Could not check this run's status.");
    } finally {
      setCheckingStatus(false);
    }
  }

  async function collectResults() {
    if (!selectedRun) return;
    setCollecting(true);
    setCollectError("");
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const res = await fetch(`/api/admin/batch-coach-info/${selectedRun.id}/collect`, {
        method: "POST",
        headers: { Authorization: `Bearer ${session?.access_token}` },
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Could not collect this run's results.");
      await loadRuns();
      await loadItems(selectedRun.id);
    } catch (err) {
      setCollectError(err.message || "Could not collect this run's results.");
    } finally {
      setCollecting(false);
    }
  }

  // Shared write logic for applying one item's suggestion -- used by both
  // the single-item "Apply" button and bulkApplyHighConfidence below, so
  // there's exactly one place that decides what "applying a suggestion"
  // means. Returns { ok, error } instead of throwing so a bulk run can keep
  // going past one item's failure and report a combined summary at the end.
  async function applySuggestionCore(item) {
    const s = item.school;
    const sug = item.suggestion;
    if (!s || !sug) return { ok: false, error: "Missing school or suggestion." };
    try {
      const update = {};
      const changes = [];
      SUGGESTION_FIELDS.forEach((f) => {
        const newVal = (sug[f] || "").trim();
        if (newVal && newVal !== (s[f] || "")) {
          update[f] = newVal;
          // hc_email gets its own distinct source label when it's a
          // pattern-derived estimate rather than an address actually found
          // on file somewhere -- so school_change_log (and Data Quality's
          // "My Recent Updates") always shows, permanently, that this
          // particular email was never directly confirmed, even after
          // it's long since been applied and looks like any other field.
          const source =
            f === "hc_email" && sug.hc_email_estimated
              ? "Batch AI lookup (pattern-estimated email, reviewed)"
              : `Batch AI lookup (${sug.confidence} confidence, reviewed)`;
          changes.push({ school_id: s.id, field_name: f, old_value: s[f] || null, new_value: newVal, source, changed_by: user.id });
        }
      });
      // A manual Apply click is a human looking at the AI's suggestion and
      // deciding it's right -- worth the same verification_status a Quick
      // Fix save on the school's own profile page gets, so this record
      // doesn't sit there looking "not verified" forever just because the
      // review happened here instead of on that page. Deliberately NOT
      // applied when the suggestion's email is only a pattern-estimated
      // guess (firstname.lastname@domain, never actually found stated
      // anywhere) -- a human clicking Apply on that is still endorsing a
      // guess, not confirming a fact, so the record stays unverified until
      // someone checks that email a different way. Also never touched by
      // autoApplyHighConfidenceSuggestion (lib/coachInfoLookup.js) -- that
      // path writes unattended overnight with nobody reviewing it at all,
      // so it must never claim a human verified anything.
      if (!sug.hc_email_estimated) {
        update.verification_status = "verified";
        update.last_verified_at = new Date().toISOString();
      }
      if (Object.keys(update).length > 0) {
        const { error: updateErr } = await supabase.from("schools").update(update).eq("id", s.id);
        if (updateErr) throw updateErr;
        // changes can be empty here (e.g. the suggestion matched what was
        // already on file field-for-field, so verification_status/
        // last_verified_at above are the only thing actually changing) --
        // skip the log insert rather than calling .insert([]), which
        // school_change_log doesn't need to see anyway since neither of
        // those two columns is itself a logged field.
        if (changes.length > 0) {
          const { error: logErr } = await supabase.from("school_change_log").insert(changes);
          if (logErr) throw logErr;
        }
      }
      const { error: itemErr } = await supabase
        .from("coach_info_batch_items")
        .update({ review_status: "applied", reviewed_at: new Date().toISOString(), reviewed_by: user.id })
        .eq("id", item.id);
      if (itemErr) throw itemErr;
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message || "Could not apply this suggestion." };
    }
  }

  // Turns one uploaded CSV row's suggested_* columns into { field: value }
  // -- blank cells mean "leave unchanged", same convention Bulk Update's
  // CSV round-trip already uses, so a reviewer only has to touch the cells
  // they actually want to correct or approve.
  function effectiveFieldsFromCsvRow(row) {
    const out = {};
    SUGGESTION_FIELDS.forEach((f) => {
      const v = (row[`suggested_${f}`] || "").toString().trim();
      if (v) out[f] = v;
    });
    return out;
  }

  // The CSV-upload counterpart to applySuggestionCore above -- same two
  // writes (schools + school_change_log), same "mark the item reviewed"
  // finish, but the values come from a (possibly hand-edited) spreadsheet
  // row instead of item.suggestion. One safety property carries over
  // unchanged: hc_email that the AI could only guess at (never actually
  // found stated anywhere -- see hc_email_estimated) still doesn't get
  // marked "verified" -- UNLESS the value in the sheet no longer matches
  // that original guess, because at that point Larry typed in a real
  // answer himself, which is exactly the kind of human confirmation
  // "verified" is supposed to mean.
  async function applySuggestionFromCsv(item, effectiveFields) {
    const s = item.school;
    const originalSug = item.suggestion || {};
    if (!s) return { ok: false, error: "Missing school." };
    try {
      const update = {};
      const changes = [];
      let sawChange = false;
      SUGGESTION_FIELDS.forEach((f) => {
        const newVal = (effectiveFields[f] || "").trim();
        if (!newVal || newVal === (s[f] || "")) return;
        sawChange = true;
        update[f] = newVal;
        const isUneditedEstimatedEmail = f === "hc_email" && originalSug.hc_email_estimated && newVal === (originalSug.hc_email || "").trim();
        const source = isUneditedEstimatedEmail ? "Batch AI lookup (pattern-estimated email, reviewed via CSV)" : "Batch AI lookup (CSV review, reviewed)";
        changes.push({ school_id: s.id, field_name: f, old_value: s[f] || null, new_value: newVal, source, changed_by: user.id });
      });

      const allChangesAreUnverifiedGuesses =
        sawChange && changes.every((c) => c.field_name === "hc_email" && originalSug.hc_email_estimated && c.new_value === (originalSug.hc_email || "").trim());

      if (Object.keys(update).length > 0) {
        if (!allChangesAreUnverifiedGuesses) {
          update.verification_status = "verified";
          update.last_verified_at = new Date().toISOString();
        }
        const { error: updateErr } = await supabase.from("schools").update(update).eq("id", s.id);
        if (updateErr) throw updateErr;
        if (changes.length > 0) {
          const { error: logErr } = await supabase.from("school_change_log").insert(changes);
          if (logErr) throw logErr;
        }
      }
      // No changes at all (every suggested_* cell was blank or already
      // matched what's on file) -- same as clicking "Skip (no changes)"
      // rather than "Apply", so the item is marked skipped, not applied.
      const { error: itemErr } = await supabase
        .from("coach_info_batch_items")
        .update({ review_status: sawChange ? "applied" : "skipped", reviewed_at: new Date().toISOString(), reviewed_by: user.id })
        .eq("id", item.id);
      if (itemErr) throw itemErr;
      return { ok: true, changed: sawChange };
    } catch (err) {
      return { ok: false, error: err.message || "Could not apply this row." };
    }
  }

  // Reads an uploaded, reviewed CSV (from exportRunCsv below, edited or
  // not) and applies every matched row in one pass -- the actual point of
  // this whole round-trip: instead of clicking through a web UI one
  // suggestion at a time, Larry can scan/correct/delete rows in Excel and
  // upload the result to process a whole run in one shot. Matches rows back
  // to this run's own items by school_id; anything that doesn't match, or
  // was already reviewed since the sheet was exported (e.g. applied earlier
  // via the on-screen button), is reported but not touched.
  async function handleCsvImport(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setCsvImportError("");
    setCsvImportResult(null);
    setCsvImporting(true);
    try {
      const text = await file.text();
      const parsed = Papa.parse(text, { header: true, skipEmptyLines: true });
      if (parsed.errors?.length) throw new Error(parsed.errors[0].message);
      const rows = parsed.data || [];
      if (!rows.length) throw new Error("The file has no data rows.");

      const itemsBySchoolId = new Map(items.map((i) => [String(i.school?.id || ""), i]));

      const targets = [];
      let unmatched = 0;
      let alreadyReviewed = 0;
      rows.forEach((row) => {
        const schoolId = String(row.school_id || "").trim();
        const item = schoolId ? itemsBySchoolId.get(schoolId) : null;
        if (!item) {
          unmatched++;
          return;
        }
        if (item.review_status !== "pending") {
          alreadyReviewed++;
          return;
        }
        targets.push({ item, effectiveFields: effectiveFieldsFromCsvRow(row) });
      });

      if (!targets.length) {
        setCsvImportResult({ applied: 0, noChange: 0, unmatched, alreadyReviewed, failures: [] });
        return;
      }

      setCsvImportProgress({ done: 0, total: targets.length });
      let done = 0;
      let applied = 0;
      let noChange = 0;
      const failures = [];
      await runWithConcurrency(targets, APPLY_CONCURRENCY, async ({ item, effectiveFields }) => {
        const result = await applySuggestionFromCsv(item, effectiveFields);
        if (result.ok) {
          setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, review_status: result.changed ? "applied" : "skipped" } : i)));
          if (result.changed) applied++;
          else noChange++;
        } else {
          failures.push(`${item.school?.name || `#${item.id}`}: ${result.error}`);
        }
        done++;
        setCsvImportProgress({ done, total: targets.length });
      });

      setCsvImportResult({ applied, noChange, unmatched, alreadyReviewed, failures });
      setFocusedIndex(0);
    } catch (err) {
      setCsvImportError(err.message || "Could not read this file.");
    } finally {
      setCsvImporting(false);
      e.target.value = "";
    }
  }

  async function applyItem(item) {
    setApplyingId(item.id);
    setReviewError("");
    const result = await applySuggestionCore(item);
    if (result.ok) {
      setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, review_status: "applied" } : i)));
    } else {
      setReviewError(result.error);
    }
    setApplyingId(null);
  }

  // Applies every PENDING high-confidence suggestion in the current run in
  // one click -- the AI only marks a suggestion "high confidence" when it
  // found the name/email directly in full page text on the school's own
  // site (not just a search snippet), so these are the suggestions a
  // reviewer would almost always click Apply on anyway. Batching them
  // removes the single biggest source of repetitive clicking: with the
  // "no_name" targeting mode, a typical run of a few hundred schools often
  // has well over half land as high confidence.
  async function bulkApplyHighConfidence() {
    const targets = pendingReview.filter((i) => i.suggestion?.confidence === "high");
    if (!targets.length) return;
    setBulkApplying(true);
    setReviewError("");
    setBulkProgress({ done: 0, total: targets.length });
    let done = 0;
    const failures = [];
    await runWithConcurrency(targets, APPLY_CONCURRENCY, async (item) => {
      const result = await applySuggestionCore(item);
      if (result.ok) {
        setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, review_status: "applied" } : i)));
      } else {
        failures.push(`${item.school?.name || `#${item.id}`}: ${result.error}`);
      }
      done++;
      setBulkProgress({ done, total: targets.length });
    });
    setBulkApplying(false);
    setFocusedIndex(0);
    if (failures.length > 0) {
      setReviewError(
        `Applied ${targets.length - failures.length} of ${targets.length} high-confidence suggestions. ${failures.length} failed: ${failures.slice(0, 3).join("; ")}${
          failures.length > 3 ? "…" : ""
        }`
      );
    }
  }

  // Clears every pending suggestion with nothing to apply -- the coach was
  // confirmed but no new email/phone/social turned up. Skip only ever
  // touches coach_info_batch_items itself (never the schools table or
  // school_change_log), so unlike bulkApplyHighConfidence this is a single
  // batched update instead of one write per item with its own concurrency
  // limit -- there's no per-school side effect that could fail on its own.
  async function bulkSkipNoChanges() {
    const targets = noChangesPendingItems;
    if (!targets.length) return;
    setBulkSkipping(true);
    setReviewError("");
    try {
      const { error } = await supabase
        .from("coach_info_batch_items")
        .update({ review_status: "skipped", reviewed_at: new Date().toISOString(), reviewed_by: user.id })
        .in(
          "id",
          targets.map((i) => i.id)
        );
      if (error) throw error;
      const skippedIds = new Set(targets.map((i) => i.id));
      setItems((prev) => prev.map((i) => (skippedIds.has(i.id) ? { ...i, review_status: "skipped" } : i)));
      setFocusedIndex(0);
    } catch (err) {
      setReviewError(err.message || "Could not skip these suggestions.");
    } finally {
      setBulkSkipping(false);
    }
  }

  async function skipItem(item) {
    setApplyingId(item.id);
    setReviewError("");
    try {
      const { error } = await supabase
        .from("coach_info_batch_items")
        .update({ review_status: "skipped", reviewed_at: new Date().toISOString(), reviewed_by: user.id })
        .eq("id", item.id);
      if (error) throw error;
      setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, review_status: "skipped" } : i)));
    } catch (err) {
      setReviewError(err.message || "Could not skip this suggestion.");
    } finally {
      setApplyingId(null);
    }
  }

  // Clears every pending row whose school already got verified through some
  // other channel since this run started (see wasVerifiedElsewhere) -- same
  // shape as bulkSkipNoChanges, just a different target list and label. Only
  // ever touches coach_info_batch_items -- the school itself is already
  // verified, there's nothing to write there.
  async function bulkSkipVerifiedElsewhere() {
    const targets = verifiedElsewhereItems;
    if (!targets.length) return;
    setBulkSkipping(true);
    setReviewError("");
    try {
      const { error } = await supabase
        .from("coach_info_batch_items")
        .update({ review_status: "skipped", reviewed_at: new Date().toISOString(), reviewed_by: user.id })
        .in("id", targets.map((i) => i.id));
      if (error) throw error;
      const skippedIds = new Set(targets.map((i) => i.id));
      setItems((prev) => prev.map((i) => (skippedIds.has(i.id) ? { ...i, review_status: "skipped" } : i)));
      setFocusedIndex(0);
    } catch (err) {
      setReviewError(err.message || "Could not skip these suggestions.");
    } finally {
      setBulkSkipping(false);
    }
  }

  // "Confirmed, no data available" -- for a school the AI genuinely couldn't
  // find anything for (suggestion_error), there was previously no way from
  // this page to mark it looked-at; Skip only touches the batch item, never
  // schools.verification_status, so a school with truly no coach info
  // findable anywhere would keep resurfacing in every future batch run
  // forever, burning a fresh AI search each time. This writes the same
  // verification_status="verified" + last_verified_at a Quick Fix save or
  // Needs-Review confirm would, with an old_value===new_value
  // school_change_log entry (so it reads as a confirmation, not a phantom
  // edit) on hc_email specifically -- the one field every other confirm
  // action in this app already uses for that purpose (see needs-review's
  // confirm route). Deliberately NOT offered on noChangesPendingItems --
  // those already have a real value on file the AI simply re-confirmed
  // matches, a different (and already-handled, via Apply) situation from
  // "nothing exists to find."
  async function confirmNoDataAvailableCore(item) {
    try {
      const s = item.school;
      if (!s) return { ok: false, error: "Missing school." };
      const { error: updateErr } = await supabase
        .from("schools")
        .update({ verification_status: "verified", last_verified_at: new Date().toISOString() })
        .eq("id", s.id);
      if (updateErr) throw updateErr;
      const { error: logErr } = await supabase.from("school_change_log").insert({
        school_id: s.id,
        field_name: "hc_email",
        old_value: s.hc_email || null,
        new_value: s.hc_email || null,
        source: "Batch Coach-Info review -- confirmed no data available",
        changed_by: user.id,
      });
      if (logErr) throw logErr;
      const { error: itemErr } = await supabase
        .from("coach_info_batch_items")
        .update({ review_status: "confirmed_no_data", reviewed_at: new Date().toISOString(), reviewed_by: user.id })
        .eq("id", item.id);
      if (itemErr) throw itemErr;
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message || "Could not confirm this school." };
    }
  }

  async function confirmNoDataAvailable(item) {
    setApplyingId(item.id);
    setReviewError("");
    const result = await confirmNoDataAvailableCore(item);
    if (result.ok) {
      setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, review_status: "confirmed_no_data" } : i)));
    } else {
      setReviewError(result.error);
    }
    setApplyingId(null);
  }

  async function bulkConfirmNoDataAvailable() {
    const targets = failedItems;
    if (!targets.length) return;
    setBulkSkipping(true);
    setReviewError("");
    const failures = [];
    await runWithConcurrency(targets, APPLY_CONCURRENCY, async (item) => {
      const result = await confirmNoDataAvailableCore(item);
      if (result.ok) {
        setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, review_status: "confirmed_no_data" } : i)));
      } else {
        failures.push(`${item.school?.name || `#${item.id}`}: ${result.error}`);
      }
    });
    setBulkSkipping(false);
    if (failures.length > 0) {
      setReviewError(`Confirmed ${targets.length - failures.length} of ${targets.length}. ${failures.length} failed: ${failures.slice(0, 3).join("; ")}${failures.length > 3 ? "…" : ""}`);
    }
  }

  // Downloads exactly what's currently on screen (visibleRows -- same
  // search box + confidence filter + "Show already-reviewed" the table
  // itself uses) as a CSV: one current/suggested pair per field so it's
  // usable as a real working sheet, not just a dump. Purely a read of data
  // already loaded client-side -- no extra query, same Papa.unparse +
  // Blob-download pattern the Leads and Bulk Update pages already use.
  function exportRunCsv() {
    if (!selectedRun || !visibleRows.length) return;
    const csv = Papa.unparse({
      fields: [
        "school_id",
        "school_name",
        "city",
        "state",
        ...SUGGESTION_FIELDS.flatMap((f) => [`current_${f}`, `suggested_${f}`]),
        "confidence",
        "email_estimated",
        "source",
        "notes",
        "status",
      ],
      data: visibleRows.map((item) => {
        const s = item.school || {};
        const sug = item.suggestion || {};
        return [
          s.id,
          s.name,
          s.city,
          s.state,
          ...SUGGESTION_FIELDS.flatMap((f) => [s[f] || "", sug[f] || ""]),
          sug.confidence || "",
          // Flags an hc_email that's a pattern guess (firstname.lastname@
          // domain) the AI never actually found stated anywhere -- edit or
          // clear the suggested_hc_email cell for these if you're not
          // confident in the guess; leaving it as-is on re-upload still
          // applies it, just without marking the record "verified" (see
          // applySuggestionFromCsv).
          sug.hc_email_estimated ? "Yes" : "No",
          sug.source || "",
          sug.notes || "",
          item.review_status === "pending"
            ? "Pending"
            : item.review_status === "applied"
            ? "Applied"
            : item.review_status === "confirmed_no_data"
            ? "No data available"
            : "Skipped",
        ];
      }),
    });
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `csd-coach-info-run-${selectedRun.id}-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  if (!canReview) {
    return (
      <div className="view">
        <div className="notice danger">Batch coach-info discovery is limited to Verification Staff and System Admins.</div>
      </div>
    );
  }

  return (
    <div className="view">
      <Link href="/admin" className="btn btn-sm" style={{ marginBottom: 12, display: "inline-flex" }}>
        ← Back to Admin
      </Link>
      <div className="view-header">
        <div>
          <h1>Batch Coach-Info Discovery</h1>
          <p>Run "Suggest Coach Info (AI)" against many schools overnight via Anthropic's Batch API, then review and apply the suggestions here.</p>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <h3>Start a New Batch Run</h3>
        <p style={{ fontSize: 12.5, color: "#697386", marginTop: -4 }}>
          {candidateMode === "missing_email"
            ? "Pulls schools that already have a head coach name on file but are missing an email -- searches for that specific coach by name instead of the generic \"who is the coach\" search."
            : candidateMode === "missing_cell"
            ? "Pulls schools that already have a head coach name on file but are missing a cell number -- searches for that specific coach by name instead of the generic \"who is the coach\" search."
            : candidateMode === "re_verify"
            ? "Pulls schools this tool has already touched before, but not recently -- a fresh open search per school (not name-anchored), so a coach who's since changed gets caught instead of re-confirmed."
            : "Pulls schools missing a head coach name that have an athletics or general website on file to search from -- schools with neither can't be helped by this tool."}
          {" "}
          {candidateMode === "re_verify"
            ? "This is the one mode that intentionally re-includes schools already applied, skipped, or attempted here before -- every other mode leaves those out of every future run."
            : "Any school already applied, skipped, or attempted here before is automatically left out of every future run."}
        </p>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 6, paddingBottom: 4, borderBottom: "1px solid #e3e6ea", marginBottom: 2 }}>
            <label style={{ fontSize: 13, display: "flex", gap: 6, alignItems: "center" }}>
              <input type="radio" checked={candidateMode === "no_name"} onChange={() => setCandidateMode("no_name")} />
              No coach name on file (the original targeting)
            </label>
            <label style={{ fontSize: 13, display: "flex", gap: 6, alignItems: "center" }}>
              <input type="radio" checked={candidateMode === "missing_email"} onChange={() => setCandidateMode("missing_email")} />
              Has a coach name, but missing an email
            </label>
            <label style={{ fontSize: 13, display: "flex", gap: 6, alignItems: "center" }}>
              <input type="radio" checked={candidateMode === "missing_cell"} onChange={() => setCandidateMode("missing_cell")} />
              Has a coach name, but missing a cell number
            </label>
            <label style={{ fontSize: 13, display: "flex", gap: 6, alignItems: "center" }}>
              <input type="radio" checked={candidateMode === "re_verify"} onChange={() => setCandidateMode("re_verify")} />
              Re-verify: schools not (re-)checked recently, including ones already run before
            </label>
            {candidateMode === "re_verify" && (
              <label style={{ fontSize: 13, marginLeft: 22 }}>
                Only include schools last reviewed more than{" "}
                <select value={staleDays} onChange={(e) => setStaleDays(Number(e.target.value))}>
                  {STALE_DAY_OPTIONS.map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>{" "}
                days ago (never-checked schools are always included)
              </label>
            )}
          </div>
          <label style={{ fontSize: 13, display: "flex", gap: 6, alignItems: "center" }}>
            <input type="radio" checked={scopeMode === "priority"} onChange={() => setScopeMode("priority")} />
            Priority recruiting states ({PRIORITY_STATES.join(", ")})
          </label>
          <label style={{ fontSize: 13, display: "flex", gap: 6, alignItems: "center" }}>
            <input type="radio" checked={scopeMode === "all"} onChange={() => setScopeMode("all")} />
            All states (or type a custom list below)
          </label>
          {scopeMode === "all" && (
            <input
              value={customStates}
              onChange={(e) => setCustomStates(e.target.value)}
              placeholder="Leave blank for every state, or type e.g. TX, OK, AR"
              style={{ maxWidth: 360 }}
            />
          )}
          <label style={{ fontSize: 13, display: "flex", gap: 6, alignItems: "center" }}>
            <input type="checkbox" checked={requireAthletics} onChange={(e) => setRequireAthletics(e.target.checked)} />
            Require an Athletics URL on file (more accurate — skips schools with only a general website)
          </label>
          <label style={{ fontSize: 13 }}>
            How many schools:{" "}
            <select value={targetCount} onChange={(e) => setTargetCount(Number(e.target.value))}>
              {TARGET_COUNTS.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <div>
            <button className="btn btn-primary btn-sm" onClick={startRun} disabled={creating}>
              {creating ? "Starting…" : "Start Run"}
            </button>
          </div>
          {createError && (
            <div className="notice danger" style={{ fontSize: 12.5 }}>
              {createError}
            </div>
          )}
        </div>
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, marginBottom: 8 }}>
          <h3 style={{ margin: 0 }}>Batch Runs</h3>
          <label style={{ fontSize: 12.5, display: "flex", gap: 6, alignItems: "center" }}>
            <input type="checkbox" checked={hideCompletedRuns} onChange={(e) => setHideCompletedRuns(e.target.checked)} />
            Hide finished runs
          </label>
        </div>
        {loadingRuns ? (
          <div className="empty-state">Loading…</div>
        ) : runs.length === 0 ? (
          <div className="empty-state">No batch runs yet -- start one above.</div>
        ) : visibleRunsList.length === 0 ? (
          <div className="empty-state">
            All {runs.length} run{runs.length === 1 ? "" : "s"} are finished -- nothing left to review. Uncheck "Hide finished runs" above to see them.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {hideCompletedRuns && openRunsCount < runs.length && (
              <div style={{ fontSize: 11.5, color: "#9aa1ab" }}>
                {runs.length - openRunsCount} finished run{runs.length - openRunsCount === 1 ? "" : "s"} hidden.
              </div>
            )}
            {visibleRunsList.map((r) => {
              const pendingCount = r.id === selectedRunId ? pendingReview.length : runPendingCounts[r.id] || 0;
              return (
                <div
                  key={r.id}
                  onClick={() => openRun(r.id)}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    flexWrap: "wrap",
                    gap: 8,
                    padding: "8px 10px",
                    border: r.id === selectedRunId ? "1px solid #2f5fa8" : "1px solid #e3e6ea",
                    borderRadius: 8,
                    cursor: "pointer",
                  }}
                >
                  <div style={{ fontSize: 12.5 }}>
                    <strong>Run #{r.id}</strong> — {new Date(r.created_at).toLocaleString()} — {r.state_filter ? r.state_filter.join(", ") : "all states"} — {r.requested_count} school
                    {r.requested_count === 1 ? "" : "s"}
                    {r.candidate_mode === "missing_email"
                      ? " — missing email"
                      : r.candidate_mode === "missing_cell"
                      ? " — missing cell"
                      : r.candidate_mode === "re_verify"
                      ? " — re-verify"
                      : r.candidate_mode === "csv_upload"
                      ? " — from CSV import"
                      : ""}
                    {r.status === "collected" && pendingCount > 0 ? ` — ${pendingCount} to review` : ""}
                    {runLastWorked[r.id] ? ` — last worked ${fmtReviewedRelative(runLastWorked[r.id])}` : ""}
                  </div>
                  <span style={{ display: "flex", alignItems: "center" }}>
                    <StatusBadge status={r.status} />
                    <WaitingBadge run={r} />
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {selectedRun && (
        <div className="card" style={{ marginBottom: 14 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, marginBottom: 8 }}>
            <h3 style={{ margin: 0 }}>Run #{selectedRun.id}</h3>
            <StatusBadge status={selectedRun.status} />
          </div>

          {selectedRun.status === "collecting" && (
            <div>
              <p style={{ fontSize: 12.5, color: "#697386" }}>
                Step 1: fetch each school's page text and a web search, then save it. {readyCount} ready, {pendingFetchCount} not fetched yet, {noContentCount} found nothing usable.
              </p>
              <button className="btn btn-sm" onClick={fetchSources} disabled={fetching || loadingItems || pendingFetchCount === 0}>
                {fetching ? `Fetching ${fetchProgress.done} of ${fetchProgress.total}…` : pendingFetchCount === 0 ? "All Fetched" : `Fetch Source Text (${pendingFetchCount} schools)`}
              </button>
              <button className="btn btn-gold btn-sm" style={{ marginLeft: 8 }} onClick={submitRun} disabled={submitting || readyCount === 0}>
                {submitting ? "Submitting…" : `Submit ${readyCount} School${readyCount === 1 ? "" : "s"} to Anthropic Batch`}
              </button>
              {submitError && (
                <div className="notice danger" style={{ marginTop: 10, fontSize: 12.5 }}>
                  {submitError}
                </div>
              )}
            </div>
          )}

          {(selectedRun.status === "submitted" || selectedRun.status === "processing") && (
            <div>
              <p style={{ fontSize: 12.5, color: "#697386" }}>
                Step 2: submitted to Anthropic's Batch API ({selectedRun.fetched_count} schools). Results usually land same-day, worst case within 24 hours -- check back and click below.
                {selectedRun.anthropic_batch_status ? ` Last known status: ${selectedRun.anthropic_batch_status}.` : ""}
              </p>
              <button className="btn btn-sm" onClick={checkStatus} disabled={checkingStatus}>
                {checkingStatus ? "Checking…" : "Check Batch Status"}
              </button>
              {lastCheckedStatus && !statusError && (
                <span style={{ marginLeft: 10, fontSize: 12.5, color: "#697386" }}>Anthropic says: {lastCheckedStatus}</span>
              )}
              {statusError && (
                <div className="notice danger" style={{ marginTop: 10, fontSize: 12.5 }}>
                  {statusError}
                </div>
              )}
            </div>
          )}

          {selectedRun.status === "ready" && (
            <div>
              <p style={{ fontSize: 12.5, color: "#697386" }}>Step 3: Anthropic has finished processing this batch. Collect the results to start reviewing suggestions.</p>
              <button className="btn btn-gold btn-sm" onClick={collectResults} disabled={collecting}>
                {collecting ? "Collecting…" : "Collect Results"}
              </button>
              {collectError && (
                <div className="notice danger" style={{ marginTop: 10, fontSize: 12.5 }}>
                  {collectError}
                </div>
              )}
            </div>
          )}

          {selectedRun.status === "collected" && (
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
                <p style={{ fontSize: 12.5, color: "#697386", margin: 0 }}>
                  {pendingReview.length} suggestion{pendingReview.length === 1 ? "" : "s"} to review
                  {verifiedElsewhereItems.length > 0 ? ` (${verifiedElsewhereItems.length} of those already verified elsewhere since this run started)` : ""}, {reviewedItems.length} already
                  reviewed{reviewedTodayCount > 0 ? ` (${reviewedTodayCount} today)` : ""}, {failedItems.length} the AI couldn't produce a suggestion for.
                </p>
                <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                  <label style={{ fontSize: 12.5, display: "flex", gap: 6, alignItems: "center" }}>
                    <input
                      type="checkbox"
                      checked={showReviewed}
                      onChange={(e) => {
                        setShowReviewed(e.target.checked);
                        // Unchecking hides every reviewed row, so a "Reviewed" tab
                        // selection would otherwise silently show zero rows.
                        if (!e.target.checked && confidenceFilter === "reviewed") setConfidenceFilter("all");
                      }}
                    />
                    Show already-reviewed
                  </label>
                  <button className="btn btn-sm" onClick={exportRunCsv} disabled={visibleRows.length === 0}>
                    Export to CSV ({visibleRows.length})
                  </button>
                  <label className="btn btn-sm btn-gold" style={{ cursor: csvImporting ? "default" : "pointer" }}>
                    {csvImporting ? `Applying ${csvImportProgress.done}/${csvImportProgress.total}…` : "Import reviewed CSV"}
                    <input type="file" accept=".csv" onChange={handleCsvImport} disabled={csvImporting} style={{ display: "none" }} />
                  </label>
                  {/* Chains straight into Batch Social Media Discovery,
                      scoped to this same run's schools -- closes the gap
                      where Coach-Info finds a coach's name but (per its own
                      SYSTEM_PROMPT) only turns up a social handle
                      opportunistically, not via a dedicated search. Social's
                      own page reads ?fromCoachInfoRun= and re-runs its usual
                      eligibility filter against just these schools, so
                      nothing here is queued unless Social would also have
                      picked it up on its own. */}
                  <Link href={`/admin/batch-social?fromCoachInfoRun=${selectedRun.id}`} className="btn btn-sm">
                    Start Social Media Discovery for These Schools →
                  </Link>
                  {/* Same chain pattern, scoped to Athletics/MaxPreps URL
                      discovery instead of social handles -- each tool's own
                      page reads ?fromCoachInfoRun= and re-runs its usual
                      eligibility filter (missing URL, not closed, not
                      already run before) against just these schools. */}
                  <Link href={`/admin/batch-athletics?fromCoachInfoRun=${selectedRun.id}`} className="btn btn-sm">
                    Start Athletics URL Discovery for These Schools →
                  </Link>
                  <Link href={`/admin/batch-maxpreps?fromCoachInfoRun=${selectedRun.id}`} className="btn btn-sm">
                    Start MaxPreps URL Discovery for These Schools →
                  </Link>
                </div>
              </div>

              {csvImportError && (
                <div className="notice danger" style={{ marginBottom: 10, fontSize: 12.5 }}>
                  {csvImportError}
                </div>
              )}
              {csvImportResult && (
                <div className="notice info" style={{ marginBottom: 10, fontSize: 12.5 }}>
                  Applied {csvImportResult.applied}, {csvImportResult.noChange} had nothing to change, {csvImportResult.alreadyReviewed} were already reviewed since export,{" "}
                  {csvImportResult.unmatched} didn&apos;t match a row in this run.
                  {csvImportResult.failures?.length > 0 && (
                    <div style={{ marginTop: 4 }}>
                      {csvImportResult.failures.length} failed: {csvImportResult.failures.slice(0, 3).join("; ")}
                      {csvImportResult.failures.length > 3 ? "…" : ""}
                    </div>
                  )}
                </div>
              )}

              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10, marginBottom: 10 }}>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {/* "reviewed" only appears once there's something to jump to -- it stays
                      hidden while showReviewed is off since reviewBaseRows has no reviewed
                      rows in it at all then. */}
                  {(showReviewed ? ["all", "high", "medium", "low", "reviewed"] : ["all", "high", "medium", "low"]).map((tier) => {
                    const active = confidenceFilter === tier;
                    const label = tier === "all" ? "All" : tier[0].toUpperCase() + tier.slice(1);
                    return (
                      <button
                        key={tier}
                        className="btn btn-sm"
                        onClick={() => setConfidenceFilter(tier)}
                        style={active ? { background: "#0b5fff", borderColor: "#0b5fff", color: "#fff" } : undefined}
                      >
                        {label} ({confidenceCounts[tier]})
                      </button>
                    );
                  })}
                </div>
                <input
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search school, city, coach, or handle…"
                  style={{ maxWidth: 240, fontSize: 12.5 }}
                />
              </div>

              {highConfidencePendingCount > 0 && (
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    flexWrap: "wrap",
                    gap: 10,
                    marginBottom: 10,
                    padding: "10px 12px",
                    background: "#eef4fb",
                    border: "1px solid #cfe0f2",
                    borderRadius: 8,
                  }}
                >
                  <span style={{ fontSize: 12.5 }}>
                    <strong>{highConfidencePendingCount}</strong> of those are <strong>high confidence</strong> -- the AI found the name/email directly in full page text on the school's own
                    site, not just a search snippet. These are safe to clear in one click instead of reviewing one at a time.
                  </span>
                  <button className="btn btn-gold btn-sm" onClick={bulkApplyHighConfidence} disabled={bulkApplying || bulkSkipping}>
                    {bulkApplying ? `Applying ${bulkProgress.done} of ${bulkProgress.total}…` : `Apply All High-Confidence (${highConfidencePendingCount})`}
                  </button>
                </div>
              )}

              {noChangesPendingCount > 0 && (
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    flexWrap: "wrap",
                    gap: 10,
                    marginBottom: 10,
                    padding: "10px 12px",
                    background: "#f5f6f8",
                    border: "1px solid #e3e6ea",
                    borderRadius: 8,
                  }}
                >
                  <span style={{ fontSize: 12.5 }}>
                    <strong>{noChangesPendingCount}</strong> have <strong>nothing to apply</strong> -- the coach was confirmed but no new email, phone, or social turned up anywhere.
                    Skipping never writes to a school's record, so these are safe to clear in one click too.
                  </span>
                  <button className="btn btn-sm" onClick={bulkSkipNoChanges} disabled={bulkApplying || bulkSkipping}>
                    {bulkSkipping ? "Skipping…" : `Skip All — No Changes Suggested (${noChangesPendingCount})`}
                  </button>
                </div>
              )}

              {verifiedElsewhereItems.length > 0 && (
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    flexWrap: "wrap",
                    gap: 10,
                    marginBottom: 10,
                    padding: "10px 12px",
                    background: "#eefbf3",
                    border: "1px solid #cdeedd",
                    borderRadius: 8,
                  }}
                >
                  <span style={{ fontSize: 12.5 }}>
                    <strong>{verifiedElsewhereItems.length}</strong> of these schools got marked <strong>verified elsewhere</strong> since this run started -- through Needs-Review, a Quick
                    Fix on another tool, or a manual edit. Reviewing them here would be redundant work.
                  </span>
                  <button className="btn btn-sm" onClick={bulkSkipVerifiedElsewhere} disabled={bulkApplying || bulkSkipping}>
                    {bulkSkipping ? "Skipping…" : `Skip All — Already Verified Elsewhere (${verifiedElsewhereItems.length})`}
                  </button>
                </div>
              )}

              {reviewError && (
                <div className="notice danger" style={{ marginBottom: 10, fontSize: 12.5 }}>
                  {reviewError}
                </div>
              )}

              {failedItems.length > 0 && (
                <div
                  style={{
                    marginBottom: 14,
                    padding: "10px 12px",
                    background: "#fff8f0",
                    border: "1px solid #f0dfc2",
                    borderRadius: 8,
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10, marginBottom: 8 }}>
                    <span style={{ fontSize: 12.5 }}>
                      <strong>{failedItems.length}</strong> school{failedItems.length === 1 ? "" : "s"} the AI couldn't find anything for at all. If there's genuinely no coach info
                      findable, confirm it below so this school stops resurfacing in every future batch run.
                    </span>
                    <button className="btn btn-sm" onClick={bulkConfirmNoDataAvailable} disabled={bulkApplying || bulkSkipping}>
                      {bulkSkipping ? "Confirming…" : `Confirm All — No Data Available (${failedItems.length})`}
                    </button>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    {failedItems.map((item) => (
                      <div key={item.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, fontSize: 12, padding: "3px 0" }}>
                        <span>
                          {item.school?.name} — {item.school?.city}, {item.school?.state}
                          <span style={{ color: "#9aa1ab" }}> ({item.suggestion_error})</span>
                        </span>
                        <button className="btn btn-sm" onClick={() => confirmNoDataAvailable(item)} disabled={applyingId === item.id || bulkSkipping}>
                          {applyingId === item.id ? "Confirming…" : "Confirm — No Data Available"}
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div style={{ fontSize: 11.5, color: "#9aa1ab", marginBottom: 6 }}>
                Keyboard shortcuts: <strong>↑</strong>/<strong>↓</strong> move focus · <strong>A</strong> apply · <strong>S</strong> skip · <strong>E</strong> quick-edit · <strong>Esc</strong> cancel edit
              </div>

              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
                  <thead>
                    <tr style={{ borderBottom: "2px solid #e3e6ea", textAlign: "left" }}>
                      <th style={{ padding: "6px 8px", whiteSpace: "nowrap" }}>School</th>
                      <th style={{ padding: "6px 8px" }}>Suggested changes</th>
                      <th style={{ padding: "6px 8px", whiteSpace: "nowrap" }}>Confidence</th>
                      <th style={{ padding: "6px 8px", whiteSpace: "nowrap" }}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleRows.map((item) => {
                        const s = item.school;
                        const sug = item.suggestion;
                        if (!s || !sug) return null;
                        const applying = applyingId === item.id;
                        const reviewed = item.review_status !== "pending";
                        const isFocused = !reviewed && focusedItem?.id === item.id;
                        const changedFields = SUGGESTION_FIELDS.filter((f) => {
                          const suggested = (sug[f] || "").trim();
                          return suggested && suggested !== (s[f] || "");
                        });
                        // A blank name getting filled in for the first time is
                        // routine. A name that was ALREADY on file getting
                        // replaced with a different one is the exact shape of
                        // the Saint Edward/Saint Edwards mix-up Larry caught
                        // by hand -- the AI found a real coach, just possibly
                        // at the wrong school. Flag it so a reviewer's eye
                        // catches it before an Apply click, rather than
                        // relying on them to notice a quiet text diff.
                        const hadPriorName = Boolean((s.hc_first_name || "").trim() || (s.hc_last_name || "").trim());
                        const nameChanged = hadPriorName && (changedFields.includes("hc_first_name") || changedFields.includes("hc_last_name"));
                        return [
                          <tr
                            key={item.id}
                            style={{
                              borderBottom: "1px solid #eef0f3",
                              opacity: reviewed ? 0.55 : 1,
                              verticalAlign: "top",
                              background: isFocused ? "#eef4fb" : undefined,
                              boxShadow: isFocused ? "inset 3px 0 0 #2f5fa8" : nameChanged ? "inset 3px 0 0 #b3261e" : undefined,
                            }}
                          >
                            <td style={{ padding: "8px", whiteSpace: "nowrap" }}>
                              <div style={{ fontWeight: 600 }}>{s.name}</div>
                              <div style={{ color: "#9aa1ab" }}>
                                {s.city}, {s.state}
                              </div>
                              {wasVerifiedElsewhere(item, selectedRun) && (
                                <span className="badge" style={{ color: "#1e7145", background: "#1e714519", fontWeight: 600, marginTop: 2, display: "inline-block" }}>
                                  ✓ Verified elsewhere since this run started
                                </span>
                              )}
                              {/* On-file coach, shown for every row (not just
                                  ones with a diff) so a reviewer can compare
                                  it against a source they already trust and
                                  hit Apply without opening the record -- see
                                  matchesSearch above for why this same
                                  name/email is also what the search box
                                  matches against. */}
                              <div style={{ color: "#697386", marginTop: 2 }}>
                                {s.hc_first_name || s.hc_last_name ? `${s.hc_first_name || ""} ${s.hc_last_name || ""}`.trim() : "No coach on file"}
                              </div>
                              {s.hc_email && <div style={{ color: "#9aa1ab" }}>{s.hc_email}</div>}
                              {/* On-file social handles, same always-visible
                                  treatment -- Coach-Info's own AI lookup CAN
                                  suggest hc_twitter/hc_facebook (see
                                  SUGGESTION_FIELDS/FIELD_LABELS above), but
                                  only turns one up occasionally since finding
                                  social accounts isn't this tool's main
                                  focus -- Batch Social Media Discovery is the
                                  dedicated tool for that. Showing what's
                                  already on file here means a reviewer
                                  clearing Coach-Info doesn't also have to
                                  open every school's profile just to see
                                  whether social is covered. wordBreak
                                  because a saved Facebook URL can run long;
                                  the parent cell's own nowrap only applies to
                                  the school name/city/coach lines above. */}
                              <div style={{ marginTop: 4, whiteSpace: "normal", maxWidth: 200, wordBreak: "break-all" }}>
                                {s.hc_twitter ? (
                                  <div style={{ color: "#5b7fb5" }}>Twitter/X: {s.hc_twitter}</div>
                                ) : (
                                  <div style={{ color: "#9aa1ab", fontStyle: "italic" }}>No Twitter/X on file</div>
                                )}
                                {s.hc_facebook ? (
                                  <div style={{ color: "#5b7fb5" }}>Facebook: {s.hc_facebook}</div>
                                ) : (
                                  <div style={{ color: "#9aa1ab", fontStyle: "italic" }}>No Facebook on file</div>
                                )}
                              </div>
                            </td>
                            <td style={{ padding: "8px", minWidth: 260 }}>
                              {nameChanged && (
                                <div style={{ color: "#b3261e", fontWeight: 600, marginBottom: 4 }}>
                                  ⚠ Different coach than on file — confirm this is the same program before applying
                                </div>
                              )}
                              {changedFields.length === 0 ? (
                                <span style={{ color: "#9aa1ab" }}>No changes suggested</span>
                              ) : (
                                changedFields.map((f) => (
                                  <div key={f}>
                                    <strong>{FIELD_LABELS[f]}:</strong> {sug[f]}
                                    {s[f] ? <span style={{ color: "#9aa1ab" }}> (was: {s[f]})</span> : null}
                                    {f === "hc_email" && sug.hc_email_estimated ? (
                                      <span style={{ color: "#8a6100", fontWeight: 600 }}> (pattern-estimated, not confirmed)</span>
                                    ) : null}
                                  </div>
                                ))
                              )}
                              {sug.notes && (
                                <div style={{ marginTop: 4 }}>
                                  <button
                                    type="button"
                                    onClick={() => toggleNotes(item.id)}
                                    style={{ background: "none", border: "none", padding: 0, color: "#5b7fb5", fontSize: 11.5, cursor: "pointer", textDecoration: "underline" }}
                                  >
                                    {expandedNotes.has(item.id) ? "Hide reasoning" : "Why?"}
                                  </button>
                                  {expandedNotes.has(item.id) && (
                                    <div style={{ marginTop: 2, fontStyle: "italic", color: "#9aa1ab" }}>
                                      "{sug.notes}" — {sug.source}
                                    </div>
                                  )}
                                </div>
                              )}
                            </td>
                            <td style={{ padding: "8px", whiteSpace: "nowrap" }}>
                              <span className="badge" style={{ fontSize: 11, color: sug.confidence === "high" ? "#1e7145" : sug.confidence === "medium" ? "#8a6100" : "#b3261e" }}>
                                {sug.confidence}
                              </span>
                            </td>
                            <td style={{ padding: "8px", whiteSpace: "nowrap" }}>
                              {reviewed ? (
                                <div>
                                  <span style={{ fontWeight: 600, color: reviewedBadgeInfo(item.review_status).color }}>{reviewedBadgeInfo(item.review_status).label}</span>
                                  {item.reviewed_at && (
                                    <div style={{ fontSize: 10.5, color: "#9aa1ab" }} title={new Date(item.reviewed_at).toLocaleString()}>
                                      {fmtReviewedRelative(item.reviewed_at)}
                                    </div>
                                  )}
                                </div>
                              ) : (
                                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                                  <button className="btn btn-gold btn-sm" disabled={applying || bulkApplying || bulkSkipping} onClick={() => applyItem(item)}>
                                    {applying ? "…" : "Apply"}
                                  </button>
                                  <button className="btn btn-sm" disabled={applying || bulkApplying || bulkSkipping} onClick={() => skipItem(item)}>
                                    Skip
                                  </button>
                                  <button
                                    className="btn btn-sm"
                                    disabled={applying || bulkApplying || bulkSkipping}
                                    onClick={() => openEdit(item)}
                                    style={editingId === item.id ? { background: "#0b5fff", borderColor: "#0b5fff", color: "#fff" } : undefined}
                                    title="Fix a field before applying, right here, without opening the school's record"
                                  >
                                    {editingId === item.id ? "Editing…" : "Edit"}
                                  </button>
                                  <Link href={`/schools/${s.id}`} className="btn btn-sm">
                                    Open
                                  </Link>
                                </div>
                              )}
                            </td>
                          </tr>,
                          editingId === item.id && (
                            <tr key={`edit-${item.id}`} style={{ borderBottom: "1px solid #eef0f3", background: "#f8fafc" }}>
                              <td colSpan={4} style={{ padding: "10px 8px 14px" }}>
                                {/* Quick Fix -- same idea as the school profile
                                    page's own inline editor, brought into the
                                    batch review queue so correcting one field
                                    on an otherwise-good suggestion (or filling
                                    in one the AI missed) doesn't require
                                    leaving this list. Saving here runs through
                                    applySuggestionFromCsv, the exact same
                                    write path a reviewed-CSV re-upload uses --
                                    same audit-log entries, same
                                    verified/estimated-email handling. */}
                                <div style={{ fontSize: 11.5, fontWeight: 600, color: "#697386", marginBottom: 8 }}>
                                  Quick Fix — {s.name}
                                </div>
                                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))", gap: 8 }}>
                                  {SUGGESTION_FIELDS.map((f) => (
                                    <label key={f} style={{ fontSize: 11.5, color: "#697386" }}>
                                      {FIELD_LABELS[f]}
                                      <input
                                        value={editDraft[f] || ""}
                                        onChange={(e) => updateDraftField(f, e.target.value)}
                                        style={{ width: "100%", marginTop: 2, fontSize: 12.5 }}
                                        placeholder={s[f] || ""}
                                      />
                                    </label>
                                  ))}
                                </div>
                                {editError && (
                                  <div className="notice danger" style={{ marginTop: 8, fontSize: 12.5 }}>
                                    {editError}
                                  </div>
                                )}
                                <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
                                  <button className="btn btn-gold btn-sm" disabled={savingEdit} onClick={() => saveEdit(item)}>
                                    {savingEdit ? "Saving…" : "Save & Next"}
                                  </button>
                                  <button className="btn btn-sm" disabled={savingEdit} onClick={cancelEdit}>
                                    Cancel
                                  </button>
                                  <span style={{ fontSize: 11, color: "#9aa1ab", alignSelf: "center" }}>
                                    Blank clears nothing — leave a field as-is to skip it. Esc to cancel.
                                  </span>
                                </div>
                              </td>
                            </tr>
                          ),
                        ];
                      })}
                  </tbody>
                </table>
                {visibleRows.length === 0 && (
                  <div className="empty-state">
                    {reviewBaseRows.length === 0
                      ? "Nothing left to review."
                      : "No suggestions match the current confidence filter and/or search -- try \"All\" or clearing the search box."}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {undoToast && (
        <div
          style={{
            position: "fixed",
            bottom: 20,
            right: 20,
            zIndex: 50,
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "10px 14px",
            background: "#1c1f24",
            color: "#fff",
            borderRadius: 10,
            boxShadow: "0 4px 16px rgba(0,0,0,0.25)",
            fontSize: 12.5,
          }}
        >
          <span>Saved {undoToast.schoolName}.</span>
          <button
            className="btn btn-sm btn-gold"
            onClick={undoQuickFixSave}
            style={{ whiteSpace: "nowrap" }}
          >
            Undo
          </button>
          <button
            onClick={() => {
              clearTimeout(undoTimeoutRef.current);
              setUndoToast(null);
            }}
            style={{ background: "none", border: "none", color: "#9aa1ab", cursor: "pointer", fontSize: 14, padding: 0 }}
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      )}
    </div>
  );
}

export default function BatchCoachInfoPage() {
  return (
    <Suspense fallback={<div className="view"><div className="empty-state">Loading…</div></div>}>
      <BatchCoachInfoPageInner />
    </Suspense>
  );
}
