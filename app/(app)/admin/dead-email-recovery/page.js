"use client";
import { useState, useEffect, useCallback, useMemo } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { useAuth } from "@/lib/auth-context";

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
export default function DeadEmailRecoveryPage() {
  const supabase = getSupabaseBrowserClient();
  const router = useRouter();
  const { user, profile } = useAuth();
  const canReview = profile?.role === "verifier" || profile?.role === "sysadmin";

  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [onlyStuck, setOnlyStuck] = useState(true);
  const [selected, setSelected] = useState(() => new Set());
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState("");

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

  const visibleRows = useMemo(() => (onlyStuck ? rows.filter((r) => r.ever_touched_by_coach_info) : rows), [rows, onlyStuck]);
  const stuckCount = useMemo(() => rows.filter((r) => r.ever_touched_by_coach_info).length, [rows]);
  const neverTriedCount = rows.length - stuckCount;

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
    const selectedRows = rows.filter((r) => selected.has(r.school_id));
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

      {!loading && (
        <div className="card" style={{ marginBottom: 14, fontSize: 12.5, color: "#697386" }}>
          <strong style={{ color: "#b3261e" }}>{stuckCount}</strong> already went through Coach-Info once and are stuck there for good unless retried here
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
          <button className="btn btn-sm btn-gold" onClick={sendSelectedForRetry} disabled={sending || selected.size === 0}>
            {sending ? "Starting…" : `Send ${selected.size} selected to Coach-Info for another AI pass`}
          </button>
        </div>
      </div>

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
              <th>Bounced</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((r) => (
              <tr key={r.school_id}>
                <td>
                  <input type="checkbox" checked={selected.has(r.school_id)} onChange={() => toggleOne(r.school_id)} />
                </td>
                <td>
                  <Link href={`/schools/${r.school_id}`}>{r.name}</Link>
                  <div style={{ fontSize: 11.5, color: "#697386" }}>
                    {r.city}, {r.state}
                  </div>
                </td>
                <td>
                  {r.hc_first_name || r.hc_last_name ? `${r.hc_first_name ?? ""} ${r.hc_last_name ?? ""}`.trim() : <span style={{ color: "#a2a9b6" }}>—</span>}
                </td>
                <td>{r.hc_email}</td>
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
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
