"use client";

// Compare a List -- drop in a state's published head-coach list (school + coach) and see, in
// seconds, how it lines up with the schools we have on file.
//
//   Agree        same coach as ours; nothing to do.
//   Spelling     same person, spelled differently. When the email on file carries the LIST's
//                spelling, one click fixes our typo (every fix is re-checked on the server).
//   Different    a different coach. Queue them for AI checking: they are flagged for Needs
//                Review, where "Send N to AI verification" picks them up.
//   Not matched  list rows with no school of ours (often co-op teams; "Also on file at" shows
//                where that coach already sits in our data).
//
// Data comes from /api/admin/compare-list. Nothing is saved until a button is pressed and
// confirmed, and no coach, email or verification status is ever changed except the spelling fix.
import { useState, useMemo, useCallback, useRef, useEffect } from "react";
import Link from "next/link";
import Papa from "papaparse";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { useAuth } from "@/lib/auth-context";

const STATES = [
  ["AL", "Alabama"], ["AK", "Alaska"], ["AZ", "Arizona"], ["AR", "Arkansas"], ["CA", "California"], ["CO", "Colorado"], ["CT", "Connecticut"], ["DE", "Delaware"], ["DC", "District of Columbia"],
  ["FL", "Florida"], ["GA", "Georgia"], ["HI", "Hawaii"], ["ID", "Idaho"], ["IL", "Illinois"], ["IN", "Indiana"], ["IA", "Iowa"], ["KS", "Kansas"], ["KY", "Kentucky"], ["LA", "Louisiana"],
  ["ME", "Maine"], ["MD", "Maryland"], ["MA", "Massachusetts"], ["MI", "Michigan"], ["MN", "Minnesota"], ["MS", "Mississippi"], ["MO", "Missouri"], ["MT", "Montana"], ["NE", "Nebraska"],
  ["NV", "Nevada"], ["NH", "New Hampshire"], ["NJ", "New Jersey"], ["NM", "New Mexico"], ["NY", "New York"], ["NC", "North Carolina"], ["ND", "North Dakota"], ["OH", "Ohio"], ["OK", "Oklahoma"],
  ["OR", "Oregon"], ["PA", "Pennsylvania"], ["RI", "Rhode Island"], ["SC", "South Carolina"], ["SD", "South Dakota"], ["TN", "Tennessee"], ["TX", "Texas"], ["UT", "Utah"], ["VT", "Vermont"],
  ["VA", "Virginia"], ["WA", "Washington"], ["WV", "West Virginia"], ["WI", "Wisconsin"], ["WY", "Wyoming"],
];

const CATS = [
  { key: "attention", label: "Needs a look" },
  { key: "spelling", label: "Spelling" },
  { key: "differ", label: "Different coach" },
  { key: "first_name", label: "First name differs" },
  { key: "ours_blank", label: "We have no coach" },
  { key: "unmatched", label: "Not matched" },
  { key: "shared", label: "Shares a school" },
  { key: "list_blank", label: "List has no coach" },
  { key: "agree", label: "Agree" },
  { key: "all", label: "All" },
];
const CAT_LABEL = {
  agree: "Agree",
  spelling: "Spelling",
  differ: "Different coach",
  first_name: "First name differs",
  ours_blank: "We have no coach",
  unmatched: "Not matched",
  shared: "Shares a school",
  list_blank: "List has no coach",
};
const CAT_COLOR = { agree: "#1e7145", spelling: "#8a6100", differ: "#b3261e", first_name: "#8a6100", ours_blank: "#2f5fa8", unmatched: "#697386", shared: "#697386", list_blank: "#697386" };
const n = (x) => Number(x || 0).toLocaleString("en-US");

// The page remembers its inputs and results in this browser, so opening a school profile (or
// reloading, or stepping away) and coming back does not lose the pasted list or the comparison.
const STORE_KEY = "csd-compare-list-v1";
const STORE_MAX_AGE_MS = 12 * 60 * 60 * 1000;

function writeSaved(v) {
  if (!v) return;
  const base = { savedAt: Date.now(), state: v.state, label: v.label, pasted: v.pasted, fileName: v.fileName };
  try {
    window.localStorage.setItem(STORE_KEY, JSON.stringify({ ...base, result: v.result, fixSel: v.fixSel, queueSel: v.queueSel, filter: v.filter, search: v.search, shown: v.shown, report: v.report }));
  } catch {
    try {
      window.localStorage.setItem(STORE_KEY, JSON.stringify(base)); // too big for the results: keep at least the list
    } catch {
      // nothing more to do
    }
  }
}

function pickColumns(rows) {
  if (!rows.length) return { start: 0, school: 0, coach: 1 };
  const head = rows[0].map((c) => String(c || "").toLowerCase());
  const looksHeader = head.some((c) => /school|coach/.test(c));
  if (!looksHeader) return { start: 0, school: 0, coach: 1 };
  let school = head.findIndex((c) => /school/.test(c));
  let coach = head.findIndex((c) => /coach/.test(c));
  if (school < 0) school = coach === 0 ? 1 : 0;
  if (coach < 0) coach = school === 0 ? 1 : 0;
  return { start: 1, school, coach };
}

function parseList(text) {
  const parsed = Papa.parse(String(text || "").replace(/^﻿/, ""), { skipEmptyLines: true });
  const rows = (parsed.data || []).filter((r) => Array.isArray(r) && r.some((c) => String(c || "").trim()));
  const { start, school, coach } = pickColumns(rows);
  return rows
    .slice(start)
    .map((r) => ({ school: String(r[school] || "").trim(), coach: String(r[coach] || "").trim() }))
    .filter((r) => r.school);
}

const ourName = (r) => [r.ourFirst, r.ourLast].filter(Boolean).join(" ");

export default function CompareListPage() {
  const supabase = getSupabaseBrowserClient();
  const { profile } = useAuth();
  const canReview = profile?.role === "verifier" || profile?.role === "sysadmin";

  const [state, setState] = useState("");
  const [label, setLabel] = useState("");
  const [pasted, setPasted] = useState("");
  const [fileName, setFileName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null); // { state, schools_on_file, rows }
  const [filter, setFilter] = useState("attention");
  const [search, setSearch] = useState("");
  const [fixSel, setFixSel] = useState({}); // idx -> bool
  const [queueSel, setQueueSel] = useState({}); // idx -> bool
  const [confirming, setConfirming] = useState(""); // "fix" | "queue" | ""
  const [report, setReport] = useState(null); // last action outcome
  const [shown, setShown] = useState(60);
  const fileRef = useRef(null);
  const [ready, setReady] = useState(false); // saved work has been read back (or there was none)
  const [restored, setRestored] = useState(false);

  // Read back whatever was saved the last time this page was open.
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORE_KEY);
      const saved = raw ? JSON.parse(raw) : null;
      if (saved && Date.now() - (saved.savedAt || 0) < STORE_MAX_AGE_MS) {
        setState(saved.state || "");
        setLabel(saved.label || "");
        setPasted(saved.pasted || "");
        setFileName(saved.fileName || "");
        if (saved.result && Array.isArray(saved.result.rows)) {
          setResult(saved.result);
          setFixSel(saved.fixSel || {});
          setQueueSel(saved.queueSel || {});
          setFilter(saved.filter || "attention");
          setSearch(saved.search || "");
          setShown(saved.shown || 60);
          setReport(saved.report || null);
          setRestored(true);
        }
      }
    } catch {
      // storage can be blocked or empty; the page works the same without it
    }
    setReady(true);
  }, []);

  // Save after every change (a moment after the last one, so typing and ticking stay quick), and
  // once more the instant the page is left, so nothing typed in the last moment is lost.
  const latest = useRef(null);
  latest.current = { ready, state, label, pasted, fileName, result, fixSel, queueSel, filter, search, shown, report };
  useEffect(() => {
    if (!ready) return undefined;
    const t = setTimeout(() => writeSaved(latest.current), 400);
    return () => clearTimeout(t);
  }, [ready, state, label, pasted, fileName, result, fixSel, queueSel, filter, search, shown, report]);
  useEffect(() => {
    const flush = () => {
      if (latest.current?.ready) writeSaved(latest.current);
    };
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, []);

  function startOver() {
    setState("");
    setLabel("");
    setPasted("");
    setFileName("");
    setResult(null);
    setFixSel({});
    setQueueSel({});
    setFilter("attention");
    setSearch("");
    setShown(60);
    setReport(null);
    setConfirming("");
    setError("");
    setRestored(false);
    try {
      window.localStorage.removeItem(STORE_KEY);
    } catch {
      // ignore
    }
  }

  const authedFetch = useCallback(
    async (url, init = {}) => {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      return fetch(url, { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${session?.access_token}`, "Content-Type": "application/json" } });
    },
    [supabase]
  );

  async function onFile(e) {
    const f = e.target.files?.[0];
    if (!f) return;
    setFileName(f.name);
    setPasted(await f.text());
    if (!label) setLabel(f.name.replace(/\.[a-z0-9]+$/i, "").replace(/[_-]+/g, " "));
  }

  async function compare() {
    setError("");
    setReport(null);
    setConfirming("");
    const rows = parseList(pasted);
    if (!state) return setError("Pick the state first.");
    if (rows.length === 0) return setError("I could not find any schools in that list. It needs one column with the school and one with the coach.");
    setBusy(true);
    try {
      const res = await authedFetch("/api/admin/compare-list", { method: "POST", body: JSON.stringify({ action: "analyze", state, rows }) });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Could not compare that list.");
      setResult(json);
      setRestored(false);
      const fs = {};
      const qs = {};
      json.rows.forEach((r) => {
        if (r.category === "spelling" && r.fix) fs[r.idx] = true;
        // Only schools nobody has verified or flagged are pre-selected for AI checking.
        if (r.category === "differ" && r.schoolId && r.status !== "verified" && !r.needsReview) qs[r.idx] = true;
      });
      setFixSel(fs);
      setQueueSel(qs);
      setFilter("attention");
      setShown(60);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const rows = result?.rows || [];
  const counts = useMemo(() => {
    const c = {};
    rows.forEach((r) => (c[r.category] = (c[r.category] || 0) + 1));
    return c;
  }, [rows]);
  const attentionCount = (counts.spelling || 0) + (counts.differ || 0) + (counts.first_name || 0) + (counts.ours_blank || 0);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (filter === "attention") {
        if (!["spelling", "differ", "first_name", "ours_blank"].includes(r.category)) return false;
      } else if (filter !== "all" && r.category !== filter) return false;
      if (!q) return true;
      return `${r.listName} ${r.listCoach} ${r.schoolName} ${ourName(r)} ${r.city}`.toLowerCase().includes(q);
    });
  }, [rows, filter, search]);

  const fixable = rows.filter((r) => r.category === "spelling" && r.fix);
  const fixCount = fixable.filter((r) => fixSel[r.idx]).length;
  const queueable = rows.filter((r) => r.category === "differ" && r.schoolId && !r.needsReview);
  const queueCount = queueable.filter((r) => queueSel[r.idx]).length;

  async function runFix() {
    setBusy(true);
    setError("");
    try {
      const picks = fixable.filter((r) => fixSel[r.idx]);
      const res = await authedFetch("/api/admin/compare-list", {
        method: "POST",
        body: JSON.stringify({
          action: "fix_spelling",
          state: result.state,
          label: label || fileName || "coach list",
          fixes: picks.map((r) => ({ school_id: r.schoolId, old_first: r.ourFirst, old_last: r.ourLast, new_first: r.fix.first, new_last: r.fix.last })),
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Could not fix those.");
      const done = new Set(json.applied.map((a) => a.school_id));
      setResult((prev) => ({
        ...prev,
        rows: prev.rows.map((r) => (done.has(r.schoolId) && r.fix ? { ...r, ourFirst: r.fix.first, ourLast: r.fix.last, category: "agree", fix: null, note: "Spelling fixed" } : r)),
      }));
      setReport({ kind: "fix", applied: json.applied, skipped: json.skipped });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
      setConfirming("");
    }
  }

  async function runQueue() {
    setBusy(true);
    setError("");
    try {
      const picks = queueable.filter((r) => queueSel[r.idx]);
      const res = await authedFetch("/api/admin/compare-list", {
        method: "POST",
        body: JSON.stringify({
          action: "queue_review",
          state: result.state,
          label: label || fileName || "coach list",
          items: picks.map((r) => ({ school_id: r.schoolId, note: `${label || "Coach list"} shows ${r.listCoach}; we have ${ourName(r)}. Check which is current.` })),
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Could not queue those.");
      const done = new Set(json.queued.map((a) => a.school_id));
      setResult((prev) => ({ ...prev, rows: prev.rows.map((r) => (done.has(r.schoolId) ? { ...r, needsReview: true } : r)) }));
      setReport({ kind: "queue", queued: json.queued, skipped: json.skipped, state: result.state });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
      setConfirming("");
    }
  }

  function download() {
    const csv = Papa.unparse(
      rows.map((r) => ({
        "List school": r.listName,
        "List coach": r.listCoach,
        Result: CAT_LABEL[r.category] || r.category,
        "Our school": r.schoolName,
        City: r.city,
        "Our coach": ourName(r),
        "Our email": r.ourEmail,
        Status: r.status,
        "Also on file at": (r.alsoAt || []).join("; "),
        Note: r.note,
      }))
    );
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${(label || "coach-list").replace(/[^a-z0-9]+/gi, "-")}-comparison.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  if (!canReview) {
    return (
      <div className="view">
        <div className="notice danger">Only verification staff or a system admin can open Compare a List.</div>
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
          <h1>Compare a List</h1>
          <p>
            Drop in a state&apos;s published head-coach list (a school column and a coach column) and see how it lines up with our schools. Agreeing coaches are set aside, obvious spelling typos can be fixed in one
            click, and the schools with a different coach can be queued for AI checking.
          </p>
        </div>
      </div>

      <div className="card" style={{ padding: "12px 14px", marginBottom: 14 }}>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginBottom: 10 }}>
          <select value={state} onChange={(e) => setState(e.target.value)} className="input" style={{ minWidth: 190 }} aria-label="State">
            <option value="">Pick the state…</option>
            {STATES.map(([abbr, name]) => (
              <option key={abbr} value={abbr}>
                {name}
              </option>
            ))}
          </select>
          <input value={label} onChange={(e) => setLabel(e.target.value)} className="input" placeholder="Name of the list (for the change log), e.g. WIAA coaches Nov 2026" style={{ flex: "1 1 280px" }} />
          <input ref={fileRef} type="file" accept=".csv,.txt,.tsv" onChange={onFile} style={{ display: "none" }} />
          <button type="button" className="btn btn-sm" onClick={() => fileRef.current?.click()}>
            {fileName ? `File: ${fileName}` : "Choose a CSV file"}
          </button>
        </div>
        <textarea
          value={pasted}
          onChange={(e) => setPasted(e.target.value)}
          placeholder={"Or paste the list here: one school and one coach per line, for example\nAbbotsford,Jacob Knapmiller\nAlgoma,Wade Vandervest"}
          rows={5}
          className="input"
          style={{ width: "100%", fontFamily: "inherit", fontSize: 13 }}
        />
        <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 10, flexWrap: "wrap" }}>
          <button type="button" className="btn btn-gold" disabled={busy || !pasted.trim() || !state} onClick={compare}>
            {busy && !result ? "Comparing…" : "Compare"}
          </button>
          <span style={{ fontSize: 12.5, color: "#697386" }}>Read-only until you press a button below the results.</span>
          {(result || pasted) && (
            <button type="button" className="btn btn-sm" disabled={busy} onClick={startOver} style={{ marginLeft: "auto" }}>
              Start over
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="notice danger" style={{ marginBottom: 14 }}>
          {error}
        </div>
      )}

      {result && (
        <>
          {restored && (
            <div className="notice" style={{ marginBottom: 12, fontSize: 12.5 }}>
              Your last comparison was kept, so nothing was lost when you left this page. Press Compare to run it again, or Start over to clear it.
            </div>
          )}
          <div className="card" style={{ padding: "10px 14px", marginBottom: 12 }}>
            <div style={{ fontSize: 14, marginBottom: 6 }}>
              <strong>{n(rows.length)}</strong> list rows compared with <strong>{n(result.schools_on_file)}</strong> open schools in {result.state} ·{" "}
              <strong style={{ color: CAT_COLOR.agree }}>{n(counts.agree)}</strong> agree ({rows.length ? Math.round(((counts.agree || 0) / rows.length) * 100) : 0}%) ·{" "}
              <strong style={{ color: CAT_COLOR.differ }}>{n(attentionCount)}</strong> need a look
            </div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {CATS.map((c) => {
                const count = c.key === "all" ? rows.length : c.key === "attention" ? attentionCount : counts[c.key] || 0;
                if (c.key !== "all" && c.key !== "attention" && count === 0) return null;
                const on = filter === c.key;
                return (
                  <button
                    key={c.key}
                    type="button"
                    className={`btn btn-sm${on ? " btn-primary" : ""}`}
                    onClick={() => {
                      setFilter(c.key);
                      setShown(60);
                    }}
                  >
                    {c.label} ({n(count)})
                  </button>
                );
              })}
              <button type="button" className="btn btn-sm" onClick={download} style={{ marginLeft: "auto" }}>
                Download results (CSV)
              </button>
            </div>
          </div>

          {fixable.length > 0 && (
            <div className="card" style={{ padding: "10px 14px", marginBottom: 12, borderLeft: "4px solid #8a6100" }}>
              <strong>{n(fixable.length)} spelling typos with the email on our side of the list.</strong>
              <div style={{ fontSize: 12.5, color: "#697386", margin: "4px 0 8px" }}>
                In each of these the email on file carries the list&apos;s spelling, so the typo is almost certainly ours. Untick any you want to leave. Each fix is checked again before it is saved and logged.
              </div>
              {confirming === "fix" ? (
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <span style={{ fontSize: 13 }}>Fix the spelling at {n(fixCount)} schools?</span>
                  <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={runFix}>
                    {busy ? "Saving…" : `Yes, fix ${n(fixCount)}`}
                  </button>
                  <button type="button" className="btn btn-sm" disabled={busy} onClick={() => setConfirming("")}>
                    Cancel
                  </button>
                </div>
              ) : (
                <button type="button" className="btn btn-sm btn-gold" disabled={busy || fixCount === 0} onClick={() => setConfirming("fix")}>
                  Fix {n(fixCount)} spelling typos
                </button>
              )}
            </div>
          )}

          {queueable.length > 0 && (
            <div className="card" style={{ padding: "10px 14px", marginBottom: 12, borderLeft: "4px solid #b3261e" }}>
              <strong>{n(queueable.length)} schools where the list shows a different coach.</strong>
              <div style={{ fontSize: 12.5, color: "#697386", margin: "4px 0 8px" }}>
                Queueing flags them in Needs Review with a note naming both coaches. Schools nobody has verified are ticked; tick the verified ones too if you want them re-checked. Nothing about the coach, email or
                verified status changes.
              </div>
              {confirming === "queue" ? (
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <span style={{ fontSize: 13 }}>Queue {n(queueCount)} schools for AI checking?</span>
                  <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={runQueue}>
                    {busy ? "Saving…" : `Yes, queue ${n(queueCount)}`}
                  </button>
                  <button type="button" className="btn btn-sm" disabled={busy} onClick={() => setConfirming("")}>
                    Cancel
                  </button>
                </div>
              ) : (
                <button type="button" className="btn btn-sm btn-gold" disabled={busy || queueCount === 0} onClick={() => setConfirming("queue")}>
                  Queue {n(queueCount)} for AI checking
                </button>
              )}
            </div>
          )}

          {report && (
            <div className="notice" style={{ marginBottom: 12 }}>
              {report.kind === "fix" ? (
                <>
                  <strong>Fixed {n(report.applied.length)} spelling typos.</strong>
                  {report.skipped.length > 0 && (
                    <div style={{ fontSize: 12.5, marginTop: 4 }}>
                      Skipped {n(report.skipped.length)}: {report.skipped.map((s) => `${s.name || s.school_id} (${s.reason})`).join("; ")}
                    </div>
                  )}
                </>
              ) : (
                <>
                  <strong>Queued {n(report.queued.length)} schools for AI checking.</strong>{" "}
                  <Link href="/admin/needs-review" style={{ fontWeight: 600 }}>
                    Open Needs Review
                  </Link>{" "}
                  and pick {report.state}: they are at the top. Press &quot;Send N to AI verification&quot; there.
                  {report.skipped.length > 0 && (
                    <div style={{ fontSize: 12.5, marginTop: 4 }}>
                      Skipped {n(report.skipped.length)}: {report.skipped.map((s) => `${s.name || s.school_id} (${s.reason})`).join("; ")}
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          <input value={search} onChange={(e) => setSearch(e.target.value)} className="input" placeholder="Search school or coach…" style={{ width: "100%", marginBottom: 10 }} />

          {visible.length === 0 ? (
            <div className="empty-state">Nothing in this view.</div>
          ) : (
            visible.slice(0, shown).map((r) => (
              <div key={r.idx} className="card" style={{ marginBottom: 8, padding: "10px 14px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    {r.category === "spelling" && r.fix && (
                      <input type="checkbox" checked={Boolean(fixSel[r.idx])} onChange={(e) => setFixSel((p) => ({ ...p, [r.idx]: e.target.checked }))} aria-label="Include this fix" />
                    )}
                    {r.category === "differ" && r.schoolId && !r.needsReview && (
                      <input type="checkbox" checked={Boolean(queueSel[r.idx])} onChange={(e) => setQueueSel((p) => ({ ...p, [r.idx]: e.target.checked }))} aria-label="Include in the AI check queue" />
                    )}
                    <strong>{r.listName}</strong>
                    <span className="badge" style={{ color: CAT_COLOR[r.category], background: `${CAT_COLOR[r.category]}1a`, fontWeight: 600 }}>
                      {CAT_LABEL[r.category]}
                    </span>
                    {r.needsReview && r.category === "differ" && <span className="badge" style={{ color: "#8a6100", background: "#8a61001a" }}>Flagged for review</span>}
                  </div>
                  {r.schoolId && (
                    <Link href={`/schools/${r.schoolId}`} target="_blank" rel="noopener noreferrer" style={{ fontSize: 12 }}>
                      Open profile
                    </Link>
                  )}
                </div>
                <div style={{ fontSize: 13, marginTop: 4 }}>
                  List coach: <strong>{r.listCoach || "(none)"}</strong>
                  {r.schoolId ? (
                    <>
                      {" "}
                      · Ours: <strong>{ourName(r) || "(none)"}</strong>{" "}
                      <span style={{ color: "#697386" }}>
                        at {r.schoolName} ({r.city}){r.status ? ` · ${r.status.replace("_", " ")}` : ""}
                      </span>
                    </>
                  ) : null}
                </div>
                {r.fix && (
                  <div style={{ fontSize: 12.5, color: "#8a6100", marginTop: 2 }}>
                    Will change {ourName(r)} → {r.fix.first} {r.fix.last} (email on file: {r.ourEmail})
                  </div>
                )}
                {r.note && <div style={{ fontSize: 12.5, color: "#697386", marginTop: 2 }}>{r.note}</div>}
                {r.alsoAt && r.alsoAt.length > 0 && (
                  <div style={{ fontSize: 12.5, color: "#697386", marginTop: 2 }}>Also on file at: {r.alsoAt.slice(0, 4).join("; ")}</div>
                )}
              </div>
            ))
          )}
          {visible.length > shown && (
            <button type="button" className="btn btn-sm" onClick={() => setShown((x) => x + 60)}>
              Show 60 more ({n(visible.length - shown)} left)
            </button>
          )}
        </>
      )}
    </div>
  );
}
