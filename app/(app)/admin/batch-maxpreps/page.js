"use client";
import { useState, useEffect, useCallback, useRef, Suspense } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import Link from "next/link";
import Papa from "papaparse";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { useAuth } from "@/lib/auth-context";

// Overnight MaxPreps-URL Batch API job -- the MaxPreps-discovery counterpart
// to /admin/batch-athletics (see that page for the pattern this mirrors
// closely: MaxPreps URL, like athletics URL, is a single field on the
// school with a single best-pick AI suggestion, unlike Social's two
// independent handles). MaxPreps coverage matters because it's the fallback
// source the nightly Coach-Change Radar checks when a school has no
// athletics URL on file (see lib/schoolRecheck.js) -- and it's also the
// single best data-quality gut-check for the recruiting staff who add this
// app's prospect data, since a school's MaxPreps team page is often the
// fastest way to confirm a roster is current.
//
// Same four stages as Batch Athletics/Social, and the same non-authoritative
// contract -- nothing here ever writes to the schools table until a human
// clicks Apply on a specific school's suggestion below:
//  1. Prep    -- run one site:maxpreps.com web search per school, save the
//                raw candidate results (fetch-item route, driven here with
//                a few requests in flight at once).
//  2. Submit  -- bundle every "ready" item into one Anthropic Batch API
//                submission (submit route). The model's job is picking
//                which ONE search result (if any) is genuinely this
//                school's own football team page -- not extracting
//                anything from a page, since there's no known page to read
//                yet.
//  3. Wait    -- Anthropic processes asynchronously; check back later
//                (check-status route, polled by hand -- no auto-refresh).
//  4. Collect -- once Anthropic reports the batch "ended", download and
//                parse its results into a review queue (collect route).
const PRIORITY_STATES = ["TX", "FL", "GA", "CA", "OH", "IN"];
const TARGET_COUNTS = [100, 300, 500, 1000];
const DEFAULT_TARGET_COUNT = 300;
const FETCH_CONCURRENCY = 8; // matches the weekly automated cron's own concurrency (app/api/cron/weekly-maxpreps-batch) -- this manual page used to run at 3, well under what the same Serper calls handle fine unattended, which just meant a longer wait staring at this tab for a same-size run
const APPLY_CONCURRENCY = 5; // applying is just a DB write, no web fetch/AI call, so higher concurrency than FETCH_CONCURRENCY is safe -- matches batch-athletics/batch-social

const ITEM_SELECT =
  "id,batch_run_id,school_id,fetch_status,suggestion,suggestion_error,review_status,school:schools(id,name,city,state,maxpreps_url,verification_status,last_verified_at)";

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

// Quick Fix drafts survive navigating away from this page and back -- see
// the identical helper on Batch Coach-Info's page for the full reasoning.
// One sessionStorage key for the whole page (not scoped per run) so it can
// be read back synchronously the instant this component remounts, before
// the run list has even loaded.
const QUICK_FIX_STORAGE_KEY = "csdQuickFix:maxpreps";
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
    collecting: ["Searching", "#697386"],
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
// AFTER this run was created -- handled through some other channel (Needs-
// Review, a Quick Fix on a different batch tool, a manual edit) while this
// run sat open. Same helper as Batch Coach-Info's own; see that page for the
// full reasoning. Scoped to pending rows only.
function wasVerifiedElsewhere(item, run) {
  const s = item?.school;
  if (!s || !run) return false;
  if (item.review_status !== "pending") return false;
  if (s.verification_status !== "verified") return false;
  if (!s.last_verified_at) return false;
  return new Date(s.last_verified_at).getTime() > new Date(run.created_at).getTime();
}

function confidenceColor(confidence) {
  if (confidence === "high") return "#1e7145";
  if (confidence === "medium") return "#8a6100";
  return "#b3261e"; // low or none
}

// Reads ?state= off the URL -- see BatchMaxPrepsPage's Suspense wrapper at
// the bottom, same requirement as batch-coach-info/batch-social's own
// Inner/Suspense split.
function BatchMaxPrepsPageInner() {
  const supabase = getSupabaseBrowserClient();
  const { user, profile } = useAuth();
  const canReview = profile?.role === "verifier" || profile?.role === "sysadmin";
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // Set when this page was opened via a "Focus →" link from State Progress
  // -- see batch-athletics's own stateFromUrl comment for the full
  // reasoning, identical here.
  const stateFromUrl = searchParams.get("state");

  // Set when this page was opened via the "Start MaxPreps URL Discovery for
  // These Schools" chain button on a completed Batch Coach-Info run -- see
  // Batch Athletics' identical chainSourceRunId for the full reasoning.
  const [chainSourceRunId] = useState(() => {
    const fromUrl = Number(searchParams.get("fromCoachInfoRun"));
    return Number.isFinite(fromUrl) && fromUrl > 0 ? fromUrl : null;
  });
  const [chainDismissed, setChainDismissed] = useState(false);
  const [chainCreating, setChainCreating] = useState(false);
  const [chainError, setChainError] = useState("");

  const [runs, setRuns] = useState([]);
  const [runPendingCounts, setRunPendingCounts] = useState({});
  // Latest reviewed_at across a run's items, keyed by run id -- shown as
  // "last worked" on each run row (see loadRuns) so Larry can tell which
  // run he was most recently in without opening each one.
  const [runLastWorked, setRunLastWorked] = useState({});
  const [hideCompletedRuns, setHideCompletedRuns] = useState(true);
  const [loadingRuns, setLoadingRuns] = useState(true);
  const [selectedRunId, setSelectedRunId] = useState(null);
  const [items, setItems] = useState([]);
  const [loadingItems, setLoadingItems] = useState(false);

  const [scopeMode, setScopeMode] = useState(stateFromUrl ? "all" : "priority"); // "priority" | "all"
  const [customStates, setCustomStates] = useState(stateFromUrl || PRIORITY_STATES.join(", "));
  const [targetCount, setTargetCount] = useState(stateFromUrl ? 1000 : DEFAULT_TARGET_COUNT);
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
  const [showReviewed, setShowReviewed] = useState(false);
  const [bulkApplying, setBulkApplying] = useState(false);
  const [bulkProgress, setBulkProgress] = useState({ done: 0, total: 0 });
  // Confidence filter + search box -- same pattern as Batch Coach-Info's
  // own review queue (see that page's confidenceFilter/searchQuery for the
  // full reasoning): lets a reviewer work through one tier at a time, or
  // jump straight to a specific school, once a run's list runs into the
  // hundreds instead of scrolling one long mixed table.
  const [confidenceFilter, setConfidenceFilter] = useState("all"); // "all" | "high" | "medium" | "low"
  const [searchQuery, setSearchQuery] = useState("");
  const [focusedIndex, setFocusedIndex] = useState(0);
  // The AI's one-paragraph reasoning for each suggestion is collapsed by
  // default (Larry's own words: reading a full paragraph per row on a
  // 100+-item run is "extremely time consuming") -- a row shows just the
  // suggested URL and a "Why?" toggle; clicking it reveals the reasoning
  // for that one row without reloading anything. Tracked as a Set of item
  // ids rather than a boolean per item so this stays a single small piece
  // of state instead of touching the items array itself.
  const [expandedReasoning, setExpandedReasoning] = useState(() => new Set());
  function toggleReasoning(itemId) {
    setExpandedReasoning((prev) => {
      const next = new Set(prev);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });
  }

  // Inline "Quick Fix" editor -- same pattern as Batch Coach-Info/Batch
  // Social/Batch Athletics (see Batch Coach-Info for the full reasoning):
  // correct the suggested MaxPreps URL, or type in one the AI missed,
  // without leaving this review queue. Only one row open at a time.
  const [editingId, setEditingId] = useState(() => readStoredQuickFix()?.itemId ?? null);
  const [editDraft, setEditDraft] = useState(() => readStoredQuickFix()?.draft ?? "");
  const [savingEdit, setSavingEdit] = useState(false);
  const [editError, setEditError] = useState("");

  // Undo toast after a Quick Fix save -- see Batch Coach-Info's identical
  // state for the full reasoning. Single-slot, auto-clears after 8s.
  const [undoToast, setUndoToast] = useState(null);
  const undoTimeoutRef = useRef(null);
  useEffect(() => () => clearTimeout(undoTimeoutRef.current), []);

  // Keeps sessionStorage in lockstep with the editor -- see Batch
  // Coach-Info's identical effect for the full reasoning.
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      if (editingId !== null) {
        window.sessionStorage.setItem(QUICK_FIX_STORAGE_KEY, JSON.stringify({ runId: selectedRunId, itemId: editingId, draft: editDraft }));
      } else {
        window.sessionStorage.removeItem(QUICK_FIX_STORAGE_KEY);
      }
    } catch (_) {}
  }, [editingId, editDraft, selectedRunId]);

  function openEdit(item) {
    if (editingId === item.id) {
      setEditingId(null);
      return;
    }
    setEditingId(item.id);
    setEditDraft(item.suggestion?.best_url || item.school?.maxpreps_url || "");
    setEditError("");
  }

  function cancelEdit() {
    setEditingId(null);
    setEditError("");
  }

  // Same single write as applySuggestionCore below, using the edited draft
  // instead of the AI's exact pick.
  async function saveEdit(item) {
    setSavingEdit(true);
    setEditError("");
    const s = item.school;
    const previousSchool = { ...(s || {}) };
    const previousReviewStatus = item.review_status;
    const newVal = (editDraft || "").trim();
    try {
      const sawChange = newVal !== (s.maxpreps_url || "");
      if (sawChange) {
        const { error: updateErr } = await supabase.from("schools").update({ maxpreps_url: newVal }).eq("id", s.id);
        if (updateErr) throw updateErr;
        const { error: logErr } = await supabase.from("school_change_log").insert({
          school_id: s.id,
          field_name: "maxpreps_url",
          old_value: s.maxpreps_url || null,
          new_value: newVal,
          source: "Batch AI lookup (reviewed, hand-corrected)",
          changed_by: user.id,
        });
        if (logErr) throw logErr;
      }
      const { error: itemErr } = await supabase
        .from("maxpreps_batch_items")
        .update({ review_status: sawChange ? "applied" : "skipped", reviewed_at: new Date().toISOString(), reviewed_by: user.id })
        .eq("id", item.id);
      if (itemErr) throw itemErr;
      setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, review_status: sawChange ? "applied" : "skipped" } : i)));
      setEditingId(null);
      if (sawChange) {
        clearTimeout(undoTimeoutRef.current);
        const toastId = Date.now();
        setUndoToast({ id: toastId, itemId: item.id, schoolName: previousSchool.name, previousSchool, previousReviewStatus });
        undoTimeoutRef.current = setTimeout(() => {
          setUndoToast((cur) => (cur && cur.id === toastId ? null : cur));
        }, 8000);
      }
    } catch (err) {
      setEditError(err.message || "Could not save this edit.");
    } finally {
      setSavingEdit(false);
    }
  }

  // Reverts a Quick Fix save back to exactly what was on file before it --
  // see Batch Coach-Info's identical action for the full reasoning.
  async function undoQuickFixSave() {
    if (!undoToast) return;
    const { itemId, previousSchool, previousReviewStatus } = undoToast;
    setReviewError("");
    try {
      const current = items.find((i) => i.id === itemId)?.school || {};
      const priorVal = previousSchool.maxpreps_url || null;
      const curVal = current.maxpreps_url || null;
      if (priorVal !== curVal) {
        const { error: updateErr } = await supabase.from("schools").update({ maxpreps_url: priorVal }).eq("id", previousSchool.id);
        if (updateErr) throw updateErr;
        const { error: logErr } = await supabase.from("school_change_log").insert({
          school_id: previousSchool.id,
          field_name: "maxpreps_url",
          old_value: curVal,
          new_value: priorVal,
          source: "Quick Fix Undo -- reverted to pre-save value",
          changed_by: user.id,
        });
        if (logErr) throw logErr;
      }
      const { error: itemErr } = await supabase
        .from("maxpreps_batch_items")
        .update({ review_status: previousReviewStatus, reviewed_at: null, reviewed_by: null })
        .eq("id", itemId);
      if (itemErr) throw itemErr;
      setItems((prev) => prev.map((i) => (i.id === itemId ? { ...i, review_status: previousReviewStatus, school: { ...i.school, maxpreps_url: priorVal } } : i)));
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
  const matchedItems = suggestedItems.filter((i) => i.suggestion.best_url);
  // Pending-only on both -- once confirmed via confirmNoDataAvailable,
  // review_status moves to "confirmed_no_data" but the underlying suggestion
  // shape doesn't change, so without this check a confirmed row would keep
  // showing up in the "Confirm no data available" section forever.
  const noMatchItems = suggestedItems.filter((i) => !i.suggestion.best_url && !i.suggestion_error && i.review_status === "pending");
  const failedItems = suggestedItems.filter((i) => i.suggestion_error && i.review_status === "pending");
  const pendingReview = matchedItems.filter((i) => i.review_status === "pending");
  const reviewedItems = matchedItems.filter((i) => i.review_status !== "pending");
  // Quick same-day progress count for the summary line below -- "today"
  // uses the same daysSince semantics as WaitingBadge elsewhere on this
  // page (within the last 24 hours, not strictly the same calendar day).
  const reviewedTodayCount = reviewedItems.filter((i) => i.reviewed_at && daysSince(i.reviewed_at) === 0).length;
  const highConfidencePendingCount = pendingReview.filter((i) => i.suggestion?.confidence === "high").length;
  const verifiedElsewhereItems = pendingReview.filter((i) => wasVerifiedElsewhere(i, selectedRun));
  // Everything with nothing usable to apply -- an outright AI failure
  // (failedItems) or a search that ran fine but found no confident match
  // (noMatchItems). Both get the same "Confirm no data available" treatment.
  const noDataItems = [...noMatchItems, ...failedItems];
  // Duplicate-suggestion groups -- e.g. a whole district sharing one
  // MaxPreps program page across several of its schools. Only groups with
  // 2+ members are worth a bulk button; a single match is just a normal row.
  const duplicateUrlGroups = (() => {
    const groups = new Map();
    pendingReview.forEach((item) => {
      const v = item.suggestion?.best_url;
      if (!v) return;
      if (!groups.has(v)) groups.set(v, []);
      groups.get(v).push(item);
    });
    return Array.from(groups.entries())
      .filter(([, list]) => list.length >= 2)
      .map(([value, list]) => ({ value, items: list }));
  })();

  function isRunOpen(r) {
    if (r.status !== "collected") return true;
    if (r.id === selectedRunId) return pendingReview.length > 0;
    return (runPendingCounts[r.id] || 0) > 0;
  }
  const openRunsCount = runs.filter(isRunOpen).length;
  const visibleRunsList = hideCompletedRuns ? runs.filter(isRunOpen) : runs;

  // Matches a row against the current search box -- school name, city, OR
  // the current/suggested MaxPreps URL, case-insensitive. Same loose
  // substring match as Batch Coach-Info's own matchesSearch.
  function matchesSearch(item) {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return true;
    const s = item.school;
    const sug = item.suggestion;
    const haystack = [s?.name, s?.city, s?.maxpreps_url, sug?.best_url].filter(Boolean).join(" ").toLowerCase();
    return haystack.includes(q);
  }

  // Base row set the table renders from -- pendingReview, or (with "Show
  // already-reviewed" checked) every matched item -- with the confidence
  // tier and search box both applied on top. Computed once here so the
  // on-screen counts next to each confidence button, the rendered rows, and
  // the keyboard-nav targets below can never disagree about what's visible.
  // With "Show already-reviewed" on, the still-pending rows stay up front
  // (they're the ones actually needing a decision) and the reviewed ones
  // sort newest-first by reviewed_at -- whatever was just finished surfaces
  // at the top instead of sitting wherever it landed in the original fetch
  // order.
  const reviewBaseRows = showReviewed
    ? [...pendingReview, ...matchedItems.filter((i) => i.review_status !== "pending").sort((a, b) => new Date(b.reviewed_at || 0) - new Date(a.reviewed_at || 0))]
    : pendingReview;
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
    // already-reviewed rows so a reviewer can jump straight to the ones with
    // a reviewed-date badge instead of scrolling past every pending row first.
    const tierMatch = confidenceFilter === "reviewed" ? i.review_status !== "pending" : confidenceFilter === "all" || i.suggestion?.confidence === confidenceFilter;
    return tierMatch && matchesSearch(i);
  });

  // Keyboard-nav targets mirror the table's own row filter (pendingReview
  // with the same confidence/search filters the visible table uses) so the
  // focused row always lines up with what's actually on screen -- reviewed
  // rows stay excluded here regardless of "Show already-reviewed" since
  // there's nothing left to apply/skip on one.
  const keyboardTargets = pendingReview.filter((i) => (confidenceFilter === "all" || i.suggestion?.confidence === confidenceFilter) && matchesSearch(i));
  // Keeps the keyboard-focused row valid as keyboardTargets shrinks (typing
  // in the search box, narrowing the confidence filter, or applying/
  // skipping removes items) or a different run is opened.
  const clampedFocusedIndex = keyboardTargets.length === 0 ? 0 : Math.min(focusedIndex, keyboardTargets.length - 1);
  const focusedItem = keyboardTargets[clampedFocusedIndex] || null;

  // Narrowing the confidence filter or typing a search query changes which
  // rows are keyboard-nav targets -- reset focus to the top of the new list
  // rather than leaving it pointed at an index that now means something
  // else (or nothing at all).
  useEffect(() => {
    setFocusedIndex(0);
  }, [confidenceFilter, searchQuery]);

  // Keyboard shortcuts for the review queue -- Up/Down move focus between
  // pending rows, A applies the focused row, S skips it. Only active while
  // this run is at the "collected" review stage, nothing's mid-flight, and
  // the user isn't typing into a form field (e.g. the custom-states input
  // above). Lets a reviewer clear a run without reaching for the mouse for
  // every single Apply/Skip click.
  useEffect(() => {
    function onKeyDown(e) {
      if (selectedRun?.status !== "collected") return;
      if (bulkApplying || applyingId) return;
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
  }, [selectedRun?.status, bulkApplying, applyingId, focusedItem, keyboardTargets.length, editingId]);

  const loadRuns = useCallback(async () => {
    setLoadingRuns(true);
    const { data } = await supabase.from("maxpreps_batch_runs").select("*").order("created_at", { ascending: false }).limit(30);
    setRuns(data || []);
    const ids = (data || []).map((r) => r.id);
    if (ids.length) {
      const [{ data: pendingRows }, { data: reviewedRows }] = await Promise.all([
        supabase.from("maxpreps_batch_run_pending").select("batch_run_id,pending_count").in("batch_run_id", ids),
        // Last-worked date per run -- just the two columns needed to find
        // the max reviewed_at client-side, cheap even for a run with a
        // thousand items, and avoids needing a dedicated view the way the
        // pending-count query above does.
        supabase.from("maxpreps_batch_items").select("batch_run_id,reviewed_at").in("batch_run_id", ids).not("reviewed_at", "is", null),
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
      const { data } = await supabase.from("maxpreps_batch_items").select(ITEM_SELECT).eq("batch_run_id", runId).order("id");
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
        await supabase.from("maxpreps_batch_items").update({ review_status: "skipped", reviewed_at: now, reviewed_by: user.id }).in("id", staleIds);
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

      // Excludes every school that's EVER gone through this tool before --
      // applied, skipped, or a suggestion the AI found no match for -- not
      // just ones sitting in a still-open run (same fix just made to Batch
      // Coach-Info's startRun; see that page for the full reasoning). Over-
      // fetches 3x and filters client-side rather than a giant SQL "not in"
      // list.
      const { data: touchedRows, error: touchedErr } = await supabase.from("maxpreps_batch_items").select("school_id");
      if (touchedErr) throw touchedErr;
      const excludedIds = new Set((touchedRows || []).map((r) => r.school_id));

      let query = supabase
        .from("schools")
        .select("id,name,city,state")
        .or("maxpreps_url.is.null,maxpreps_url.eq.")
        // Skip schools a human has already confirmed have no MaxPreps page,
        // and closed/discontinued schools -- neither will ever have a real
        // MaxPreps page to find. See lib/dataQuality.js.
        .eq("maxpreps_not_available", false)
        .eq("is_closed", false)
        // Skip schools Larry has already marked reviewed/confirmed-accurate
        // (verification_status = "verified") even if this particular field
        // happens to still read blank -- a human already looked at this
        // record, so it shouldn't come back through an automated sweep.
        // Doesn't affect the single-school "Find MaxPreps Page" button on a
        // school's own profile, which is still there any time someone
        // wants to force a fresh look at one specific school.
        .neq("verification_status", "verified")
        .order("id", { ascending: true })
        .limit(targetCount * 3);
      if (scopeMode !== "all" || states.length) {
        query = query.in("state", states);
      }

      const { data: rawSchoolsData, error: schoolsErr } = await query;
      if (schoolsErr) throw schoolsErr;
      const schoolsData = (rawSchoolsData || []).filter((s) => !excludedIds.has(s.id)).slice(0, targetCount);
      if (!schoolsData || schoolsData.length === 0) {
        setCreateError("No schools matched -- everyone missing a MaxPreps URL in this scope has already been through this tool before.");
        return;
      }

      const { data: runRow, error: runErr } = await supabase
        .from("maxpreps_batch_runs")
        .insert({ status: "collecting", state_filter: scopeMode === "all" && states.length === 0 ? null : states, requested_count: schoolsData.length, created_by: user.id })
        .select()
        .single();
      if (runErr) throw runErr;

      const itemRows = schoolsData.map((s) => ({ batch_run_id: runRow.id, school_id: s.id }));
      const { error: itemsErr } = await supabase.from("maxpreps_batch_items").insert(itemRows);
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
        const res = await fetch("/api/admin/maxpreps-batch/fetch-item", {
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
      const res = await fetch(`/api/admin/maxpreps-batch/${selectedRun.id}/submit`, {
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
      const res = await fetch(`/api/admin/maxpreps-batch/${selectedRun.id}/check-status`, {
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
      const res = await fetch(`/api/admin/maxpreps-batch/${selectedRun.id}/collect`, {
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

  // Pulled out of applyItem so bulkApplyHighConfidence can reuse the exact
  // same write path (schools update + school_change_log entry + item
  // marked applied) for each item in a batch, without touching the
  // single-item applyingId/reviewError state that only makes sense for one
  // row at a time. Mirrors the same split on the Batch Athletics/Social
  // pages.
  async function applySuggestionCore(item) {
    const s = item.school;
    const sug = item.suggestion;
    if (!s || !sug || !sug.best_url) return { ok: false, error: "Missing school or suggestion." };
    try {
      const newVal = sug.best_url;
      if (newVal !== (s.maxpreps_url || "")) {
        const { error: updateErr } = await supabase.from("schools").update({ maxpreps_url: newVal }).eq("id", s.id);
        if (updateErr) throw updateErr;
        const { error: logErr } = await supabase.from("school_change_log").insert({
          school_id: s.id,
          field_name: "maxpreps_url",
          old_value: s.maxpreps_url || null,
          new_value: newVal,
          source: `Batch AI lookup (${sug.confidence} confidence, reviewed)`,
          changed_by: user.id,
        });
        if (logErr) throw logErr;
      }
      const { error: itemErr } = await supabase
        .from("maxpreps_batch_items")
        .update({ review_status: "applied", reviewed_at: new Date().toISOString(), reviewed_by: user.id })
        .eq("id", item.id);
      if (itemErr) throw itemErr;
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message || "Could not apply this suggestion." };
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
  // one click -- the AI only marks a suggestion "high confidence" when the
  // search result was unambiguously this school's own MaxPreps football
  // page, so these are the ones a reviewer would almost always click Apply
  // on anyway. Same batching pattern as Batch Athletics/Social's
  // bulkApplyHighConfidence.
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

  async function skipItem(item) {
    setApplyingId(item.id);
    setReviewError("");
    try {
      const { error } = await supabase
        .from("maxpreps_batch_items")
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
  // other channel since this run started -- see wasVerifiedElsewhere.
  async function bulkSkipVerifiedElsewhere() {
    const targets = verifiedElsewhereItems;
    if (!targets.length) return;
    setBulkApplying(true);
    setReviewError("");
    try {
      const { error } = await supabase
        .from("maxpreps_batch_items")
        .update({ review_status: "skipped", reviewed_at: new Date().toISOString(), reviewed_by: user.id })
        .in("id", targets.map((i) => i.id));
      if (error) throw error;
      const skippedIds = new Set(targets.map((i) => i.id));
      setItems((prev) => prev.map((i) => (skippedIds.has(i.id) ? { ...i, review_status: "skipped" } : i)));
      setFocusedIndex(0);
    } catch (err) {
      setReviewError(err.message || "Could not skip these suggestions.");
    } finally {
      setBulkApplying(false);
    }
  }

  // Applies one duplicate-suggestion group in one click (see
  // duplicateUrlGroups) -- same applySuggestionCore write path as every
  // other apply here, just run across a pre-grouped list.
  async function bulkApplyGroup(groupItems) {
    if (!groupItems.length) return;
    setBulkApplying(true);
    setReviewError("");
    setBulkProgress({ done: 0, total: groupItems.length });
    let done = 0;
    const failures = [];
    await runWithConcurrency(groupItems, APPLY_CONCURRENCY, async (item) => {
      const result = await applySuggestionCore(item);
      if (result.ok) {
        setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, review_status: "applied" } : i)));
      } else {
        failures.push(`${item.school?.name || `#${item.id}`}: ${result.error}`);
      }
      done++;
      setBulkProgress({ done, total: groupItems.length });
    });
    setBulkApplying(false);
    setFocusedIndex(0);
    if (failures.length > 0) {
      setReviewError(`Applied ${groupItems.length - failures.length} of ${groupItems.length}. ${failures.length} failed: ${failures.slice(0, 3).join("; ")}${failures.length > 3 ? "…" : ""}`);
    }
  }

  // "Confirmed, no data available" -- see Batch Coach-Info's identical
  // action for the full reasoning. Marks the school verified so it stops
  // resurfacing in every future MaxPreps run.
  async function confirmNoDataAvailableCore(item) {
    try {
      const s = item.school;
      if (!s) return { ok: false, error: "Missing school." };
      const wasNotAvailable = !!s.maxpreps_not_available;
      const { error: updateErr } = await supabase
        .from("schools")
        .update({ verification_status: "verified", last_verified_at: new Date().toISOString(), maxpreps_not_available: true })
        .eq("id", s.id);
      if (updateErr) throw updateErr;
      const logRows = [
        {
          school_id: s.id,
          field_name: "maxpreps_url",
          old_value: s.maxpreps_url || null,
          new_value: s.maxpreps_url || null,
          source: "Batch MaxPreps review -- confirmed no data available",
          changed_by: user.id,
        },
      ];
      if (!wasNotAvailable) {
        logRows.push({
          school_id: s.id,
          field_name: "maxpreps_not_available",
          old_value: String(wasNotAvailable),
          new_value: "true",
          source: "Batch MaxPreps review -- confirmed no data available",
          changed_by: user.id,
        });
      }
      const { error: logErr } = await supabase.from("school_change_log").insert(logRows);
      if (logErr) throw logErr;
      const { error: itemErr } = await supabase
        .from("maxpreps_batch_items")
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
    const targets = noDataItems;
    if (!targets.length) return;
    setBulkApplying(true);
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
    setBulkApplying(false);
    if (failures.length > 0) {
      setReviewError(`Confirmed ${targets.length - failures.length} of ${targets.length}. ${failures.length} failed: ${failures.slice(0, 3).join("; ")}${failures.length > 3 ? "…" : ""}`);
    }
  }

  // Chained run: scoped to exactly the schools Batch Coach-Info just
  // processed in run #chainSourceRunId, instead of a state/count pull --
  // same pattern as Batch Athletics' own startChainedRun. Still re-runs
  // MaxPreps' own eligibility filter (no MaxPreps URL, not marked
  // unavailable/closed, not already run through this tool before) -- a
  // school landing in the Coach-Info run doesn't bypass any of MaxPreps'
  // own rules, it just narrows the candidate pool.
  async function startChainedRun() {
    if (!chainSourceRunId) return;
    setChainCreating(true);
    setChainError("");
    try {
      const { data: sourceItems, error: srcErr } = await supabase
        .from("coach_info_batch_items")
        .select("school_id")
        .eq("batch_run_id", chainSourceRunId);
      if (srcErr) throw srcErr;
      const schoolIds = Array.from(new Set((sourceItems || []).map((i) => i.school_id).filter(Boolean)));
      if (!schoolIds.length) {
        setChainError(`Coach-Info run #${chainSourceRunId} doesn't have any schools to chain from.`);
        return;
      }

      const { data: touchedRows, error: touchedErr } = await supabase.from("maxpreps_batch_items").select("school_id");
      if (touchedErr) throw touchedErr;
      const excludedIds = new Set((touchedRows || []).map((r) => r.school_id));

      const { data: rawSchoolsData, error: schoolsErr } = await supabase
        .from("schools")
        .select("id,name,city,state")
        .in("id", schoolIds)
        .or("maxpreps_url.is.null,maxpreps_url.eq.")
        .eq("maxpreps_not_available", false)
        .eq("is_closed", false)
        .neq("verification_status", "verified")
        .order("id", { ascending: true });
      if (schoolsErr) throw schoolsErr;
      const schoolsData = (rawSchoolsData || []).filter((s) => !excludedIds.has(s.id));
      if (!schoolsData.length) {
        setChainError(
          `None of the schools from Coach-Info run #${chainSourceRunId} currently qualify -- they may already have a MaxPreps URL on file, be marked unavailable or closed, or have already been through MaxPreps Discovery before.`
        );
        return;
      }

      const { data: runRow, error: runErr } = await supabase
        .from("maxpreps_batch_runs")
        .insert({ status: "collecting", state_filter: null, requested_count: schoolsData.length, created_by: user.id, source_coach_info_run_id: chainSourceRunId })
        .select()
        .single();
      if (runErr) throw runErr;

      const itemRows = schoolsData.map((s) => ({ batch_run_id: runRow.id, school_id: s.id }));
      const { error: itemsErr } = await supabase.from("maxpreps_batch_items").insert(itemRows);
      if (itemsErr) throw itemsErr;

      await loadRuns();
      openRun(runRow.id);
      router.replace(pathname, { scroll: false });
    } catch (err) {
      setChainError(err.message || "Could not start a chained batch run.");
    } finally {
      setChainCreating(false);
    }
  }

  function exportRunCsv() {
    if (!selectedRun || !visibleRows.length) return;
    const csv = Papa.unparse({
      fields: ["school_id", "school_name", "city", "state", "current_maxpreps_url", "suggested_maxpreps_url", "confidence", "reasoning", "status"],
      data: visibleRows.map((item) => {
        const s = item.school || {};
        const sug = item.suggestion || {};
        return [
          s.id,
          s.name,
          s.city,
          s.state,
          s.maxpreps_url || "",
          sug.best_url || "",
          sug.confidence || "",
          sug.reasoning || "",
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
    link.download = `csd-maxpreps-run-${selectedRun.id}-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  if (!canReview) {
    return (
      <div className="view">
        <div className="notice danger">Batch MaxPreps discovery is limited to Verification Staff and System Admins.</div>
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
          <h1>Batch MaxPreps Discovery</h1>
          <p>Run a web search for each school's MaxPreps football team page overnight via Anthropic's Batch API, then review and apply the AI's best pick here.</p>
        </div>
      </div>

      {chainSourceRunId && !chainDismissed ? (
        <div className="card" style={{ marginBottom: 14, border: "1px solid #cfe0f2", background: "#f5f9fd" }}>
          <h3 style={{ marginBottom: 4 }}>Chained from Batch Coach-Info Discovery — Run #{chainSourceRunId}</h3>
          <p style={{ fontSize: 12.5, color: "#697386" }}>
            This starts a MaxPreps URL Discovery run scoped to just the schools from that Coach-Info run -- not a new state/count pull. Each one still has to actually qualify (no MaxPreps
            URL on file, not marked unavailable or closed, and not already run through this tool before) -- schools that don't qualify are simply left out, same as any other run.
          </p>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <button className="btn btn-primary btn-sm" onClick={startChainedRun} disabled={chainCreating}>
              {chainCreating ? "Starting…" : "Start MaxPreps URL Discovery for These Schools"}
            </button>
            <button
              type="button"
              className="btn btn-sm"
              disabled={chainCreating}
              onClick={() => {
                setChainDismissed(true);
                router.replace(pathname, { scroll: false });
              }}
            >
              Cancel — start a regular run instead
            </button>
          </div>
          {chainError && (
            <div className="notice danger" style={{ marginTop: 10, fontSize: 12.5 }}>
              {chainError}
            </div>
          )}
        </div>
      ) : (
        <div className="card" style={{ marginBottom: 14 }}>
          <h3>Start a New Batch Run</h3>
          <p style={{ fontSize: 12.5, color: "#697386", marginTop: -4 }}>
            Pulls schools with no MaxPreps URL on file yet. A school's MaxPreps team page is the fallback source the nightly Coach-Change Radar checks when there's no athletics URL on file,
            and it's often the fastest way for recruiting staff to confirm a roster is current -- closing this gap raises the accuracy ceiling here too.
            {" "}Any school already applied, skipped, or attempted here before is automatically left out of every future run.
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
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
      )}

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
                Step 1: search for each school's MaxPreps page, then save the results. {readyCount} ready, {pendingFetchCount} not searched yet, {noContentCount} found nothing usable.
              </p>
              <button className="btn btn-sm" onClick={fetchSources} disabled={fetching || loadingItems || pendingFetchCount === 0}>
                {fetching ? `Searching ${fetchProgress.done} of ${fetchProgress.total}…` : pendingFetchCount === 0 ? "All Searched" : `Search (${pendingFetchCount} schools)`}
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
                  reviewed{reviewedTodayCount > 0 ? ` (${reviewedTodayCount} today)` : ""}, {noMatchItems.length} where the AI found no confident match, {failedItems.length} the AI couldn't
                  produce a suggestion for.
                </p>
                <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
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
                </div>
              </div>

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
                  placeholder="Search school, city, or URL…"
                  style={{ maxWidth: 220, fontSize: 12.5 }}
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
                    <strong>{highConfidencePendingCount}</strong> of those are <strong>high confidence</strong> -- the AI was confident the search result was unambiguously this school's own
                    MaxPreps football page. These are safe to clear in one click instead of reviewing one at a time.
                  </span>
                  <button className="btn btn-gold btn-sm" onClick={bulkApplyHighConfidence} disabled={bulkApplying}>
                    {bulkApplying ? `Applying ${bulkProgress.done} of ${bulkProgress.total}…` : `Apply All High-Confidence (${highConfidencePendingCount})`}
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
                    <strong>{verifiedElsewhereItems.length}</strong> of these schools got marked <strong>verified elsewhere</strong> since this run started. Reviewing them here would be
                    redundant work.
                  </span>
                  <button className="btn btn-sm" onClick={bulkSkipVerifiedElsewhere} disabled={bulkApplying}>
                    {bulkApplying ? "Skipping…" : `Skip All — Already Verified Elsewhere (${verifiedElsewhereItems.length})`}
                  </button>
                </div>
              )}

              {duplicateUrlGroups.length > 0 && (
                <div
                  style={{
                    marginBottom: 10,
                    padding: "10px 12px",
                    background: "#f5f6f8",
                    border: "1px solid #e3e6ea",
                    borderRadius: 8,
                  }}
                >
                  <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 6 }}>Same URL suggested for multiple schools</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {duplicateUrlGroups.map((g) => (
                      <div key={g.value} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, fontSize: 12 }}>
                        <span>
                          <strong>{g.value}</strong> suggested for {g.items.length} schools ({g.items.map((i) => i.school?.name).slice(0, 3).join(", ")}
                          {g.items.length > 3 ? "…" : ""})
                        </span>
                        <button className="btn btn-sm" onClick={() => bulkApplyGroup(g.items)} disabled={bulkApplying}>
                          Apply to All {g.items.length}
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {reviewError && (
                <div className="notice danger" style={{ marginBottom: 10, fontSize: 12.5 }}>
                  {reviewError}
                </div>
              )}

              {noDataItems.length > 0 && (
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
                      <strong>{noDataItems.length}</strong> school{noDataItems.length === 1 ? "" : "s"} with no confident MaxPreps URL match, or the AI couldn't produce a suggestion at
                      all. If there's genuinely no MaxPreps page findable, confirm it below so it stops resurfacing in every future run.
                    </span>
                    <button className="btn btn-sm" onClick={bulkConfirmNoDataAvailable} disabled={bulkApplying}>
                      {bulkApplying ? "Confirming…" : `Confirm All — No Data Available (${noDataItems.length})`}
                    </button>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    {noDataItems.map((item) => (
                      <div key={item.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, fontSize: 12, padding: "3px 0" }}>
                        <span>
                          {item.school?.name} — {item.school?.city}, {item.school?.state}
                          {item.suggestion_error && <span style={{ color: "#9aa1ab" }}> ({item.suggestion_error})</span>}
                        </span>
                        <button className="btn btn-sm" onClick={() => confirmNoDataAvailable(item)} disabled={applyingId === item.id || bulkApplying}>
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
                      <th style={{ padding: "6px 8px" }}>Suggested MaxPreps URL</th>
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
                      return [
                        <tr
                          key={item.id}
                          style={{
                            borderBottom: "1px solid #eef0f3",
                            opacity: reviewed ? 0.55 : 1,
                            verticalAlign: "top",
                            background: isFocused ? "#eef4fb" : undefined,
                            boxShadow: isFocused ? "inset 3px 0 0 #2f5fa8" : undefined,
                          }}
                        >
                          <td style={{ padding: "8px", whiteSpace: "nowrap" }}>
                            <div style={{ fontWeight: 600 }}>{s.name}</div>
                            <div style={{ color: "#9aa1ab" }}>
                              {s.city}, {s.state}
                            </div>
                            {wasVerifiedElsewhere(item, selectedRun) && (
                              <span className="badge" style={{ fontSize: 10.5, color: "#1e7145", background: "#1e714519", fontWeight: 600, marginTop: 2, display: "inline-block" }}>
                                ✓ Verified elsewhere since this run started
                              </span>
                            )}
                          </td>
                          <td style={{ padding: "8px", minWidth: 260 }}>
                            <div style={{ color: "#1e7145", fontWeight: 600 }}>{sug.best_url}</div>
                            <div style={{ color: "#9aa1ab" }}>Current: {s.maxpreps_url || "(blank)"}</div>
                            {sug.reasoning && (
                              <div style={{ marginTop: 4 }}>
                                <button
                                  type="button"
                                  onClick={() => toggleReasoning(item.id)}
                                  style={{ background: "none", border: "none", padding: 0, color: "#5b7fb5", fontSize: 11.5, cursor: "pointer", textDecoration: "underline" }}
                                >
                                  {expandedReasoning.has(item.id) ? "Hide reasoning" : "Why?"}
                                </button>
                                {expandedReasoning.has(item.id) && (
                                  <div style={{ marginTop: 2, fontStyle: "italic", color: "#9aa1ab" }}>"{sug.reasoning}"</div>
                                )}
                              </div>
                            )}
                          </td>
                          <td style={{ padding: "8px", whiteSpace: "nowrap" }}>
                            <span className="badge" style={{ fontSize: 11, color: confidenceColor(sug.confidence) }}>
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
                                <button className="btn btn-gold btn-sm" disabled={applying || bulkApplying} onClick={() => applyItem(item)}>
                                  {applying ? "…" : "Apply"}
                                </button>
                                <button className="btn btn-sm" disabled={applying || bulkApplying} onClick={() => skipItem(item)}>
                                  Skip
                                </button>
                                <button
                                  className="btn btn-sm"
                                  disabled={applying || bulkApplying}
                                  onClick={() => openEdit(item)}
                                  style={editingId === item.id ? { background: "#0b5fff", borderColor: "#0b5fff", color: "#fff" } : undefined}
                                  title="Fix the URL before applying, right here, without opening the school's record"
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
                              <div style={{ fontSize: 11.5, fontWeight: 600, color: "#697386", marginBottom: 8 }}>Quick Fix — {s.name}</div>
                              <label style={{ fontSize: 11.5, color: "#697386", display: "block", maxWidth: 420 }}>
                                MaxPreps URL
                                <input
                                  value={editDraft}
                                  onChange={(e) => setEditDraft(e.target.value)}
                                  style={{ width: "100%", marginTop: 2, fontSize: 12.5 }}
                                  placeholder={s.maxpreps_url || ""}
                                />
                              </label>
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
                                <span style={{ fontSize: 11, color: "#9aa1ab", alignSelf: "center" }}>Esc to cancel.</span>
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
          <button className="btn btn-sm btn-gold" onClick={undoQuickFixSave} style={{ whiteSpace: "nowrap" }}>
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

export default function BatchMaxPrepsPage() {
  return (
    <Suspense fallback={<div className="view"><div className="empty-state">Loading…</div></div>}>
      <BatchMaxPrepsPageInner />
    </Suspense>
  );
}
