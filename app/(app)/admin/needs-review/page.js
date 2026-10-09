// app/(app)/admin/needs-review/page.js
"use client";

import { useState, useEffect, useCallback, useRef, Suspense } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { useAuth } from "@/lib/auth-context";
import { EDIT_FIELDS, EDIT_LABELS, linkableUrl, staleEmailInfo } from "@/lib/needsReviewEdit";

// Same six states Batch Coach-Info Discovery treats as priority recruiting
// states (kept as a local const there too, so mirroring that here).
const PRIORITY_STATES = ["TX", "FL", "GA", "CA", "OH", "IN"];

// Why a school is in the queue. A school flagged with needs_review = true
// carries a needs_review_note saying why; the two notes this tool writes
// itself are recognized by their wording so they get their own filter.
// Everything else flagged by hand is "flagged"; a school with no flag that
// simply never had its coach fields re-checked is "never".
const REASONS = {
  paste: { label: "Paste-match", color: "#8a4b00", bg: "#fff1de" },
  unchecked: { label: "Unchecked sheet", color: "#a02b8f", bg: "#f9e8f6" },
  flagged: { label: "Flagged", color: "#b3261e", bg: "#fdeeed" },
  never: { label: "Never checked", color: "#697386", bg: "#eef0f3" },
};
const REASON_ORDER = ["paste", "unchecked", "flagged", "never"];

// Most schools one click will queue for an AI web check. Keeps a single run
// (and its search + AI cost) small enough to sanity-check before doing more.
const AI_SEND_CAP = 100;
// How many schools' web sources are fetched at once while a run is being
// prepared (same number Batch Coach-Info uses for its own Fetch Sources).
const AI_FETCH_CONCURRENCY = 8;

// Plain-English status for an AI verification run in the banner.
const RUN_STATUS_TEXT = {
  collecting: "Queued — web sources not fetched yet",
  submitted: "Sent to the AI — results usually arrive within a few hours",
  processing: "The AI is working on it — results usually arrive within a few hours",
  ready: "Finished — results ready to collect",
};

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
// Most rows "Edit all shown" opens at once.
const EDIT_ALL_CAP = 40;
// Rows saved at the same time by "Save all changed".
const SAVE_CONCURRENCY = 3;

// What the AI web check (a Batch Coach-Info run queued from this page, or any
// other run that included the school) found, read against the school's
// current on-file coach -- see lib/needsReviewAi.js. ai_check is null when
// the school has never been in a run.
const AI_FILTERS = {
  ai_matched: { label: "AI matched", test: (s) => !!s.ai_check?.confirmable },
  ai_review: { label: "AI: look closer", test: (s) => !!s.ai_check && ["differs", "name_ok", "no_result"].includes(s.ai_check.status) || (!!s.ai_check && s.ai_check.status === "matches" && !s.ai_check.confirmable) },
  ai_pending: { label: "AI check in progress", test: (s) => s.ai_check?.status === "pending" },
  ai_none: { label: "Not AI-checked", test: (s) => !s.ai_check },
};
const AI_FILTER_ORDER = ["ai_matched", "ai_review", "ai_pending", "ai_none"];

function AiCheckCell({ ai }) {
  if (!ai) return <span style={{ color: "#a2a9b6" }}>—</span>;
  if (ai.status === "pending") {
    return <span style={{ fontSize: 12, color: "#697386" }}>In progress (run #{ai.run_id})</span>;
  }
  if (ai.confirmable) {
    return (
      <span className="badge" style={{ color: "#1e7145", background: "#e9f5ee", fontWeight: 700 }} title={`Same coach and email as on file, high confidence (run #${ai.run_id})`}>
        ✓ AI matched
      </span>
    );
  }
  if (ai.status === "matches") {
    return (
      <span style={{ fontSize: 12, color: "#8a6d3b" }} title={`Run #${ai.run_id}`}>
        Matches on file, but only {ai.confidence || "low"} confidence
      </span>
    );
  }
  if (ai.status === "name_ok") {
    return (
      <span style={{ fontSize: 12, color: "#8a6d3b" }} title={`Run #${ai.run_id}`}>
        Same coach — email {ai.suggestedEmail ? `differs (${ai.suggestedEmail})` : "not confirmed"}
      </span>
    );
  }
  if (ai.status === "differs") {
    return (
      <span style={{ fontSize: 12, color: "#b3261e", fontWeight: 600 }} title={`Run #${ai.run_id}`}>
        AI found a different coach: {ai.suggestedName}
      </span>
    );
  }
  return <span style={{ fontSize: 12, color: "#697386" }}>AI found nothing usable</span>;
}

// The school's own athletics site (falling back to its general website) as a
// new-tab link, so the staff page can be pulled up and the coach's email
// confirmed without leaving the queue.
function SchoolSiteLink({ school }) {
  const ath = linkableUrl(school?.athletics_url);
  const web = ath ? null : linkableUrl(school?.website);
  const href = ath || web;
  if (!href) return <div style={{ color: "#9aa1ab", fontStyle: "italic", fontSize: 11.5 }}>No athletics URL on file</div>;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" title={href} style={{ color: "#0b5fff", fontWeight: 600, fontSize: 12, textDecoration: "underline" }}>
      {ath ? "Athletics site ↗" : "School website ↗ (no athletics URL)"}
    </a>
  );
}

function reasonOf(s) {
  if (!s.flagged_needs_review) return "never";
  const note = s.needs_review_note || "";
  if (/comparing a pasted list/i.test(note)) return "paste";
  if (/unchecked sheet/i.test(note)) return "unchecked";
  return "flagged";
}

function pctColor(pct) {
  if (pct >= 50) return "#1e7145"; // var(--green)
  if (pct >= 20) return "#b8860b"; // var(--amber)
  return "#b3261e"; // var(--red)
}

function CoverageBar({ pct }) {
  return (
    <div style={{ width: "100%", background: "#eef0f3", borderRadius: 999, height: 8 }}>
      <div
        style={{
          width: `${Math.min(pct, 100)}%`,
          background: pctColor(pct),
          height: 8,
          borderRadius: 999,
        }}
      />
    </div>
  );
}

const LAST_STATE_KEY = "needsReviewLastState";

// "123 Main St, Suite 4, Chicago, IL 60601" -- whatever parts are on file.
// Shown under each school name so same-named schools are easy to tell apart.
function schoolAddressLine(s) {
  const cityState = [s.city, [s.state, s.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  return [s.addr1, s.addr2, cityState].filter((x) => x && String(x).trim()).join(", ");
}

function NeedsReviewPageInner() {
  const supabase = getSupabaseBrowserClient();
  const { profile, user } = useAuth();
  const canReview = profile?.role === "verifier" || profile?.role === "sysadmin";
  const searchParams = useSearchParams();
  // Lets State Progress's "Review →" link (on the new Marked Reviewed
  // column) jump straight into this state's queue instead of landing on
  // the state-picker list.
  const stateFromUrl = searchParams.get("state");

  const [states, setStates] = useState([]);
  const [loadingStates, setLoadingStates] = useState(true);
  const [selectedState, setSelectedState] = useState(null);
  const [schools, setSchools] = useState([]);
  const [loadingSchools, setLoadingSchools] = useState(false);
  const [reviewedToday, setReviewedToday] = useState(0);
  const [totalInQueue, setTotalInQueue] = useState(0);
  // "all" | "flagged" (every flagged school) | one of REASON_ORDER
  const [reasonFilter, setReasonFilter] = useState("all");
  // AI web-check actions (see sendToAi / confirmAiMatched below).
  const [aiBusy, setAiBusy] = useState(false);
  const [aiNote, setAiNote] = useState(null); // { kind: "info" | "danger", text, runId? }
  // AI verification runs still in flight for the state on screen (queued,
  // sent, or finished-but-not-collected), plus the live step of whichever run
  // this tab is currently preparing: { runId, step: "fetch" | "submit" | "check" | "collect", done, total }.
  const [aiRuns, setAiRuns] = useState([]);
  const [aiStep, setAiStep] = useState(null);
  const [confirmingId, setConfirmingId] = useState(null);
  // Quick Fix: any number of rows can be open at once. editDrafts is a
  // {schoolId: {field: value, __clearEmail}} map (a row is open exactly when it
  // has an entry); editErrors / rowNotes are per-row messages.
  const [editDrafts, setEditDrafts] = useState({});
  const [editErrors, setEditErrors] = useState({});
  const [rowNotes, setRowNotes] = useState({});
  const [savingIds, setSavingIds] = useState({});
  const [saveAllProgress, setSaveAllProgress] = useState(null); // { done, total }
  const [aiNotesOpen, setAiNotesOpen] = useState({}); // schoolId -> true while "Why?" is open
  const [priorityOnly, setPriorityOnly] = useState(true);
  const [error, setError] = useState("");

  const authedFetch = useCallback(
    async (url, options = {}) => {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      return fetch(url, {
        ...options,
        headers: {
          ...(options.headers || {}),
          Authorization: `Bearer ${session?.access_token}`,
        },
      });
    },
    [supabase]
  );

  const loadStates = useCallback(async () => {
    setLoadingStates(true);
    setError("");
    try {
      const res = await authedFetch("/api/admin/needs-review");
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Could not load state coverage.");
      setStates(json.states || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoadingStates(false);
    }
  }, [authedFetch]);

  useEffect(() => {
    if (canReview) loadStates();
  }, [canReview, loadStates]);

  const loadState = useCallback(
    async (state) => {
      setSelectedState(state);
      // Remember the state this browser last worked in, so coming back to
      // Needs Review later (from the Admin page, a bookmark, a new tab) opens
      // straight into it instead of the state picker. "All states" clears it.
      try {
        window.localStorage.setItem(LAST_STATE_KEY, state);
      } catch {}
      // Keep the state in the address bar, so a reload or the Back button lands
      // right back in this queue instead of the state picker.
      try {
        const u = new URL(window.location.href);
        if (u.searchParams.get("state") !== state) {
          u.searchParams.set("state", state);
          window.history.replaceState(window.history.state, "", u.toString());
        }
      } catch {}
      setReasonFilter("all");
      setAiNote(null);
      setEditDrafts({});
      setEditErrors({});
      setRowNotes({});
      setLoadingSchools(true);
      setError("");
      try {
        const res = await authedFetch(`/api/admin/needs-review?state=${state}`);
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || "Could not load this state's queue.");
        setSchools(json.schools || []);
        // Put back edits that were open and unsaved when the page last went away
        // (accidental reload, browser restart of the tab, etc.).
        try {
          const saved = JSON.parse(window.sessionStorage.getItem(`needsReviewDrafts:${state}`) || "{}");
          const here = new Set((json.schools || []).map((x) => x.id));
          const keep = {};
          Object.keys(saved).forEach((id) => {
            if (here.has(id) || here.has(Number(id))) keep[id] = saved[id];
          });
          if (Object.keys(keep).length) setEditDrafts(keep);
        } catch {}
        setTotalInQueue(json.total_in_queue ?? (json.schools || []).length);
        setReviewedToday(json.reviewed_today || 0);
      } catch (err) {
        setError(err.message);
      } finally {
        setLoadingSchools(false);
      }
    },
    [authedFetch]
  );

  useEffect(() => {
    // Skip when the queue for this state is already on screen (loadState itself
    // writes ?state= into the address bar) -- reloading would wipe open edits.
    if (canReview && stateFromUrl && stateFromUrl.toUpperCase() !== selectedState) loadState(stateFromUrl.toUpperCase());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canReview, stateFromUrl]);

  // No ?state= in the address bar (opened from the Admin page, a bookmark, a
  // new tab): reopen the state worked in last. Runs once per page load, and
  // never after the person has clicked "All states" on purpose (that clears
  // the remembered state).
  const triedLastState = useRef(false);
  useEffect(() => {
    if (!canReview || triedLastState.current) return;
    triedLastState.current = true;
    if (stateFromUrl) return;
    try {
      const last = (window.localStorage.getItem(LAST_STATE_KEY) || "").toUpperCase();
      if (/^[A-Z]{2}$/.test(last)) loadState(last);
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canReview]);

  // Save open edit drafts for this browser tab only, so nothing typed is lost.
  useEffect(() => {
    if (!selectedState || loadingSchools) return;
    try {
      const key = `needsReviewDrafts:${selectedState}`;
      if (Object.keys(editDrafts).length) window.sessionStorage.setItem(key, JSON.stringify(editDrafts));
      else window.sessionStorage.removeItem(key);
    } catch {}
  }, [editDrafts, selectedState, loadingSchools]);

  // A school just left the queue (confirmed, or saved and cleared): drop its
  // row, any open editor, and move the state's counters.
  const dropClearedSchool = (schoolId) => {
    setSchools((prev) => prev.filter((s) => s.id !== schoolId));
    setEditDrafts((prev) => {
      const { [schoolId]: _drop, ...rest } = prev;
      return rest;
    });
    setTotalInQueue((prev) => Math.max(0, prev - 1));
    setReviewedToday((prev) => prev + 1);
    setStates((prev) =>
      prev.map((s) =>
        s.state === selectedState
          ? {
              ...s,
              ever_reviewed: s.ever_reviewed + 1,
              never_reviewed: s.never_reviewed - 1,
              pct_reviewed: ((100 * (s.ever_reviewed + 1)) / s.total_schools).toFixed(1),
            }
          : s
      )
    );
  };

  // aiItemId (optional): confirm because the AI web check matched -- the
  // server re-checks that and logs it as an AI lookup, not a human confirm.
  // Returns true on success so the bulk "Confirm AI-matched" loop can stop
  // on the first failure.
  const confirmAccurate = async (schoolId, aiItemId = null) => {
    setConfirmingId(schoolId);
    setError("");
    try {
      const res = await authedFetch("/api/admin/needs-review/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(aiItemId ? { school_id: schoolId, ai_item_id: aiItemId } : { school_id: schoolId }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Could not save this confirmation.");

      dropClearedSchool(schoolId);
      return true;
    } catch (err) {
      setError(err.message);
      return false;
    } finally {
      setConfirmingId(null);
    }
  };

  // Runs from this tool for the state on screen that haven't been collected
  // yet. Read straight from the table so the banner survives a reload, a
  // closed tab, or a run that was started on another day.
  const loadAiRuns = useCallback(
    async (state) => {
      if (!state) {
        setAiRuns([]);
        return;
      }
      try {
        const { data, error: runsErr } = await supabase
          .from("coach_info_batch_runs")
          .select("id,status,requested_count,fetched_count,created_at")
          .eq("candidate_mode", "re_verify")
          .contains("state_filter", [state])
          .in("status", ["collecting", "submitted", "processing", "ready"])
          .order("id", { ascending: false })
          .limit(8);
        if (runsErr) throw runsErr;
        setAiRuns(data || []);
      } catch (_) {
        setAiRuns([]);
      }
    },
    [supabase]
  );

  useEffect(() => {
    if (canReview && selectedState) loadAiRuns(selectedState);
  }, [canReview, selectedState, loadAiRuns]);

  // Re-reads the queue (so AI check results show up) WITHOUT touching any
  // Quick Fix edits that are open.
  const refreshQueue = async () => {
    if (!selectedState) return;
    const res = await authedFetch(`/api/admin/needs-review?state=${selectedState}`);
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || "Could not refresh the queue.");
    setSchools(json.schools || []);
    setTotalInQueue(json.total_in_queue ?? (json.schools || []).length);
    setReviewedToday(json.reviewed_today || 0);
  };

  // Steps 2 and 3 of the one-click flow: fetch each queued school's web
  // sources, then submit the run to the AI. Safe to run again on a run that
  // stopped part-way -- it only fetches items still pending, and submit only
  // takes a run that hasn't been sent yet.
  const prepareAndSubmitRun = async (runId) => {
    setAiBusy(true);
    setError("");
    try {
      const { data: pending, error: pendErr } = await supabase.from("coach_info_batch_items").select("id").eq("batch_run_id", runId).eq("fetch_status", "pending");
      if (pendErr) throw pendErr;
      const toFetch = pending || [];
      let done = 0;
      setAiStep({ runId, step: "fetch", done: 0, total: toFetch.length });
      await runWithConcurrency(toFetch, AI_FETCH_CONCURRENCY, async (item) => {
        try {
          await authedFetch("/api/admin/batch-coach-info/fetch-item", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ itemId: item.id }),
          });
        } catch (_) {
          // an item that fails here is simply left out of the submit
        }
        done += 1;
        setAiStep({ runId, step: "fetch", done, total: toFetch.length });
      });
      setAiStep({ runId, step: "submit", done: 0, total: 0 });
      const res = await authedFetch(`/api/admin/batch-coach-info/${runId}/submit`, { method: "POST" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Could not submit this run to the AI.");
      setAiNote({
        kind: "info",
        runId,
        text: `Run #${runId} is with the AI: ${json.submitted_count ?? "your"} school${json.submitted_count === 1 ? "" : "s"} submitted. Results usually arrive within a few hours and are collected automatically overnight — or click "Check & collect" in the banner below any time. Then the AI check column fills in and the matches can be confirmed in one click.`,
      });
    } catch (err) {
      setAiNote({ kind: "danger", text: `${err.message || "Could not finish preparing this run."} The run is saved — click "Fetch sources & submit" in the banner to try again.` });
    } finally {
      setAiStep(null);
      setAiBusy(false);
      loadAiRuns(selectedState);
    }
  };

  // One button for a run that's already with the AI: ask whether it's done,
  // and if it is, collect the results and refresh the queue.
  const checkAndCollectRun = async (runId) => {
    setAiBusy(true);
    setAiNote(null);
    setError("");
    try {
      setAiStep({ runId, step: "check", done: 0, total: 0 });
      const res = await authedFetch(`/api/admin/batch-coach-info/${runId}/check-status`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Could not check this run.");
      if (json.processing_status !== "ended") {
        const counts = json.request_counts;
        const left = counts && typeof counts.processing === "number" ? ` (${counts.processing} still being worked on)` : "";
        setAiNote({ kind: "info", text: `Run #${runId} isn't finished yet${left}. Check again in a little while — it's also collected automatically overnight.` });
        return;
      }
      setAiStep({ runId, step: "collect", done: 0, total: 0 });
      const cRes = await authedFetch(`/api/admin/batch-coach-info/${runId}/collect`, { method: "POST" });
      const cJson = await cRes.json().catch(() => ({}));
      if (!cRes.ok) throw new Error(cJson.error || "Could not collect this run's results.");
      await refreshQueue();
      setAiNote({
        kind: "info",
        text: `Run #${runId} collected: ${cJson.succeeded ?? 0} result${cJson.succeeded === 1 ? "" : "s"}${cJson.failed ? `, ${cJson.failed} with no answer` : ""}. The AI check column is updated — use the "AI matched" filter and "Confirm AI-matched" for the easy ones, and Quick Fix for the rest.`,
      });
    } catch (err) {
      setAiNote({ kind: "danger", text: err.message || "Could not check this run." });
    } finally {
      setAiStep(null);
      setAiBusy(false);
      loadAiRuns(selectedState);
    }
  };

  // Queues the given schools into a new Batch Coach-Info Discovery run
  // (candidate_mode "re_verify": the open, identity-confirming search, so a
  // coach who has since been replaced gets found rather than re-confirmed).
  // Same insert Import & Reconcile and the Batch Coach-Info page itself use.
  // Then carries straight on (prepareAndSubmitRun): web sources fetched for
  // each school, the run submitted to the AI batch. Schools already queued or
  // checked are skipped by the caller.
  const sendToAi = async (list) => {
    const picked = list.slice(0, AI_SEND_CAP);
    if (!picked.length || !user) return;
    setAiBusy(true);
    setAiNote(null);
    setError("");
    try {
      const { data: runRow, error: runErr } = await supabase
        .from("coach_info_batch_runs")
        .insert({ status: "collecting", state_filter: [selectedState], requested_count: picked.length, created_by: user.id, candidate_mode: "re_verify" })
        .select()
        .single();
      if (runErr) throw runErr;
      for (let i = 0; i < picked.length; i += 200) {
        const rows = picked.slice(i, i + 200).map((s) => ({ batch_run_id: runRow.id, school_id: s.id }));
        const { error: itemsErr } = await supabase.from("coach_info_batch_items").insert(rows);
        if (itemsErr) throw itemsErr;
      }
      const queued = new Set(picked.map((s) => s.id));
      setSchools((prev) => prev.map((s) => (queued.has(s.id) ? { ...s, ai_check: { status: "pending", run_id: runRow.id, run_status: "collecting", confirmable: false } } : s)));
      // Straight on to the web search + submit -- the old flow stopped here
      // and made you finish on the Batch Coach-Info page.
      setAiBusy(false);
      await prepareAndSubmitRun(runRow.id);
      return;
    } catch (err) {
      setAiNote({ kind: "danger", text: err.message || "Could not queue these schools." });
    }
    setAiBusy(false);
  };

  // Confirms every school in the list whose AI check matched the on-file
  // coach and email at high confidence. One at a time (each call is
  // re-verified on the server) and stops at the first failure.
  const confirmAiMatched = async (list) => {
    if (!list.length) return;
    setAiBusy(true);
    setAiNote(null);
    let done = 0;
    for (const s of list) {
      // eslint-disable-next-line no-await-in-loop
      const ok = await confirmAccurate(s.id, s.ai_check.item_id);
      if (!ok) break;
      done += 1;
    }
    setAiNote({ kind: done === list.length ? "info" : "danger", text: `Confirmed ${done} of ${list.length} AI-matched school${list.length === 1 ? "" : "s"}.${done < list.length ? " Stopped at the first error shown above." : ""}` });
    setAiBusy(false);
  };

  // ---- Quick Fix (multi-row) -------------------------------------------
  // Opens with each field showing what's on file, EXCEPT an email that still
  // looks like the previous coach's: that one starts empty (the on-file value
  // stays visible as the placeholder) so a stale address isn't carried
  // forward by habit.
  const draftFromSchool = (s) => {
    const draft = {};
    EDIT_FIELDS.forEach((f) => {
      draft[f] = (s[f] || "").toString();
    });
    if (staleEmailInfo(s)) draft.hc_email = "";
    return draft;
  };
  const isEditing = (s) => Object.prototype.hasOwnProperty.call(editDrafts, s.id);
  // "Changed" = a field, or the remove-email box, differs from how the editor
  // opened. Save all only writes changed rows, so opening 40 editors and
  // pressing Save all can't quietly confirm 40 schools nobody looked at.
  const isDirty = (s) => {
    const d = editDrafts[s.id];
    if (!d) return false;
    if (d.__clearEmail) return true;
    const base = draftFromSchool(s);
    return EDIT_FIELDS.some((f) => (d[f] || "").trim() !== (base[f] || "").trim());
  };
  const toggleEdit = (s) => {
    if (isEditing(s)) {
      closeEdit(s.id);
      return;
    }
    setEditDrafts((prev) => ({ ...prev, [s.id]: draftFromSchool(s) }));
    setEditErrors((prev) => {
      const { [s.id]: _drop, ...rest } = prev;
      return rest;
    });
  };
  const closeEdit = (id) => {
    setEditDrafts((prev) => {
      const { [id]: _drop, ...rest } = prev;
      return rest;
    });
    setEditErrors((prev) => {
      const { [id]: _drop, ...rest } = prev;
      return rest;
    });
  };
  const updateDraft = (id, field, value) => setEditDrafts((prev) => ({ ...prev, [id]: { ...(prev[id] || {}), [field]: value } }));
  // What the AI web check found that differs from what's on file, as
  // [{field, value, estimated}] -- the fields Quick Fix can fill in one click.
  const aiFindings = (s) => {
    const sg = s.ai_suggestion;
    if (!sg) return [];
    return EDIT_FIELDS.filter((f) => (sg[f] || "").trim() && (sg[f] || "").trim() !== (s[f] || "").trim()).map((f) => ({
      field: f,
      value: sg[f].trim(),
      estimated: f === "hc_email" && sg.hc_email_estimated,
    }));
  };
  const useAiField = (s, field) => {
    const f = aiFindings(s).find((x) => x.field === field);
    if (!f) return;
    // A different email than what the draft started with is also no longer the
    // "remove the old email" case, so untick that.
    setEditDrafts((prev) => ({ ...prev, [s.id]: { ...(prev[s.id] || {}), [field]: f.value, ...(field === "hc_email" ? { __clearEmail: false } : {}) } }));
  };
  // Fills every AI finding except a pattern-guessed email, which has to be
  // chosen on its own.
  const useAiAll = (s) => {
    const list = aiFindings(s).filter((x) => !x.estimated);
    if (!list.length) return;
    setEditDrafts((prev) => {
      const next = { ...(prev[s.id] || {}) };
      list.forEach((x) => {
        next[x.field] = x.value;
        if (x.field === "hc_email") next.__clearEmail = false;
      });
      return { ...prev, [s.id]: next };
    });
  };
  const openEditAllShown = () => {
    const targets = shownSchools.slice(0, EDIT_ALL_CAP);
    setEditDrafts((prev) => {
      const next = { ...prev };
      targets.forEach((s) => {
        if (!Object.prototype.hasOwnProperty.call(next, s.id)) next[s.id] = draftFromSchool(s);
      });
      return next;
    });
  };
  const closeAllEdits = () => {
    setEditDrafts({});
    setEditErrors({});
  };

  // Saves one school through /api/admin/needs-review/save. A save that
  // clears the school drops it from the queue; one the server holds back
  // (a previous coach's email still on the record, a changed coach with no
  // confirmed email, an email removed with nothing replacing it) is saved,
  // stays in the queue still flagged, and shows why.
  const saveRow = async (s) => {
    const d = editDrafts[s.id] || {};
    setSavingIds((prev) => ({ ...prev, [s.id]: true }));
    setEditErrors((prev) => {
      const { [s.id]: _drop, ...rest } = prev;
      return rest;
    });
    try {
      const fields = {};
      EDIT_FIELDS.forEach((f) => {
        const v = (d[f] || "").trim();
        if (v) fields[f] = v;
      });
      const res = await authedFetch("/api/admin/needs-review/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ school_id: s.id, fields, clear_email: Boolean(d.__clearEmail) }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Could not save this school.");
      if (json.cleared) {
        dropClearedSchool(s.id);
        return true;
      }
      setSchools((prev) => prev.map((x) => (x.id === s.id ? { ...x, ...json.school, flagged_needs_review: true, needs_review_note: x.flagged_needs_review ? x.needs_review_note : json.reason } : x)));
      setRowNotes((prev) => ({ ...prev, [s.id]: `Saved, but still flagged: ${json.reason}` }));
      closeEdit(s.id);
      return true;
    } catch (err) {
      setEditErrors((prev) => ({ ...prev, [s.id]: err.message || "Could not save this school." }));
      return false;
    } finally {
      setSavingIds((prev) => {
        const { [s.id]: _drop, ...rest } = prev;
        return rest;
      });
    }
  };

  const saveAllChanged = async () => {
    const targets = shownSchools.filter((s) => isEditing(s) && isDirty(s));
    if (!targets.length) return;
    setError("");
    setSaveAllProgress({ done: 0, total: targets.length });
    let done = 0;
    let failed = 0;
    let next = 0;
    const worker = async () => {
      while (next < targets.length) {
        const s = targets[next];
        next += 1;
        // eslint-disable-next-line no-await-in-loop
        const ok = await saveRow(s);
        if (!ok) failed += 1;
        done += 1;
        setSaveAllProgress({ done, total: targets.length });
      }
    };
    await Promise.all(Array.from({ length: Math.min(SAVE_CONCURRENCY, targets.length) }, worker));
    setSaveAllProgress(null);
    if (failed > 0) setError(`Saved ${targets.length - failed} of ${targets.length} edited schools. The ${failed} that failed are still open with their error.`);
  };

  if (!canReview) {
    return (
      <div className="view">
        <div className="notice danger">The Needs Review queue is limited to Verification Staff and System Admins.</div>
      </div>
    );
  }

  const visibleStates = priorityOnly ? states.filter((s) => PRIORITY_STATES.includes(s.state)) : states;
  // Live "how many are left" counters -- the whole point of a queue is
  // knowing when you're done with it, not just what % complete it is.
  const totalRemaining = visibleStates.reduce((sum, s) => sum + (s.never_reviewed || 0), 0);
  const selectedStateSummary = selectedState ? states.find((s) => s.state === selectedState) : null;
  const remainingInSelectedState = selectedStateSummary ? selectedStateSummary.never_reviewed : schools.length;
  // Per-reason counts and the filtered list for the queue table.
  const reasonCounts = { paste: 0, unchecked: 0, flagged: 0, never: 0 };
  schools.forEach((s) => {
    reasonCounts[reasonOf(s)] += 1;
  });
  const flaggedCount = reasonCounts.paste + reasonCounts.unchecked + reasonCounts.flagged;
  const aiCounts = {};
  AI_FILTER_ORDER.forEach((k) => {
    aiCounts[k] = schools.filter(AI_FILTERS[k].test).length;
  });
  const shownSchools = schools.filter((s) => {
    if (reasonFilter === "all") return true;
    if (reasonFilter === "flagged") return reasonOf(s) !== "never";
    if (AI_FILTERS[reasonFilter]) return AI_FILTERS[reasonFilter].test(s);
    return reasonOf(s) === reasonFilter;
  });
  // What the two AI buttons act on: whatever the current filter is showing.
  const aiSendable = shownSchools.filter((s) => !s.ai_check);
  const aiConfirmable = shownSchools.filter((s) => s.ai_check?.confirmable);
  const openEditCount = shownSchools.filter(isEditing).length;
  const dirtyEditCount = shownSchools.filter((s) => isEditing(s) && isDirty(s)).length;

  return (
    <div className="view">
      <Link href="/admin" className="btn btn-sm" style={{ marginBottom: 12, display: "inline-flex" }}>
        ← Back to Admin
      </Link>
      <div className="view-header">
        <div>
          <h1>Needs Review</h1>
          <p>
            Schools that need a second look, by state: ones someone flagged for review (with the reason shown) come first, then schools whose
            coach name, email, cell, or office phone has never been specifically re-checked since import.
          </p>
        </div>
      </div>

      {error && (
        <div className="notice danger" style={{ marginBottom: 14 }}>
          {error}
        </div>
      )}

      {!selectedState && (
        <div className="card" style={{ marginBottom: 14 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
            <h3 style={{ margin: 0 }}>Coverage by state</h3>
            <label style={{ fontSize: 13, display: "flex", gap: 6, alignItems: "center" }}>
              <input type="checkbox" checked={priorityOnly} onChange={(e) => setPriorityOnly(e.target.checked)} />
              Priority recruiting states only ({PRIORITY_STATES.join(", ")})
            </label>
          </div>

          {!loadingStates && visibleStates.length > 0 && (
            <div style={{ fontSize: 12.5, color: "#697386", marginTop: 8 }}>
              <strong style={{ color: totalRemaining > 0 ? "#b3261e" : "#1e7145" }}>{totalRemaining.toLocaleString()}</strong>{" "}
              {totalRemaining === 1 ? "school" : "schools"} still left to verify{priorityOnly ? " across the priority states" : ""}.
            </div>
          )}

          {loadingStates ? (
            <div className="empty-state">Loading…</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 10 }}>
              {visibleStates.map((s) => (
                <div
                  key={s.state}
                  onClick={() => loadState(s.state)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 14,
                    padding: "9px 10px",
                    border: "1px solid #e3e6ea",
                    borderRadius: 8,
                    cursor: "pointer",
                  }}
                >
                  <span style={{ width: 34, fontWeight: 700 }}>{s.state}</span>
                  <span style={{ width: 150, fontSize: 12.5, color: "#697386" }}>
                    {s.ever_reviewed}/{s.total_schools} checked
                    {s.never_reviewed > 0 && <span style={{ color: "#b3261e", fontWeight: 600 }}> · {s.never_reviewed} left</span>}
                  </span>
                  <span style={{ flex: 1 }}>
                    <CoverageBar pct={parseFloat(s.pct_reviewed)} />
                  </span>
                  <span style={{ width: 54, textAlign: "right", fontSize: 12.5, fontWeight: 700 }}>
                    {s.pct_reviewed}%
                  </span>
                  {s.is_priority_state && (
                    <span className="badge" style={{ color: "#1c5fb3", background: "#e7effc" }}>
                      ICP
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {selectedState && (
        <div className="card" style={{ marginBottom: 14 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, flexWrap: "wrap", gap: 8 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <h3 style={{ margin: 0 }}>{selectedState} — review queue</h3>
              {!loadingSchools && (
                <span
                  className="badge"
                  style={{
                    color: remainingInSelectedState > 0 ? "#b3261e" : "#1e7145",
                    background: remainingInSelectedState > 0 ? "#fdeeed" : "#e9f5ee",
                    fontWeight: 700,
                  }}
                >
                  {remainingInSelectedState} left to verify
                </span>
              )}
              {!loadingSchools && reviewedToday > 0 && (
                <span className="badge" style={{ color: "#1e7145", background: "#e9f5ee", fontWeight: 700 }}>
                  ✓ {reviewedToday} confirmed today
                </span>
              )}
            </div>
            <button className="btn btn-sm" onClick={() => { setSelectedState(null); try { window.localStorage.removeItem(LAST_STATE_KEY); } catch {} try { window.history.replaceState(window.history.state, "", window.location.pathname); } catch {} }}>
              ← All states
            </button>
          </div>

          {loadingSchools ? (
            <div className="empty-state">Loading…</div>
          ) : schools.length === 0 ? (
            <div className="empty-state">
              Nothing left to check in {selectedState} — nice.
              {reviewedToday > 0 && (
                <div style={{ marginTop: 6, fontSize: 12.5, color: "#1e7145", fontWeight: 600 }}>✓ {reviewedToday} confirmed today.</div>
              )}
            </div>
          ) : (
            <>
            {totalInQueue > schools.length && (
              <div className="notice danger" style={{ marginBottom: 10, fontSize: 12.5 }}>
                Showing the first {schools.length.toLocaleString()} of {totalInQueue.toLocaleString()} schools in this state&apos;s queue (flagged ones first). Confirm some and reload to
                bring the rest up.
              </div>
            )}
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10, alignItems: "center" }}>
              <button className={`btn btn-sm ${reasonFilter === "all" ? "btn-gold" : ""}`} onClick={() => setReasonFilter("all")}>
                All ({schools.length})
              </button>
              {flaggedCount > 0 && (
                <button className={`btn btn-sm ${reasonFilter === "flagged" ? "btn-gold" : ""}`} onClick={() => setReasonFilter("flagged")}>
                  All flagged ({flaggedCount})
                </button>
              )}
              {REASON_ORDER.filter((r) => reasonCounts[r] > 0).map((r) => (
                <button key={r} className={`btn btn-sm ${reasonFilter === r ? "btn-gold" : ""}`} onClick={() => setReasonFilter(r)}>
                  {REASONS[r].label} ({reasonCounts[r]})
                </button>
              ))}
              {AI_FILTER_ORDER.filter((k) => aiCounts[k] > 0 && (k !== "ai_none" || aiCounts[k] < schools.length)).map((k) => (
                <button key={k} className={`btn btn-sm ${reasonFilter === k ? "btn-gold" : ""}`} onClick={() => setReasonFilter(k)}>
                  {AI_FILTERS[k].label} ({aiCounts[k]})
                </button>
              ))}
              {reasonFilter !== "all" && (
                <span style={{ fontSize: 12, color: "#697386" }}>
                  Showing {shownSchools.length} of {schools.length}
                </span>
              )}
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10, alignItems: "center" }}>
              <button
                className="btn btn-sm"
                disabled={aiBusy || aiSendable.length === 0}
                onClick={() => sendToAi(aiSendable)}
                title="One click: queues these schools, searches the web for each one's current head coach, and submits them to the AI. Keep this tab open for a couple of minutes while the searches run. Searches and AI time are charged."
              >
                {aiStep?.step === "fetch"
                  ? `Searching the web… ${aiStep.done} of ${aiStep.total}`
                  : aiStep?.step === "submit"
                  ? "Sending to the AI…"
                  : aiBusy
                  ? "Working…"
                  : `Send ${Math.min(aiSendable.length, AI_SEND_CAP)}${aiSendable.length > AI_SEND_CAP ? ` of ${aiSendable.length}` : ""} to AI verification`}
              </button>
              <button
                className="btn btn-sm"
                style={aiConfirmable.length ? { background: "#1e7145", color: "#fff", borderColor: "#1e7145" } : undefined}
                disabled={aiBusy || aiConfirmable.length === 0}
                onClick={() => confirmAiMatched(aiConfirmable)}
                title="Confirms the schools whose AI web check found the same coach and email as on file, at high confidence. Logged as an AI lookup."
              >
                {`Confirm ${aiConfirmable.length} AI-matched`}
              </button>
              <Link href="/admin/batch-coach-info" className="btn btn-sm">
                Open Batch Coach-Info →
              </Link>
            </div>
            {aiNote && (
              <div className={`notice ${aiNote.kind === "danger" ? "danger" : "info"}`} style={{ marginBottom: 10, fontSize: 12.5 }}>
                {aiNote.text}
              </div>
            )}
            {aiRuns.length > 0 && (
              <div style={{ marginBottom: 10, padding: "8px 10px", border: "1px solid #d7e3f3", background: "#f6f9fd", borderRadius: 8, fontSize: 12.5 }}>
                <div style={{ fontWeight: 600, marginBottom: 4 }}>AI verification runs in progress</div>
                {aiRuns.map((r) => {
                  const mine = aiStep && aiStep.runId === r.id;
                  return (
                    <div key={r.id} style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", padding: "3px 0" }}>
                      <span>
                        <strong>Run #{r.id}</strong> · {r.requested_count} school{r.requested_count === 1 ? "" : "s"} · {RUN_STATUS_TEXT[r.status] || r.status}
                      </span>
                      {r.status === "collecting" ? (
                        <button className="btn btn-sm" disabled={aiBusy} onClick={() => prepareAndSubmitRun(r.id)}>
                          {mine && aiStep.step === "fetch" ? `Searching… ${aiStep.done} of ${aiStep.total}` : mine ? "Sending…" : "Fetch sources & submit"}
                        </button>
                      ) : (
                        <button className="btn btn-sm" disabled={aiBusy} onClick={() => checkAndCollectRun(r.id)}>
                          {mine && aiStep.step === "check" ? "Checking…" : mine && aiStep.step === "collect" ? "Collecting…" : "Check & collect"}
                        </button>
                      )}
                    </div>
                  );
                })}
                <div style={{ color: "#697386", fontSize: 11.5, marginTop: 2 }}>Anything the AI finishes is also collected automatically overnight; results then show in the AI check column.</div>
              </div>
            )}
            <div
              style={{
                position: "sticky",
                top: 0,
                zIndex: 5,
                display: "flex",
                alignItems: "center",
                flexWrap: "wrap",
                gap: 8,
                marginBottom: 8,
                padding: "8px 10px",
                background: openEditCount > 0 ? "#eef4fb" : "#f8fafc",
                border: `1px solid ${openEditCount > 0 ? "#cfe0f2" : "#e3e6ea"}`,
                borderRadius: 8,
                fontSize: 12.5,
              }}
            >
              <button className="btn btn-sm" disabled={shownSchools.length === 0 || !!saveAllProgress} onClick={openEditAllShown}>
                Edit all shown ({Math.min(shownSchools.length, EDIT_ALL_CAP)})
              </button>
              {openEditCount > 0 ? (
                <>
                  <span>
                    <strong>{openEditCount}</strong> open · <strong>{dirtyEditCount}</strong> changed
                  </span>
                  <button className="btn btn-gold btn-sm" disabled={!!saveAllProgress || dirtyEditCount === 0} onClick={saveAllChanged}>
                    {saveAllProgress ? `Saving ${saveAllProgress.done} of ${saveAllProgress.total}…` : `Save all changed (${dirtyEditCount})`}
                  </button>
                  <button className="btn btn-sm" disabled={!!saveAllProgress} onClick={closeAllEdits}>
                    Close all
                  </button>
                  <span style={{ color: "#9aa1ab", fontSize: 11.5 }}>
                    A save counts as your review: the school is marked verified and leaves the queue, unless its email still looks like the previous coach&apos;s. Save all only writes rows you changed.
                  </span>
                </>
              ) : (
                <span style={{ color: "#9aa1ab", fontSize: 11.5 }}>Open Quick Fix on several schools, check each on its athletics site, then save them all at once.</span>
              )}
            </div>
            <table>
              <thead>
                <tr>
                  <th>School</th>
                  <th>Coach</th>
                  <th>Email</th>
                  <th>Cell</th>
                  <th>Office</th>
                  <th>Status</th>
                  <th>AI check</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {shownSchools.map((s) => {
                  const stale = staleEmailInfo(s);
                  const findings = aiFindings(s);
                  const draft = editDrafts[s.id] || {};
                  const editing = isEditing(s);
                  const saving = !!savingIds[s.id];
                  return [
                  <tr key={s.id}>
                    <td>
                      <Link href={`/schools/${s.id}`} target="_blank" rel="noopener noreferrer" title="Opens in a new tab so this queue stays open">{s.name}</Link>
                      <div style={{ fontSize: 11.5, color: "#697386" }}>{schoolAddressLine(s)}</div>
                      <div style={{ marginTop: 3 }}>
                        <SchoolSiteLink school={s} />
                      </div>
                      {s.flagged_needs_review && s.needs_review_note && (
                        <div style={{ fontSize: 11.5, color: "#8a6d3b", fontStyle: "italic", marginTop: 2, maxWidth: 340 }}>{s.needs_review_note}</div>
                      )}
                    </td>
                    <td>
                      {s.hc_first_name || s.hc_last_name ? (
                        `${s.hc_first_name ?? ""} ${s.hc_last_name ?? ""}`.trim()
                      ) : (
                        <span style={{ color: "#a2a9b6" }}>—</span>
                      )}
                    </td>
                    <td>
                      {s.hc_email || <span style={{ color: "#a2a9b6" }}>—</span>}
                      {stale && (
                        <div style={{ fontSize: 11.5, color: "#b3261e", fontWeight: 600, maxWidth: 220 }}>⚠ Looks like the previous coach&apos;s email ({stale.priorLast})</div>
                      )}
                      {findings.find((x) => x.field === "hc_email") && (
                        <div style={{ fontSize: 11.5, color: "#1e7145", maxWidth: 220, wordBreak: "break-all" }}>
                          AI found: {findings.find((x) => x.field === "hc_email").value}
                          {findings.find((x) => x.field === "hc_email").estimated ? " (guess)" : ""}
                        </div>
                      )}
                    </td>
                    <td>{s.hc_cell || <span style={{ color: "#a2a9b6" }}>—</span>}</td>
                    <td>{s.hc_office || <span style={{ color: "#a2a9b6" }}>—</span>}</td>
                    <td>
                      {/* Every row here is guaranteed never_reviewed=true -- the API now
                          filters out anything already confirmed, so this queue only ever
                          shows what's actually still outstanding. */}
                      <span className="badge" style={{ color: REASONS[reasonOf(s)].color, background: REASONS[reasonOf(s)].bg }}>
                        {REASONS[reasonOf(s)].label}
                      </span>
                    </td>
                    <td>
                      <AiCheckCell ai={s.ai_check} />
                    </td>
                    <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                      <button
                        className="btn btn-sm"
                        style={editing ? { background: "#0b5fff", borderColor: "#0b5fff", color: "#fff", marginRight: 6 } : { marginRight: 6 }}
                        onClick={() => toggleEdit(s)}
                        disabled={saving || !!saveAllProgress}
                        title="Fix the coach name, email or phones right here, then save"
                      >
                        {editing ? "Editing…" : "Edit"}
                      </button>
                      <button
                        className="btn btn-sm"
                        style={{ background: "#1e7145", color: "#fff", borderColor: "#1e7145" }}
                        onClick={() => confirmAccurate(s.id)}
                        disabled={confirmingId === s.id || saving}
                        title={stale ? "The email on file still looks like the previous coach's — open Edit to fix it first" : undefined}
                      >
                        {confirmingId === s.id ? "Saving…" : "Confirmed accurate"}
                      </button>
                    </td>
                  </tr>,
                  rowNotes[s.id] && !editing && (
                    <tr key={`note-${s.id}`}>
                      <td colSpan={8} style={{ fontSize: 12, color: "#8a6d3b", paddingTop: 0 }}>
                        {rowNotes[s.id]}
                      </td>
                    </tr>
                  ),
                  editing && (
                    <tr key={`edit-${s.id}`} style={{ background: "#f8fafc" }}>
                      <td colSpan={8} style={{ padding: "10px 8px 14px" }}>
                        <div style={{ fontSize: 11.5, fontWeight: 600, color: "#697386", marginBottom: 8, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                          <span>Quick Fix — {s.name}</span>
                          <SchoolSiteLink school={s} />
                        </div>
                        {s.ai_suggestion && (
                          <div style={{ marginBottom: 10, padding: "8px 10px", background: "#f0f7f2", border: "1px solid #cfe6d7", borderRadius: 8, fontSize: 12.5 }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: findings.length ? 6 : 0 }}>
                              <strong style={{ color: "#1e7145" }}>AI web check</strong>
                              <span style={{ color: "#697386", fontSize: 11.5 }}>
                                run #{s.ai_suggestion.run_id}
                                {s.ai_suggestion.mode ? ` (${String(s.ai_suggestion.mode).replace(/_/g, " ")})` : ""}
                                {s.ai_suggestion.confidence ? ` · ${s.ai_suggestion.confidence} confidence` : ""}
                              </span>
                              {findings.length === 0 && <span style={{ color: "#697386" }}>— found nothing different from what's on file.</span>}
                              {findings.some((x) => !x.estimated) && (
                                <button className="btn btn-sm" onClick={() => useAiAll(s)} style={{ marginLeft: "auto" }}>
                                  Use all
                                </button>
                              )}
                            </div>
                            {findings.map((x) => {
                              const filled = (draft[x.field] || "").trim() === x.value;
                              return (
                                <div key={x.field} style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", padding: "2px 0" }}>
                                  <span style={{ width: 90, color: "#697386" }}>{EDIT_LABELS[x.field]}</span>
                                  <span style={{ fontWeight: 600, wordBreak: "break-all" }}>{x.value}</span>
                                  {s[x.field] ? <span style={{ color: "#9aa1ab" }}>(on file: {s[x.field]})</span> : null}
                                  {x.estimated && <span style={{ color: "#8a6100", fontWeight: 600 }}>pattern-estimated, never seen on a page</span>}
                                  {filled ? (
                                    <span style={{ color: "#1e7145", fontWeight: 600 }}>✓ filled in</span>
                                  ) : (
                                    <button className="btn btn-sm" onClick={() => useAiField(s, x.field)}>
                                      Use this
                                    </button>
                                  )}
                                </div>
                              );
                            })}
                            {s.ai_suggestion.notes && (
                              <div style={{ marginTop: 4 }}>
                                <button
                                  type="button"
                                  onClick={() => setAiNotesOpen((prev) => ({ ...prev, [s.id]: !prev[s.id] }))}
                                  style={{ background: "none", border: "none", padding: 0, color: "#5b7fb5", fontSize: 11.5, cursor: "pointer", textDecoration: "underline" }}
                                >
                                  {aiNotesOpen[s.id] ? "Hide reasoning" : "Why?"}
                                </button>
                                {aiNotesOpen[s.id] && <div style={{ marginTop: 2, fontStyle: "italic", color: "#697386" }}>&ldquo;{s.ai_suggestion.notes}&rdquo;{s.ai_suggestion.source ? ` — ${s.ai_suggestion.source}` : ""}</div>}
                              </div>
                            )}
                          </div>
                        )}
                        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))", gap: 8 }}>
                          {EDIT_FIELDS.map((f) => (
                            <label key={f} style={{ fontSize: 11.5, color: "#697386" }}>
                              {EDIT_LABELS[f]}
                              <input
                                value={draft[f] || ""}
                                onChange={(e) => updateDraft(s.id, f, e.target.value)}
                                style={{ width: "100%", marginTop: 2, fontSize: 12.5 }}
                                placeholder={s[f] || ""}
                              />
                            </label>
                          ))}
                        </div>
                        {stale && (
                          <label style={{ display: "block", marginTop: 8, fontSize: 12, color: "#8a6100" }}>
                            <input type="checkbox" checked={Boolean(draft.__clearEmail)} onChange={(e) => updateDraft(s.id, "__clearEmail", e.target.checked)} style={{ marginRight: 6 }} />
                            Remove the previous coach&apos;s email ({s.hc_email}) — it contains {stale.priorLast}. Type the current coach&apos;s email in the Email box to replace it, or tick this to clear it.
                          </label>
                        )}
                        {editErrors[s.id] && (
                          <div className="notice danger" style={{ marginTop: 8, fontSize: 12.5 }}>
                            {editErrors[s.id]}
                          </div>
                        )}
                        <div style={{ display: "flex", gap: 6, marginTop: 10, alignItems: "center", flexWrap: "wrap" }}>
                          <button className="btn btn-gold btn-sm" disabled={saving || !!saveAllProgress} onClick={() => saveRow(s)}>
                            {saving ? "Saving…" : "Save & confirm this row"}
                          </button>
                          <button className="btn btn-sm" disabled={saving || !!saveAllProgress} onClick={() => closeEdit(s.id)}>
                            Cancel
                          </button>
                          <span style={{ fontSize: 11, color: "#9aa1ab" }}>Blank fields are left as they are.</span>
                        </div>
                      </td>
                    </tr>
                  ),
                  ];
                })}
              </tbody>
            </table>
            {shownSchools.length === 0 && <div className="empty-state">No schools match this filter.</div>}
            </>
          )}

          {/* Repeats the counter after the table too, so it's visible without
              scrolling back up once the list runs longer than one screen. */}
          {!loadingSchools && schools.length > 0 && (
            <div style={{ marginTop: 10, fontSize: 12.5, color: "#697386" }}>
              <strong style={{ color: "#b3261e" }}>{remainingInSelectedState}</strong> left to verify in {selectedState}
              {reviewedToday > 0 && (
                <>
                  {" "}
                  · <strong style={{ color: "#1e7145" }}>✓ {reviewedToday}</strong> confirmed today
                </>
              )}
              .
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function NeedsReviewPage() {
  return (
    <Suspense fallback={<div className="view"><div className="empty-state">Loading…</div></div>}>
      <NeedsReviewPageInner />
    </Suspense>
  );
}
