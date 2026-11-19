"use client";

// Text Outreach -- one organized worklist of every coach phone number worth texting to learn
// who the NEW head coach is and what their cell number is.
//
// Priority order: (1) numbers listed as the head coach's cell at 2+ schools, (2) numbers of a
// coach who left one school and is live at another, (3) departed coaches whose old cell is still
// on record. Each card has the number, why it is on the list, a ready-to-send message, and a
// place to type the reply straight into the school's record.
//
// Texts are sent by hand from Larry's own phone or computer (no texting service): "Text it" opens
// the messaging app with the number and message filled in, and Copy buttons are the fallback.
// Data comes from /api/admin/text-outreach. The page remembers its tab, filters and scroll spot
// (lib/rememberPlace.js) so leaving and coming back lands on the same card.
import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import Link from "next/link";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { useAuth } from "@/lib/auth-context";
import { readPlace, writePlace, clearPlace, captureScrollAnchor, restoreScrollAnchor } from "@/lib/rememberPlace";

const PLACE_KEY = "text-outreach";
const PAGE_SIZE = 25;
const TABS = [
  { key: "to_text", label: "To text" },
  { key: "waiting", label: "Waiting for reply" },
  { key: "replied", label: "Replied: save details" },
  { key: "parked", label: "No answer / skipped" },
  { key: "done", label: "Done" },
];
const TYPES = [
  { key: "all", label: "All" },
  { key: "duplicate", label: "Same number at 2+ schools" },
  { key: "moved", label: "Coach moved" },
  { key: "departed", label: "Old coach's number" },
];
const TYPE_LABEL = { duplicate: "Same number at 2+ schools", moved: "Coach moved", departed: "Old coach's number" };
const TYPE_COLOR = { duplicate: "#b3261e", moved: "#1e7145", departed: "#8a6100" };

const fmtPhone = (p) => (p && p.length === 10 ? `(${p.slice(0, 3)}) ${p.slice(3, 6)}-${p.slice(6)}` : p || "");
const fmtCell = (v) => {
  const d = String(v || "").replace(/\D/g, "").slice(-10);
  return d.length === 10 ? fmtPhone(d) : String(v || "");
};
const n = (x) => Number(x || 0).toLocaleString("en-US");

function daysAgo(ts) {
  if (!ts) return "";
  const d = Math.floor((Date.now() - new Date(ts).getTime()) / 86400000);
  return d <= 0 ? "today" : d === 1 ? "yesterday" : `${d} days ago`;
}

function stageOf(item) {
  if (item.all_saved) return "done";
  if (item.status === "texted") return "waiting";
  if (item.status === "replied") return "replied";
  if (item.status === "no_answer" || item.status === "wrong_number" || item.status === "skip") return "parked";
  return "to_text";
}

const schoolLabel = (s) => `${s.name} (${s.city}, ${s.state})`;
function joinList(list) {
  if (list.length <= 1) return list[0] || "";
  if (list.length === 2) return `${list[0]} and ${list[1]}`;
  return `${list.slice(0, -1).join(", ")}, and ${list[list.length - 1]}`;
}

// The message Larry sends. Short, one question, with an easy way out.
function buildMessage(item) {
  const lasts =
    item.type === "duplicate"
      ? Array.from(new Set(item.targets.map((t) => t.last).filter(Boolean)))
      : [item.targets[0]?.departed_last].filter(Boolean);
  const hi = lasts.length === 1 ? `Hi Coach ${lasts[0]}` : "Hi Coach";
  const intro = `${hi}, this is Larry DeVooght with Collegiate Sports Data.`;
  const stop = " Reply STOP and I won't text again.";
  if (item.type === "duplicate") {
    return `${intro} This number is on file for the head coach at ${joinList(item.targets.map(schoolLabel))}. Which of those are you at now? And who is the head coach at the other school, with their best cell number? Thank you!${stop}`;
  }
  if (item.type === "moved") {
    const now = joinList(item.context.map(schoolLabel));
    const was = joinList(item.targets.map(schoolLabel));
    return `${intro} I have this number for you at ${now}, and earlier at ${was}. Are you at ${now} now? Who is the head football coach at ${was} now, and what is their best cell number? Thank you!${stop}`;
  }
  return `${intro} I have this number for the head football coach at ${joinList(item.targets.map(schoolLabel))}. Who is the head coach there now, and what is the best cell number for them? Thank you!${stop}`;
}

function whyLine(item) {
  if (item.type === "duplicate") return `Listed as the head coach's cell at ${item.targets.length} schools. One coach can't be head coach at all of them, so at least one record is out of date.`;
  if (item.type === "moved") {
    const who = item.targets[0]?.departed_name || "The old coach";
    return `${who} was head coach at ${item.targets.map((t) => t.name).join(", ")}. The same number is now live at ${item.context.map((c) => c.name).join(", ")}, so they probably moved there.`;
  }
  const t = item.targets[0];
  return `${t?.departed_name || "The old coach"} was the head coach here, and this was their cell.${t?.cell_never_changed ? " It is still the cell on file for the current coach, so it is probably out of date." : ""}`;
}

function PhoneCard({ item, stage, draft, forms, busy, errorMap, copied, onDraft, onCopy, onStatus, onForm, onSave, formOpen, onToggleForm }) {
  const msg = draft ?? buildMessage(item);
  const smsHref = `sms:+1${item.phone}?body=${encodeURIComponent(msg)}`;
  const isBusy = Boolean(busy[item.key]);
  const statusLabel = { texted: "Texted", replied: "Replied", no_answer: "No answer", wrong_number: "Wrong number", skip: "Skipped" }[item.status] || "";
  const showForm = formOpen || stage === "replied";
  return (
    <div data-place-row={item.key} className="card" style={{ marginBottom: 10, padding: "12px 14px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <strong style={{ fontSize: 18 }}>{fmtPhone(item.phone)}</strong>
          <button type="button" className="btn btn-sm" onClick={() => onCopy(`num-${item.key}`, fmtPhone(item.phone))}>
            {copied === `num-${item.key}` ? "Copied!" : "Copy number"}
          </button>
          <span className="badge" style={{ color: TYPE_COLOR[item.type], background: `${TYPE_COLOR[item.type]}1a`, fontWeight: 600 }}>
            {TYPE_LABEL[item.type]}
          </span>
        </div>
        {statusLabel && (
          <span className="badge" style={{ color: "#2f5fa8", background: "#2f5fa81a", fontWeight: 600 }}>
            {statusLabel}
            {item.status === "texted" && item.texted_at ? ` ${daysAgo(item.texted_at)}` : ""}
          </span>
        )}
      </div>

      <div style={{ fontSize: 12.5, color: "#697386", margin: "6px 0 8px" }}>{whyLine(item)}</div>

      {item.targets.map((t) => (
        <div key={t.id} style={{ fontSize: 13, padding: "4px 0", borderTop: "1px solid #eef0f3" }}>
          <strong>{t.name}</strong> <span style={{ color: "#697386" }}>· {t.city}, {t.state}</span>{" "}
          <Link href={`/schools/${t.id}`} target="_blank" rel="noopener noreferrer" style={{ fontSize: 12 }}>
            Open profile
          </Link>
          <div style={{ fontSize: 12.5, color: "#697386" }}>
            Coach on file: {[t.first, t.last].filter(Boolean).join(" ") || "(none)"} · Cell on file: {t.cell_on_file ? fmtCell(t.cell_on_file) : "(none)"}
            {t.saved_at ? <span style={{ color: "#1e7145", fontWeight: 600 }}> · ✓ saved {daysAgo(t.saved_at)}</span> : null}
          </div>
        </div>
      ))}
      {item.context.map((c) => (
        <div key={c.id} style={{ fontSize: 12.5, color: "#1e7145", padding: "2px 0" }}>
          Now live at: <strong>{c.name}</strong> ({c.city}, {c.state}) · coach on file {[c.first, c.last].filter(Boolean).join(" ") || "(none)"}
        </div>
      ))}

      <div style={{ marginTop: 8 }}>
        <textarea
          value={msg}
          onChange={(e) => onDraft(item.key, e.target.value)}
          rows={4}
          style={{ width: "100%", border: "1px solid #dde1e7", borderRadius: 8, padding: "8px 10px", fontSize: 13, fontFamily: "inherit", resize: "vertical" }}
          aria-label={`Message to ${fmtPhone(item.phone)}`}
        />
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 6, alignItems: "center" }}>
          <a href={smsHref} className="btn btn-sm btn-gold" style={{ textDecoration: "none" }}>
            Text it
          </a>
          <button type="button" className="btn btn-sm" onClick={() => onCopy(`msg-${item.key}`, msg)}>
            {copied === `msg-${item.key}` ? "Copied!" : "Copy message"}
          </button>
          <span style={{ color: "#c5cad3" }}>|</span>
          {stage === "to_text" && (
            <button type="button" className="btn btn-sm btn-primary" disabled={isBusy} onClick={() => onStatus(item, "texted")}>
              I texted this
            </button>
          )}
          {stage !== "to_text" && stage !== "done" && (
            <button type="button" className="btn btn-sm" disabled={isBusy} onClick={() => onStatus(item, "reset")}>
              Back to "To text"
            </button>
          )}
          {(stage === "to_text" || stage === "waiting") && (
            <>
              <button type="button" className="btn btn-sm" disabled={isBusy} onClick={() => onStatus(item, "no_answer")}>
                No answer
              </button>
              <button type="button" className="btn btn-sm" disabled={isBusy} onClick={() => onStatus(item, "wrong_number")}>
                Wrong number
              </button>
              <button type="button" className="btn btn-sm" disabled={isBusy} onClick={() => onStatus(item, "skip")}>
                Skip
              </button>
            </>
          )}
          {stage !== "done" && stage !== "replied" && (
            <button type="button" className="btn btn-sm" onClick={() => onToggleForm(item.key)}>
              {formOpen ? "Hide reply form" : "They replied: enter it"}
            </button>
          )}
        </div>
      </div>

      {errorMap[item.key] && (
        <div className="notice danger" style={{ marginTop: 8, fontSize: 12.5 }}>
          {errorMap[item.key]}
        </div>
      )}

      {showForm && stage !== "done" && (
        <div style={{ marginTop: 10, padding: "8px 10px", background: "#f7f8fa", border: "1px solid #dde1e7", borderRadius: 8 }}>
          <div style={{ fontSize: 12, color: "#697386", marginBottom: 6 }}>
            Type what they told you. The first and last name start as the coach on file; change them only if the coach is different. Changing the name flags that school for an email check, because the email on file may belong to the old coach.
          </div>
          {item.targets
            .filter((t) => !t.saved_at)
            .map((t) => {
              const fk = `${item.phone}|${t.id}`;
              const f = forms[fk] || { first: t.first, last: t.last, cell: "" };
              const bKey = `save-${fk}`;
              return (
                <div key={t.id} style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 6 }}>
                  <span style={{ fontSize: 12.5, minWidth: 160 }}>
                    <strong>{t.name}</strong>
                  </span>
                  <input
                    value={f.first}
                    onChange={(e) => onForm(fk, { ...f, first: e.target.value })}
                    placeholder="Coach first name"
                    aria-label={`Head coach first name at ${t.name}`}
                    style={{ border: "1px solid #dde1e7", borderRadius: 7, padding: "5px 8px", width: 130 }}
                  />
                  <input
                    value={f.last}
                    onChange={(e) => onForm(fk, { ...f, last: e.target.value })}
                    placeholder="Coach last name"
                    aria-label={`Head coach last name at ${t.name}`}
                    style={{ border: "1px solid #dde1e7", borderRadius: 7, padding: "5px 8px", width: 130 }}
                  />
                  <input
                    value={f.cell}
                    onChange={(e) => onForm(fk, { ...f, cell: e.target.value })}
                    placeholder="New coach's cell"
                    aria-label={`New head coach cell at ${t.name}`}
                    style={{ border: "1px solid #dde1e7", borderRadius: 7, padding: "5px 8px", width: 150 }}
                  />
                  <button type="button" className="btn btn-sm btn-primary" disabled={Boolean(busy[bKey])} onClick={() => onSave(item, t, f, false)}>
                    {busy[bKey] ? "Saving…" : "Save to school"}
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={Boolean(busy[bKey])}
                    title="Use when they confirm the cell on file is right for the current coach"
                    onClick={() => onSave(item, t, f, true)}
                  >
                    Number is right
                  </button>
                </div>
              );
            })}
        </div>
      )}
    </div>
  );
}

export default function TextOutreachPage() {
  const supabase = getSupabaseBrowserClient();
  const { profile } = useAuth();
  const canReview = profile?.role === "verifier" || profile?.role === "sysadmin";

  const [savedPlace] = useState(() => readPlace(PLACE_KEY));
  const restoreRef = useRef(savedPlace ? { anchorId: savedPlace.anchorId ?? null, anchorTop: savedPlace.anchorTop || 0, scrollY: savedPlace.scrollY || 0 } : null);
  const scrollRef = useRef({ scrollY: 0, anchorId: null, anchorTop: 0 });

  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [tab, setTab] = useState(TABS.some((t) => t.key === savedPlace?.tab) ? savedPlace.tab : "to_text");
  const [typeFilter, setTypeFilter] = useState(TYPES.some((t) => t.key === savedPlace?.typeFilter) ? savedPlace.typeFilter : "all");
  const [stateFilter, setStateFilter] = useState(typeof savedPlace?.stateFilter === "string" ? savedPlace.stateFilter : "all");
  const [search, setSearch] = useState(typeof savedPlace?.search === "string" ? savedPlace.search : "");
  const [shown, setShown] = useState(Number(savedPlace?.shown) > 0 ? Number(savedPlace.shown) : PAGE_SIZE);
  const [drafts, setDrafts] = useState({});
  const [forms, setForms] = useState({});
  const [busy, setBusy] = useState({});
  const [errorMap, setErrorMap] = useState({});
  const [copied, setCopied] = useState("");
  const [openForms, setOpenForms] = useState({});
  const [resumedNote, setResumedNote] = useState(false);
  const copyTimer = useRef(null);
  useEffect(() => () => clearTimeout(copyTimer.current), []);

  const authedFetch = useCallback(
    async (url, init = {}) => {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      return fetch(url, { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${session?.access_token}`, "Content-Type": "application/json" } });
    },
    [supabase]
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await authedFetch("/api/admin/text-outreach");
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Could not load the list.");
      setItems(json.items || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [authedFetch]);

  useEffect(() => {
    if (canReview) load();
  }, [canReview, load]);

  // ---- filters ----
  const stateOptions = useMemo(() => Array.from(new Set(items.flatMap((i) => i.targets.map((t) => t.state)))).sort(), [items]);
  const base = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter((i) => {
      if (typeFilter !== "all" && i.type !== typeFilter) return false;
      if (stateFilter !== "all" && !i.targets.some((t) => t.state === stateFilter)) return false;
      if (q) {
        const hay = [i.phone, fmtPhone(i.phone), ...i.targets.flatMap((t) => [t.name, t.city, t.first, t.last, t.departed_name]), ...i.context.map((c) => c.name)].filter(Boolean).join(" ").toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [items, typeFilter, stateFilter, search]);
  const counts = useMemo(() => {
    const c = { to_text: 0, waiting: 0, replied: 0, parked: 0, done: 0 };
    base.forEach((i) => {
      c[stageOf(i)] += 1;
    });
    return c;
  }, [base]);
  const rows = useMemo(() => base.filter((i) => stageOf(i) === tab), [base, tab]);

  const totals = useMemo(() => {
    const t = { all: items.length, texted: 0, done: 0 };
    items.forEach((i) => {
      const s = stageOf(i);
      if (s === "done") t.done += 1;
      if (s !== "to_text") t.texted += 1;
    });
    return t;
  }, [items]);

  // ---- remember where I am (see lib/rememberPlace.js) ----
  const placeRef = useRef({});
  placeRef.current = { tab, typeFilter, stateFilter, search, shown };
  const saveSoon = useCallback(() => {
    if (restoreRef.current) return;
    scrollRef.current = captureScrollAnchor();
    writePlace(PLACE_KEY, { ...placeRef.current, ...scrollRef.current });
  }, []);
  useEffect(() => {
    const t = setTimeout(saveSoon, 250);
    return () => clearTimeout(t);
  }, [tab, typeFilter, stateFilter, search, shown, saveSoon]);
  useEffect(() => {
    let t = null;
    function onScroll() {
      clearTimeout(t);
      t = setTimeout(saveSoon, 200);
    }
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      clearTimeout(t);
    };
  }, [saveSoon]);
  useEffect(() => {
    if (!restoreRef.current) return undefined;
    const t = setTimeout(() => {
      restoreRef.current = null;
    }, 15000);
    return () => clearTimeout(t);
  }, []);
  useEffect(() => {
    const r = restoreRef.current;
    if (!r || loading) return;
    restoreRef.current = null;
    // Show the "picked up where you left off" note when anything beyond the default view came back.
    if (r.anchorId !== null || r.scrollY > 0 || tab !== "to_text" || typeFilter !== "all" || stateFilter !== "all" || search) setResumedNote(true);
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        restoreScrollAnchor(r);
        saveSoon();
      })
    );
  }, [loading, saveSoon, tab, typeFilter, stateFilter, search]);

  function startFresh() {
    setTab("to_text");
    setTypeFilter("all");
    setStateFilter("all");
    setSearch("");
    setShown(PAGE_SIZE);
    setResumedNote(false);
    clearPlace(PLACE_KEY);
    window.scrollTo(0, 0);
  }
  function changeFilter(setter) {
    return (v) => {
      setter(v);
      setShown(PAGE_SIZE);
    };
  }

  // ---- actions ----
  function copyText(key, text) {
    const done = () => {
      setCopied(key);
      clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(""), 1500);
    };
    try {
      navigator.clipboard.writeText(text).then(done, done);
    } catch (_) {
      done();
    }
  }
  const setBusyFlag = (k, v) => setBusy((p) => ({ ...p, [k]: v }));
  const setErr = (k, msg) => setErrorMap((p) => ({ ...p, [k]: msg }));

  async function setStatus(item, status) {
    setBusyFlag(item.key, true);
    setErr(item.key, "");
    try {
      const res = await authedFetch("/api/admin/text-outreach", { method: "POST", body: JSON.stringify({ action: "status", phone: item.phone, school_ids: item.targets.map((t) => t.id), status }) });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Could not save.");
      setItems((prev) => prev.map((i) => (i.key === item.key ? { ...i, status: json.status, texted_at: json.texted_at || (status === "texted" ? new Date().toISOString() : i.texted_at) } : i)));
    } catch (err) {
      setErr(item.key, err.message);
    } finally {
      setBusyFlag(item.key, false);
    }
  }

  async function saveSchool(item, target, form, confirmOnly) {
    const bKey = `save-${item.phone}|${target.id}`;
    setBusyFlag(bKey, true);
    setErr(item.key, "");
    try {
      const res = await authedFetch("/api/admin/text-outreach", {
        method: "POST",
        body: JSON.stringify({ action: "save", phone: item.phone, school_id: target.id, first_name: form.first, last_name: form.last, cell: form.cell, confirm_only: confirmOnly }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Could not save.");
      setItems((prev) =>
        prev.map((i) => {
          if (i.key !== item.key) return i;
          const targets = i.targets.map((t) =>
            t.id === target.id
              ? {
                  ...t,
                  saved_at: json.saved_at,
                  first: confirmOnly ? t.first : form.first || t.first,
                  last: confirmOnly ? t.last : form.last || t.last,
                  cell_on_file: confirmOnly ? t.cell_on_file : form.cell || t.cell_on_file,
                }
              : t
          );
          return { ...i, targets, status: i.status || "replied", all_saved: targets.every((t) => t.saved_at) };
        })
      );
    } catch (err) {
      setErr(item.key, err.message);
    } finally {
      setBusyFlag(bKey, false);
    }
  }

  if (!canReview) {
    return (
      <div className="view">
        <div className="notice danger">Only verification staff or a system admin can open Text Outreach.</div>
      </div>
    );
  }

  const pctDone = totals.all > 0 ? Math.round((totals.done / totals.all) * 100) : 0;

  return (
    <div className="view">
      <Link href="/admin" className="btn btn-sm" style={{ marginBottom: 12, display: "inline-flex" }}>
        ← Back to Admin
      </Link>
      <div className="view-header">
        <div>
          <h1>Text Outreach</h1>
          <p>
            Every coach number worth a text, in the order that gets answers fastest: the same number at two schools first, then coaches who moved, then departed coaches. Send the message, type the reply into the
            card, and it saves to the school.
          </p>
        </div>
      </div>

      {error && (
        <div className="notice danger" style={{ marginBottom: 14 }}>
          {error}{" "}
          <button type="button" className="btn btn-sm" onClick={load}>
            Try again
          </button>
        </div>
      )}

      {loading ? (
        <div className="empty-state">Loading the list…</div>
      ) : (
        <>
          <div className="card" style={{ marginBottom: 12, padding: "10px 14px" }}>
            <div style={{ fontSize: 14 }}>
              <strong>{n(totals.all)}</strong> numbers on the list · <strong>{n(totals.texted)}</strong> texted · <strong>{n(totals.done)}</strong> finished ({pctDone}%)
            </div>
            <div style={{ height: 8, background: "#e8ebf0", borderRadius: 6, marginTop: 6, overflow: "hidden" }}>
              <div style={{ width: `${pctDone}%`, height: "100%", background: "#1e7145" }} />
            </div>
          </div>

          {resumedNote && (
            <div style={{ fontSize: 12, color: "#697386", marginBottom: 8, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <span>↩ Picked up where you left off.</span>
              <button type="button" className="btn btn-sm" onClick={startFresh}>
                Start fresh
              </button>
              <button type="button" className="btn btn-sm" onClick={() => setResumedNote(false)}>
                Hide
              </button>
            </div>
          )}

          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
            {TABS.map((t) => (
              <button
                key={t.key}
                type="button"
                className="btn btn-sm"
                onClick={() => changeFilter(setTab)(t.key)}
                style={tab === t.key ? { background: "#0b5fff", borderColor: "#0b5fff", color: "#fff" } : undefined}
              >
                {t.label} ({n(counts[t.key])})
              </button>
            ))}
          </div>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
            <label style={{ fontSize: 12.5 }}>
              Type:{" "}
              <select value={typeFilter} onChange={(e) => changeFilter(setTypeFilter)(e.target.value)} style={{ border: "1px solid #dde1e7", borderRadius: 7, padding: "5px 8px" }}>
                {TYPES.map((t) => (
                  <option key={t.key} value={t.key}>
                    {t.label}
                  </option>
                ))}
              </select>
            </label>
            <label style={{ fontSize: 12.5 }}>
              State:{" "}
              <select value={stateFilter} onChange={(e) => changeFilter(setStateFilter)(e.target.value)} style={{ border: "1px solid #dde1e7", borderRadius: 7, padding: "5px 8px" }}>
                <option value="all">All states</option>
                {stateOptions.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>
            <input
              type="search"
              value={search}
              onChange={(e) => changeFilter(setSearch)(e.target.value)}
              placeholder="Search school, coach or number"
              style={{ border: "1px solid #dde1e7", borderRadius: 7, padding: "6px 9px", minWidth: 220 }}
            />
            <button type="button" className="btn btn-sm" onClick={load}>
              Refresh
            </button>
          </div>

          {rows.length === 0 ? (
            <div className="empty-state">{tab === "to_text" ? "Nothing left to text with these filters." : "Nothing here yet."}</div>
          ) : (
            <>
              {rows.slice(0, shown).map((item) => (
                <PhoneCard
                  key={item.key}
                  item={item}
                  stage={stageOf(item)}
                  draft={drafts[item.key]}
                  forms={forms}
                  busy={busy}
                  errorMap={errorMap}
                  copied={copied}
                  formOpen={Boolean(openForms[item.key])}
                  onDraft={(k, v) => setDrafts((p) => ({ ...p, [k]: v }))}
                  onCopy={copyText}
                  onStatus={setStatus}
                  onForm={(k, v) => setForms((p) => ({ ...p, [k]: v }))}
                  onSave={saveSchool}
                  onToggleForm={(k) => setOpenForms((p) => ({ ...p, [k]: !p[k] }))}
                />
              ))}
              {rows.length > shown && (
                <button type="button" className="btn btn-sm" onClick={() => setShown((x) => x + PAGE_SIZE)}>
                  Show {Math.min(PAGE_SIZE, rows.length - shown)} more ({n(rows.length - shown)} left in this view)
                </button>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
