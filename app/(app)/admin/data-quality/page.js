"use client";
import { useState, useEffect, useCallback, useRef } from "react";
import Link from "next/link";
import Papa from "papaparse";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { useAuth } from "@/lib/auth-context";
import { classifySchools, classifySchool } from "@/lib/dataQuality";

const PAGE_SIZE = 1000;
const DISPLAY_CAP = 200;
const BATCH_SIZE = 300;
const RECHECK_LIMIT = 2000;
// Matches the recency bonus bands in compute_school_confidence_score() --
// a verified school's confidence score starts losing its recency bonus
// past 180 days since last_verified_at (10 -> 5), and loses it entirely
// past 365 days (5 -> 0). This queue surfaces those schools before that
// decay happens quietly in the background.
const RECHECK_CUTOFF_DAYS = 180;
const RECHECK_STALE_DAYS = 365;
// Matches BATCH_SIZE in app/api/cron/recheck-schools -- the nightly sweep
// only ever pulls this many schools per run, oldest-checked first, so this
// preview shows exactly the batch that will run tonight, in the same order.
const RECHECK_BATCH_SIZE = 500;
// The nightly cron fires at "0 9 * * *" (see vercel.json) -- 9:00 AM UTC,
// which is 4:00 AM Central during Daylight Time and 3:00 AM Central during
// Standard Time. Just used for the plain-English schedule line below.
const RECHECK_SCHEDULE_LABEL = "every night at 4:00 AM Central (9:00 AM UTC — 3:00 AM Central once clocks fall back)";
// Today's List -- see its derivation near the render below. Capped well
// under a full scroll on purpose: the point is a daily list that's
// actually finishable, not another long queue.
const TODAYS_LIST_SIZE = 25;
const TODAYS_LIST_FLAG_CAP = 15;
// How far back the MaxPreps Opportunities report scans school_recheck_log
// looking for each school's most recent result -- roughly a week's worth
// of nightly runs at RECHECK_BATCH_SIZE. This is deliberately a "recent
// activity" report, not an exhaustive one: the point is surfacing schools
// the sweep JUST failed to confirm, not every school lacking a MaxPreps
// URL (most of the database, per the coverage stats above).
const MAXPREPS_OPP_LOG_SCAN = 4000;

// Caches the last scan's review queue (and current filter/sort) in
// sessionStorage so leaving this tab -- opening a school profile, an
// accidental refresh, anything short of closing the tab -- doesn't force
// a full ~14,600-school re-scan just to get back to where you were.
// "Open Profile" already opens in a new tab for the same reason; this is
// the safety net for everything else. Cleared automatically when the tab
// closes (sessionStorage), and always overwritten by an explicit
// Re-scan Database.
const SCAN_CACHE_KEY = "csd_dq_scan_cache_v1";
const SCAN_CACHE_STALE_MS = 6 * 60 * 60 * 1000; // 6 hours

// Same idea as SCAN_CACHE_KEY, for the "Find & Edit a School" search below
// -- the search box, its results, and whichever one (if any) has its Quick
// Fix editor open. Without this, leaving the tab (a back-button press, an
// accidental refresh -- "Open Profile" itself already opens in a new tab)
// meant losing the search and landing back on an empty box.
const FIND_SCHOOL_CACHE_KEY = "csd_dq_find_school_cache_v1";

function fmtRelativeTime(date) {
  if (!date) return "";
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

const FILTERS = [
  { key: "all", label: "All actionable issues" },
  { key: "no_contact", label: "No contact info" },
  { key: "bad_email", label: "Malformed email" },
  { key: "bad_cell", label: "Malformed cell" },
  { key: "bad_office", label: "Malformed office phone" },
  { key: "no_name", label: "No coach name" },
];

const SORTS = [
  { key: "default", label: "Sort: Severity (default)" },
  { key: "confidence_asc", label: "Sort: Confidence, low → high" },
  { key: "confidence_desc", label: "Sort: Confidence, high → low" },
];

const EDIT_FIELDS = [
  ["hc_first_name", "First name"],
  ["hc_last_name", "Last name"],
  ["hc_email", "Email"],
  ["hc_cell", "Cell"],
  ["hc_office", "Office"],
  ["maxpreps_url", "MaxPreps URL"],
  ["athletics_url", "Athletics URL"],
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
// hc_first_name/hc_last_name/hc_email/hc_cell/hc_office -- see the Coach
// Change History card below. Anything not listed here still shows up, just
// with a plain gray badge carrying the raw source text, so a new write path
// never goes missing.
const COACH_CHANGE_SOURCE_META = {
  "Head coach change (manual)": { label: "Marked coach change", color: "#0b5fff", bg: "#e8f0ff" },
  "Data quality review (quick fix)": { label: "Quick fix", color: "#697386", bg: "#f0f1f4" },
  "School profile (quick fix)": { label: "Quick fix (school profile)", color: "#697386", bg: "#f0f1f4" },
  "Coach-submitted correction (approved)": { label: "Coach-submitted (approved)", color: "#1a7f37", bg: "#e6f4ea" },
  "Coach-submitted correction (approved, edited by verifier)": { label: "Coach-submitted, edited", color: "#1a7f37", bg: "#e6f4ea" },
  "Bulk correction upload (Data Quality)": { label: "Bulk upload", color: "#8a6100", bg: "#fff4dc" },
  "Bulk school update (CSV)": { label: "Bulk update tool", color: "#8a6100", bg: "#fff4dc" },
};
// Every field this card tracks -- originally just the coach's name, now
// widened to cover email/cell/office too, since those are logged to
// school_change_log on every save exactly the same way and deserve the
// same dated, sortable history instead of going unseen.
const COACH_CHANGE_TRACKED_FIELDS = ["hc_first_name", "hc_last_name", "hc_email", "hc_cell", "hc_office"];
const COACH_CHANGE_FIELD_LABELS = {
  hc_first_name: "First name",
  hc_last_name: "Last name",
  hc_email: "Email",
  hc_cell: "Cell",
  hc_office: "Office",
};

function fmtPhone(v) {
  if (!v) return "";
  const digits = String(v).replace(/\D/g, "");
  return digits.length === 10 ? `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}` : v;
}

// Same helper used on the school profile page (app/(app)/schools/[id]/page.js)
// -- lets a plain "example.com" saved without a scheme still open as a link.
function withProtocol(v) {
  const trimmed = (v || "").trim();
  if (!trimmed) return null;
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
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
  const [sortBy, setSortBy] = useState("default");

  const [editingId, setEditingId] = useState(null);
  const [editValues, setEditValues] = useState({});
  const [saving, setSaving] = useState(null);
  const [saveError, setSaveError] = useState("");
  // Set only when the open editor was opened via "Mark Coach Change" rather
  // than plain "Quick Fix" -- holds the pre-change school row so the form
  // can show who the outgoing coach was and saveEdit can tag the write
  // distinctly in school_change_log (see COACH_CHANGE_SOURCE_META).
  const [coachChangeFrom, setCoachChangeFrom] = useState(null);
  // A lighter-weight sibling to Quick Fix -- for a school found via search
  // or turned up by a scan where nothing actually needs to change, just a
  // "yes, I checked this, it's still right" without opening the editor.
  const [markingVerifiedId, setMarkingVerifiedId] = useState(null);
  const [markVerifiedError, setMarkVerifiedError] = useState("");
  const [scannedAt, setScannedAt] = useState(null);

  // Restore a cached scan (if any) on mount -- see SCAN_CACHE_KEY above.
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(SCAN_CACHE_KEY);
      if (!raw) return;
      const cached = JSON.parse(raw);
      if (cached?.result) {
        setResult(cached.result);
        setScannedAt(cached.scannedAt ? new Date(cached.scannedAt) : null);
      }
      if (cached?.filter) setFilter(cached.filter);
      if (cached?.sortBy) setSortBy(cached.sortBy);
    } catch {
      // Corrupt or unavailable cache -- fall back to the normal
      // "Click Scan Database" empty state, same as if none existed.
    }
  }, []);

  // Keep the cache in sync with the live queue -- every scan, Quick Fix,
  // Mark Verified, Mark Coach Change, and bulk upload/verify all flow
  // through setResult, so this effect alone covers all of them.
  useEffect(() => {
    if (!result) return;
    try {
      sessionStorage.setItem(SCAN_CACHE_KEY, JSON.stringify({ result, scannedAt: scannedAt ? scannedAt.toISOString() : null, filter, sortBy }));
    } catch {
      // Storage full/unavailable -- the queue still works for this tab,
      // it just won't survive a reload. Not worth surfacing an error for.
    }
  }, [result, scannedAt, filter, sortBy]);

  // MaxPreps URL auto-discovery -- only ever active for whichever single
  // row is currently being edited (editingId), same as editValues itself.
  const [discovering, setDiscovering] = useState(false);
  const [discoverError, setDiscoverError] = useState("");
  const [suggestions, setSuggestions] = useState([]);

  // Athletics site auto-discovery -- same idea as MaxPreps discovery above,
  // just pointed at app/api/schools/[id]/discover-athletics (see that route
  // for why the search isn't restricted to one domain the way MaxPreps is).
  // Same "one active row at a time" scoping.
  const [discoveringAthletics, setDiscoveringAthletics] = useState(false);
  const [discoverAthleticsError, setDiscoverAthleticsError] = useState("");
  const [athleticsSuggestions, setAthleticsSuggestions] = useState([]);

  // AI coach-info auto-fill -- same "one active row at a time" pattern as
  // MaxPreps discovery above, since only one row can be in edit mode.
  const [aiSuggesting, setAiSuggesting] = useState(false);
  const [aiSuggestError, setAiSuggestError] = useState("");
  const [aiSuggestInfo, setAiSuggestInfo] = useState(null); // {confidence, source, notes}

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

  // Restore the last "Find & Edit a School" search (and, if one was open,
  // its Quick Fix editor) on mount -- see FIND_SCHOOL_CACHE_KEY above.
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(FIND_SCHOOL_CACHE_KEY);
      if (!raw) return;
      const cached = JSON.parse(raw);
      if (cached?.schoolQuery) setSchoolQuery(cached.schoolQuery);
      if (Array.isArray(cached?.searchResults)) setSearchResults(cached.searchResults);
      if (cached?.hasSearched) setHasSearched(true);
      // Only reopen the editor if it belongs to one of the restored search
      // results -- editingId is shared with the Flagged and Scan Results
      // lists above, and neither of those is what's being restored here.
      if (cached?.editingId != null && Array.isArray(cached?.searchResults) && cached.searchResults.some((s) => s.id === cached.editingId)) {
        setEditingId(cached.editingId);
        setEditValues(cached.editValues || {});
        setCoachChangeFrom(cached.coachChangeFrom || null);
        setAiSuggestInfo(cached.aiSuggestInfo || null);
      }
    } catch {
      // Corrupt or unavailable cache -- fall back to the normal empty
      // search box, same as if none existed.
    }
  }, []);

  // Keep the cache in sync with the search box, its results, and whichever
  // one (if any) has its Quick Fix editor open. Only captures
  // editingId/editValues/coachChangeFrom/aiSuggestInfo when the open editor
  // actually belongs to a search result, so editing a Flagged or Scan
  // Results row elsewhere on this page doesn't get mistakenly saved here.
  useEffect(() => {
    try {
      const editingASearchResult = editingId != null && searchResults.some((s) => s.id === editingId);
      sessionStorage.setItem(
        FIND_SCHOOL_CACHE_KEY,
        JSON.stringify({
          schoolQuery,
          searchResults,
          hasSearched,
          editingId: editingASearchResult ? editingId : null,
          editValues: editingASearchResult ? editValues : null,
          coachChangeFrom: editingASearchResult ? coachChangeFrom : null,
          aiSuggestInfo: editingASearchResult ? aiSuggestInfo : null,
        })
      );
    } catch {
      // Storage full/unavailable -- search still works for this tab, it
      // just won't survive leaving and coming back. Not worth surfacing an
      // error for.
    }
  }, [schoolQuery, searchResults, hasSearched, editingId, editValues, coachChangeFrom, aiSuggestInfo]);

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

  // Coach Change History -- every name/email/cell/office entry ever written
  // to school_change_log, however it got there (Quick Fix, the "Mark Coach
  // Change" button below, a bulk upload/update, or an approved
  // coach-submitted correction), grouped so several fields changed in one
  // save show as one dated entry instead of several. Defaults to newest
  // first; coachChangeSort flips that for whoever wants to work oldest-first
  // instead (e.g. clearing out a long-untouched backlog in order).
  const [coachChanges, setCoachChanges] = useState([]);
  const [loadingCoachChanges, setLoadingCoachChanges] = useState(true);
  const [coachChangeExporting, setCoachChangeExporting] = useState(false);
  const [coachChangeExportError, setCoachChangeExportError] = useState("");
  const [coachChangeSort, setCoachChangeSort] = useState("newest");

  // Needs Re-check -- verified schools whose last_verified_at has aged past
  // the recency bands the confidence-score trigger cares about (see
  // RECHECK_CUTOFF_DAYS/RECHECK_STALE_DAYS above), oldest first, so staff
  // can re-confirm a listing before its score quietly decays.
  const [needsRecheck, setNeedsRecheck] = useState([]);
  const [loadingNeedsRecheck, setLoadingNeedsRecheck] = useState(true);
  const [recheckExporting, setRecheckExporting] = useState(false);
  const [recheckExportError, setRecheckExportError] = useState("");

  // Bulk Mark Verified -- for a batch that's already been confirmed some
  // other way (a trusted external roster, a phone-verified list) and just
  // needs marking, with no field changes to make. A much lighter cousin of
  // the CSV upload above: matches on school_id or school_name+state only,
  // writes nothing to school_change_log (nothing changed), and just flips
  // verification_status/last_verified_at.
  const bulkVerifyInputRef = useRef(null);
  const [bulkVerifyFileName, setBulkVerifyFileName] = useState("");
  const [bulkVerifyParsing, setBulkVerifyParsing] = useState(false);
  const [bulkVerifyError, setBulkVerifyError] = useState("");
  const [bulkVerifyMatched, setBulkVerifyMatched] = useState([]); // [{id,name,city,state}]
  const [bulkVerifyUnmatched, setBulkVerifyUnmatched] = useState([]); // [{row,reason}]
  const [bulkVerifyApplying, setBulkVerifyApplying] = useState(false);
  const [bulkVerifyApplyStatus, setBulkVerifyApplyStatus] = useState("");
  const [bulkVerifyApplyError, setBulkVerifyApplyError] = useState("");
  const [bulkVerifyApplyResult, setBulkVerifyApplyResult] = useState(null); // {count}

  // Upcoming Recheck Queue -- a preview of tonight's Coach-Change Radar
  // batch, pulled straight from the same school_recheck_priority view and
  // ordering the cron job itself uses, so this is exactly who gets checked
  // next. Lets Larry get ahead of it: fix a stale website URL before the
  // sweep runs against it, rather than only reacting after a miss.
  const [upcomingQueue, setUpcomingQueue] = useState([]);
  const [loadingUpcoming, setLoadingUpcoming] = useState(true);
  const [upcomingExporting, setUpcomingExporting] = useState(false);
  const [upcomingExportError, setUpcomingExportError] = useState("");
  // Coverage stats for that same eligibility rule (needs a coach last name
  // on file, plus a website or MaxPreps URL to actually check) -- shown
  // alongside the queue so it's obvious at a glance how much of the
  // database the sweep can even reach right now.
  const [coverageStats, setCoverageStats] = useState(null);
  const [loadingCoverage, setLoadingCoverage] = useState(true);

  // MaxPreps Opportunities -- schools whose most recent Coach-Change Radar
  // check came back not_found/fetch_error (the primary website check is
  // currently failing) and that have no MaxPreps URL on file to fall back
  // to. These are exactly the schools where adding one would make the
  // nightly sweep actually work again for them.
  const [maxprepsOpportunities, setMaxprepsOpportunities] = useState([]);
  const [loadingMaxprepsOpp, setLoadingMaxprepsOpp] = useState(true);
  const [maxprepsOppExporting, setMaxprepsOppExporting] = useState(false);
  const [maxprepsOppExportError, setMaxprepsOppExportError] = useState("");

  const loadFlags = useCallback(async () => {
    if (!canReview) {
      setLoadingFlags(false);
      return;
    }
    setLoadingFlags(true);
    const { data } = await supabase
      .from("school_flags")
      .select("*, schools(id,name,city,state,hc_first_name,hc_last_name,hc_email,hc_cell,hc_office,maxpreps_url,athletics_url,website,verification_status,confidence_score), colleges:flagged_by_college_id(name)")
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
      .in("field_name", COACH_CHANGE_TRACKED_FIELDS)
      .order("changed_at", { ascending: false })
      .limit(2000);

    // A single save writes each changed field (name, email, cell, office)
    // as its own row sharing the same changed_at (one insert statement, one
    // transaction timestamp) -- group them back into one entry per save.
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

  // Newest-first is the order coachChanges already comes in (see
  // loadCoachChanges above) -- oldest-first is just that list reversed,
  // recomputed on every render so flipping the dropdown needs no re-fetch.
  const sortedCoachChanges = coachChangeSort === "oldest" ? [...coachChanges].reverse() : coachChanges;

  const loadNeedsRecheck = useCallback(async () => {
    if (!canReview) {
      setLoadingNeedsRecheck(false);
      return;
    }
    setLoadingNeedsRecheck(true);
    const cutoff = new Date(Date.now() - RECHECK_CUTOFF_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const { data } = await supabase
      .from("schools")
      .select("id,name,city,state,hc_first_name,hc_last_name,hc_email,hc_cell,hc_office,maxpreps_url,athletics_url,website,verification_status,confidence_score,last_verified_at")
      .eq("verification_status", "verified")
      .lt("last_verified_at", cutoff)
      .order("last_verified_at", { ascending: true })
      .limit(RECHECK_LIMIT);
    setNeedsRecheck(data || []);
    setLoadingNeedsRecheck(false);
  }, [supabase, canReview]);

  useEffect(() => {
    loadNeedsRecheck();
  }, [loadNeedsRecheck]);

  const loadUpcomingQueue = useCallback(async () => {
    if (!canReview) {
      setLoadingUpcoming(false);
      return;
    }
    setLoadingUpcoming(true);
    // school_recheck_priority is the exact same view + ordering
    // app/api/cron/recheck-schools reads from -- this is tonight's batch,
    // not an approximation of it.
    const { data: priority } = await supabase
      .from("school_recheck_priority")
      .select("school_id, website, hc_first_name, hc_last_name, maxpreps_url, last_checked_at")
      .order("last_checked_at", { ascending: true, nullsFirst: true })
      .limit(RECHECK_BATCH_SIZE);

    const ids = (priority || []).map((r) => r.school_id);
    let schoolById = new Map();
    if (ids.length) {
      const { data: schoolRows } = await supabase.from("schools").select("id,name,city,state,verification_status,last_verified_at").in("id", ids);
      (schoolRows || []).forEach((s) => schoolById.set(s.id, s));
    }
    setUpcomingQueue((priority || []).map((r) => ({ ...r, school: schoolById.get(r.school_id) })));
    setLoadingUpcoming(false);
  }, [supabase, canReview]);

  useEffect(() => {
    loadUpcomingQueue();
  }, [loadUpcomingQueue]);

  const loadRecheckCoverage = useCallback(async () => {
    if (!canReview) {
      setLoadingCoverage(false);
      return;
    }
    setLoadingCoverage(true);
    const [totalRes, eligibleRes, websiteRes, maxprepsRes] = await Promise.all([
      supabase.from("schools").select("id", { count: "exact", head: true }),
      supabase.from("school_recheck_priority").select("school_id", { count: "exact", head: true }),
      supabase.from("schools").select("id", { count: "exact", head: true }).not("website", "is", null).neq("website", ""),
      supabase.from("schools").select("id", { count: "exact", head: true }).not("maxpreps_url", "is", null).neq("maxpreps_url", ""),
    ]);
    setCoverageStats({
      total: totalRes.count || 0,
      eligible: eligibleRes.count || 0,
      withWebsite: websiteRes.count || 0,
      withMaxpreps: maxprepsRes.count || 0,
    });
    setLoadingCoverage(false);
  }, [supabase, canReview]);

  useEffect(() => {
    loadRecheckCoverage();
  }, [loadRecheckCoverage]);

  const loadMaxprepsOpportunities = useCallback(async () => {
    if (!canReview) {
      setLoadingMaxprepsOpp(false);
      return;
    }
    setLoadingMaxprepsOpp(true);
    // No DISTINCT ON / window functions available through the client, so:
    // pull the most recent log rows overall, then keep only the first
    // (most recent) row seen per school -- that's each school's current
    // status. checked_at descending guarantees "first seen" == "latest".
    const { data: logRows } = await supabase
      .from("school_recheck_log")
      .select("school_id, result, checked_at")
      .order("checked_at", { ascending: false })
      .limit(MAXPREPS_OPP_LOG_SCAN);

    const latestBySchool = new Map();
    (logRows || []).forEach((row) => {
      if (!latestBySchool.has(row.school_id)) latestBySchool.set(row.school_id, row);
    });
    const badIds = Array.from(latestBySchool.values())
      .filter((row) => row.result === "not_found" || row.result === "fetch_error")
      .map((row) => row.school_id);

    if (!badIds.length) {
      setMaxprepsOpportunities([]);
      setLoadingMaxprepsOpp(false);
      return;
    }

    const { data: schoolRows } = await supabase
      .from("schools")
      .select("id,name,city,state,website,maxpreps_url,hc_first_name,hc_last_name")
      .in("id", badIds);

    const opportunities = (schoolRows || [])
      .filter((s) => !s.maxpreps_url || !s.maxpreps_url.trim())
      .map((s) => {
        const latest = latestBySchool.get(s.id);
        return { ...s, lastResult: latest?.result, lastCheckedAt: latest?.checked_at };
      })
      .sort((a, b) => new Date(b.lastCheckedAt) - new Date(a.lastCheckedAt));

    setMaxprepsOpportunities(opportunities);
    setLoadingMaxprepsOpp(false);
  }, [supabase, canReview]);

  useEffect(() => {
    loadMaxprepsOpportunities();
  }, [loadMaxprepsOpportunities]);

  function daysSince(dateStr) {
    return Math.floor((Date.now() - new Date(dateStr).getTime()) / (24 * 60 * 60 * 1000));
  }

  // Exports the full Needs Re-check list (not capped to what's on screen).
  function exportNeedsRecheck() {
    setRecheckExportError("");
    setRecheckExporting(true);
    try {
      const csv = Papa.unparse({
        fields: ["school_id", "school_name", "city", "state", "days_since_verified", "hc_first_name", "hc_last_name", "hc_email", "hc_cell", "hc_office", "confidence_score"],
        data: needsRecheck.map((s) => [
          s.id,
          s.name || "",
          s.city || "",
          s.state || "",
          daysSince(s.last_verified_at),
          s.hc_first_name || "",
          s.hc_last_name || "",
          s.hc_email || "",
          s.hc_cell || "",
          s.hc_office || "",
          s.confidence_score ?? 0,
        ]),
      });
      downloadBlob(csv, `needs_recheck_${new Date().toISOString().slice(0, 10)}.csv`);
    } catch (err) {
      setRecheckExportError(err.message || "Could not export this list.");
    } finally {
      setRecheckExporting(false);
    }
  }

  // Exports the full upcoming-batch preview (not capped to what's on
  // screen) -- one row per school in tonight's Coach-Change Radar run.
  function exportUpcomingQueue() {
    setUpcomingExportError("");
    setUpcomingExporting(true);
    try {
      const csv = Papa.unparse({
        fields: ["school_id", "school_name", "city", "state", "website", "maxpreps_url", "hc_first_name", "hc_last_name", "last_checked_at"],
        data: upcomingQueue.map((r) => [
          r.school_id,
          r.school?.name || "",
          r.school?.city || "",
          r.school?.state || "",
          r.website || "",
          r.maxpreps_url || "",
          r.hc_first_name || "",
          r.hc_last_name || "",
          r.last_checked_at ? new Date(r.last_checked_at).toISOString() : "never checked",
        ]),
      });
      downloadBlob(csv, `upcoming_recheck_queue_${new Date().toISOString().slice(0, 10)}.csv`);
    } catch (err) {
      setUpcomingExportError(err.message || "Could not export this list.");
    } finally {
      setUpcomingExporting(false);
    }
  }

  function exportMaxprepsOpportunities() {
    setMaxprepsOppExportError("");
    setMaxprepsOppExporting(true);
    try {
      const csv = Papa.unparse({
        fields: ["school_id", "school_name", "city", "state", "website", "hc_first_name", "hc_last_name", "last_result", "last_checked_at"],
        data: maxprepsOpportunities.map((s) => [
          s.id,
          s.name || "",
          s.city || "",
          s.state || "",
          s.website || "",
          s.hc_first_name || "",
          s.hc_last_name || "",
          s.lastResult || "",
          s.lastCheckedAt ? new Date(s.lastCheckedAt).toISOString() : "",
        ]),
      });
      downloadBlob(csv, `maxpreps_opportunities_${new Date().toISOString().slice(0, 10)}.csv`);
    } catch (err) {
      setMaxprepsOppExportError(err.message || "Could not export this list.");
    } finally {
      setMaxprepsOppExporting(false);
    }
  }

  // Exports the full Coach Change History list (not capped to the ~100
  // shown on screen) -- one row per changed field, so "old value"/"new
  // value" stay in their own columns for a spreadsheet.
  function exportCoachChanges() {
    setCoachChangeExportError("");
    setCoachChangeExporting(true);
    try {
      const csv = Papa.unparse({
        fields: ["school_name", "city", "state", "field", "old_value", "new_value", "source", "changed_at"],
        data: sortedCoachChanges.flatMap((g) =>
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
        .select("id,name,city,state,hc_first_name,hc_last_name,hc_email,hc_cell,hc_office,lat,lon,verification_status,maxpreps_url,athletics_url,website,confidence_score")
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
        .select("id,name,city,state,hc_first_name,hc_last_name,hc_email,hc_cell,hc_office,maxpreps_url,athletics_url,website,verification_status,confidence_score")
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
      setScannedAt(new Date());
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
          // confidence_score isn't set here -- the schools table recomputes
          // it itself on every write (see the trigger note in markVerified
          // below), so anything sent from the client would just be
          // overridden anyway.
          updatesById.set(row.id, update);
          return update;
        });
        const { error } = await supabase.from("schools").upsert(upserts, { onConflict: "id" });
        if (error) throw error;
        await logManualVerificationBatch(upserts.map((u) => ({ ...u, via: "bulk correction upload" })));
        markUpcomingVerified(chunk.map((row) => row.id), { verification_status: "verified", last_verified_at: now });

        const changes = [];
        chunk.forEach((row) => {
          row.fields.forEach((f) => {
            // A bulk upload that touches the coach's name is, in practice,
            // almost always recording a coach change (a season's worth of
            // hires dumped in from a spreadsheet) -- tag those two fields
            // the same way "Mark Coach Change" does, so they show up
            // correctly in Coach Change History without anyone having to
            // fix them one at a time by hand.
            const isCoachName = f.field === "hc_first_name" || f.field === "hc_last_name";
            changes.push({
              school_id: row.id,
              field_name: f.field,
              old_value: f.old === "—" ? null : f.old,
              new_value: f.new,
              source: isCoachName ? "Head coach change (manual)" : "Bulk correction upload (Data Quality)",
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
      // Every row in this batch just got verification_status/last_verified_at
      // refreshed, so none of them are stale anymore.
      setNeedsRecheck((prev) => prev.filter((s) => !updatedIds.has(s.id)));

      if (updatedIds.size) {
        await supabase
          .from("school_flags")
          .update({ status: "resolved", resolved_by: user.id, resolved_at: now })
          .in("school_id", Array.from(updatedIds))
          .eq("status", "pending");
        setFlaggedQueue((prev) => prev.filter((f) => !updatedIds.has(f.school_id)));
      }

      if (uploadPreview.some((row) => row.fields.some((f) => COACH_CHANGE_TRACKED_FIELDS.includes(f.field)))) {
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

  function resetBulkVerify() {
    setBulkVerifyMatched([]);
    setBulkVerifyUnmatched([]);
    setBulkVerifyError("");
    setBulkVerifyApplyResult(null);
    setBulkVerifyApplyError("");
    setBulkVerifyFileName("");
    if (bulkVerifyInputRef.current) bulkVerifyInputRef.current.value = "";
  }

  // Reads a simple list of schools -- school_id (preferred) or
  // school_name + state (+ city to break ties) -- and matches each row
  // without touching any field. Same matching rule as the CSV upload
  // above, just without the field-by-field diff, since there's nothing to
  // diff here.
  async function handleBulkVerifyFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    resetBulkVerify();
    setBulkVerifyFileName(file.name);
    setBulkVerifyParsing(true);
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

      const matched = [];
      const unmatched = [];
      const seenIds = new Set();

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
        if (seenIds.has(school.id)) return; // same school listed twice -- not an error, just skip the repeat
        seenIds.add(school.id);
        matched.push({ id: school.id, name: school.name, city: school.city, state: school.state });
      });

      setBulkVerifyMatched(matched);
      setBulkVerifyUnmatched(unmatched);
    } catch (err) {
      setBulkVerifyError(err.message || "Could not read this file.");
    } finally {
      setBulkVerifyParsing(false);
    }
  }

  // Applies the batch in one shot (chunked for the upsert): flips
  // verification_status/last_verified_at, resolves any pending "possibly
  // outdated" flags on the schools touched, and folds the result back
  // into every list on screen -- same bookkeeping as markVerified, just
  // for many schools at once instead of one.
  async function applyBulkVerify() {
    setBulkVerifyApplying(true);
    setBulkVerifyApplyError("");
    setBulkVerifyApplyResult(null);
    try {
      const now = new Date().toISOString();
      const ids = bulkVerifyMatched.map((s) => s.id);
      for (let i = 0; i < ids.length; i += BATCH_SIZE) {
        const chunk = ids.slice(i, i + BATCH_SIZE);
        setBulkVerifyApplyStatus(`Verifying ${i + 1}–${Math.min(i + BATCH_SIZE, ids.length)} of ${ids.length}…`);
        const upserts = chunk.map((id) => ({ id, verification_status: "verified", last_verified_at: now }));
        const { error } = await supabase.from("schools").upsert(upserts, { onConflict: "id" });
        if (error) throw error;
        await logManualVerificationBatch(chunk.map((id) => ({ id, via: "Bulk Mark Verified" })));
        markUpcomingVerified(chunk, { verification_status: "verified", last_verified_at: now });
      }

      const updatedIds = new Set(ids);
      if (updatedIds.size) {
        await supabase
          .from("school_flags")
          .update({ status: "resolved", resolved_by: user.id, resolved_at: now })
          .in("school_id", ids)
          .eq("status", "pending");
      }

      const merge = { verification_status: "verified", last_verified_at: now };
      setResult((prev) => {
        if (!prev) return prev;
        const nextFlagged = prev.flagged.map((r) => (updatedIds.has(r.school.id) ? { ...r, school: { ...r.school, ...merge } } : r));
        return { ...prev, flagged: nextFlagged };
      });
      setSearchResults((prev) => prev.map((s) => (updatedIds.has(s.id) ? { ...s, ...merge } : s)));
      setNeedsRecheck((prev) => prev.filter((s) => !updatedIds.has(s.id)));
      setFlaggedQueue((prev) => prev.filter((f) => !updatedIds.has(f.school_id)));

      setBulkVerifyApplyResult({ count: ids.length });
      setBulkVerifyMatched([]);
    } catch (err) {
      setBulkVerifyApplyError(err.message || "Something went wrong marking these schools verified.");
    } finally {
      setBulkVerifyApplying(false);
      setBulkVerifyApplyStatus("");
    }
  }

  function startEdit(school) {
    setEditingId(school.id);
    setCoachChangeFrom(null);
    setSaveError("");
    setDiscoverError("");
    setSuggestions([]);
    setDiscoverAthleticsError("");
    setAthleticsSuggestions([]);
    setAiSuggestError("");
    setAiSuggestInfo(null);
    setEditValues({
      hc_first_name: school.hc_first_name || "",
      hc_last_name: school.hc_last_name || "",
      hc_email: school.hc_email || "",
      hc_cell: school.hc_cell || "",
      hc_office: school.hc_office || "",
      maxpreps_url: school.maxpreps_url || "",
      athletics_url: school.athletics_url || "",
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
    setDiscoverAthleticsError("");
    setAthleticsSuggestions([]);
    setAiSuggestError("");
    setAiSuggestInfo(null);
    setEditValues({
      hc_first_name: "",
      hc_last_name: "",
      hc_email: "",
      hc_cell: "",
      hc_office: "",
      maxpreps_url: school.maxpreps_url || "",
      athletics_url: school.athletics_url || "",
    });
  }

  function cancelEdit() {
    setEditingId(null);
    setCoachChangeFrom(null);
    setSaveError("");
    setDiscoverError("");
    setSuggestions([]);
    setDiscoverAthleticsError("");
    setAthleticsSuggestions([]);
    setAiSuggestError("");
    setAiSuggestInfo(null);
  }

  // Asks Serper.dev's Google-search proxy (via our own API route, which
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

  // Same idea as discoverMaxPreps above, pointed at a school's own
  // athletics-department site instead of MaxPreps -- see
  // app/api/schools/[id]/discover-athletics for why that search isn't
  // restricted to one domain the way MaxPreps is (an athletics site can
  // live almost anywhere: a subdomain of the school's own site, or a
  // third-party host like rSchoolToday or SportsEngine). Same school
  // profile page already has this exact button; this brings it to the
  // Quick Fix editor here too, so Athletics URL doesn't have to be found
  // and typed in by hand. Only ever returns candidates for a human to pick
  // from; never writes athletics_url on its own.
  async function discoverAthletics(school) {
    setDiscoveringAthletics(true);
    setDiscoverAthleticsError("");
    setAthleticsSuggestions([]);
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const res = await fetch(`/api/schools/${school.id}/discover-athletics`, {
        method: "POST",
        headers: { Authorization: `Bearer ${session?.access_token}` },
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Could not search for an athletics site.");
      setAthleticsSuggestions(json.candidates || []);
      if (!json.candidates?.length) setDiscoverAthleticsError("No athletics site turned up for this school. Try searching directly and paste the link in.");
    } catch (err) {
      setDiscoverAthleticsError(err.message || "Could not search for an athletics site.");
    } finally {
      setDiscoveringAthletics(false);
    }
  }

  function pickAthleticsSuggestion(link) {
    setEditValues((prev) => ({ ...prev, athletics_url: link }));
    setAthleticsSuggestions([]);
  }

  // Reads the school's athletics site/website itself and suggests a head
  // coach name, email, and phone for the reviewer to confirm -- instead of
  // opening the site by hand to find and retype it. Never saves anything
  // on its own; it only pre-fills the Quick Fix inputs. A returned field
  // stays blank if the AI didn't find it there, so it never overwrites
  // something already typed with an empty guess.
  async function suggestCoachInfo(school) {
    setAiSuggesting(true);
    setAiSuggestError("");
    setAiSuggestInfo(null);
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const res = await fetch(`/api/schools/${school.id}/discover-coach-info`, {
        method: "POST",
        headers: { Authorization: `Bearer ${session?.access_token}` },
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Could not look up coach info.");
      setEditValues((prev) => ({
        ...prev,
        hc_first_name: json.hc_first_name || prev.hc_first_name,
        hc_last_name: json.hc_last_name || prev.hc_last_name,
        hc_email: json.hc_email || prev.hc_email,
        hc_office: json.hc_office || prev.hc_office,
        hc_cell: json.hc_cell || prev.hc_cell,
      }));
      setAiSuggestInfo({ confidence: json.confidence, source: json.source, notes: json.notes });
    } catch (err) {
      setAiSuggestError(err.message || "Could not look up coach info.");
    } finally {
      setAiSuggesting(false);
    }
  }

  async function resolvePendingFlags(schoolId) {
    await supabase
      .from("school_flags")
      .update({ status: "resolved", resolved_by: user.id, resolved_at: new Date().toISOString() })
      .eq("school_id", schoolId)
      .eq("status", "pending");
    setFlaggedQueue((prev) => prev.filter((f) => f.school_id !== schoolId));
  }

  // The nightly Coach-Change Radar sweep picks its batch from
  // school_recheck_log (see school_recheck_priority / RECHECK_BATCH_SIZE
  // above), not from verification_status/last_verified_at -- so without
  // this, a school just verified by hand here would still show up in
  // tonight's automated batch. Logging a row here moves it to the back of
  // that queue exactly like a real website check would. result is
  // constrained to the same five values the automated checks use (see
  // school_recheck_log's CHECK constraint) -- "confirmed" is the closest
  // fit; the [Manual verification] detail prefix is what actually tells
  // this apart from an automated check (and keeps it out of the "[Automated
  // nightly sweep]" Coach-Change Radar report above, which filters on that
  // exact prefix). Best-effort: this is bookkeeping for the nightly
  // schedule, not the verification itself, so a failure here shouldn't
  // block or error out the action that's actually marking the school
  // verified.
  async function logManualVerification(school) {
    try {
      await supabase.from("school_recheck_log").insert({
        school_id: school.id,
        checked_by: user.id,
        website_checked: school.website || null,
        coach_name_checked: [school.hc_first_name, school.hc_last_name].filter(Boolean).join(" ") || null,
        result: "confirmed",
        detail: "[Manual verification] Marked verified by a staff member — not an automated website check.",
      });
    } catch (err) {
      console.error("Could not log manual verification", err);
    }
  }

  // Reflects a fresh verification on any row currently shown in the
  // Upcoming Recheck Queue -- that queue is a point-in-time snapshot (see
  // loadUpcomingQueue), so without this a school you just checked would
  // keep sitting there looking untouched until the next full reload. A
  // school shows the "You verified this" badge below once its
  // last_verified_at is newer than the last_checked_at this row was
  // loaded with -- exactly what just happened here.
  function markUpcomingVerified(schoolIds, patch) {
    const idSet = schoolIds instanceof Set ? schoolIds : new Set(schoolIds);
    setUpcomingQueue((prev) => prev.map((r) => (idSet.has(r.school_id) ? { ...r, school: { ...r.school, ...patch } } : r)));
  }

  // Same as logManualVerification, batched for the CSV upload / Bulk Mark
  // Verified tools -- one insert per chunk instead of one round trip per
  // school. `rows` is whatever's on hand at the call site (may not include
  // website/coach name if this particular tool didn't fetch or touch that
  // field) -- those columns are just informational either way, so a null
  // there doesn't affect what actually matters: the row existing at all,
  // so this school drops to the back of tonight's queue.
  async function logManualVerificationBatch(rows) {
    if (!rows.length) return;
    try {
      await supabase.from("school_recheck_log").insert(
        rows.map((r) => ({
          school_id: r.id,
          checked_by: user.id,
          website_checked: r.website || null,
          coach_name_checked: [r.hc_first_name, r.hc_last_name].filter(Boolean).join(" ") || null,
          result: "confirmed",
          detail: `[Manual verification] Marked verified via ${r.via || "a bulk tool"} — not an automated website check.`,
        }))
      );
    } catch (err) {
      console.error("Could not log manual verification batch", err);
    }
  }

  // Marks a school verified with no field changes -- for a record found
  // via search or a scan that you've actually checked (in person, on the
  // phone, on the school's website) and it's already correct. Same effect
  // as "Confirm accurate" in the flagged queue below, just reachable from
  // places that don't have a flag to confirm against. Doesn't touch
  // confidence_score directly -- the database recalculates that on its own
  // the moment verification_status/last_verified_at change (see the
  // trigger note in markVerified below), so the on-screen % badge may
  // lag a beat until the next search or scan picks up the fresh value.
  async function markVerified(school) {
    setMarkingVerifiedId(school.id);
    setMarkVerifiedError("");
    try {
      const update = { verification_status: "verified", last_verified_at: new Date().toISOString() };
      const { error } = await supabase.from("schools").update(update).eq("id", school.id);
      if (error) throw error;
      const merged = { ...school, ...update };
      await logManualVerification(merged);
      await resolvePendingFlags(school.id);
      markUpcomingVerified([school.id], update);

      setResult((prev) => {
        if (!prev) return prev;
        const nextFlagged = prev.flagged.map((r) => (r.school.id === school.id ? { ...r, school: merged } : r));
        const reclass = classifySchool(merged);
        const finalFlagged = reclass.actionable
          ? nextFlagged.map((r) => (r.school.id === school.id ? { ...r, ...reclass, school: merged } : r))
          : nextFlagged.filter((r) => r.school.id !== school.id);
        return { ...prev, flagged: finalFlagged, totalFlagged: finalFlagged.length };
      });
      setSearchResults((prev) => prev.map((s) => (s.id === school.id ? { ...s, ...update } : s)));
      // Freshly verified -- no longer stale, so it drops out of the Needs
      // Re-check queue without waiting on a reload.
      setNeedsRecheck((prev) => prev.filter((s) => s.id !== school.id));
    } catch (err) {
      setMarkVerifiedError(err.message || "Could not mark this school verified.");
    } finally {
      setMarkingVerifiedId(null);
    }
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
      // confidence_score isn't set here -- the schools table recomputes it
      // itself on every write, from whatever the row looks like after this
      // update lands (see the trigger note in markVerified below).
      const { error: updateError } = await supabase.from("schools").update(update).eq("id", before.id);
      if (updateError) throw updateError;
      if (changes.length) {
        const { error: logError } = await supabase.from("school_change_log").insert(changes);
        if (logError) throw logError;
      }
      const merged = { ...before, ...update };
      await logManualVerification(merged);
      await resolvePendingFlags(before.id);
      markUpcomingVerified([before.id], update);

      // Reflect the fix locally without a full re-scan: drop the row from
      // the queue if it's no longer actionable, otherwise re-classify it.
      setResult((prev) => {
        if (!prev) return prev;
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
      // Freshly verified -- no longer stale, so it drops out of the Needs
      // Re-check queue without waiting on a reload.
      setNeedsRecheck((prev) => prev.filter((s) => s.id !== before.id));
      if (changes.some((c) => COACH_CHANGE_TRACKED_FIELDS.includes(c.field_name))) {
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
      const { error: schoolError } = await supabase.from("schools").update(schoolUpdate).eq("id", flag.school_id);
      if (schoolError) throw schoolError;
      await logManualVerification({ ...flag.schools, id: flag.school_id, ...schoolUpdate });
      markUpcomingVerified([flag.school_id], schoolUpdate);
      setFlaggedQueue((prev) => prev.filter((f) => f.id !== flag.id));
      setNeedsRecheck((prev) => prev.filter((s) => s.id !== flag.school_id));
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

  const filteredRows = result ? result.flagged.filter((r) => filter === "all" || r.issues.some((iss) => iss.code === filter)) : [];
  // classifySchools already sorts `filteredRows` by issue severity, then
  // name -- that's the "default" sort below. Confidence sorting is applied
  // on top, client-side, without touching that underlying order.
  const sortedRows =
    sortBy === "confidence_asc"
      ? [...filteredRows].sort((a, b) => (a.school.confidence_score ?? 0) - (b.school.confidence_score ?? 0))
      : sortBy === "confidence_desc"
      ? [...filteredRows].sort((a, b) => (b.school.confidence_score ?? 0) - (a.school.confidence_score ?? 0))
      : filteredRows;
  const visibleRows = sortedRows.slice(0, DISPLAY_CAP);
  const visibleTotal = filteredRows.length;
  const automatedPendingCount = flaggedQueue.filter((f) => (f.reason || "").startsWith(AUTOMATED_FLAG_PREFIX)).length;
  const confirmedTotal = (radarStats?.counts.confirmed || 0) + (radarStats?.counts.confirmed_maxpreps || 0);
  const radarFilteredRows = radarFilter === "all" ? radarRows : radarRows.filter((r) => r.result === radarFilter);
  const cycleDays = coverageStats?.eligible ? Math.ceil(coverageStats.eligible / RECHECK_BATCH_SIZE) : null;

  // Today's List -- a short, finishable daily task list instead of an
  // open-ended scroll through hundreds of rows. Flags come first (someone
  // already reported or the sweep already detected a possible problem, so
  // they're the most urgent), then the oldest overdue re-checks fill any
  // remaining slots up to TODAYS_LIST_SIZE. Both queues are already
  // sorted oldest-first, and both are live state -- completing an item
  // here (Confirm Accurate / Mark Verified) removes it from its source
  // list, which removes it from here too, no separate bookkeeping needed.
  const todaysFlags = flaggedQueue.slice(0, TODAYS_LIST_FLAG_CAP);
  const todaysRecheck = needsRecheck.slice(0, Math.max(0, TODAYS_LIST_SIZE - todaysFlags.length));
  const todaysListTotal = todaysFlags.length + todaysRecheck.length;

  return (
    <div className="view">
      <Link href="/admin" className="btn btn-sm" style={{ marginBottom: 12, display: "inline-flex" }}>
        ← Back to Admin
      </Link>
      <div className="view-header">
        <div>
          <h1>Data Quality Review</h1>
          <p>Scans every school for outreach-critical problems — missing contact info, malformed emails/phones, orphaned contact info with no coach name.</p>
          {scannedAt && (
            <p style={{ fontSize: 12, color: "#9aa2b1", marginTop: 2 }}>
              Last scanned {fmtRelativeTime(scannedAt)}
              {Date.now() - scannedAt.getTime() > SCAN_CACHE_STALE_MS ? " — records may have changed since; consider a re-scan." : "."}
            </p>
          )}
        </div>
        <button className="btn btn-gold" onClick={runScan} disabled={scanning}>
          {scanning ? "Scanning…" : result ? "Re-scan Database" : "Scan Database"}
        </button>
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <h3 style={{ marginBottom: 4 }}>Today&apos;s List ({todaysListTotal})</h3>
        <p style={{ fontSize: 12.5, color: "#697386", marginTop: -2, marginBottom: 10 }}>
          A short, finishable list instead of a long scroll — flagged/possibly-outdated schools first (up to {TODAYS_LIST_FLAG_CAP}), then whatever&apos;s most overdue for a re-check fills the rest, up to {TODAYS_LIST_SIZE} total. Clear one and it drops off the list.
        </p>
        {flagActionError && <div className="notice danger" style={{ marginBottom: 10 }}>{flagActionError}</div>}
        {markVerifiedError && <div className="notice danger" style={{ marginBottom: 10 }}>{markVerifiedError}</div>}
        {loadingFlags || loadingNeedsRecheck ? (
          <div className="empty-state">Loading…</div>
        ) : todaysListTotal === 0 ? (
          <div className="empty-state">Nothing urgent right now — no flags pending, and nothing overdue for a re-check.</div>
        ) : (
          <>
            {todaysFlags.map((flag) => {
              const s = flag.schools;
              const isAutomated = (flag.reason || "").startsWith(AUTOMATED_FLAG_PREFIX);
              return (
                <div className="log-item" key={`flag-${flag.id}`} style={{ paddingBottom: 10 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 8 }}>
                    <div>
                      <strong>{s?.name || `School #${flag.school_id}`}</strong> — {s?.city}, {s?.state}
                      <span
                        className={isAutomated ? "badge badge-unverified" : "badge"}
                        style={isAutomated ? { marginLeft: 8 } : { marginLeft: 8, background: "#e8ebf0", color: "#42506b" }}
                      >
                        {isAutomated ? "Automated flag" : "Coach-reported flag"}
                      </span>
                      <div style={{ fontSize: 12, color: "#697386", marginTop: 2 }}>
                        {flag.reason ? `"${flag.reason}"` : "No reason given."}
                      </div>
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
                      <Link href={`/schools/${flag.school_id}`} className="btn btn-sm" target="_blank" rel="noopener noreferrer">Open Profile</Link>
                      <button className="btn btn-sm" disabled={flagActionId === flag.id} onClick={() => confirmAccurate(flag)}>
                        {flagActionId === flag.id ? "Saving…" : "Confirm accurate"}
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
            {todaysRecheck.map((s) => {
              const days = daysSince(s.last_verified_at);
              return (
                <div className="log-item" key={`recheck-${s.id}`} style={{ paddingBottom: 10 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 8 }}>
                    <div>
                      <strong>{s.name}</strong> — {s.city}, {s.state}
                      <span className="badge badge-unverified" style={{ marginLeft: 8 }}>{days}d since verified</span>
                      <div style={{ fontSize: 12, color: "#697386", marginTop: 2 }}>
                        {[s.hc_first_name, s.hc_last_name].filter(Boolean).join(" ") || "no coach name"}
                      </div>
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
                      <Link href={`/schools/${s.id}`} className="btn btn-sm" target="_blank" rel="noopener noreferrer">Open Profile</Link>
                      <button className="btn btn-sm" disabled={markingVerifiedId === s.id} onClick={() => markVerified(s)}>
                        {markingVerifiedId === s.id ? "Marking…" : "Mark Verified"}
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </>
        )}
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
        {markVerifiedError && <div className="notice danger" style={{ marginBottom: 10 }}>{markVerifiedError}</div>}
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
                  <Link href={`/schools/${s.id}`} className="btn btn-sm" target="_blank" rel="noopener noreferrer">Open Profile</Link>
                  {!isEditing && (
                    <>
                      <button className="btn btn-sm btn-primary" onClick={() => startEdit(s)}>Quick Fix</button>
                      <button className="btn btn-sm" onClick={() => startCoachChange(s)}>Mark Coach Change</button>
                      <button className="btn btn-sm" disabled={markingVerifiedId === s.id} onClick={() => markVerified(s)}>
                        {markingVerifiedId === s.id ? "Marking…" : "Mark Verified"}
                      </button>
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
                    <button type="button" className="btn btn-sm" disabled={discoveringAthletics} onClick={() => discoverAthletics(s)} style={{ marginLeft: 6 }}>
                      {discoveringAthletics ? "Searching…" : "Find Athletics page"}
                    </button>
                    {discoverAthleticsError && <div style={{ fontSize: 12, color: "#b3261e", marginTop: 6 }}>{discoverAthleticsError}</div>}
                    {athleticsSuggestions.length > 0 && (
                      <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 4 }}>
                        {athleticsSuggestions.map((sugg) => (
                          <button
                            type="button"
                            key={sugg.link}
                            className="btn btn-sm"
                            style={{ textAlign: "left", justifyContent: "flex-start", whiteSpace: "normal" }}
                            onClick={() => pickAthleticsSuggestion(sugg.link)}
                          >
                            {sugg.title} — <span style={{ color: "#697386" }}>{sugg.link}</span>
                          </button>
                        ))}
                      </div>
                    )}
                    <button type="button" className="btn btn-sm" disabled={aiSuggesting} onClick={() => suggestCoachInfo(s)} style={{ marginLeft: 6 }}>
                      {aiSuggesting ? "Looking…" : "Suggest Coach Info (AI)"}
                    </button>
                    {aiSuggestError && <div style={{ fontSize: 12, color: "#b3261e", marginTop: 6 }}>{aiSuggestError}</div>}
                    {aiSuggestInfo && (
                      <div style={{ fontSize: 12, color: "#697386", marginTop: 6 }}>
                        AI suggestion ({aiSuggestInfo.confidence} confidence, from the {aiSuggestInfo.source}) filled into the fields below — review before saving.
                        {aiSuggestInfo.notes ? ` ${aiSuggestInfo.notes}` : ""}
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
                            <Link href={`/schools/${row.school_id}`} className="btn btn-sm" target="_blank" rel="noopener noreferrer">Open Profile</Link>
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
            <h3 style={{ marginBottom: 4 }}>Upcoming Recheck Queue</h3>
            <p style={{ fontSize: 12.5, color: "#697386", marginTop: -2, marginBottom: 0 }}>
              Coach-Change Radar runs automatically {RECHECK_SCHEDULE_LABEL}, checking up to {RECHECK_BATCH_SIZE.toLocaleString()} schools per run — whichever have gone longest without a check. This is that exact batch, in that exact order, so you can review or fix a website below before the sweep gets to it tonight.
            </p>
          </div>
          <button className="btn btn-sm" onClick={exportUpcomingQueue} disabled={upcomingExporting || upcomingQueue.length === 0}>
            {upcomingExporting ? "Exporting…" : "Download CSV"}
          </button>
        </div>
        {upcomingExportError && <div className="notice danger" style={{ marginTop: 10 }}>{upcomingExportError}</div>}

        {loadingCoverage ? (
          <div className="empty-state" style={{ marginTop: 10 }}>Loading…</div>
        ) : coverageStats ? (
          <div className="grid grid-4" style={{ marginTop: 10, marginBottom: 12 }}>
            <div className="card stat-card">
              <div className="label">Total Schools</div>
              <div className="num">{coverageStats.total.toLocaleString()}</div>
            </div>
            <div className="card stat-card">
              <div className="label">Eligible For Nightly Check</div>
              <div className="num">{coverageStats.eligible.toLocaleString()}</div>
              <div className="sub">has a coach name + a website or MaxPreps URL</div>
            </div>
            <div className="card stat-card">
              <div className="label">Website On File</div>
              <div className="num">{coverageStats.withWebsite.toLocaleString()}</div>
              <div className="sub">{coverageStats.total ? `${Math.round((coverageStats.withWebsite / coverageStats.total) * 100)}% of all schools` : ""}</div>
            </div>
            <div className="card stat-card">
              <div className="label">MaxPreps URL On File</div>
              <div className="num">{coverageStats.withMaxpreps.toLocaleString()}</div>
              <div className="sub">
                {coverageStats.total
                  ? coverageStats.withMaxpreps === 0
                    ? "none yet — the MaxPreps fallback check never fires"
                    : `${Math.round((coverageStats.withMaxpreps / coverageStats.total) * 100)}% of all schools`
                  : ""}
              </div>
            </div>
          </div>
        ) : null}

        {cycleDays && (
          <p style={{ fontSize: 12.5, color: "#697386", marginTop: -4, marginBottom: 10 }}>
            At {RECHECK_BATCH_SIZE.toLocaleString()} schools a night, a full pass through all {coverageStats.eligible.toLocaleString()} eligible schools takes about {cycleDays} night{cycleDays === 1 ? "" : "s"}.
          </p>
        )}

        {loadingUpcoming ? (
          <div className="empty-state">Loading…</div>
        ) : upcomingQueue.length === 0 ? (
          <div className="empty-state">No schools are currently eligible for the nightly sweep — see the coverage numbers above.</div>
        ) : (
          <>
            {upcomingQueue.slice(0, DISPLAY_CAP).map((r) => {
              // "Already handled" means a human verification is on record
              // more recently than this row's last_checked_at snapshot --
              // covers both a check made just now (see markUpcomingVerified)
              // and one already on file from before this list loaded.
              const alreadyChecked =
                r.school?.last_verified_at && (!r.last_checked_at || new Date(r.school.last_verified_at) > new Date(r.last_checked_at));
              return (
              <div className="log-item" key={r.school_id} style={{ paddingBottom: 10, opacity: alreadyChecked ? 0.7 : 1 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 8 }}>
                  <div>
                    <strong>{r.school?.name || `School #${r.school_id}`}</strong> — {r.school?.city}, {r.school?.state}
                    {alreadyChecked && (
                      <span className="badge" style={{ marginLeft: 8, color: "#1a7f37", background: "#e6f4ea" }}>
                        ✓ You checked this{r.school.last_verified_at ? ` — ${new Date(r.school.last_verified_at).toLocaleDateString()}` : ""}
                      </span>
                    )}
                    <div style={{ fontSize: 12, color: "#697386", marginTop: 2 }}>
                      {[r.hc_first_name, r.hc_last_name].filter(Boolean).join(" ") || "no coach on file"}
                      {r.website ? (
                        <>
                          {" · "}
                          <a href={withProtocol(r.website)} target="_blank" rel="noreferrer">{r.website}</a>
                        </>
                      ) : (
                        " · no website on file"
                      )}
                    </div>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
                    <Link href={`/schools/${r.school_id}`} className="btn btn-sm" target="_blank" rel="noopener noreferrer">Open Profile</Link>
                    <span style={{ fontSize: 11, color: "#9aa2b1", whiteSpace: "nowrap" }}>
                      {r.last_checked_at ? `Last checked ${new Date(r.last_checked_at).toLocaleDateString()}` : "Never checked"}
                    </span>
                  </div>
                </div>
              </div>
              );
            })}
            {upcomingQueue.length > DISPLAY_CAP && (
              <div style={{ fontSize: 12, color: "#697386", marginTop: 6 }}>
                Showing the first {DISPLAY_CAP} of {upcomingQueue.length.toLocaleString()} — download the CSV for the full batch.
              </div>
            )}
          </>
        )}
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 8 }}>
          <div>
            <h3 style={{ marginBottom: 4 }}>MaxPreps Opportunities ({maxprepsOpportunities.length})</h3>
            <p style={{ fontSize: 12.5, color: "#697386", marginTop: -2, marginBottom: 0 }}>
              Schools whose most recent automated check came back &quot;Not found&quot; or &quot;Could not load&quot; on their own website, and don&apos;t have a MaxPreps URL on file to fall back to. Add one here and the nightly sweep gets a real second chance to confirm the coach for these.
            </p>
          </div>
          <button className="btn btn-sm" onClick={exportMaxprepsOpportunities} disabled={maxprepsOppExporting || maxprepsOpportunities.length === 0}>
            {maxprepsOppExporting ? "Exporting…" : "Download CSV"}
          </button>
        </div>
        {maxprepsOppExportError && <div className="notice danger" style={{ marginTop: 10 }}>{maxprepsOppExportError}</div>}
        {loadingMaxprepsOpp ? (
          <div className="empty-state" style={{ marginTop: 10 }}>Loading…</div>
        ) : maxprepsOpportunities.length === 0 ? (
          <div className="empty-state" style={{ marginTop: 10 }}>Nothing here right now — either recent checks are all coming back confirmed, or the affected schools already have a MaxPreps URL on file.</div>
        ) : (
          <div style={{ marginTop: 10 }}>
            {maxprepsOpportunities.slice(0, DISPLAY_CAP).map((s) => {
              const meta = RADAR_RESULT_META[s.lastResult] || { label: s.lastResult, color: "#42506b", bg: "#e8ebf0" };
              return (
                <div className="log-item" key={s.id} style={{ paddingBottom: 10 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 8 }}>
                    <div>
                      <strong>{s.name}</strong> — {s.city}, {s.state}
                      <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 999, color: meta.color, background: meta.bg }}>
                        {meta.label}
                      </span>
                      <div style={{ fontSize: 12, color: "#697386", marginTop: 2 }}>
                        {[s.hc_first_name, s.hc_last_name].filter(Boolean).join(" ") || "no coach on file"}
                        {s.website ? ` · ${s.website}` : " · no website on file"}
                      </div>
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
                      <Link href={`/schools/${s.id}`} className="btn btn-sm" target="_blank" rel="noopener noreferrer">Add MaxPreps URL</Link>
                      <span style={{ fontSize: 11, color: "#9aa2b1", whiteSpace: "nowrap" }}>
                        {s.lastCheckedAt ? `Checked ${new Date(s.lastCheckedAt).toLocaleDateString()}` : ""}
                      </span>
                    </div>
                  </div>
                </div>
              );
            })}
            {maxprepsOpportunities.length > DISPLAY_CAP && (
              <div style={{ fontSize: 12, color: "#697386", marginTop: 6 }}>
                Showing the first {DISPLAY_CAP} of {maxprepsOpportunities.length.toLocaleString()} — download the CSV for the full list.
              </div>
            )}
          </div>
        )}
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 8 }}>
          <div>
            <h3 style={{ marginBottom: 4 }}>Coach Change History</h3>
            <p style={{ fontSize: 12.5, color: "#697386", marginTop: -2, marginBottom: 0 }}>
              Every recorded head coach update — name, email, cell, or office phone — dated and tagged with how it was made: &quot;Mark Coach Change,&quot; a Quick Fix, a bulk upload, or an approved coach-submitted correction.
            </p>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <label style={{ fontSize: 12.5, color: "#697386" }}>
              Sort:{" "}
              <select
                value={coachChangeSort}
                onChange={(e) => setCoachChangeSort(e.target.value)}
                style={{ fontSize: 12.5, padding: "3px 6px" }}
              >
                <option value="newest">Newest first</option>
                <option value="oldest">Oldest first</option>
              </select>
            </label>
            <button className="btn btn-sm" onClick={exportCoachChanges} disabled={coachChangeExporting || coachChanges.length === 0}>
              {coachChangeExporting ? "Exporting…" : "Download CSV"}
            </button>
          </div>
        </div>
        {coachChangeExportError && <div className="notice danger" style={{ marginTop: 10 }}>{coachChangeExportError}</div>}
        {loadingCoachChanges ? (
          <div className="empty-state" style={{ marginTop: 10 }}>Loading…</div>
        ) : sortedCoachChanges.length === 0 ? (
          <div className="empty-state" style={{ marginTop: 10 }}>No coach changes recorded yet.</div>
        ) : (
          <div style={{ maxHeight: 360, overflow: "auto", marginTop: 10 }}>
            {sortedCoachChanges.slice(0, 100).map((g) => {
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
                      <Link href={`/schools/${g.school_id}`} className="btn btn-sm" target="_blank" rel="noopener noreferrer">Open Profile</Link>
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
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 8 }}>
          <div>
            <h3 style={{ marginBottom: 4 }}>Needs Re-check ({needsRecheck.length})</h3>
            <p style={{ fontSize: 12.5, color: "#697386", marginTop: -2, marginBottom: 10 }}>
              Verified schools whose last check has aged past {RECHECK_CUTOFF_DAYS} days — that&apos;s exactly where the confidence score&apos;s recency bonus starts fading, and by {RECHECK_STALE_DAYS} days it&apos;s gone entirely. Oldest first.
            </p>
          </div>
          <button className="btn btn-sm" onClick={exportNeedsRecheck} disabled={recheckExporting || needsRecheck.length === 0}>
            {recheckExporting ? "Exporting…" : "Download CSV"}
          </button>
        </div>
        {recheckExportError && <div className="notice danger" style={{ marginBottom: 10 }}>{recheckExportError}</div>}
        {markVerifiedError && <div className="notice danger" style={{ marginBottom: 10 }}>{markVerifiedError}</div>}
        {loadingNeedsRecheck ? (
          <div className="empty-state">Loading…</div>
        ) : needsRecheck.length === 0 ? (
          <div className="empty-state">Nothing overdue — every verified school has been checked within the last {RECHECK_CUTOFF_DAYS} days.</div>
        ) : (
          <>
            {needsRecheck.slice(0, DISPLAY_CAP).map((s) => {
              const isEditing = editingId === s.id;
              const days = daysSince(s.last_verified_at);
              const stale = days >= RECHECK_STALE_DAYS;
              return (
                <div className="log-item" key={s.id} style={{ paddingBottom: 12 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 8 }}>
                    <div>
                      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                        <strong>{s.name}</strong> — {s.city}, {s.state}
                        <span className={stale ? "badge badge-private" : "badge badge-unverified"}>
                          {stale ? `${days}d — score fully decayed` : `${days}d since verified`}
                        </span>
                        <span style={{ fontSize: 11, fontWeight: 600, color: confidenceColor(s.confidence_score ?? 0) }}>
                          {s.confidence_score ?? 0}% confidence
                        </span>
                      </div>
                      <div style={{ fontSize: 12, color: "#697386", marginTop: 2 }}>
                        {[s.hc_first_name, s.hc_last_name].filter(Boolean).join(" ") || "no name"}
                        {s.hc_email ? ` · ${s.hc_email}` : ""}
                        {s.hc_cell ? ` · ${fmtPhone(s.hc_cell)}` : ""}
                      </div>
                    </div>
                    <div style={{ display: "flex", gap: 6 }}>
                      <Link href={`/schools/${s.id}`} className="btn btn-sm" target="_blank" rel="noopener noreferrer">Open Profile</Link>
                      {!isEditing && (
                        <>
                          <button className="btn btn-sm btn-primary" onClick={() => startEdit(s)}>Quick Fix</button>
                          <button className="btn btn-sm" onClick={() => startCoachChange(s)}>Mark Coach Change</button>
                          <button className="btn btn-sm" disabled={markingVerifiedId === s.id} onClick={() => markVerified(s)}>
                            {markingVerifiedId === s.id ? "Marking…" : "Mark Verified"}
                          </button>
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
                        <button type="button" className="btn btn-sm" disabled={discoveringAthletics} onClick={() => discoverAthletics(s)} style={{ marginLeft: 6 }}>
                          {discoveringAthletics ? "Searching…" : "Find Athletics page"}
                        </button>
                        {discoverAthleticsError && <div style={{ fontSize: 12, color: "#b3261e", marginTop: 6 }}>{discoverAthleticsError}</div>}
                        {athleticsSuggestions.length > 0 && (
                          <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 4 }}>
                            {athleticsSuggestions.map((sugg) => (
                              <button
                                type="button"
                                key={sugg.link}
                                className="btn btn-sm"
                                style={{ textAlign: "left", justifyContent: "flex-start", whiteSpace: "normal" }}
                                onClick={() => pickAthleticsSuggestion(sugg.link)}
                              >
                                {sugg.title} — <span style={{ color: "#697386" }}>{sugg.link}</span>
                              </button>
                            ))}
                          </div>
                        )}
                        <button type="button" className="btn btn-sm" disabled={aiSuggesting} onClick={() => suggestCoachInfo(s)} style={{ marginLeft: 6 }}>
                          {aiSuggesting ? "Looking…" : "Suggest Coach Info (AI)"}
                        </button>
                        {aiSuggestError && <div style={{ fontSize: 12, color: "#b3261e", marginTop: 6 }}>{aiSuggestError}</div>}
                        {aiSuggestInfo && (
                          <div style={{ fontSize: 12, color: "#697386", marginTop: 6 }}>
                            AI suggestion ({aiSuggestInfo.confidence} confidence, from the {aiSuggestInfo.source}) filled into the fields below — review before saving.
                            {aiSuggestInfo.notes ? ` ${aiSuggestInfo.notes}` : ""}
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
            {needsRecheck.length > DISPLAY_CAP && (
              <div style={{ fontSize: 12, color: "#697386", marginTop: 6 }}>
                Showing the oldest {DISPLAY_CAP} of {needsRecheck.length.toLocaleString()} — download the CSV for the full list.
              </div>
            )}
          </>
        )}
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <h3 style={{ marginBottom: 4 }}>Bulk Mark Verified</h3>
        <p style={{ fontSize: 12.5, color: "#697386", marginTop: -2, marginBottom: 10 }}>
          Already confirmed a batch of schools some other way — a trusted external roster, a phone-verified list? Upload a simple list (one school per row: <code>school_id</code> preferred, or{" "}
          <code>school_name</code> + <code>state</code>) and mark them all verified at once. No field changes, no editing — just a confirmation.
        </p>
        {bulkVerifyError && <div className="notice danger" style={{ marginBottom: 10 }}>{bulkVerifyError}</div>}
        <input ref={bulkVerifyInputRef} type="file" accept=".csv" onChange={handleBulkVerifyFile} disabled={bulkVerifyParsing || bulkVerifyApplying} />
        {bulkVerifyParsing && <div className="empty-state" style={{ marginTop: 8 }}>Reading {bulkVerifyFileName}…</div>}

        {bulkVerifyApplyResult && (
          <div className="notice" style={{ marginTop: 10 }}>
            Marked {bulkVerifyApplyResult.count} school{bulkVerifyApplyResult.count === 1 ? "" : "s"} verified.
          </div>
        )}

        {(bulkVerifyMatched.length > 0 || bulkVerifyUnmatched.length > 0) && !bulkVerifyApplyResult && (
          <div style={{ marginTop: 10 }}>
            <div className="grid grid-2" style={{ marginBottom: 10 }}>
              <div className="stat-card">
                <div className="label">Matched</div>
                <div className="num">{bulkVerifyMatched.length}</div>
                <div className="sub">will be marked verified</div>
              </div>
              <div className="stat-card">
                <div className="label">Unmatched rows</div>
                <div className="num">{bulkVerifyUnmatched.length}</div>
                <div className="sub">need school_id or name+state</div>
              </div>
            </div>

            {bulkVerifyApplyError && <div className="notice danger" style={{ marginBottom: 10 }}>{bulkVerifyApplyError}</div>}

            {bulkVerifyUnmatched.length > 0 && (
              <div className="notice danger" style={{ marginBottom: 10 }}>
                <strong>{bulkVerifyUnmatched.length} row(s) could not be matched:</strong>
                <div style={{ maxHeight: 140, overflow: "auto", marginTop: 6 }}>
                  {bulkVerifyUnmatched.slice(0, 50).map((u, i) => (
                    <div key={i} style={{ fontSize: 12, padding: "3px 0" }}>{u.row}: {u.reason}</div>
                  ))}
                  {bulkVerifyUnmatched.length > 50 && <div style={{ fontSize: 12 }}>…and {bulkVerifyUnmatched.length - 50} more.</div>}
                </div>
              </div>
            )}

            {bulkVerifyMatched.length > 0 && (
              <>
                <div style={{ maxHeight: 220, overflow: "auto", marginBottom: 10 }}>
                  {bulkVerifyMatched.slice(0, 100).map((s) => (
                    <div key={s.id} style={{ fontSize: 12.5, padding: "4px 0", borderBottom: "1px solid #eee" }}>
                      <strong>{s.name}</strong> — {s.city}, {s.state}
                    </div>
                  ))}
                  {bulkVerifyMatched.length > 100 && <div style={{ fontSize: 12, color: "#697386", marginTop: 6 }}>…and {bulkVerifyMatched.length - 100} more.</div>}
                </div>
                <button className="btn btn-sm btn-gold" onClick={applyBulkVerify} disabled={bulkVerifyApplying}>
                  {bulkVerifyApplying ? bulkVerifyApplyStatus || "Verifying…" : `Mark ${bulkVerifyMatched.length} School${bulkVerifyMatched.length === 1 ? "" : "s"} Verified`}
                </button>
              </>
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
                    <Link href={`/schools/${flag.school_id}`} className="btn btn-sm" target="_blank" rel="noopener noreferrer">Open Profile</Link>
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
                      <button type="button" className="btn btn-sm" disabled={discoveringAthletics} onClick={() => discoverAthletics(s)} style={{ marginLeft: 6 }}>
                        {discoveringAthletics ? "Searching…" : "Find Athletics page"}
                      </button>
                      {discoverAthleticsError && <div style={{ fontSize: 12, color: "#b3261e", marginTop: 6 }}>{discoverAthleticsError}</div>}
                      {athleticsSuggestions.length > 0 && (
                        <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 4 }}>
                          {athleticsSuggestions.map((sugg) => (
                            <button
                              type="button"
                              key={sugg.link}
                              className="btn btn-sm"
                              style={{ textAlign: "left", justifyContent: "flex-start", whiteSpace: "normal" }}
                              onClick={() => pickAthleticsSuggestion(sugg.link)}
                            >
                              {sugg.title} — <span style={{ color: "#697386" }}>{sugg.link}</span>
                            </button>
                          ))}
                        </div>
                      )}
                      <button type="button" className="btn btn-sm" disabled={aiSuggesting} onClick={() => suggestCoachInfo(s)} style={{ marginLeft: 6 }}>
                        {aiSuggesting ? "Looking…" : "Suggest Coach Info (AI)"}
                      </button>
                      {aiSuggestError && <div style={{ fontSize: 12, color: "#b3261e", marginTop: 6 }}>{aiSuggestError}</div>}
                      {aiSuggestInfo && (
                        <div style={{ fontSize: 12, color: "#697386", marginTop: 6 }}>
                          AI suggestion ({aiSuggestInfo.confidence} confidence, from the {aiSuggestInfo.source}) filled into the fields below — review before saving.
                          {aiSuggestInfo.notes ? ` ${aiSuggestInfo.notes}` : ""}
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

          <div className="filters" style={{ alignItems: "center" }}>
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
            <select value={sortBy} onChange={(e) => setSortBy(e.target.value)} style={{ marginLeft: "auto" }}>
              {SORTS.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.label}
                </option>
              ))}
            </select>
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
            {markVerifiedError && <div className="notice danger" style={{ margin: "8px 0" }}>{markVerifiedError}</div>}
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
                        <Link href={`/schools/${s.id}`} className="btn btn-sm" target="_blank" rel="noopener noreferrer">Open Profile</Link>
                        {!isEditing && (
                          <>
                            <button className="btn btn-sm btn-primary" onClick={() => startEdit(s)}>Quick Fix</button>
                            <button className="btn btn-sm" onClick={() => startCoachChange(s)}>Mark Coach Change</button>
                            <button className="btn btn-sm" disabled={markingVerifiedId === s.id} onClick={() => markVerified(s)}>
                              {markingVerifiedId === s.id ? "Marking…" : "Mark Verified"}
                            </button>
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
                          <button type="button" className="btn btn-sm" disabled={discoveringAthletics} onClick={() => discoverAthletics(s)} style={{ marginLeft: 6 }}>
                            {discoveringAthletics ? "Searching…" : "Find Athletics page"}
                          </button>
                          {discoverAthleticsError && <div style={{ fontSize: 12, color: "#b3261e", marginTop: 6 }}>{discoverAthleticsError}</div>}
                          {athleticsSuggestions.length > 0 && (
                            <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 4 }}>
                              {athleticsSuggestions.map((sugg) => (
                                <button
                                  type="button"
                                  key={sugg.link}
                                  className="btn btn-sm"
                                  style={{ textAlign: "left", justifyContent: "flex-start", whiteSpace: "normal" }}
                                  onClick={() => pickAthleticsSuggestion(sugg.link)}
                                >
                                  {sugg.title} — <span style={{ color: "#697386" }}>{sugg.link}</span>
                                </button>
                              ))}
                            </div>
                          )}
                          <button type="button" className="btn btn-sm" disabled={aiSuggesting} onClick={() => suggestCoachInfo(s)} style={{ marginLeft: 6 }}>
                            {aiSuggesting ? "Looking…" : "Suggest Coach Info (AI)"}
                          </button>
                          {aiSuggestError && <div style={{ fontSize: 12, color: "#b3261e", marginTop: 6 }}>{aiSuggestError}</div>}
                          {aiSuggestInfo && (
                            <div style={{ fontSize: 12, color: "#697386", marginTop: 6 }}>
                              AI suggestion ({aiSuggestInfo.confidence} confidence, from the {aiSuggestInfo.source}) filled into the fields below — review before saving.
                              {aiSuggestInfo.notes ? ` ${aiSuggestInfo.notes}` : ""}
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
