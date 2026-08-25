"use client";
import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { useAuth } from "@/lib/auth-context";

// Bulk-batch version of the per-school "Find Social Media" button on the
// Data Quality Review page. That button (app/api/schools/[id]/discover-social
// -- unchanged, reused as-is here) is deliberately non-authoritative: it
// only returns candidate links for a human to review, and NEVER writes to
// the schools table itself. This page keeps that same contract at scale --
// it runs the search across many schools at once instead of one at a
// time, but every single link still has to be picked by a person before
// Apply writes anything.
//
// Different from Bulk MaxPreps/Athletics Discovery in one important way:
// discover-social needs an actual coach name to search on (it searches
// Twitter/X and Facebook scoped to that name, not just the school), so
// this only pulls schools that already HAVE a head coach last name on
// file. A school with no coach name yet should go through Suggest Coach
// Info (AI) first -- this tool can't help it.
//
// Also different: each school can be missing Twitter, Facebook, or both
// independently, and a field that's already filled in is shown as read-only
// ("Current: ...") rather than as another radio choice -- so this never
// offers to silently overwrite a value that's already on file. Only the
// genuinely-missing field(s) get a pick-a-link list.
//
// Each search costs two Serper.dev lookups (one per platform) -- free for
// the first 2,500 total, roughly $0.0003-$0.001 each after that -- see the
// comment in discover-social/route.js.
const BATCH_SIZES = [10, 25, 50, 100];
const DEFAULT_BATCH_SIZE = 25;
const SEARCH_CONCURRENCY = 3;

// Runs `worker` over `items` with at most `limit` in flight at once --
// keeps a batch of 50-100 searches from firing all at once against Serper
// while still finishing well inside a reasonable page-load wait.
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

export default function BulkSocialPage() {
  const supabase = getSupabaseBrowserClient();
  const { user, profile } = useAuth();
  const canReview = profile?.role === "verifier" || profile?.role === "sysadmin";

  const [missingCount, setMissingCount] = useState(null);
  const [batchSize, setBatchSize] = useState(DEFAULT_BATCH_SIZE);
  const [cursorId, setCursorId] = useState(0);

  const [loadingBatch, setLoadingBatch] = useState(false);
  const [batchError, setBatchError] = useState("");
  const [batch, setBatch] = useState([]); // [{id,name,city,state,hc_first_name,hc_last_name,hc_twitter,hc_facebook}]

  const [results, setResults] = useState({}); // schoolId -> {status:'searching'|'done'|'error', twitter?, facebook?, error?}
  const [selections, setSelections] = useState({}); // schoolId -> { twitter?: link|"", facebook?: link|"" }
  const [searching, setSearching] = useState(false);
  const [searchedCount, setSearchedCount] = useState(0);
  const [searchTotal, setSearchTotal] = useState(0);

  const [appliedIds, setAppliedIds] = useState(new Set());
  const [applying, setApplying] = useState(false);
  const [applyStatus, setApplyStatus] = useState("");
  const [applyError, setApplyError] = useState("");
  const [applyResult, setApplyResult] = useState(null); // {schools}
  const [sessionApplied, setSessionApplied] = useState(0);

  const refreshMissingCount = useCallback(async () => {
    try {
      const { count, error } = await supabase
        .from("schools")
        .select("id", { count: "exact", head: true })
        .not("hc_last_name", "is", null)
        .neq("hc_last_name", "")
        .or("hc_twitter.is.null,hc_twitter.eq.,hc_facebook.is.null,hc_facebook.eq.");
      if (error) throw error;
      setMissingCount(count ?? null);
    } catch (_) {
      // Non-critical -- the page still works without this count, so just
      // leave it blank rather than surfacing an error banner for it.
    }
  }, [supabase]);

  useEffect(() => {
    refreshMissingCount();
  }, [refreshMissingCount]);

  async function loadBatch() {
    setBatchError("");
    setLoadingBatch(true);
    setResults({});
    setSelections({});
    setAppliedIds(new Set());
    setApplyResult(null);
    setApplyError("");
    try {
      const { data, error } = await supabase
        .from("schools")
        .select("id,name,city,state,hc_first_name,hc_last_name,hc_twitter,hc_facebook")
        .gt("id", cursorId)
        .not("hc_last_name", "is", null)
        .neq("hc_last_name", "")
        .or("hc_twitter.is.null,hc_twitter.eq.,hc_facebook.is.null,hc_facebook.eq.")
        .order("id", { ascending: true })
        .limit(batchSize);
      if (error) throw error;
      const rows = data || [];
      setBatch(rows);
      if (rows.length) {
        setCursorId(rows[rows.length - 1].id);
      } else {
        setBatchError("No more schools with a coach name but missing Twitter/Facebook were found further down the list. Refresh this page to start again from the top.");
      }
    } catch (err) {
      setBatchError(err.message || "Could not load a batch of schools.");
    } finally {
      setLoadingBatch(false);
    }
  }

  async function searchOne(school) {
    setResults((prev) => ({ ...prev, [school.id]: { status: "searching" } }));
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const res = await fetch(`/api/schools/${school.id}/discover-social`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token}` },
        body: JSON.stringify({ hc_first_name: school.hc_first_name, hc_last_name: school.hc_last_name }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Search failed.");
      setResults((prev) => ({ ...prev, [school.id]: { status: "done", twitter: json.twitter || [], facebook: json.facebook || [] } }));
    } catch (err) {
      setResults((prev) => ({ ...prev, [school.id]: { status: "error", error: err.message || "Search failed." } }));
    }
  }

  async function runSearch() {
    const toSearch = batch.filter((s) => !appliedIds.has(s.id));
    if (!toSearch.length) return;
    setSearching(true);
    setSearchedCount(0);
    setSearchTotal(toSearch.length);
    await runWithConcurrency(toSearch, SEARCH_CONCURRENCY, async (s) => {
      await searchOne(s);
      setSearchedCount((n) => n + 1);
    });
    setSearching(false);
  }

  function selectCandidate(schoolId, field, link) {
    setSelections((prev) => ({ ...prev, [schoolId]: { ...prev[schoolId], [field]: link } }));
  }

  const selectedToApply = batch.filter((s) => {
    const sel = selections[s.id];
    return sel && (sel.twitter !== undefined || sel.facebook !== undefined) && !appliedIds.has(s.id);
  });

  async function applySelections() {
    if (!selectedToApply.length) return;
    setApplying(true);
    setApplyError("");
    setApplyResult(null);
    try {
      const changes = [];
      for (let i = 0; i < selectedToApply.length; i++) {
        const s = selectedToApply[i];
        setApplyStatus(`Applying ${i + 1} of ${selectedToApply.length}…`);
        const sel = selections[s.id];
        const update = {};
        if (sel.twitter !== undefined) update.hc_twitter = sel.twitter || null;
        if (sel.facebook !== undefined) update.hc_facebook = sel.facebook || null;
        const { error } = await supabase.from("schools").update(update).eq("id", s.id);
        if (error) throw error;
        if (sel.twitter !== undefined) {
          changes.push({ school_id: s.id, field_name: "hc_twitter", old_value: s.hc_twitter || null, new_value: sel.twitter || null, source: "Social media bulk discovery (reviewed)", changed_by: user.id });
        }
        if (sel.facebook !== undefined) {
          changes.push({ school_id: s.id, field_name: "hc_facebook", old_value: s.hc_facebook || null, new_value: sel.facebook || null, source: "Social media bulk discovery (reviewed)", changed_by: user.id });
        }
      }
      if (changes.length) {
        const { error: logError } = await supabase.from("school_change_log").insert(changes);
        if (logError) throw logError;
      }
      setAppliedIds((prev) => new Set([...prev, ...selectedToApply.map((s) => s.id)]));
      setApplyResult({ schools: selectedToApply.length });
      setSessionApplied((n) => n + selectedToApply.length);
      setMissingCount((prev) => (prev != null ? Math.max(0, prev - selectedToApply.length) : prev));
    } catch (err) {
      setApplyError(err.message || "Could not apply these updates.");
    } finally {
      setApplying(false);
      setApplyStatus("");
    }
  }

  if (!canReview) {
    return (
      <div className="view">
        <div className="notice danger">Bulk Social Media discovery is limited to Verification Staff and System Admins.</div>
      </div>
    );
  }

  const hasSearchedAny = Object.keys(results).length > 0;
  const allApplied = batch.length > 0 && batch.every((s) => appliedIds.has(s.id));

  function renderColumn(s, field, label, candidates) {
    const applied = appliedIds.has(s.id);
    const current = s[field === "twitter" ? "hc_twitter" : "hc_facebook"];
    const sel = selections[s.id];
    if (current) {
      return (
        <div>
          <div style={{ fontWeight: 600, fontSize: 12 }}>{label}</div>
          <div style={{ fontSize: 12, color: "#697386", wordBreak: "break-all" }}>Current: {current}</div>
        </div>
      );
    }
    return (
      <div>
        <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 4 }}>{label}</div>
        {applied ? (
          <div style={{ fontSize: 12, color: "#697386", wordBreak: "break-all" }}>{sel?.[field] || "(left blank)"}</div>
        ) : candidates && candidates.length ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {candidates.map((c) => (
              <label key={c.link} style={{ display: "flex", gap: 6, fontSize: 12, alignItems: "flex-start" }}>
                <input
                  type="radio"
                  name={`${field}-${s.id}`}
                  checked={sel?.[field] === c.link}
                  onChange={() => selectCandidate(s.id, field, c.link)}
                  style={{ marginTop: 3 }}
                />
                <span>
                  <div style={{ fontWeight: 600 }}>{c.title}</div>
                  <div style={{ color: "#2f5fa8", wordBreak: "break-all" }}>{c.link}</div>
                  {c.snippet && <div style={{ color: "#697386" }}>{c.snippet}</div>}
                </span>
              </label>
            ))}
            <label style={{ display: "flex", gap: 6, fontSize: 12, alignItems: "center" }}>
              <input type="radio" name={`${field}-${s.id}`} checked={sel?.[field] === ""} onChange={() => selectCandidate(s.id, field, "")} />
              None of these are correct
            </label>
          </div>
        ) : candidates ? (
          <div style={{ fontSize: 12, color: "#697386" }}>Nothing found.</div>
        ) : (
          <div style={{ fontSize: 12, color: "#9aa1ab" }}>Not searched yet.</div>
        )}
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
          <h1>Bulk Social Media Discovery</h1>
          <p>Search for a head coach's Twitter/X and Facebook across many schools at once, then pick the right link (or skip) for each one before anything is saved.</p>
        </div>
      </div>

      {sessionApplied > 0 && (
        <div className="notice info" style={{ marginBottom: 14 }}>
          Applied social media updates to {sessionApplied} school{sessionApplied === 1 ? "" : "s"} so far this session.
        </div>
      )}

      <div className="card" style={{ marginBottom: 14 }}>
        <h3>1. Load a batch of schools with a coach name but missing Twitter or Facebook</h3>
        <p style={{ fontSize: 12.5, color: "#697386", marginTop: -4 }}>
          Only pulls schools that already have a head coach last name on file -- this search needs a name to look for. Each school searched below costs two Serper.dev lookups (one per
          platform) -- free for the first 2,500 total, roughly $0.0003-$0.001 each after that.
        </p>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <label style={{ fontSize: 13 }}>
            Batch size:{" "}
            <select value={batchSize} onChange={(e) => setBatchSize(Number(e.target.value))} disabled={loadingBatch || searching}>
              {BATCH_SIZES.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <button className="btn btn-primary btn-sm" onClick={loadBatch} disabled={loadingBatch || searching}>
            {loadingBatch ? "Loading…" : batch.length ? "Load Next Batch" : "Load Batch"}
          </button>
          {missingCount != null && (
            <span style={{ fontSize: 12.5, color: "#697386" }}>
              {missingCount} school{missingCount === 1 ? "" : "s"} with a coach name still missing Twitter or Facebook
            </span>
          )}
        </div>
        {batchError && (
          <div className="notice danger" style={{ marginTop: 10 }}>
            {batchError}
          </div>
        )}
      </div>

      {batch.length > 0 && (
        <div className="card" style={{ marginBottom: 14 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, marginBottom: 8 }}>
            <h3 style={{ margin: 0 }}>
              2. Search &amp; review — {batch.length} school{batch.length === 1 ? "" : "s"} in this batch
            </h3>
            <button className="btn btn-sm" onClick={runSearch} disabled={searching || loadingBatch || allApplied}>
              {searching ? `Searching ${searchedCount} of ${searchTotal}…` : hasSearchedAny ? "Search Again" : `Search This Batch (${batch.length} lookups)`}
            </button>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {batch.map((s) => {
              const r = results[s.id];
              const applied = appliedIds.has(s.id);
              return (
                <div key={s.id} style={{ border: "1px solid #e3e6ea", borderRadius: 8, padding: 12 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 6 }}>
                    <div>
                      <strong>{s.name}</strong> — {[s.hc_first_name, s.hc_last_name].filter(Boolean).join(" ")}
                      <div style={{ fontSize: 12, color: "#697386" }}>
                        {s.city}, {s.state}
                      </div>
                    </div>
                    {applied && <span style={{ fontSize: 12, color: "#1e7145", fontWeight: 700 }}>✓ Applied</span>}
                  </div>

                  {r?.status === "searching" && <div style={{ fontSize: 12, color: "#697386", marginTop: 8 }}>Searching…</div>}
                  {r?.status === "error" && (
                    <div className="notice danger" style={{ marginTop: 8, fontSize: 12 }}>
                      {r.error}{" "}
                      <button type="button" className="btn btn-sm" style={{ marginLeft: 8 }} onClick={() => searchOne(s)}>
                        Retry
                      </button>
                    </div>
                  )}
                  {(!r || r.status === "done") && (
                    <div style={{ marginTop: 8, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
                      {renderColumn(s, "twitter", "Twitter / X", r?.twitter)}
                      {renderColumn(s, "facebook", "Facebook", r?.facebook)}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {applyError && (
            <div className="notice danger" style={{ marginTop: 12 }}>
              {applyError}
            </div>
          )}
          {applyResult && (
            <div className="notice info" style={{ marginTop: 12 }}>
              Applied social media updates to {applyResult.schools} school{applyResult.schools === 1 ? "" : "s"}.
            </div>
          )}
          <button className="btn btn-gold" style={{ marginTop: 12 }} onClick={applySelections} disabled={applying || selectedToApply.length === 0}>
            {applying ? applyStatus || "Applying…" : `Apply Selections for ${selectedToApply.length} School${selectedToApply.length === 1 ? "" : "s"}`}
          </button>
        </div>
      )}
    </div>
  );
}
