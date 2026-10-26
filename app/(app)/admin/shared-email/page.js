// app/(app)/admin/shared-email/page.js
"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import Link from "next/link";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { useAuth } from "@/lib/auth-context";
import { linkableUrl } from "@/lib/needsReviewEdit";

// Shared Email review.
//
// One head-coach email sitting on two or more open schools almost always means
// one of them is wrong (the original import copied a coach's email onto a
// same-named school or a neighbor in the same district). Needs Review sorts by
// state, which scatters these pairs across the whole country. This page puts
// every shared email in ONE list, side by side, whatever the state, and settles
// each in one click:
//   - "Email belongs here"   -> clears the email from the other school(s) and
//                               sends them to Needs Review for a coach lookup
//   - "Keep this, close the others" -> same school entered twice
//   - "Both correct"         -> a combined program / one coach for two schools
const FILTERS = {
  all: { label: "All", test: () => true },
  same_city: { label: "Same city", test: (g) => g.same_city },
  diff_coach: { label: "Different towns, different coaches", test: (g) => !g.same_city && !g.same_coach },
  same_coach: { label: "Different towns, same coach (likely combined programs)", test: (g) => !g.same_city && g.same_coach },
};
const FILTER_ORDER = ["all", "same_city", "diff_coach", "same_coach"];

function fmtDate(d) {
  if (!d) return "never";
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return "never";
  return dt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function SchoolColumn({ s, group, busy, onKeep, onDuplicate }) {
  const coach = `${s.hc_first_name || ""} ${s.hc_last_name || ""}`.trim() || "—";
  const mp = linkableUrl(s.maxpreps_url);
  const ath = linkableUrl(s.athletics_url);
  const web = linkableUrl(s.website);
  return (
    <div style={{ flex: "1 1 260px", minWidth: 240, border: "1px solid #e3e7ee", borderRadius: 8, padding: 12, background: "#fff" }}>
      <div style={{ fontWeight: 700 }}>
        <Link href={`/schools/${s.id}`} target="_blank" rel="noopener noreferrer" title="Opens in a new tab so this list stays open">
          {s.name}
        </Link>
      </div>
      <div style={{ fontSize: 12.5, color: "#697386", marginBottom: 6 }}>
        {s.city}, {s.state}
        {s.county ? ` · ${s.county} County` : ""}
        {s.classification ? ` · ${s.classification}` : ""} · id {s.id}
      </div>
      <div style={{ fontSize: 13 }}>
        <div>
          <strong>Coach:</strong> {coach}
        </div>
        <div>
          <strong>School phone:</strong> {s.phone || "—"}
        </div>
        <div>
          <strong>Coach office / cell:</strong> {s.hc_office || "—"} / {s.hc_cell || "—"}
        </div>
      </div>
      <div style={{ fontSize: 12.5, margin: "6px 0" }}>
        {s.verification_status === "verified" ? (
          <span className="badge" style={{ color: "#1e7145", background: "#e9f5ee", fontWeight: 700 }}>
            Verified {fmtDate(s.last_verified_at)}
          </span>
        ) : (
          <span className="badge" style={{ color: "#697386", background: "#eef0f3" }}>Not verified</span>
        )}
        {s.needs_review && (
          <span className="badge" style={{ color: "#b3261e", background: "#fdeeed", marginLeft: 6 }}>Flagged</span>
        )}
      </div>
      <div style={{ fontSize: 12.5, marginBottom: 8 }}>
        {mp && (
          <a href={mp} target="_blank" rel="noopener noreferrer" style={{ marginRight: 10 }}>MaxPreps</a>
        )}
        {ath && (
          <a href={ath} target="_blank" rel="noopener noreferrer" style={{ marginRight: 10 }}>Athletics site</a>
        )}
        {web && (
          <a href={web} target="_blank" rel="noopener noreferrer">School site</a>
        )}
      </div>
      {s.needs_review && s.needs_review_note && (
        <div style={{ fontSize: 12, color: "#8a6d3b", marginBottom: 8 }}>{String(s.needs_review_note).slice(0, 220)}</div>
      )}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        <button className="btn btn-sm btn-gold" disabled={busy} onClick={() => onKeep(group, s)} title="This school really uses this email. It is removed from the other school(s), which are sent to Needs Review for a lookup.">
          Email belongs here
        </button>
        <button className="btn btn-sm" disabled={busy} onClick={() => onDuplicate(group, s)} title="Same school entered more than once. Keeps this one, closes the others as duplicates.">
          Keep this, close the others
        </button>
      </div>
    </div>
  );
}

export default function SharedEmailPage() {
  const supabase = getSupabaseBrowserClient();
  const { profile } = useAuth();
  const canReview = profile?.role === "verifier" || profile?.role === "sysadmin";

  const [groups, setGroups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [filter, setFilter] = useState("all");
  const [stateFilter, setStateFilter] = useState("all");
  const [busyKey, setBusyKey] = useState(null);
  const [bulkBusy, setBulkBusy] = useState(false);

  const authedFetch = useCallback(
    async (url, options = {}) => {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      return fetch(url, {
        ...options,
        headers: { ...(options.headers || {}), Authorization: `Bearer ${session?.access_token}` },
      });
    },
    [supabase]
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await authedFetch("/api/admin/shared-email");
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Could not load the shared emails.");
      setGroups(json.groups || []);
    } catch (err) {
      setError(err.message || "Could not load the shared emails.");
    } finally {
      setLoading(false);
    }
  }, [authedFetch]);

  useEffect(() => {
    if (canReview) load();
  }, [canReview, load]);

  const post = async (payload) => {
    const res = await authedFetch("/api/admin/shared-email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const e = new Error(json.error || "Could not save that.");
      e.code = json.code;
      throw e;
    }
    return json;
  };

  const dropGroup = (key) => setGroups((prev) => prev.filter((g) => g.email_key !== key));

  const names = (list) => list.map((s) => `${s.name} (${s.city}, ${s.state})`).join("\n  • ");

  const onKeep = async (group, keeper) => {
    const others = group.schools.filter((s) => s.id !== keeper.id);
    const ok = window.confirm(
      `${group.email}\n\nThis email belongs to ${keeper.name} (${keeper.city}, ${keeper.state}).\n\nIt will be REMOVED from:\n  • ${names(others)}\n\nand those schools sent to Needs Review. Continue?`
    );
    if (!ok) return;
    setBusyKey(group.email_key);
    setError("");
    setNotice("");
    try {
      await post({ action: "keep", email_key: group.email_key, keep_school_id: keeper.id });
      dropGroup(group.email_key);
      setNotice(`Done. ${group.email} stays on ${keeper.name}; ${others.length} other school${others.length === 1 ? "" : "s"} cleared and sent to Needs Review.`);
    } catch (err) {
      setError(err.message);
      if (err.code === "stale_group") load();
    } finally {
      setBusyKey(null);
    }
  };

  const onDuplicate = async (group, keeper) => {
    const others = group.schools.filter((s) => s.id !== keeper.id);
    const ok = window.confirm(
      `${group.email}\n\nKeep ${keeper.name} (${keeper.city}, ${keeper.state}) and CLOSE these as duplicates of it:\n  • ${names(others)}\n\nContinue?`
    );
    if (!ok) return;
    setBusyKey(group.email_key);
    setError("");
    setNotice("");
    try {
      await post({ action: "duplicate", email_key: group.email_key, keep_school_id: keeper.id });
      dropGroup(group.email_key);
      setNotice(`Done. Kept ${keeper.name}; closed ${others.length} duplicate${others.length === 1 ? "" : "s"}.`);
    } catch (err) {
      setError(err.message);
      if (err.code === "stale_group") load();
    } finally {
      setBusyKey(null);
    }
  };

  const dismissOne = async (group) => {
    setBusyKey(group.email_key);
    setError("");
    setNotice("");
    try {
      await post({ action: "dismiss", email_key: group.email_key });
      dropGroup(group.email_key);
      setNotice(`Marked correct: ${group.email} (${group.schools.length} schools). It won't be listed again.`);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyKey(null);
    }
  };

  const states = useMemo(() => {
    const set = new Set();
    groups.forEach((g) => g.schools.forEach((s) => set.add(s.state)));
    return Array.from(set).sort();
  }, [groups]);

  const counts = useMemo(() => {
    const c = {};
    FILTER_ORDER.forEach((k) => {
      c[k] = groups.filter(FILTERS[k].test).length;
    });
    return c;
  }, [groups]);

  const shown = useMemo(
    () => groups.filter(FILTERS[filter].test).filter((g) => stateFilter === "all" || g.schools.some((s) => s.state === stateFilter)),
    [groups, filter, stateFilter]
  );

  const dismissAllShown = async () => {
    if (!shown.length) return;
    const ok = window.confirm(
      `Mark ALL ${shown.length} shown emails as correct?\n\nOnly do this for combined programs and coaches who really coach both schools. Each email stops being listed.`
    );
    if (!ok) return;
    setBulkBusy(true);
    setError("");
    setNotice("");
    try {
      const keys = shown.map((g) => g.email_key);
      for (let i = 0; i < keys.length; i += 100) {
        await post({ action: "dismiss", email_keys: keys.slice(i, i + 100) });
      }
      setGroups((prev) => prev.filter((g) => !keys.includes(g.email_key)));
      setNotice(`Marked ${keys.length} shared emails as correct.`);
    } catch (err) {
      setError(err.message);
      load();
    } finally {
      setBulkBusy(false);
    }
  };

  if (!canReview) {
    return (
      <div className="view">
        <div className="notice danger">The Shared Email review is limited to Verification Staff and System Admins.</div>
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
          <h1>Shared Email</h1>
          <p>
            One coach email on two or more schools usually means one is wrong. Every shared email is listed here side by side, whatever the
            state. Pick who the email really belongs to, close a duplicate, or mark both correct.
          </p>
        </div>
      </div>

      {error && <div className="notice danger" style={{ marginBottom: 12 }}>{error}</div>}
      {notice && (
        <div className="notice" style={{ marginBottom: 12, background: "#e9f5ee", color: "#1e7145" }}>
          {notice}
        </div>
      )}

      {loading ? (
        <div className="empty-state">Loading…</div>
      ) : groups.length === 0 ? (
        <div className="empty-state">No shared emails to review. Nothing is sitting on two schools right now.</div>
      ) : (
        <>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", marginBottom: 12 }}>
            {FILTER_ORDER.map((k) => (
              <button
                key={k}
                className={filter === k ? "btn btn-sm btn-gold" : "btn btn-sm"}
                onClick={() => setFilter(k)}
              >
                {FILTERS[k].label} ({counts[k]})
              </button>
            ))}
            <select value={stateFilter} onChange={(e) => setStateFilter(e.target.value)} style={{ marginLeft: 8 }}>
              <option value="all">All states</option>
              {states.map((st) => (
                <option key={st} value={st}>{st}</option>
              ))}
            </select>
            {filter === "same_coach" && shown.length > 0 && (
              <button className="btn btn-sm" disabled={bulkBusy} onClick={dismissAllShown} style={{ marginLeft: "auto" }}>
                {bulkBusy ? "Saving…" : `Mark all ${shown.length} shown as correct`}
              </button>
            )}
          </div>
          <div style={{ fontSize: 13, color: "#697386", marginBottom: 10 }}>
            Showing {shown.length} of {groups.length} shared emails.
          </div>

          {shown.length === 0 && <div className="empty-state">Nothing in this view.</div>}

          {shown.map((g) => (
            <div key={g.email_key} className="card" style={{ marginBottom: 14, padding: 14 }}>
              <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, marginBottom: 10 }}>
                <strong style={{ fontSize: 15 }}>{g.email}</strong>
                <span className="badge" style={{ background: "#eef0f3", color: "#697386" }}>{g.schools.length} schools</span>
                {g.same_city && <span className="badge" style={{ background: "#fff1de", color: "#8a4b00" }}>Same city</span>}
                {!g.same_coach && <span className="badge" style={{ background: "#fdeeed", color: "#b3261e" }}>Different coach names</span>}
                <button className="btn btn-sm" disabled={busyKey === g.email_key} onClick={() => dismissOne(g)} style={{ marginLeft: "auto" }}>
                  Both correct
                </button>
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
                {g.schools.map((s) => (
                  <SchoolColumn key={s.id} s={s} group={g} busy={busyKey === g.email_key} onKeep={onKeep} onDuplicate={onDuplicate} />
                ))}
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
