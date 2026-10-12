"use client";
import { Fragment, useState, useEffect, useCallback, useMemo, useRef } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { useAuth } from "@/lib/auth-context";
import { NEEDS_REVIEW_CLEAR_FIELDS } from "@/lib/needsReview";
import { EDIT_FIELDS, EDIT_LABELS, isValidEmail, linkableUrl } from "@/lib/needsReviewEdit";

// Most rows that can be opened for editing at once ("Edit all shown").
const EDIT_ALL_CAP = 40;
// Rows saved at the same time by "Save all changed".
const SAVE_CONCURRENCY = 5;

// The open editors, what's typed in them, the filters, and which school you
// were last working on are kept in this browser (localStorage), so leaving the
// page -- following a school link, a browser reload, a tab the browser put to
// sleep -- and coming back puts you on the same screen with nothing lost.
// A draft for a school that's no longer on the list (it was saved) is dropped.
const SAVED_STATE_KEY = "csdDeadEmailRecovery:v1";
const AI_FILTERS = ["all", "different", "same", "none"];
function readSavedState() {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(SAVED_STATE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}
function mergeSavedState(patch) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(SAVED_STATE_KEY, JSON.stringify({ ...(readSavedState() || {}), ...patch }));
  } catch (_) {
    /* storage full or blocked -- the page just won't remember */
  }
}

// Dead Email Recovery -- built alongside the needs_review-clearing fix
// (lib/needsReview.js) after Larry asked which of Run #34's 110
// bounce-recovery schools still needed attention (see
// claude/batch-exclusion-row-cap-bug-fix.md, Part 5 and Part 6). That
// investigation found 21 schools whose coach's NAME had been corrected but
// whose email was still the exact address already confirmed dead -- and
// that Coach-Info's own "touched by any past run, any mode" exclusion
// permanently locks a school out of ever getting a second automated AI
// attempt once it's gone through the tool once.
//
// This page is the durable home for that problem, not a one-off list:
// dead_email_schools (Postgres view, see the migration) surfaces every
// open school whose CURRENT hc_email still matches its most recent hard
// bounce, whether or not it's ever been through Coach-Info before -- so it
// stays accurate on its own as emails get fixed or new bounces come in,
// with no separate bookkeeping. A school with ever_touched_by_coach_info
// true is the "stuck" case Run #34 exposed -- it needs a deliberate retry
// (the button below) because the normal exclusion will never re-offer it.
// One that's never been touched will surface in an ordinary bounce-recovery
// run on its own; it's still shown here (toggle-able) for full visibility,
// since a person coming back to this page wants the whole picture of
// what's currently broken, not just the stuck half.
// "123 Main St, Suite 4, Delray Beach, FL 33444" -- whatever parts are on file.
function addressLine(r, extra) {
  const e = extra || {};
  const cityState = [r.city, [r.state, e.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  return [e.addr1, e.addr2, cityState].filter((x) => x && String(x).trim()).join(", ");
}

export default function DeadEmailRecoveryPage() {
  const supabase = getSupabaseBrowserClient();
  const router = useRouter();
  const { user, profile } = useAuth();
  const canReview = profile?.role === "verifier" || profile?.role === "sysadmin";

  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [onlyStuck, setOnlyStuck] = useState(true);
  // Schools a reviewer already clicked "Confirm -- same address" on stay in
  // dead_email_schools on purpose (the bounce history is kept), but they are
  // finished work -- hide them by default so "select all" can't re-send them.
  const [hideConfirmed, setHideConfirmed] = useState(true);
  // What the last Coach-Info AI pass found for each school, and the street
  // address, keyed by school id. Loaded after the main list.
  const [extras, setExtras] = useState({});
  // "all" | "different" | "same" | "none" -- filters by what the AI found.
  const [aiFilter, setAiFilter] = useState("all");
  // Multi-edit: open editors keyed by school id, per-row errors/notes, and
  // progress/summary for "Save all changed".
  const [editDrafts, setEditDrafts] = useState({});
  const [editErrors, setEditErrors] = useState({});
  const [rowNotes, setRowNotes] = useState({});
  const [saveAllProgress, setSaveAllProgress] = useState(null);
  const [saveSummary, setSaveSummary] = useState("");
  // Saved state is read after mount (not in the initializers) so the first
  // render matches the server's. Nothing is written back until it's read.
  const [restored, setRestored] = useState(false);
  const anchorRef = useRef(null);
  const anchorDoneRef = useRef(false);
  const [selected, setSelected] = useState(() => new Set());
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState("");

  // For every listed school: the street address, and what the MOST RECENT
  // Coach-Info item for it suggested. Loaded in chunks of 100 school ids so a
  // single request never gets near PostgREST's 1000-row cap.
  async function loadExtras(list) {
    const ids = list.map((r) => r.school_id);
    const next = {};
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100);
      const [{ data: schoolRows }, { data: itemRows }] = await Promise.all([
        supabase.from("schools").select("id,addr1,addr2,zip,hc_office,hc_cell,athletics_url,website").in("id", chunk),
        supabase
          .from("coach_info_batch_items")
          .select("id,school_id,review_status,suggestion")
          .in("school_id", chunk)
          .order("id", { ascending: false })
          .limit(1000),
      ]);
      (schoolRows || []).forEach((sc) => {
        next[sc.id] = { ...(next[sc.id] || {}), addr1: sc.addr1, addr2: sc.addr2, zip: sc.zip, hc_office: sc.hc_office, hc_cell: sc.hc_cell, athletics_url: sc.athletics_url, website: sc.website };
      });
      const seen = new Set();
      (itemRows || []).forEach((it) => {
        if (seen.has(it.school_id)) return; // newest first -- keep only the latest
        seen.add(it.school_id);
        next[it.school_id] = {
          ...(next[it.school_id] || {}),
          sugEmail: String(it.suggestion?.hc_email || "").trim(),
          confidence: it.suggestion?.confidence || "",
          reviewStatus: it.review_status || "",
        };
      });
    }
    setExtras(next);
  }

  // "different" = the AI proposed another email, "same" = it re-found the
  // address that bounced, "none" = it found no email at all.
  function aiResult(r) {
    const e = extras[r.school_id];
    if (!e || e.sugEmail === undefined) return "none";
    if (!e.sugEmail) return "none";
    return e.sugEmail.toLowerCase() === String(r.hc_email || "").trim().toLowerCase() ? "same" : "different";
  }

  useEffect(() => {
    const saved = readSavedState();
    if (saved) {
      if (saved.drafts && typeof saved.drafts === "object") setEditDrafts(saved.drafts);
      if (typeof saved.onlyStuck === "boolean") setOnlyStuck(saved.onlyStuck);
      if (typeof saved.hideConfirmed === "boolean") setHideConfirmed(saved.hideConfirmed);
      if (AI_FILTERS.includes(saved.aiFilter)) setAiFilter(saved.aiFilter);
      if (saved.anchor) anchorRef.current = saved.anchor;
    }
    setRestored(true);
  }, []);

  useEffect(() => {
    if (!restored) return;
    mergeSavedState({ drafts: editDrafts, onlyStuck, hideConfirmed, aiFilter });
  }, [restored, editDrafts, onlyStuck, hideConfirmed, aiFilter]);

  // Remember the school you were last working on (clicked in, typed in, or
  // followed a link from) so coming back scrolls straight to it.
  const rememberSchool = (id) => {
    anchorRef.current = id;
    mergeSavedState({ anchor: id });
  };

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const { data, error: err } = await supabase
        .from("dead_email_schools")
        .select("*")
        .order("ever_touched_by_coach_info", { ascending: false })
        .order("state", { ascending: true })
        .order("name", { ascending: true })
        .limit(2000);
      if (err) throw err;
      setRows(data || []);
      // Drop drafts for schools no longer on the list (saved or fixed since).
      const stillListed = new Set((data || []).map((r) => r.school_id));
      setEditDrafts((prev) => Object.fromEntries(Object.entries(prev).filter(([id]) => stillListed.has(Number(id)))));
      await loadExtras(data || []);
    } catch (err) {
      setError(err.message || "Could not load dead-email schools.");
    } finally {
      setLoading(false);
    }
  }, [supabase]);

  useEffect(() => {
    if (canReview) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canReview]);

  // Everything still open (not already confirmed by a person).
  const openRows = useMemo(() => rows.filter((r) => !r.manually_confirmed_at), [rows]);
  const confirmedCount = rows.length - openRows.length;
  const baseRows = hideConfirmed ? openRows : rows;
  const visibleRows = useMemo(() => {
    let list = onlyStuck ? baseRows.filter((r) => r.ever_touched_by_coach_info) : baseRows;
    if (aiFilter !== "all") list = list.filter((r) => aiResult(r) === aiFilter);
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseRows, onlyStuck, aiFilter, extras]);
  const aiCounts = useMemo(() => {
    const c = { all: 0, different: 0, same: 0, none: 0 };
    (onlyStuck ? baseRows.filter((r) => r.ever_touched_by_coach_info) : baseRows).forEach((r) => {
      c.all += 1;
      c[aiResult(r)] += 1;
    });
    return c;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseRows, onlyStuck, extras]);
  const stuckCount = useMemo(() => openRows.filter((r) => r.ever_touched_by_coach_info).length, [openRows]);
  const neverTriedCount = openRows.length - stuckCount;
  // Only rows that are on screen AND ticked count -- a row hidden by a filter
  // is never sent or confirmed by accident.
  const selectedVisible = useMemo(() => visibleRows.filter((r) => selected.has(r.school_id)), [visibleRows, selected]);

  function toggleOne(schoolId) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(schoolId)) next.delete(schoolId);
      else next.add(schoolId);
      return next;
    });
  }

  function toggleAllVisible() {
    setSelected((prev) => {
      const visibleIds = visibleRows.map((r) => r.school_id);
      const allSelected = visibleIds.length > 0 && visibleIds.every((id) => prev.has(id));
      if (allSelected) {
        const next = new Set(prev);
        visibleIds.forEach((id) => next.delete(id));
        return next;
      }
      return new Set([...prev, ...visibleIds]);
    });
  }

  // Creates one new Coach-Info batch run scoped to exactly the selected
  // school_ids -- candidate_mode "bounce_recovery" so it inherits the same
  // "always manual review, never auto-apply" behavior Larry chose for
  // bounce-sourced schools (see app/api/admin/batch-coach-info/[runId]/
  // collect/route.js), and so it reads correctly everywhere the app already
  // labels that mode. Deliberately does NOT run through fetchAllTouchedSchoolIds
  // or any other "already touched" exclusion -- every school selected here
  // has, by definition, already been through the tool before (that's why
  // it's stuck), so re-including them is the whole point.
  async function sendSelectedForRetry() {
    const selectedRows = selectedVisible;
    if (selectedRows.length === 0) return;
    setSending(true);
    setSendError("");
    try {
      const { data: runRow, error: runErr } = await supabase
        .from("coach_info_batch_runs")
        .insert({
          status: "collecting",
          state_filter: null,
          requested_count: selectedRows.length,
          created_by: user.id,
          candidate_mode: "bounce_recovery",
        })
        .select()
        .single();
      if (runErr) throw runErr;

      const itemRows = selectedRows.map((r) => ({ batch_run_id: runRow.id, school_id: r.school_id }));
      const { error: itemsErr } = await supabase.from("coach_info_batch_items").insert(itemRows);
      if (itemsErr) throw itemsErr;

      const eventIds = selectedRows.map((r) => r.event_id).filter(Boolean);
      if (eventIds.length > 0) {
        const { error: bounceErr } = await supabase
          .from("email_bounce_events")
          .update({ reviewed: true, reviewed_at: new Date().toISOString(), reviewed_by: user.id })
          .in("id", eventIds);
        if (bounceErr) console.error("Could not mark email_bounce_events reviewed for this retry run", bounceErr);
      }

      router.push(`/admin/batch-coach-info?run=${runRow.id}`);
    } catch (err) {
      setSendError(err.message || "Could not start a retry run for the selected schools.");
    } finally {
      setSending(false);
    }
  }

  // For the stuck-but-actually-fine case Larry described: he manually opens a
  // dead-email record, re-checks the address (school site, call, etc.), and
  // finds the exact same email is still the right one -- there's no better
  // option to switch to. Simply clearing needs_review would make the badge
  // disappear but leaves no trace that a human ever looked, and the row would
  // vanish from "stuck" tracking (ever_touched_by_coach_info is batch-based,
  // not review-based) only if we removed the bounce record itself -- which we
  // deliberately do NOT do, since the system should keep remembering this
  // address has a history of hard-bouncing (for sender-reputation reasons,
  // and so a future automated pass doesn't blindly re-trust it). Instead this
  // logs a no-op school_change_log entry (old value == new value) as a durable
  // "a human re-checked this on <date> and confirmed it" record, clears the
  // needs_review bookmark via NEEDS_REVIEW_CLEAR_FIELDS, and stamps
  // manually_confirmed_at/by on the underlying bounce event so the "Confirmed
  // current" badge below can distinguish this from a never-checked row.
  async function confirmSelectedCurrent() {
    const selectedRows = selectedVisible;
    if (selectedRows.length === 0) return;
    setConfirming(true);
    setConfirmError("");
    try {
      const nowIso = new Date().toISOString();
      const today = nowIso.slice(0, 10);

      const logRows = selectedRows.map((r) => ({
        school_id: r.school_id,
        field_name: "hc_email",
        old_value: r.hc_email,
        new_value: r.hc_email,
        source: `Manually re-checked by Larry DeVooght -- confirmed still the correct/current address, no better option found (Claude, ${today})`,
        changed_by: null,
      }));
      const { error: logErr } = await supabase.from("school_change_log").insert(logRows);
      if (logErr) throw logErr;

      const schoolIds = selectedRows.map((r) => r.school_id);
      const { error: schoolErr } = await supabase
        .from("schools")
        .update({ ...NEEDS_REVIEW_CLEAR_FIELDS })
        .in("id", schoolIds);
      if (schoolErr) throw schoolErr;

      const eventIds = selectedRows.map((r) => r.event_id).filter(Boolean);
      if (eventIds.length > 0) {
        const { error: bounceErr } = await supabase
          .from("email_bounce_events")
          .update({ manually_confirmed_at: nowIso, manually_confirmed_by: user.id })
          .in("id", eventIds);
        if (bounceErr) throw bounceErr;
      }

      setSelected((prev) => {
        const next = new Set(prev);
        schoolIds.forEach((id) => next.delete(id));
        return next;
      });
      await load();
    } catch (err) {
      setConfirmError(err.message || "Could not save the manual confirmation for the selected schools.");
    } finally {
      setConfirming(false);
    }
  }

  // ---- Multi-edit -------------------------------------------------------
  // Same save path as Needs Review's Quick Fix (/api/admin/needs-review/save):
  // only values that differ are written and logged, and a record that would be
  // left with a changed coach but no confirmed email, or a previous coach's
  // email, is saved but kept flagged and unverified -- never stamped verified.
  async function authedFetch(url, options = {}) {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    return fetch(url, { ...options, headers: { ...(options.headers || {}), Authorization: `Bearer ${session?.access_token}` } });
  }

  function draftFromRow(r) {
    const e = extras[r.school_id] || {};
    return {
      hc_first_name: r.hc_first_name || "",
      hc_last_name: r.hc_last_name || "",
      hc_email: r.hc_email || "",
      hc_office: e.hc_office || "",
      hc_cell: e.hc_cell || "",
    };
  }
  const isEditing = (r) => Object.prototype.hasOwnProperty.call(editDrafts, r.school_id);
  // Changed = any field differs from how the editor opened. Save all only
  // writes changed rows, so opening 40 editors and pressing Save all can't
  // quietly save 40 schools nobody touched.
  const isDirty = (r) => {
    const d = editDrafts[r.school_id];
    if (!d) return false;
    const base = draftFromRow(r);
    return EDIT_FIELDS.some((f) => (d[f] || "").trim() !== (base[f] || "").trim());
  };
  const clearRowMsg = (id) => {
    setEditErrors((prev) => {
      const { [id]: _drop, ...rest } = prev;
      return rest;
    });
  };
  const closeEdit = (id) => {
    setEditDrafts((prev) => {
      const { [id]: _drop, ...rest } = prev;
      return rest;
    });
    clearRowMsg(id);
  };
  function toggleEdit(r) {
    if (isEditing(r)) {
      closeEdit(r.school_id);
      return;
    }
    setEditDrafts((prev) => ({ ...prev, [r.school_id]: draftFromRow(r) }));
    clearRowMsg(r.school_id);
  }
  const updateDraft = (id, field, value) => setEditDrafts((prev) => ({ ...prev, [id]: { ...(prev[id] || {}), [field]: value } }));
  function openEditAllShown() {
    const targets = visibleRows.slice(0, EDIT_ALL_CAP);
    setEditDrafts((prev) => {
      const next = { ...prev };
      targets.forEach((r) => {
        if (!Object.prototype.hasOwnProperty.call(next, r.school_id)) next[r.school_id] = draftFromRow(r);
      });
      return next;
    });
  }
  function closeAllEdits() {
    setEditDrafts({});
    setEditErrors({});
  }
  // The email the AI proposed last time, when it differs from the bounced one.
  function useAiEmail(r) {
    const e = extras[r.school_id];
    if (e?.sugEmail) updateDraft(r.school_id, "hc_email", e.sugEmail);
  }

  // Saves one school. Returns "cleared" | "held" | "error".
  async function saveRow(r) {
    const d = editDrafts[r.school_id] || {};
    clearRowMsg(r.school_id);
    const newEmail = (d.hc_email || "").trim();
    // The dead address is the whole problem here: saving with it unchanged
    // would stamp the school verified while the bounced email is still on it.
    if (!newEmail || newEmail.toLowerCase() === String(r.hc_email || "").trim().toLowerCase()) {
      setEditErrors((prev) => ({ ...prev, [r.school_id]: "Enter a NEW email to save. If the same address is right, tick the school and use \"Confirm selected -- same address\" instead." }));
      return "error";
    }
    if (!isValidEmail(newEmail)) {
      setEditErrors((prev) => ({ ...prev, [r.school_id]: `"${newEmail}" doesn't look like an email address.` }));
      return "error";
    }
    try {
      const fields = {};
      EDIT_FIELDS.forEach((f) => {
        const v = (d[f] || "").trim();
        if (v) fields[f] = v;
      });
      const res = await authedFetch("/api/admin/needs-review/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ school_id: r.school_id, fields }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Could not save this school.");
      closeEdit(r.school_id);
      if (!json.cleared) {
        setRowNotes((prev) => ({ ...prev, [r.school_id]: `Saved, but still flagged: ${json.reason}` }));
        return "held";
      }
      return "cleared";
    } catch (err) {
      setEditErrors((prev) => ({ ...prev, [r.school_id]: err.message || "Could not save this school." }));
      return "error";
    }
  }

  async function saveOne(r) {
    setSaveSummary("");
    const result = await saveRow(r);
    if (result !== "error") await load();
  }

  async function saveAllChanged() {
    const targets = visibleRows.filter((r) => isEditing(r) && isDirty(r));
    if (targets.length === 0) return;
    setSaveSummary("");
    const tally = { cleared: 0, held: 0, error: 0 };
    let done = 0;
    setSaveAllProgress({ done: 0, total: targets.length });
    let idx = 0;
    async function worker() {
      while (idx < targets.length) {
        const r = targets[idx++];
        const result = await saveRow(r);
        tally[result] += 1;
        done += 1;
        setSaveAllProgress({ done, total: targets.length });
      }
    }
    await Promise.all(Array.from({ length: Math.min(SAVE_CONCURRENCY, targets.length) }, worker));
    setSaveAllProgress(null);
    setSaveSummary(
      `Saved ${tally.cleared + tally.held} of ${targets.length}: ${tally.cleared} cleared` +
        (tally.held ? `, ${tally.held} saved but still flagged (see the note on each)` : "") +
        (tally.error ? `, ${tally.error} not saved (see the red message on each)` : "") +
        "."
    );
    await load();
  }
  const dirtyEditCount = visibleRows.filter((r) => isEditing(r) && isDirty(r)).length;
  const openEditCount = visibleRows.filter((r) => isEditing(r)).length;

  // Once the list has rendered after a visit, scroll back to the school you
  // were last on (once only -- never again while you work).
  useEffect(() => {
    if (!restored || loading || anchorDoneRef.current) return;
    anchorDoneRef.current = true;
    const id = anchorRef.current;
    if (!id) return;
    setTimeout(() => {
      const el = document.getElementById(`dead-row-${id}`);
      if (el) el.scrollIntoView({ block: "center" });
    }, 250);
  }, [restored, loading, rows.length]);

  if (!canReview) {
    return (
      <div className="view">
        <div className="notice danger">Dead Email Recovery is limited to Verification Staff and System Admins.</div>
      </div>
    );
  }

  const allVisibleSelected = visibleRows.length > 0 && visibleRows.every((r) => selected.has(r.school_id));

  return (
    <div className="view">
      <Link href="/admin" className="btn btn-sm" style={{ marginBottom: 12, display: "inline-flex" }}>
        ← Back to Admin
      </Link>
      <div className="view-header">
        <div>
          <h1>Dead Email Recovery</h1>
          <p>Every open school whose head coach email is still the exact address already confirmed to bounce -- nothing has replaced it since.</p>
        </div>
        <button className="btn btn-sm" onClick={load} disabled={loading}>
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>

      {error && <div className="notice danger" style={{ marginBottom: 14 }}>{error}</div>}
      {sendError && <div className="notice danger" style={{ marginBottom: 14 }}>{sendError}</div>}
      {confirmError && <div className="notice danger" style={{ marginBottom: 14 }}>{confirmError}</div>}

      {!loading && (
        <div className="card" style={{ marginBottom: 14, fontSize: 12.5, color: "#697386" }}>
          <strong style={{ color: "#b3261e" }}>{stuckCount}</strong> already went through Coach-Info once and are stuck there for good unless retried here
          {confirmedCount > 0 && (
            <>
              {" "}
              · <strong>{confirmedCount}</strong> already confirmed by you ({hideConfirmed ? "hidden" : "shown"})
            </>
          )}
          {neverTriedCount > 0 && (
            <>
              {" "}
              · <strong>{neverTriedCount}</strong> haven&apos;t been through Coach-Info yet (a normal bounce-recovery run will pick these up on its own)
            </>
          )}
          .
        </div>
      )}

      <div className="card" style={{ marginBottom: 14 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
          <label style={{ fontSize: 13, display: "flex", gap: 6, alignItems: "center" }}>
            <input type="checkbox" checked={onlyStuck} onChange={(e) => setOnlyStuck(e.target.checked)} />
            Only show schools stuck after already going through Coach-Info once
          </label>
          <label style={{ fontSize: 13, display: "flex", gap: 6, alignItems: "center" }}>
            <input type="checkbox" checked={hideConfirmed} onChange={(e) => setHideConfirmed(e.target.checked)} />
            Hide schools I already confirmed
          </label>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button className="btn btn-sm" onClick={confirmSelectedCurrent} disabled={confirming || selectedVisible.length === 0} title="Use this when you've personally re-checked these schools and the same email is still the best one on file -- keeps the bounce history, just clears the stuck flag.">
              {confirming ? "Saving…" : `Confirm ${selectedVisible.length} selected -- same address, no better option found`}
            </button>
            <button className="btn btn-sm btn-gold" onClick={sendSelectedForRetry} disabled={sending || selectedVisible.length === 0}>
              {sending ? "Starting…" : `Send ${selectedVisible.length} selected to Coach-Info for another AI pass`}
            </button>
          </div>
        </div>
      </div>

      {!loading && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12, alignItems: "center", fontSize: 12.5 }}>
          <span style={{ color: "#697386" }}>What the last AI pass found:</span>
          {[
            ["all", "All"],
            ["different", "Suggested a DIFFERENT email"],
            ["same", "Suggested the same bounced email"],
            ["none", "Found no email"],
          ].map(([key, label]) => (
            <button key={key} className={`btn btn-sm${aiFilter === key ? " btn-gold" : ""}`} onClick={() => setAiFilter(key)}>
              {label} ({aiCounts[key]})
            </button>
          ))}
        </div>
      )}

      {!loading && (
        <div className="card" style={{ marginBottom: 14, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", fontSize: 13 }}>
          <button className="btn btn-sm" onClick={openEditAllShown} disabled={visibleRows.length === 0 || !!saveAllProgress}>
            Edit all shown ({Math.min(visibleRows.length, EDIT_ALL_CAP)})
          </button>
          <span>
            {openEditCount} open · {dirtyEditCount} changed
          </span>
          <button className="btn btn-sm btn-gold" onClick={saveAllChanged} disabled={!!saveAllProgress || dirtyEditCount === 0}>
            {saveAllProgress ? `Saving ${saveAllProgress.done} of ${saveAllProgress.total}…` : `Save all changed (${dirtyEditCount})`}
          </button>
          <button className="btn btn-sm" onClick={closeAllEdits} disabled={openEditCount === 0 || !!saveAllProgress}>
            Close all
          </button>
          <span style={{ color: "#697386", fontSize: 12 }}>Save all only writes rows you changed, and every changed row needs a NEW email.</span>
        </div>
      )}
      {saveSummary && (
        <div className="notice" style={{ marginBottom: 14 }}>
          {saveSummary}
        </div>
      )}

      {loading ? (
        <div className="empty-state">Loading…</div>
      ) : visibleRows.length === 0 ? (
        <div className="empty-state">Nothing here right now -- every confirmed-dead email on file has already been replaced.</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>
                <input type="checkbox" checked={allVisibleSelected} onChange={toggleAllVisible} />
              </th>
              <th>School</th>
              <th>Coach</th>
              <th>Dead email on file</th>
              <th>Last AI pass</th>
              <th>Bounced</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((r) => (
              <Fragment key={r.school_id}>
              <tr id={`dead-row-${r.school_id}`} onClickCapture={() => rememberSchool(r.school_id)}>
                <td>
                  <input type="checkbox" checked={selected.has(r.school_id)} onChange={() => toggleOne(r.school_id)} />
                </td>
                <td>
                  <Link href={`/schools/${r.school_id}`}>{r.name}</Link>
                  <div style={{ fontSize: 11.5, color: "#697386" }}>{addressLine(r, extras[r.school_id])}</div>
                  <div style={{ fontSize: 11.5, display: "flex", gap: 10 }}>
                    {linkableUrl(extras[r.school_id]?.athletics_url) && (
                      <a href={linkableUrl(extras[r.school_id].athletics_url)} target="_blank" rel="noopener noreferrer">
                        Athletics site ↗
                      </a>
                    )}
                    {linkableUrl(extras[r.school_id]?.website) && (
                      <a href={linkableUrl(extras[r.school_id].website)} target="_blank" rel="noopener noreferrer">
                        Website ↗
                      </a>
                    )}
                  </div>
                  {rowNotes[r.school_id] && <div style={{ fontSize: 11.5, color: "#8a6100", marginTop: 2 }}>{rowNotes[r.school_id]}</div>}
                </td>
                <td>
                  {r.hc_first_name || r.hc_last_name ? `${r.hc_first_name ?? ""} ${r.hc_last_name ?? ""}`.trim() : <span style={{ color: "#a2a9b6" }}>—</span>}
                </td>
                <td>{r.hc_email}</td>
                <td style={{ fontSize: 12 }}>
                  {(() => {
                    const e = extras[r.school_id] || {};
                    const res = aiResult(r);
                    if (res === "different")
                      return (
                        <span title="The AI proposed a different email last time -- it was never applied. Worth a look.">
                          <strong style={{ color: "#1a7f4b" }}>New: {e.sugEmail}</strong>
                          <div style={{ color: "#697386" }}>{[e.confidence, e.reviewStatus].filter(Boolean).join(" · ")}</div>
                        </span>
                      );
                    if (res === "same") return <span style={{ color: "#8a6100" }}>Same bounced address</span>;
                    return <span style={{ color: "#a2a9b6" }}>No email found</span>;
                  })()}
                </td>
                <td style={{ fontSize: 12, color: "#697386" }}>
                  {r.detected_at ? new Date(r.detected_at).toLocaleDateString() : "—"}
                  {r.bounce_type ? ` · ${r.bounce_type}` : ""}
                </td>
                <td>
                  {r.ever_touched_by_coach_info ? (
                    <span className="badge" style={{ color: "#b3261e", background: "#fdeeed" }} title="Already went through Coach-Info once -- needs a deliberate retry to get another AI attempt.">
                      Stuck -- tried once
                    </span>
                  ) : (
                    <span className="badge" style={{ color: "#1c5fb3", background: "#e7effc" }} title="Hasn't been through Coach-Info yet -- a normal bounce-recovery run will pick this up.">
                      Not yet tried
                    </span>
                  )}
                  {r.needs_review && (
                    <span className="badge" style={{ marginLeft: 6, color: "#8a6100", background: "#fff4dc" }} title={r.needs_review_note || "Marked for review"}>
                      Needs review
                    </span>
                  )}
                  <div style={{ marginTop: 4 }}>
                    <button className="btn btn-sm" onClick={() => toggleEdit(r)} disabled={!!saveAllProgress}>
                      {isEditing(r) ? "Close" : "Edit"}
                    </button>
                  </div>
                  {r.manually_confirmed_at && (
                    <span
                      className="badge"
                      style={{ marginLeft: 6, color: "#1a7f4b", background: "#e6f6ee" }}
                      title={`A reviewer manually re-checked this address on ${new Date(r.manually_confirmed_at).toLocaleDateString()} and confirmed it's still the correct/current one on file.`}
                    >
                      Confirmed current
                    </span>
                  )}
                </td>
              </tr>
              {isEditing(r) && (
                <tr onClickCapture={() => rememberSchool(r.school_id)} onFocusCapture={() => rememberSchool(r.school_id)}>
                  <td colSpan={7} style={{ background: "#f7f9fc", padding: "10px 12px" }}>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 8 }}>
                      {EDIT_FIELDS.map((f) => (
                        <label key={f} style={{ fontSize: 11.5, color: "#697386", display: "flex", flexDirection: "column", gap: 2 }}>
                          {EDIT_LABELS[f]}
                          <input
                            value={editDrafts[r.school_id]?.[f] ?? ""}
                            onChange={(e) => updateDraft(r.school_id, f, e.target.value)}
                            style={f === "hc_email" ? { borderColor: "#b3261e" } : undefined}
                          />
                        </label>
                      ))}
                    </div>
                    <div style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "center", flexWrap: "wrap" }}>
                      {aiResult(r) === "different" && (
                        <button className="btn btn-sm" onClick={() => useAiEmail(r)}>
                          Use AI&apos;s email: {extras[r.school_id]?.sugEmail}
                        </button>
                      )}
                      <button className="btn btn-sm btn-gold" onClick={() => saveOne(r)} disabled={!!saveAllProgress || !isDirty(r)}>
                        Save this school
                      </button>
                      <span style={{ fontSize: 11.5, color: "#697386" }}>The email box (red) holds the bounced address -- replace it with the working one.</span>
                    </div>
                    {editErrors[r.school_id] && <div style={{ color: "#b3261e", fontSize: 12, marginTop: 6 }}>{editErrors[r.school_id]}</div>}
                  </td>
                </tr>
              )}
              </Fragment>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
