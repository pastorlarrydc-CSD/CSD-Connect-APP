"use client";
import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { useAuth } from "@/lib/auth-context";

// Bulk-batch version of the per-school "Find Athletics page" button on the
// Data Quality Review page. That button (app/api/schools/[id]/discover-athletics
// -- unchanged, reused as-is here) is deliberately non-authoritative: it
// only returns candidate links for a human to review, and NEVER writes to
// the schools table itself. This page keeps that same contract at scale --
// it runs the search across many schools at once instead of one at a
// time, but every single link still has to be picked by a person (or
// explicitly marked "none of these") before Apply writes anything.
//
// A good Athletics URL isn't just a nice-to-have field: Suggest Coach Info
// (AI) actively fetches and reads this page as a primary source, and
// Coach-Change Radar checks it FIRST on its nightly sweep (see
// lib/schoolRecheck.js) -- so cleaning these up in bulk has a direct
// downstream payoff for both of those.
//
// Each search costs a real Serper.dev lookup (free for the first 2,500,
// roughly $0.0003-$0.001 each after that -- see the comment in
// discover-athletics/route.js), so batches are capped and sized by the
// reviewer rather than running against the whole database at once.
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

export default function BulkAthleticsPage() {
  const supabase = getSupabaseBrowserClient();
  const { user, profile } = useAuth();
  const canReview = profile?.role === "verifier" || profile?.role === "sysadmin";

  const [missingCount, setMissingCount] = useState(null);
  const [batchSize, setBatchSize] = useState(DEFAULT_BATCH_SIZE);
  const [cursorId, setCursorId] = useState(0);

  const [loadingBatch, setLoadingBatch] = useState(false);
  const [batchError, setBatchError] = useState("");
  const [batch, setBatch] = useState([]); // [{id,name,city,state,athletics_url}]

  const [results, setResults] = useState({}); // schoolId -> {status:'searching'|'done'|'error', candidates?, error?}
  const [selections, setSelections] = useState({}); // schoolId -> chosen link ("" = explicitly "none of these")
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
        .or("athletics_url.is.null,athletics_url.eq.");
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
        .select("id,name,city,state,athletics_url")
        .gt("id", cursorId)
        .or("athletics_url.is.null,athletics_url.eq.")
        .order("id", { ascending: true })
        .limit(batchSize);
      if (error) throw error;
      const rows = data || [];
      setBatch(rows);
      if (rows.length) {
        setCursorId(rows[rows.length - 1].id);
      } else {
        setBatchError("No more schools without an Athletics link were found further down the list. Refresh this page to start again from the top.");
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
      const res = await fetch(`/api/schools/${school.id}/discover-athletics`, {
        method: "POST",
        headers: { Authorization: `Bearer ${session?.access_token}` },
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Search failed.");
      setResults((prev) => ({ ...prev, [school.id]: { status: "done", candidates: json.candidates || [] } }));
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

  function selectCandidate(schoolId, link) {
    setSelections((prev) => ({ ...prev, [schoolId]: link }));
  }

  const selectedToApply = batch.filter((s) => selections[s.id] && !appliedIds.has(s.id));

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
        const newVal = selections[s.id];
        const { error } = await supabase.from("schools").update({ athletics_url: newVal }).eq("id", s.id);
        if (error) throw error;
        changes.push({
          school_id: s.id,
          field_name: "athletics_url",
          old_value: s.athletics_url || null,
          new_value: newVal,
          source: "Athletics bulk discovery (reviewed)",
          changed_by: user.id,
        });
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
        <div className="notice danger">Bulk Athletics discovery is limited to Verification Staff and System Admins.</div>
      </div>
    );
  }

  const hasSearchedAny = Object.keys(results).length > 0;
  const allApplied = batch.length > 0 && batch.every((s) => appliedIds.has(s.id));

  return (
    <div className="view">
      <Link href="/admin" className="btn btn-sm" style={{ marginBottom: 12, display: "inline-flex" }}>
        ← Back to Admin
      </Link>
      <div className="view-header">
        <div>
          <h1>Bulk Athletics Discovery</h1>
          <p>Search for a school's athletics department site across many schools at once, then pick the right link (or skip) for each one before anything is saved.</p>
        </div>
      </div>

      {sessionApplied > 0 && (
        <div className="notice info" style={{ marginBottom: 14 }}>
          Applied {sessionApplied} Athletics link{sessionApplied === 1 ? "" : "s"} so far this session.
        </div>
      )}

      <div className="card" style={{ marginBottom: 14 }}>
        <h3>1. Load a batch of schools missing an Athletics link</h3>
        <p style={{ fontSize: 12.5, color: "#697386", marginTop: -4 }}>
          Pulls schools straight from the database that currently have nothing in the Athletics URL field. Each school searched below costs one Serper.dev lookup -- free for the first 2,500,
          roughly $0.0003-$0.001 each after that.
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
              {missingCount} school{missingCount === 1 ? "" : "s"} still missing an Athletics link
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
                      <strong>{s.name}</strong>
                      <div style={{ fontSize: 12, color: "#697386" }}>
                        {s.city}, {s.state}
                      </div>
                    </div>
                    {applied && (
                      <span style={{ fontSize: 12, color: "#1e7145", fontWeight: 700 }}>✓ Applied</span>
                    )}
                  </div>

                  {!r && <div style={{ fontSize: 12, color: "#9aa1ab", marginTop: 8 }}>Not searched yet.</div>}
                  {r?.status === "searching" && <div style={{ fontSize: 12, color: "#697386", marginTop: 8 }}>Searching…</div>}
                  {r?.status === "error" && (
                    <div className="notice danger" style={{ marginTop: 8, fontSize: 12 }}>
                      {r.error}{" "}
                      <button type="button" className="btn btn-sm" style={{ marginLeft: 8 }} onClick={() => searchOne(s)}>
                        Retry
                      </button>
                    </div>
                  )}
                  {r?.status === "done" && applied && (
                    <div style={{ fontSize: 12, color: "#697386", marginTop: 8, wordBreak: "break-all" }}>{selections[s.id]}</div>
                  )}
                  {r?.status === "done" &&
                    !applied &&
                    (r.candidates.length ? (
                      <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 6 }}>
                        {r.candidates.map((c) => (
                          <label key={c.link} style={{ display: "flex", gap: 8, fontSize: 12.5, alignItems: "flex-start" }}>
                            <input
                              type="radio"
                              name={`ath-${s.id}`}
                              checked={selections[s.id] === c.link}
                              onChange={() => selectCandidate(s.id, c.link)}
                              style={{ marginTop: 3 }}
                            />
                            <span>
                              <div style={{ fontWeight: 600 }}>{c.title}</div>
                              <div style={{ color: "#2f5fa8", wordBreak: "break-all" }}>{c.link}</div>
                              {c.snippet && <div style={{ color: "#697386" }}>{c.snippet}</div>}
                            </span>
                          </label>
                        ))}
                        <label style={{ display: "flex", gap: 8, fontSize: 12.5, alignItems: "center" }}>
                          <input type="radio" name={`ath-${s.id}`} checked={selections[s.id] === ""} onChange={() => selectCandidate(s.id, "")} />
                          None of these are correct
                        </label>
                      </div>
                    ) : (
                      <div style={{ fontSize: 12, color: "#697386", marginTop: 8 }}>No Athletics page found.</div>
                    ))}
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
              Applied {applyResult.schools} Athletics link{applyResult.schools === 1 ? "" : "s"}.
            </div>
          )}
          <button className="btn btn-gold" style={{ marginTop: 12 }} onClick={applySelections} disabled={applying || selectedToApply.length === 0}>
            {applying ? applyStatus || "Applying…" : `Apply ${selectedToApply.length} Selected Link${selectedToApply.length === 1 ? "" : "s"}`}
          </button>
        </div>
      )}
    </div>
  );
}
