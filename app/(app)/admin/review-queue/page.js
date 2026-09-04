"use client";
import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { useAuth } from "@/lib/auth-context";

// Unified cross-tool Review Queue -- every PENDING suggestion from all four
// AI batch discovery tools (Coach-Info, Athletics-URL, MaxPreps, Social
// Media), combined into one table. Built at Larry's request as the second
// half of "make the review process simpler and faster": before this, a
// reviewer had to open all four /admin/batch-* pages separately and work
// each one's own queue to completion, even though the actual review motion
// -- read a suggestion, check the confidence, click Apply or Skip -- is
// identical across all four. This page lets a reviewer sit in one place
// and clear suggestions from every tool without switching tabs, filtering
// by tool and/or confidence tier and/or a school-name search exactly like
// each individual tool's own review page already does.
//
// Each tool writes to its own schools column(s) with its own field shape
// (Coach-Info: seven hc_* fields; Athletics/MaxPreps: one *_url field;
// Social: hc_twitter/hc_facebook) -- applyRow below switches on which tool
// a row came from and reuses that tool's own applySuggestionCore write
// path (schools update + school_change_log entry + item marked applied),
// so an apply/skip made from here is indistinguishable in the audit trail
// from one made on that tool's own page.
//
// Deliberately pulls PENDING items only (no "show already-reviewed" mode
// like the individual tool pages have) -- this page's whole purpose is
// working a queue down to empty, not browsing history, and rows
// disappear from the list here the moment they're applied or skipped
// rather than staying dimmed in place.
const ROWS_PER_TOOL_CAP = 500; // keeps the initial load fast even if a tool's pending pile is huge; a banner says so if any tool hits this cap

const COACH_INFO_FIELDS = ["hc_first_name", "hc_last_name", "hc_email", "hc_office", "hc_cell", "hc_twitter", "hc_facebook"];
const COACH_INFO_FIELD_LABELS = {
  hc_first_name: "First name",
  hc_last_name: "Last name",
  hc_email: "Email",
  hc_office: "Office phone",
  hc_cell: "Cell",
  hc_twitter: "Twitter / X",
  hc_facebook: "Facebook",
};

const TOOLS = [
  {
    key: "coach_info",
    label: "Coach-Info",
    itemsTable: "coach_info_batch_items",
    href: "/admin/batch-coach-info",
    select:
      "id,school_id,suggestion,suggestion_error,review_status,school:schools(id,name,city,state,hc_first_name,hc_last_name,hc_email,hc_office,hc_cell,hc_twitter,hc_facebook)",
  },
  {
    key: "athletics",
    label: "Athletics-URL",
    itemsTable: "athletics_batch_items",
    href: "/admin/batch-athletics",
    select: "id,school_id,suggestion,suggestion_error,review_status,school:schools(id,name,city,state,athletics_url)",
  },
  {
    key: "maxpreps",
    label: "MaxPreps",
    itemsTable: "maxpreps_batch_items",
    href: "/admin/batch-maxpreps",
    select: "id,school_id,suggestion,suggestion_error,review_status,school:schools(id,name,city,state,maxpreps_url)",
  },
  {
    key: "social",
    label: "Social Media",
    itemsTable: "social_batch_items",
    href: "/admin/batch-social",
    select: "id,school_id,suggestion,suggestion_error,review_status,school:schools(id,name,city,state,hc_twitter,hc_facebook)",
  },
];
const TOOL_BY_KEY = Object.fromEntries(TOOLS.map((t) => [t.key, t]));

function confidenceColor(c) {
  return c === "high" ? "#1e7145" : c === "medium" ? "#8a6100" : "#b3261e";
}

// Same bounded-concurrency helper every batch review page defines locally
// for its own bulk-apply button (see e.g. batch-athletics/page.js) --
// duplicated here rather than imported since it's not shared-lib code
// anywhere yet.
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

const APPLY_CONCURRENCY = 5;

function rowKey(row) {
  return `${row.tool}:${row.id}`;
}

export default function ReviewQueuePage() {
  const supabase = getSupabaseBrowserClient();
  const { user, profile } = useAuth();
  const canReview = profile?.role === "verifier" || profile?.role === "sysadmin";

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [reviewError, setReviewError] = useState("");
  const [rows, setRows] = useState([]);
  const [truncatedTools, setTruncatedTools] = useState([]);

  const [toolFilter, setToolFilter] = useState("all"); // "all" | tool key
  const [confidenceFilter, setConfidenceFilter] = useState("all"); // "all" | "high" | "medium" | "low"
  const [searchQuery, setSearchQuery] = useState("");

  const [focusedIndex, setFocusedIndex] = useState(0);
  const [applyingKey, setApplyingKey] = useState(null);
  const [bulkApplying, setBulkApplying] = useState(false);
  const [bulkProgress, setBulkProgress] = useState({ done: 0, total: 0 });

  const load = useCallback(async () => {
    if (!canReview) return;
    setLoading(true);
    setError("");
    try {
      const results = await Promise.all(
        TOOLS.map(async (tool) => {
          const { data, error: qErr } = await supabase
            .from(tool.itemsTable)
            .select(tool.select)
            .eq("review_status", "pending")
            .not("suggestion", "is", null)
            .is("suggestion_error", null)
            .order("id")
            .limit(ROWS_PER_TOOL_CAP);
          if (qErr) throw qErr;
          return (data || []).map((item) => ({ ...item, tool: tool.key }));
        })
      );
      setRows(results.flat());
      setTruncatedTools(TOOLS.filter((_, i) => results[i].length === ROWS_PER_TOOL_CAP).map((t) => t.label));
    } catch (err) {
      setError(err.message || "Could not load the review queue.");
    } finally {
      setLoading(false);
    }
  }, [supabase, canReview]);

  useEffect(() => {
    load();
  }, [load]);

  // Matches a row against the current search box -- school name or city,
  // case-insensitive. Same loose substring match every individual tool
  // page's own matchesSearch uses.
  function matchesSearch(row) {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return true;
    const s = row.school;
    return Boolean(s && (`${s.name || ""}`.toLowerCase().includes(q) || `${s.city || ""}`.toLowerCase().includes(q)));
  }

  // Each facet's own counts reflect every OTHER active filter but not
  // itself, so switching tabs never makes a count disappear out from under
  // the tab you're looking at.
  const toolSearchFiltered = rows.filter((r) => (toolFilter === "all" || r.tool === toolFilter) && matchesSearch(r));
  const confidenceCounts = {
    all: toolSearchFiltered.length,
    high: toolSearchFiltered.filter((r) => r.suggestion?.confidence === "high").length,
    medium: toolSearchFiltered.filter((r) => r.suggestion?.confidence === "medium").length,
    low: toolSearchFiltered.filter((r) => r.suggestion?.confidence === "low").length,
  };

  const confidenceSearchFiltered = rows.filter((r) => (confidenceFilter === "all" || r.suggestion?.confidence === confidenceFilter) && matchesSearch(r));
  const toolCounts = { all: confidenceSearchFiltered.length };
  TOOLS.forEach((t) => {
    toolCounts[t.key] = confidenceSearchFiltered.filter((r) => r.tool === t.key).length;
  });

  const visibleRows = toolSearchFiltered.filter((r) => confidenceFilter === "all" || r.suggestion?.confidence === confidenceFilter);
  const clampedFocusedIndex = visibleRows.length === 0 ? 0 : Math.min(focusedIndex, visibleRows.length - 1);
  const focusedRow = visibleRows[clampedFocusedIndex] || null;

  useEffect(() => {
    setFocusedIndex(0);
  }, [toolFilter, confidenceFilter, searchQuery]);

  // Writes one row's suggestion into the schools table -- the same
  // write shape (schools update + school_change_log entry + item marked
  // applied) each tool's own applySuggestionCore uses, just switched on
  // which tool this particular row came from since the four tools don't
  // share a suggestion shape.
  async function applySuggestionCore(row) {
    const s = row.school;
    const sug = row.suggestion;
    if (!s || !sug) return { ok: false, error: "Missing school or suggestion." };
    try {
      const update = {};
      const changes = [];
      if (row.tool === "coach_info") {
        COACH_INFO_FIELDS.forEach((f) => {
          const newVal = (sug[f] || "").trim();
          if (newVal && newVal !== (s[f] || "")) {
            update[f] = newVal;
            changes.push({ school_id: s.id, field_name: f, old_value: s[f] || null, new_value: newVal, source: `Batch AI lookup (${sug.confidence} confidence, reviewed)`, changed_by: user.id });
          }
        });
      } else if (row.tool === "athletics" || row.tool === "maxpreps") {
        const field = row.tool === "athletics" ? "athletics_url" : "maxpreps_url";
        if (sug.best_url && sug.best_url !== (s[field] || "")) {
          update[field] = sug.best_url;
          changes.push({ school_id: s.id, field_name: field, old_value: s[field] || null, new_value: sug.best_url, source: `Batch AI lookup (${sug.confidence} confidence, reviewed)`, changed_by: user.id });
        }
      } else if (row.tool === "social") {
        if (sug.twitter_url && sug.twitter_url !== (s.hc_twitter || "")) {
          update.hc_twitter = sug.twitter_url;
          changes.push({ school_id: s.id, field_name: "hc_twitter", old_value: s.hc_twitter || null, new_value: sug.twitter_url, source: `Batch AI lookup (${sug.confidence} confidence, reviewed)`, changed_by: user.id });
        }
        if (sug.facebook_url && sug.facebook_url !== (s.hc_facebook || "")) {
          update.hc_facebook = sug.facebook_url;
          changes.push({ school_id: s.id, field_name: "hc_facebook", old_value: s.hc_facebook || null, new_value: sug.facebook_url, source: `Batch AI lookup (${sug.confidence} confidence, reviewed)`, changed_by: user.id });
        }
      }

      if (Object.keys(update).length > 0) {
        const { error: updateErr } = await supabase.from("schools").update(update).eq("id", s.id);
        if (updateErr) throw updateErr;
        const { error: logErr } = await supabase.from("school_change_log").insert(changes);
        if (logErr) throw logErr;
      }

      const { error: itemErr } = await supabase
        .from(TOOL_BY_KEY[row.tool].itemsTable)
        .update({ review_status: "applied", reviewed_at: new Date().toISOString(), reviewed_by: user.id })
        .eq("id", row.id);
      if (itemErr) throw itemErr;
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message || "Could not apply this suggestion." };
    }
  }

  async function applyRow(row) {
    setApplyingKey(rowKey(row));
    setReviewError("");
    const result = await applySuggestionCore(row);
    if (result.ok) {
      setRows((prev) => prev.filter((r) => rowKey(r) !== rowKey(row)));
    } else {
      setReviewError(result.error);
    }
    setApplyingKey(null);
  }

  async function skipRow(row) {
    setApplyingKey(rowKey(row));
    setReviewError("");
    try {
      const { error: itemErr } = await supabase
        .from(TOOL_BY_KEY[row.tool].itemsTable)
        .update({ review_status: "skipped", reviewed_at: new Date().toISOString(), reviewed_by: user.id })
        .eq("id", row.id);
      if (itemErr) throw itemErr;
      setRows((prev) => prev.filter((r) => rowKey(r) !== rowKey(row)));
    } catch (err) {
      setReviewError(err.message || "Could not skip this suggestion.");
    } finally {
      setApplyingKey(null);
    }
  }

  // Applies every high-confidence suggestion currently matching the tool
  // filter and search box (ignoring the confidence tab itself, same as
  // each individual tool page's own bulk-apply button) in one click.
  async function bulkApplyHighConfidence() {
    const targets = toolSearchFiltered.filter((r) => r.suggestion?.confidence === "high");
    if (!targets.length) return;
    setBulkApplying(true);
    setReviewError("");
    setBulkProgress({ done: 0, total: targets.length });
    let done = 0;
    const failures = [];
    await runWithConcurrency(targets, APPLY_CONCURRENCY, async (row) => {
      const result = await applySuggestionCore(row);
      if (result.ok) {
        setRows((prev) => prev.filter((r) => rowKey(r) !== rowKey(row)));
      } else {
        failures.push(`${row.school?.name || `#${row.id}`}: ${result.error}`);
      }
      done++;
      setBulkProgress({ done, total: targets.length });
    });
    setBulkApplying(false);
    setFocusedIndex(0);
    if (failures.length > 0) {
      setReviewError(`Applied ${targets.length - failures.length} of ${targets.length} high-confidence suggestions. ${failures.length} failed: ${failures.slice(0, 3).join("; ")}${failures.length > 3 ? "…" : ""}`);
    }
  }

  // Keyboard shortcuts: Up/Down moves the focused row, A applies it, S
  // skips it -- identical contract to every individual tool page's own
  // review table, so a reviewer's muscle memory carries straight over.
  useEffect(() => {
    function onKeyDown(e) {
      if (loading || bulkApplying || applyingKey) return;
      const tag = (document.activeElement?.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      const key = e.key.toLowerCase();
      if (key === "arrowdown") {
        e.preventDefault();
        setFocusedIndex((i) => Math.min(i + 1, Math.max(0, visibleRows.length - 1)));
      } else if (key === "arrowup") {
        e.preventDefault();
        setFocusedIndex((i) => Math.max(i - 1, 0));
      } else if (key === "a") {
        e.preventDefault();
        if (focusedRow) applyRow(focusedRow);
      } else if (key === "s") {
        e.preventDefault();
        if (focusedRow) skipRow(focusedRow);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, bulkApplying, applyingKey, visibleRows, focusedRow]);

  if (!canReview) {
    return (
      <div className="view">
        <div className="notice danger">The Review Queue is limited to Verification Staff and System Admins.</div>
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
          <h1>Review Queue</h1>
          <p>Every pending suggestion across all four AI discovery tools — Coach-Info, Athletics-URL, MaxPreps, and Social Media — in one place.</p>
        </div>
        <button className="btn btn-sm" onClick={load} disabled={loading}>
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {error && (
        <div className="notice danger" style={{ marginBottom: 14 }}>
          {error}
        </div>
      )}

      {!loading && truncatedTools.length > 0 && (
        <div className="notice" style={{ marginBottom: 14 }}>
          Showing the first {ROWS_PER_TOOL_CAP} pending suggestions for {truncatedTools.join(", ")} — more are waiting; clear some of this queue or narrow
          the search to see further in.
        </div>
      )}

      {!loading && rows.length === 0 && (
        <div className="notice" style={{ marginBottom: 14 }}>
          Nothing waiting for review across any of the four tools right now.
        </div>
      )}

      {rows.length > 0 && (
        <div className="card" style={{ marginBottom: 14 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10, marginBottom: 12 }}>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              <button
                className="btn btn-sm"
                onClick={() => setToolFilter("all")}
                style={toolFilter === "all" ? { background: "#131a2b", borderColor: "#131a2b", color: "#fff" } : undefined}
              >
                All tools ({toolCounts.all})
              </button>
              {TOOLS.map((t) => (
                <button
                  key={t.key}
                  className="btn btn-sm"
                  onClick={() => setToolFilter(t.key)}
                  style={toolFilter === t.key ? { background: "#131a2b", borderColor: "#131a2b", color: "#fff" } : undefined}
                >
                  {t.label} ({toolCounts[t.key] || 0})
                </button>
              ))}
            </div>
            <button className="btn btn-gold btn-sm" onClick={bulkApplyHighConfidence} disabled={bulkApplying || confidenceCounts.high === 0}>
              {bulkApplying ? `Applying ${bulkProgress.done}/${bulkProgress.total}…` : `Apply All High-Confidence (${confidenceCounts.high})`}
            </button>
          </div>

          {reviewError && (
            <div className="notice danger" style={{ marginBottom: 10, fontSize: 12.5 }}>
              {reviewError}
            </div>
          )}

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
              placeholder="Search school or city…"
              style={{ maxWidth: 220, fontSize: 12.5 }}
            />
          </div>

          <div style={{ fontSize: 11.5, color: "#9aa1ab", marginBottom: 6 }}>
            Keyboard shortcuts: <strong>↑</strong>/<strong>↓</strong> move focus · <strong>A</strong> apply · <strong>S</strong> skip
          </div>

          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
              <thead>
                <tr style={{ borderBottom: "2px solid #e3e6ea", textAlign: "left" }}>
                  <th style={{ padding: "6px 8px", whiteSpace: "nowrap" }}>Tool</th>
                  <th style={{ padding: "6px 8px", whiteSpace: "nowrap" }}>School</th>
                  <th style={{ padding: "6px 8px" }}>Suggestion</th>
                  <th style={{ padding: "6px 8px", whiteSpace: "nowrap" }}>Confidence</th>
                  <th style={{ padding: "6px 8px", whiteSpace: "nowrap" }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((row) => {
                  const s = row.school;
                  const sug = row.suggestion;
                  if (!s || !sug) return null;
                  const applying = applyingKey === rowKey(row);
                  const isFocused = focusedRow && rowKey(focusedRow) === rowKey(row);
                  const tool = TOOL_BY_KEY[row.tool];
                  return (
                    <tr
                      key={rowKey(row)}
                      style={{
                        borderBottom: "1px solid #eef0f3",
                        verticalAlign: "top",
                        background: isFocused ? "#eef4fb" : undefined,
                        boxShadow: isFocused ? "inset 3px 0 0 #2f5fa8" : undefined,
                      }}
                    >
                      <td style={{ padding: "8px", whiteSpace: "nowrap" }}>
                        <span className="badge" style={{ fontSize: 11 }}>
                          {tool.label}
                        </span>
                      </td>
                      <td style={{ padding: "8px", whiteSpace: "nowrap" }}>
                        <div style={{ fontWeight: 600 }}>{s.name}</div>
                        <div style={{ color: "#9aa1ab" }}>
                          {s.city}, {s.state}
                        </div>
                      </td>
                      <td style={{ padding: "8px", minWidth: 260 }}>
                        {row.tool === "coach_info" &&
                          (() => {
                            const changedFields = COACH_INFO_FIELDS.filter((f) => {
                              const suggested = (sug[f] || "").trim();
                              return suggested && suggested !== (s[f] || "");
                            });
                            return changedFields.length === 0 ? (
                              <span style={{ color: "#9aa1ab" }}>No changes suggested</span>
                            ) : (
                              changedFields.map((f) => (
                                <div key={f}>
                                  <strong>{COACH_INFO_FIELD_LABELS[f]}:</strong> {sug[f]}
                                  {s[f] ? <span style={{ color: "#9aa1ab" }}> (was: {s[f]})</span> : null}
                                </div>
                              ))
                            );
                          })()}
                        {(row.tool === "athletics" || row.tool === "maxpreps") && (
                          <>
                            <div style={{ color: "#1e7145", fontWeight: 600 }}>{sug.best_url}</div>
                            <div style={{ color: "#9aa1ab" }}>Current: {s[row.tool === "athletics" ? "athletics_url" : "maxpreps_url"] || "(blank)"}</div>
                          </>
                        )}
                        {row.tool === "social" && (
                          <>
                            {sug.twitter_url && (
                              <div>
                                <strong>Twitter/X:</strong> {sug.twitter_url}
                                {s.hc_twitter ? <span style={{ color: "#9aa1ab" }}> (was: {s.hc_twitter})</span> : null}
                              </div>
                            )}
                            {sug.facebook_url && (
                              <div>
                                <strong>Facebook:</strong> {sug.facebook_url}
                                {s.hc_facebook ? <span style={{ color: "#9aa1ab" }}> (was: {s.hc_facebook})</span> : null}
                              </div>
                            )}
                          </>
                        )}
                        {sug.reasoning && <div style={{ marginTop: 4, fontStyle: "italic", color: "#9aa1ab" }}>"{sug.reasoning}"</div>}
                      </td>
                      <td style={{ padding: "8px", whiteSpace: "nowrap" }}>
                        <span className="badge" style={{ fontSize: 11, color: confidenceColor(sug.confidence) }}>
                          {sug.confidence}
                        </span>
                      </td>
                      <td style={{ padding: "8px", whiteSpace: "nowrap" }}>
                        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                          <button className="btn btn-gold btn-sm" disabled={applying || bulkApplying} onClick={() => applyRow(row)}>
                            {applying ? "…" : "Apply"}
                          </button>
                          <button className="btn btn-sm" disabled={applying || bulkApplying} onClick={() => skipRow(row)}>
                            Skip
                          </button>
                          <Link href={`/schools/${s.id}`} className="btn btn-sm">
                            Open
                          </Link>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {visibleRows.length === 0 && (
              <div className="empty-state">
                {toolSearchFiltered.length === 0
                  ? "Nothing left to review for this tool/search."
                  : "No suggestions match the current confidence filter and/or search -- try \"All\" or clearing the search box."}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
