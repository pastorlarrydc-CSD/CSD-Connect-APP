"use client";
import { useState, useEffect, useCallback, Suspense } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import Link from "next/link";
import Papa from "papaparse";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { useAuth } from "@/lib/auth-context";

// Overnight Social Media Batch API job -- the social-handle counterpart to
// /admin/batch-athletics (see that page for the pattern this mirrors, and
// lib/socialLookup.js for the model prompt this pipeline runs against).
// Social handle coverage is the single worst-covered field in the whole
// database (well under 1% of schools have one on file) -- unlike
// Athletics-URL or Coach-Info discovery, a useful search here needs a
// coach's NAME to search by (site:-restricted Twitter/Facebook searches
// for a name, same as the single-school "Find Social Media" button), so
// this tool's candidate pool is schools that already HAVE a head coach
// name on file but are missing a Twitter/X and/or Facebook handle -- not
// schools missing a name.
//
// Same four stages as Batch Athletics/Batch Coach-Info, and the same
// non-authoritative contract -- nothing here ever writes to the schools
// table until a human clicks Apply on a specific school's suggestion
// below:
//  1. Prep    -- run two web searches per school (one per platform) for
//                the coach's own account, save the raw candidate results
//                (fetch-item route, driven here with a few requests in
//                flight at once).
//  2. Submit  -- bundle every "ready" item into one Anthropic Batch API
//                submission (submit route). The model's job is picking
//                which ONE result per platform (if any) is genuinely this
//                coach's own account -- not extracting anything from a
//                page, since these are search-result picks, not page reads.
//  3. Wait    -- Anthropic processes asynchronously; check back later
//                (check-status route, polled by hand -- no auto-refresh).
//  4. Collect -- once Anthropic reports the batch "ended", download and
//                parse its results into a review queue (collect route).
const PRIORITY_STATES = ["TX", "FL", "GA", "CA", "OH", "IN"];
const TARGET_COUNTS = [100, 300, 500, 1000];
const DEFAULT_TARGET_COUNT = 300;
const FETCH_CONCURRENCY = 8; // matches the weekly automated cron's own concurrency (app/api/cron/weekly-social-batch) -- this manual page used to run at 3, well under what the same Serper calls handle fine unattended, which just meant a longer wait staring at this tab for a same-size run
const APPLY_CONCURRENCY = 5; // applying is just a DB write, no web fetch/AI call, so higher concurrency than FETCH_CONCURRENCY is safe -- matches batch-athletics/batch-coach-info

const ITEM_SELECT =
  "id,batch_run_id,school_id,fetch_status,suggestion,suggestion_error,review_status,school:schools(id,name,city,state,hc_first_name,hc_last_name,hc_twitter,hc_facebook)";

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

function confidenceColor(confidence) {
  if (confidence === "high") return "#1e7145";
  if (confidence === "medium") return "#8a6100";
  return "#b3261e"; // low or none
}

// Reads ?fromCoachInfoRun= off the URL -- see BatchSocialPage's Suspense
// wrapper at the bottom, same requirement/reasoning as
// app/(app)/admin/batch-coach-info/page.js's own Inner/Suspense split.
function BatchSocialPageInner() {
  const supabase = getSupabaseBrowserClient();
  const { user, profile } = useAuth();
  const canReview = profile?.role === "verifier" || profile?.role === "sysadmin";
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // Set when this page was opened via the "Start Social Media Discovery for
  // These Schools" button on a Batch Coach-Info run -- see that page. Drives
  // a distinct "chained run" card in place of the usual state/count picker,
  // scoped to just that run's schools instead of a state-based pull.
  const [chainSourceRunId] = useState(() => {
    const fromUrl = Number(searchParams.get("fromCoachInfoRun"));
    return Number.isFinite(fromUrl) && fromUrl > 0 ? fromUrl : null;
  });
  const [chainDismissed, setChainDismissed] = useState(false);
  const [chainCreating, setChainCreating] = useState(false);
  const [chainError, setChainError] = useState("");

  const [runs, setRuns] = useState([]);
  const [runPendingCounts, setRunPendingCounts] = useState({});
  const [hideCompletedRuns, setHideCompletedRuns] = useState(true);
  const [loadingRuns, setLoadingRuns] = useState(true);
  const [selectedRunId, setSelectedRunId] = useState(null);
  const [items, setItems] = useState([]);
  const [loadingItems, setLoadingItems] = useState(false);

  const [scopeMode, setScopeMode] = useState("priority"); // "priority" | "all"
  const [customStates, setCustomStates] = useState(PRIORITY_STATES.join(", "));
  const [targetCount, setTargetCount] = useState(DEFAULT_TARGET_COUNT);
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
  // suggested handle(s) and a "Why?" toggle; clicking it reveals the
  // reasoning for that one row without reloading anything. Tracked as a
  // Set of item ids rather than a boolean per item so this stays a single
  // small piece of state instead of touching the items array itself.
  const [expandedReasoning, setExpandedReasoning] = useState(() => new Set());
  function toggleReasoning(itemId) {
    setExpandedReasoning((prev) => {
      const next = new Set(prev);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });
  }

  const selectedRun = runs.find((r) => r.id === selectedRunId) || null;

  // school_id -> that school's review_status ("applied"/"skipped"/"pending")
  // in the Coach-Info run this Social run was chained from, if any -- see
  // the loading effect below. Lets each row show whether its coach name was
  // already reviewed and Applied on the Coach-Info side, so a row can be
  // trusted and Applied here without opening the school's own profile to
  // cross-check the coach. Empty object for a normal (non-chained) run.
  const [coachInfoReviewMap, setCoachInfoReviewMap] = useState({});

  const readyCount = items.filter((i) => i.fetch_status === "ready").length;
  const pendingFetchCount = items.filter((i) => i.fetch_status === "pending").length;
  const noContentCount = items.filter((i) => i.fetch_status === "no_content").length;
  const suggestedItems = items.filter((i) => i.suggestion);
  const matchedItems = suggestedItems.filter((i) => i.suggestion.twitter_url || i.suggestion.facebook_url);
  const noMatchItems = suggestedItems.filter((i) => !i.suggestion.twitter_url && !i.suggestion.facebook_url && !i.suggestion_error);
  const failedItems = suggestedItems.filter((i) => i.suggestion_error);
  const pendingReview = matchedItems.filter((i) => i.review_status === "pending");
  const reviewedItems = matchedItems.filter((i) => i.review_status !== "pending");
  const highConfidencePendingCount = pendingReview.filter((i) => i.suggestion?.confidence === "high").length;
  // Pending rows whose Coach-Info suggestion was already Applied -- the
  // "safe to trust, apply without opening the record" set. Any confidence
  // tier counts (not just high) because the trust signal here is about the
  // coach's IDENTITY being confirmed, not the AI's confidence in the
  // handle pick -- a medium-confidence handle for a confirmed-real coach is
  // still worth a quick look, but no longer worth second-guessing who the
  // coach even is.
  const coachInfoConfirmedPending = pendingReview.filter((i) => coachInfoReviewMap[i.school_id] === "applied");

  function isRunOpen(r) {
    if (r.status !== "collected") return true;
    if (r.id === selectedRunId) return pendingReview.length > 0;
    return (runPendingCounts[r.id] || 0) > 0;
  }
  const openRunsCount = runs.filter(isRunOpen).length;
  const visibleRunsList = hideCompletedRuns ? runs.filter(isRunOpen) : runs;

  // Matches a row against the current search box -- school name, city, or
  // a coach's name/handle, case-insensitive. Same loose substring match as
  // Batch Coach-Info's own matchesSearch. Checks the coach name already on
  // file plus both the on-file and suggested Twitter/Facebook handles, so
  // typing a coach's name or handle jumps straight to their row.
  function matchesSearch(item) {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return true;
    const s = item.school;
    const sug = item.suggestion;
    const haystack = [s?.name, s?.city, s?.hc_first_name, s?.hc_last_name, s?.hc_twitter, s?.hc_facebook, sug?.twitter_url, sug?.facebook_url]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return haystack.includes(q);
  }

  // Base row set the table renders from -- pendingReview, or (with "Show
  // already-reviewed" checked) every matched item -- with the confidence
  // tier and search box both applied on top. Computed once here so the
  // on-screen counts next to each confidence button, the rendered rows, and
  // the keyboard-nav targets below can never disagree about what's visible.
  const reviewBaseRows = showReviewed ? matchedItems : pendingReview;
  const confidenceCounts = {
    all: reviewBaseRows.length,
    high: reviewBaseRows.filter((i) => i.suggestion?.confidence === "high").length,
    medium: reviewBaseRows.filter((i) => i.suggestion?.confidence === "medium").length,
    low: reviewBaseRows.filter((i) => i.suggestion?.confidence === "low").length,
  };
  const visibleRows = reviewBaseRows.filter((i) => (confidenceFilter === "all" || i.suggestion?.confidence === confidenceFilter) && matchesSearch(i));

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
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedRun?.status, bulkApplying, applyingId, focusedItem, keyboardTargets.length]);

  const loadRuns = useCallback(async () => {
    setLoadingRuns(true);
    const { data } = await supabase.from("social_batch_runs").select("*").order("created_at", { ascending: false }).limit(30);
    setRuns(data || []);
    const ids = (data || []).map((r) => r.id);
    if (ids.length) {
      const { data: pendingRows } = await supabase.from("social_batch_run_pending").select("batch_run_id,pending_count").in("batch_run_id", ids);
      const counts = {};
      (pendingRows || []).forEach((row) => {
        counts[row.batch_run_id] = row.pending_count;
      });
      setRunPendingCounts(counts);
    } else {
      setRunPendingCounts({});
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
      const { data } = await supabase.from("social_batch_items").select(ITEM_SELECT).eq("batch_run_id", runId).order("id");
      setItems(data || []);
      setLoadingItems(false);
    },
    [supabase]
  );

  useEffect(() => {
    if (selectedRunId) loadItems(selectedRunId);
  }, [selectedRunId, loadItems]);

  // Loads coachInfoReviewMap for the currently-open run -- only meaningful
  // when this run has a source_coach_info_run_id (i.e. it was started via
  // the Coach-Info chain button), so a plain state/count run just clears it
  // back to empty and no badges/bulk-apply banner show up.
  useEffect(() => {
    const sourceRunId = selectedRun?.source_coach_info_run_id;
    if (!sourceRunId) {
      setCoachInfoReviewMap({});
      return;
    }
    (async () => {
      const { data } = await supabase.from("coach_info_batch_items").select("school_id,review_status").eq("batch_run_id", sourceRunId);
      const map = {};
      (data || []).forEach((row) => {
        map[row.school_id] = row.review_status;
      });
      setCoachInfoReviewMap(map);
    })();
  }, [selectedRun?.source_coach_info_run_id, supabase]);

  function openRun(runId) {
    setSelectedRunId(runId);
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
      const { data: touchedRows, error: touchedErr } = await supabase.from("social_batch_items").select("school_id");
      if (touchedErr) throw touchedErr;
      const excludedIds = new Set((touchedRows || []).map((r) => r.school_id));

      // Needs a coach name on file to search by -- see the file header.
      // Missing either handle (not necessarily both) is enough to qualify,
      // since a school might already have a Twitter but not a Facebook, or
      // vice versa, and this run can still fill in whichever's missing.
      let query = supabase
        .from("schools")
        .select("id,name,city,state,hc_first_name,hc_last_name")
        .not("hc_first_name", "is", null)
        .neq("hc_first_name", "")
        .not("hc_last_name", "is", null)
        .neq("hc_last_name", "")
        .or("hc_twitter.is.null,hc_twitter.eq.,hc_facebook.is.null,hc_facebook.eq.")
        // Skip schools a human has already confirmed have no social media --
        // otherwise they'd resurface here forever (blank fields look the
        // same as "not yet checked"). See lib/dataQuality.js.
        .eq("social_not_available", false)
        // Closed/discontinued schools will never have real social media to
        // find -- see lib/dataQuality.js.
        .eq("is_closed", false)
        // Skip schools Larry has already marked reviewed/confirmed-accurate
        // (verification_status = "verified") even if the handle fields
        // above still read blank -- a human already looked at this record,
        // so it shouldn't come back through an automated sweep. Doesn't
        // affect the single-school "Find Social Media" button on a
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
        setCreateError("No schools matched -- everyone with a coach name on file in this scope already has both a Twitter/X and Facebook handle, or has already been through this tool before.");
        return;
      }

      const { data: runRow, error: runErr } = await supabase
        .from("social_batch_runs")
        .insert({ status: "collecting", state_filter: scopeMode === "all" && states.length === 0 ? null : states, requested_count: schoolsData.length, created_by: user.id })
        .select()
        .single();
      if (runErr) throw runErr;

      const itemRows = schoolsData.map((s) => ({ batch_run_id: runRow.id, school_id: s.id }));
      const { error: itemsErr } = await supabase.from("social_batch_items").insert(itemRows);
      if (itemsErr) throw itemsErr;

      await loadRuns();
      openRun(runRow.id);
    } catch (err) {
      setCreateError(err.message || "Could not start a new batch run.");
    } finally {
      setCreating(false);
    }
  }

  // Chained run: scoped to exactly the schools Batch Coach-Info just found a
  // coach name for in run #chainSourceRunId, instead of a state/count pull.
  // Still re-runs Social's own eligibility filter (coach name present,
  // missing at least one handle, not marked unavailable/closed) and the same
  // "never re-touch a school this tool has already been through" exclusion
  // as startRun above -- a school landing in the Coach-Info run doesn't
  // bypass any of Social's own rules, it just narrows the candidate pool to
  // schools we know just got a name.
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

      const { data: touchedRows, error: touchedErr } = await supabase.from("social_batch_items").select("school_id");
      if (touchedErr) throw touchedErr;
      const excludedIds = new Set((touchedRows || []).map((r) => r.school_id));

      const { data: rawSchoolsData, error: schoolsErr } = await supabase
        .from("schools")
        .select("id,name,city,state,hc_first_name,hc_last_name")
        .in("id", schoolIds)
        .not("hc_first_name", "is", null)
        .neq("hc_first_name", "")
        .not("hc_last_name", "is", null)
        .neq("hc_last_name", "")
        .or("hc_twitter.is.null,hc_twitter.eq.,hc_facebook.is.null,hc_facebook.eq.")
        .eq("social_not_available", false)
        .eq("is_closed", false)
        // Same "already reviewed" exclusion as the regular startRun query
        // above -- see its comment for the full reasoning.
        .neq("verification_status", "verified")
        .order("id", { ascending: true });
      if (schoolsErr) throw schoolsErr;
      const schoolsData = (rawSchoolsData || []).filter((s) => !excludedIds.has(s.id));
      if (!schoolsData.length) {
        setChainError(
          `None of the schools from Coach-Info run #${chainSourceRunId} currently qualify -- they may already have both handles on file, be marked social-unavailable or closed, or have already been through Social Media Discovery before.`
        );
        return;
      }

      const { data: runRow, error: runErr } = await supabase
        .from("social_batch_runs")
        // source_coach_info_run_id records where this run was chained from --
        // read back below (see the coachInfoReviewMap effect) to show each
        // row whether its coach name was already Applied in that run.
        .insert({ status: "collecting", state_filter: null, requested_count: schoolsData.length, created_by: user.id, source_coach_info_run_id: chainSourceRunId })
        .select()
        .single();
      if (runErr) throw runErr;

      const itemRows = schoolsData.map((s) => ({ batch_run_id: runRow.id, school_id: s.id }));
      const { error: itemsErr } = await supabase.from("social_batch_items").insert(itemRows);
      if (itemsErr) throw itemsErr;

      await loadRuns();
      openRun(runRow.id);
      // Clears ?fromCoachInfoRun= now that the chained run exists, so
      // reloading (or the URL-persistence effect on this page, if this page
      // ever grows one) doesn't keep re-showing the chain-setup card on top
      // of a run that's already been created.
      router.replace(pathname, { scroll: false });
    } catch (err) {
      setChainError(err.message || "Could not start a chained batch run.");
    } finally {
      setChainCreating(false);
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
        const res = await fetch("/api/admin/social-batch/fetch-item", {
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
      const res = await fetch(`/api/admin/social-batch/${selectedRun.id}/submit`, {
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
      const res = await fetch(`/api/admin/social-batch/${selectedRun.id}/check-status`, {
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
      const res = await fetch(`/api/admin/social-batch/${selectedRun.id}/collect`, {
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
  // same write path for each item in a batch, without touching the
  // single-item applyingId/reviewError state that only makes sense for one
  // row at a time. Mirrors the same split on Batch Athletics/Batch
  // Coach-Info. Unlike Athletics (one URL field), a social suggestion can
  // carry BOTH a Twitter and a Facebook pick -- each is written and logged
  // independently, so a school missing only one platform still gets that
  // one filled in even if the other wasn't found.
  async function applySuggestionCore(item) {
    const s = item.school;
    const sug = item.suggestion;
    if (!s || !sug || (!sug.twitter_url && !sug.facebook_url)) return { ok: false, error: "Missing school or suggestion." };
    try {
      const update = {};
      const changes = [];
      if (sug.twitter_url && sug.twitter_url !== (s.hc_twitter || "")) {
        update.hc_twitter = sug.twitter_url;
        changes.push({ school_id: s.id, field_name: "hc_twitter", old_value: s.hc_twitter || null, new_value: sug.twitter_url, source: `Batch AI lookup (${sug.confidence} confidence, reviewed)`, changed_by: user.id });
      }
      if (sug.facebook_url && sug.facebook_url !== (s.hc_facebook || "")) {
        update.hc_facebook = sug.facebook_url;
        changes.push({ school_id: s.id, field_name: "hc_facebook", old_value: s.hc_facebook || null, new_value: sug.facebook_url, source: `Batch AI lookup (${sug.confidence} confidence, reviewed)`, changed_by: user.id });
      }
      if (Object.keys(update).length > 0) {
        const { error: updateErr } = await supabase.from("schools").update(update).eq("id", s.id);
        if (updateErr) throw updateErr;
        const { error: logErr } = await supabase.from("school_change_log").insert(changes);
        if (logErr) throw logErr;
      }
      const { error: itemErr } = await supabase
        .from("social_batch_items")
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
  // one click -- same batching pattern as Batch Athletics/Batch
  // Coach-Info's bulkApplyHighConfidence, built in here from the start
  // rather than as a later upgrade, since the review-speed lesson from
  // those two tools is already learned.
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

  // Applies every PENDING suggestion whose coach name was already reviewed
  // and Applied back on the Coach-Info side (coachInfoConfirmedPending) --
  // only relevant for a run chained from Coach-Info (see the button/banner
  // this backs, which only renders when selectedRun.source_coach_info_run_id
  // is set). Same batching pattern as bulkApplyHighConfidence just above.
  async function bulkApplyCoachInfoConfirmed() {
    const targets = coachInfoConfirmedPending;
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
        `Applied ${targets.length - failures.length} of ${targets.length} Coach-Info-confirmed suggestions. ${failures.length} failed: ${failures.slice(0, 3).join("; ")}${
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
        .from("social_batch_items")
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

  function exportRunCsv() {
    if (!selectedRun || !visibleRows.length) return;
    const csv = Papa.unparse({
      fields: [
        "school_id",
        "school_name",
        "city",
        "state",
        "coach",
        "current_twitter",
        "suggested_twitter",
        "current_facebook",
        "suggested_facebook",
        "confidence",
        "reasoning",
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
          [s.hc_first_name, s.hc_last_name].filter(Boolean).join(" "),
          s.hc_twitter || "",
          sug.twitter_url || "",
          s.hc_facebook || "",
          sug.facebook_url || "",
          sug.confidence || "",
          sug.reasoning || "",
          item.review_status === "pending" ? "Pending" : item.review_status === "applied" ? "Applied" : "Skipped",
        ];
      }),
    });
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `csd-social-run-${selectedRun.id}-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  if (!canReview) {
    return (
      <div className="view">
        <div className="notice danger">Batch social discovery is limited to Verification Staff and System Admins.</div>
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
          <h1>Batch Social Media Discovery</h1>
          <p>Run a Twitter/X and Facebook search for each coach overnight via Anthropic's Batch API, then review and apply the AI's best picks here.</p>
        </div>
      </div>

      {chainSourceRunId && !chainDismissed ? (
        <div className="card" style={{ marginBottom: 14, border: "1px solid #cfe0f2", background: "#f5f9fd" }}>
          <h3 style={{ marginBottom: 4 }}>Chained from Batch Coach-Info Discovery — Run #{chainSourceRunId}</h3>
          <p style={{ fontSize: 12.5, color: "#697386" }}>
            This starts a Social Media Discovery run scoped to just the schools from that Coach-Info run -- not a new state/count pull. Each one still has to actually qualify (a coach
            name now on file, missing a Twitter/X and/or Facebook handle, not marked social-unavailable or closed, and not already run through this tool before) -- schools that don't
            qualify are simply left out, same as any other run.
          </p>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <button className="btn btn-primary btn-sm" onClick={startChainedRun} disabled={chainCreating}>
              {chainCreating ? "Starting…" : "Start Social Media Discovery for These Schools"}
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
            Pulls schools that already have a head coach name on file but are missing a Twitter/X and/or Facebook handle -- a useful search needs a name, so schools with no coach name yet
            can't be helped by this tool (run Batch Coach-Info Discovery first for those).
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
                  </div>
                  <StatusBadge status={r.status} />
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
                Step 1: search Twitter/X and Facebook for each coach, then save the results. {readyCount} ready, {pendingFetchCount} not searched yet, {noContentCount} found nothing usable.
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
                  {pendingReview.length} suggestion{pendingReview.length === 1 ? "" : "s"} to review, {reviewedItems.length} already reviewed, {noMatchItems.length} where the AI found no
                  confident match on either platform, {failedItems.length} the AI couldn't produce a suggestion for.
                </p>
                <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                  <label style={{ fontSize: 12.5, display: "flex", gap: 6, alignItems: "center" }}>
                    <input type="checkbox" checked={showReviewed} onChange={(e) => setShowReviewed(e.target.checked)} />
                    Show already-reviewed
                  </label>
                  <button className="btn btn-sm" onClick={exportRunCsv} disabled={visibleRows.length === 0}>
                    Export to CSV ({visibleRows.length})
                  </button>
                </div>
              </div>

              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10, marginBottom: 10 }}>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {["all", "high", "medium", "low"].map((tier) => {
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
                    <strong>{highConfidencePendingCount}</strong> of those are <strong>high confidence</strong> -- the AI was confident the account it picked is unambiguously this coach's
                    own. These are safe to clear in one click instead of reviewing one at a time.
                  </span>
                  <button className="btn btn-gold btn-sm" onClick={bulkApplyHighConfidence} disabled={bulkApplying}>
                    {bulkApplying ? `Applying ${bulkProgress.done} of ${bulkProgress.total}…` : `Apply All High-Confidence (${highConfidencePendingCount})`}
                  </button>
                </div>
              )}

              {/* Only shows on a run chained from Coach-Info (see the
                  "Start Social Media Discovery for These Schools" button on
                  that page) -- coachInfoConfirmedPending is always empty
                  otherwise. Any confidence tier counts here, not just high,
                  since the trust signal is "this coach is confirmed real,"
                  not "the AI liked this specific handle." */}
              {coachInfoConfirmedPending.length > 0 && (
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    flexWrap: "wrap",
                    gap: 10,
                    marginBottom: 10,
                    padding: "10px 12px",
                    background: "#eefaf1",
                    border: "1px solid #cdead9",
                    borderRadius: 8,
                  }}
                >
                  <span style={{ fontSize: 12.5 }}>
                    <strong>{coachInfoConfirmedPending.length}</strong> of those have a coach name that's already <strong>reviewed and Applied</strong> from Coach-Info run #
                    {selectedRun.source_coach_info_run_id} -- you already confirmed who the coach is, so these are safe to apply without opening the school's profile first.
                  </span>
                  <button className="btn btn-gold btn-sm" onClick={bulkApplyCoachInfoConfirmed} disabled={bulkApplying}>
                    {bulkApplying ? `Applying ${bulkProgress.done} of ${bulkProgress.total}…` : `Apply All Coach-Info-Confirmed (${coachInfoConfirmedPending.length})`}
                  </button>
                </div>
              )}

              {reviewError && (
                <div className="notice danger" style={{ marginBottom: 10, fontSize: 12.5 }}>
                  {reviewError}
                </div>
              )}

              <div style={{ fontSize: 11.5, color: "#9aa1ab", marginBottom: 6 }}>
                Keyboard shortcuts: <strong>↑</strong>/<strong>↓</strong> move focus · <strong>A</strong> apply · <strong>S</strong> skip
              </div>

              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
                  <thead>
                    <tr style={{ borderBottom: "2px solid #e3e6ea", textAlign: "left" }}>
                      <th style={{ padding: "6px 8px", whiteSpace: "nowrap" }}>School / Coach</th>
                      <th style={{ padding: "6px 8px" }}>Suggested handles</th>
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
                      return (
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
                            <div style={{ color: "#9aa1ab" }}>
                              {[s.hc_first_name, s.hc_last_name].filter(Boolean).join(" ") || "(no coach name)"}
                            </div>
                            {/* Only present on a run chained from Coach-Info
                                -- see coachInfoReviewMap's loading effect and
                                the bulk-apply banner above. Tells you at a
                                glance whether THIS coach name was already
                                reviewed there, without opening the school. */}
                            {coachInfoReviewMap[item.school_id] && (
                              <div style={{ marginTop: 3 }}>
                                {coachInfoReviewMap[item.school_id] === "applied" ? (
                                  <span className="badge" style={{ fontSize: 10.5, color: "#1e7145", background: "#1e71451a", fontWeight: 600 }}>
                                    ✓ Coach-Info Applied
                                  </span>
                                ) : (
                                  <span className="badge" style={{ fontSize: 10.5, color: "#697386", background: "#6973861a" }}>
                                    Coach-Info: {coachInfoReviewMap[item.school_id] === "skipped" ? "Skipped" : "Pending"}
                                  </span>
                                )}
                              </div>
                            )}
                          </td>
                          <td style={{ padding: "8px", minWidth: 260 }}>
                            {/* Both platforms always render now, even when the
                                AI found nothing new for one of them -- same
                                "show the current value on every row" treatment
                                Athletics/MaxPreps already had and Coach-Info
                                just got, so a reviewer can compare against
                                something they already trust without opening
                                the record. */}
                            <div>
                              <strong>Twitter/X:</strong>{" "}
                              {sug.twitter_url ? (
                                <>
                                  {sug.twitter_url}
                                  {s.hc_twitter && s.hc_twitter !== sug.twitter_url ? <span style={{ color: "#9aa1ab" }}> (was: {s.hc_twitter})</span> : null}
                                </>
                              ) : (
                                <span style={{ color: "#9aa1ab" }}>{s.hc_twitter || "(blank)"}</span>
                              )}
                            </div>
                            <div>
                              <strong>Facebook:</strong>{" "}
                              {sug.facebook_url ? (
                                <>
                                  {sug.facebook_url}
                                  {s.hc_facebook && s.hc_facebook !== sug.facebook_url ? <span style={{ color: "#9aa1ab" }}> (was: {s.hc_facebook})</span> : null}
                                </>
                              ) : (
                                <span style={{ color: "#9aa1ab" }}>{s.hc_facebook || "(blank)"}</span>
                              )}
                            </div>
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
                              <span style={{ fontWeight: 600, color: item.review_status === "applied" ? "#1e7145" : "#697386" }}>
                                {item.review_status === "applied" ? "✓ Applied" : "Skipped"}
                              </span>
                            ) : (
                              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                                <button className="btn btn-gold btn-sm" disabled={applying || bulkApplying} onClick={() => applyItem(item)}>
                                  {applying ? "…" : "Apply"}
                                </button>
                                <button className="btn btn-sm" disabled={applying || bulkApplying} onClick={() => skipItem(item)}>
                                  Skip
                                </button>
                                <Link href={`/schools/${s.id}`} className="btn btn-sm">
                                  Open
                                </Link>
                              </div>
                            )}
                          </td>
                        </tr>
                      );
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
    </div>
  );
}

export default function BatchSocialPage() {
  return (
    <Suspense fallback={<div className="view"><div className="empty-state">Loading…</div></div>}>
      <BatchSocialPageInner />
    </Suspense>
  );
}
