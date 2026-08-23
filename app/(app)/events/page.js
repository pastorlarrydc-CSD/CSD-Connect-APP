"use client";
import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { useAuth } from "@/lib/auth-context";

const EVENT_TYPES = [
  { value: "camp", label: "Camp" },
  { value: "combine", label: "Combine" },
  { value: "showcase", label: "Showcase" },
  { value: "tournament", label: "Tournament" },
  { value: "other", label: "Other" },
];
const TYPE_LABEL = Object.fromEntries(EVENT_TYPES.map((t) => [t.value, t.label]));
const TYPE_BADGE = {
  camp: "badge-unverified",
  combine: "badge-contacted",
  showcase: "badge-watching",
  tournament: "badge-offered",
  other: "badge-not-contacted",
};

const PLAN_STATUSES = [
  { value: "", label: "Not set" },
  { value: "planning", label: "Planning to attend" },
  { value: "confirmed", label: "Confirmed attending" },
  { value: "not_attending", label: "Not attending" },
];
const PLAN_BADGE = { planning: "badge-unverified", confirmed: "badge-committed", not_attending: "badge-not-contacted" };

const EMPTY_FORM = { name: "", event_type: "camp", event_date: "", end_date: "", city: "", state: "", level_of_play: "", source_url: "", notes: "" };

function fmtDateRange(start, end) {
  const s = new Date(start + "T00:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  if (!end || end === start) return s;
  const e = new Date(end + "T00:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  return `${s} – ${e}`;
}

export default function EventsPage() {
  const supabase = getSupabaseBrowserClient();
  const { user, profile, college } = useAuth();
  const canModerate = profile?.role === "verifier" || profile?.role === "sysadmin";

  const [events, setEvents] = useState([]);
  const [prospectCounts, setProspectCounts] = useState({});
  const [myPlans, setMyPlans] = useState({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  const [search, setSearch] = useState("");
  const [stateFilter, setStateFilter] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [showPast, setShowPast] = useState(false);

  const [showAdd, setShowAdd] = useState(false);
  const [addForm, setAddForm] = useState(EMPTY_FORM);
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState("");

  const [savingPlanId, setSavingPlanId] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    const { data: eventRows, error: eventsErr } = await supabase.from("events").select("*").order("event_date", { ascending: true });
    if (eventsErr) {
      setLoadError(eventsErr.message);
      setLoading(false);
      return;
    }
    setEvents(eventRows || []);

    const { data: linkRows } = await supabase.from("prospect_events").select("event_id");
    const counts = {};
    (linkRows || []).forEach((r) => {
      counts[r.event_id] = (counts[r.event_id] || 0) + 1;
    });
    setProspectCounts(counts);

    if (college?.id) {
      const { data: planRows } = await supabase.from("college_event_plans").select("event_id,status,notes").eq("college_id", college.id);
      const plans = {};
      (planRows || []).forEach((p) => {
        plans[p.event_id] = p;
      });
      setMyPlans(plans);
    }
    setLoading(false);
  }, [supabase, college]);

  useEffect(() => {
    load();
  }, [load]);

  function field(key, val) {
    setAddForm((prev) => ({ ...prev, [key]: val }));
  }

  async function submitAdd(e) {
    e.preventDefault();
    setAddError("");
    if (!addForm.name.trim() || !addForm.event_date) {
      setAddError("Event name and date are required.");
      return;
    }
    setAdding(true);
    try {
      const { error } = await supabase.from("events").insert({
        name: addForm.name.trim(),
        event_type: addForm.event_type,
        event_date: addForm.event_date,
        end_date: addForm.end_date || null,
        city: addForm.city.trim() || null,
        state: addForm.state.trim().slice(0, 2).toUpperCase() || null,
        level_of_play: addForm.level_of_play.trim() || null,
        source_url: addForm.source_url.trim() || null,
        notes: addForm.notes.trim() || null,
        created_by: user.id,
      });
      if (error) throw error;
      setAddForm(EMPTY_FORM);
      setShowAdd(false);
      await load();
    } catch (err) {
      setAddError(err.message || "Could not add this event.");
    } finally {
      setAdding(false);
    }
  }

  async function savePlan(eventId, status) {
    if (!college?.id) return;
    setSavingPlanId(eventId);
    try {
      if (!status) {
        await supabase.from("college_event_plans").delete().eq("college_id", college.id).eq("event_id", eventId);
      } else {
        await supabase
          .from("college_event_plans")
          .upsert({ college_id: college.id, event_id: eventId, status, updated_at: new Date().toISOString(), created_by: user.id }, { onConflict: "college_id,event_id" });
      }
      await load();
    } finally {
      setSavingPlanId(null);
    }
  }

  const todayStr = new Date().toISOString().slice(0, 10);
  const filtered = events.filter((ev) => {
    if (!showPast && ev.event_date < todayStr) return false;
    if (typeFilter && ev.event_type !== typeFilter) return false;
    if (stateFilter && ev.state !== stateFilter) return false;
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      const hay = `${ev.name} ${ev.city || ""} ${ev.state || ""}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  const stateOptions = [...new Set(events.map((e) => e.state).filter(Boolean))].sort();

  return (
    <div className="view">
      <div className="view-header">
        <div>
          <h1>Events</h1>
          <p>Camps, combines, and showcases — tag prospects to the events they&apos;ll be at, and mark which ones your staff plans to attend.</p>
        </div>
        <button className="btn btn-gold" onClick={() => setShowAdd((v) => !v)}>
          {showAdd ? "Cancel" : "+ Add Event"}
        </button>
      </div>

      {showAdd && (
        <div className="card" style={{ marginBottom: 14 }}>
          <h3>Add an Event</h3>
          {addError && <div className="notice danger" style={{ marginBottom: 10 }}>{addError}</div>}
          <form onSubmit={submitAdd}>
            <div className="grid grid-2" style={{ marginBottom: 8 }}>
              <div className="form-field">
                <label>Event Name</label>
                <input required value={addForm.name} onChange={(e) => field("name", e.target.value)} placeholder="e.g. Nashville Combine" />
              </div>
              <div className="form-field">
                <label>Type</label>
                <select value={addForm.event_type} onChange={(e) => field("event_type", e.target.value)}>
                  {EVENT_TYPES.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="form-field">
                <label>Start Date</label>
                <input required type="date" value={addForm.event_date} onChange={(e) => field("event_date", e.target.value)} />
              </div>
              <div className="form-field">
                <label>End Date (optional)</label>
                <input type="date" value={addForm.end_date} onChange={(e) => field("end_date", e.target.value)} />
              </div>
              <div className="form-field">
                <label>City</label>
                <input value={addForm.city} onChange={(e) => field("city", e.target.value)} />
              </div>
              <div className="form-field">
                <label>State</label>
                <input value={addForm.state} onChange={(e) => field("state", e.target.value)} placeholder="TN" maxLength={2} />
              </div>
              <div className="form-field">
                <label>Level of Play (optional)</label>
                <input value={addForm.level_of_play} onChange={(e) => field("level_of_play", e.target.value)} placeholder="D2/D3/NAIA/JUCO…" />
              </div>
              <div className="form-field">
                <label>Source URL (optional)</label>
                <input value={addForm.source_url} onChange={(e) => field("source_url", e.target.value)} placeholder="https://…" />
              </div>
            </div>
            <div className="form-field">
              <label>Notes (optional)</label>
              <input value={addForm.notes} onChange={(e) => field("notes", e.target.value)} placeholder="Registration info, contact, etc." />
            </div>
            <button className="btn btn-gold btn-sm" disabled={adding}>
              {adding ? "Adding…" : "Add Event"}
            </button>
          </form>
        </div>
      )}

      <div className="filters">
        <div className="field" style={{ minWidth: 200 }}>
          <label>Search</label>
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Name, city…" />
        </div>
        <div className="field">
          <label>Type</label>
          <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
            <option value="">All</option>
            {EVENT_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>State</label>
          <select value={stateFilter} onChange={(e) => setStateFilter(e.target.value)}>
            <option value="">All</option>
            {stateOptions.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        <label style={{ display: "flex", alignItems: "flex-end", gap: 6, fontSize: 12.5, paddingBottom: 7 }}>
          <input type="checkbox" checked={showPast} onChange={(e) => setShowPast(e.target.checked)} /> Show past events
        </label>
      </div>

      {loadError && <div className="notice danger" style={{ marginBottom: 14 }}>{loadError}</div>}

      <div className="card">
        <h3>{filtered.length} Event{filtered.length === 1 ? "" : "s"}</h3>
        {loading ? (
          <div className="empty-state">Loading…</div>
        ) : filtered.length === 0 ? (
          <div className="empty-state">No events match. Add one above.</div>
        ) : (
          filtered.map((ev) => {
            const myPlan = myPlans[ev.id]?.status || "";
            return (
              <div className="log-item" key={ev.id} style={{ paddingBottom: 12 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 8 }}>
                  <div>
                    <Link href={`/events/${ev.id}`} style={{ fontWeight: 700, fontSize: 14 }}>
                      {ev.name}
                    </Link>{" "}
                    <span className={TYPE_BADGE[ev.event_type]} style={{ padding: "2px 8px", borderRadius: 20, fontSize: 11, fontWeight: 700, marginLeft: 4 }}>
                      {TYPE_LABEL[ev.event_type]}
                    </span>
                    <div style={{ fontSize: 12.5, color: "#3c4658", marginTop: 3 }}>
                      {fmtDateRange(ev.event_date, ev.end_date)}
                      {(ev.city || ev.state) ? ` · ${[ev.city, ev.state].filter(Boolean).join(", ")}` : ""}
                    </div>
                    <div style={{ fontSize: 12, color: "#697386", marginTop: 2 }}>
                      {prospectCounts[ev.id] || 0} prospect{prospectCounts[ev.id] === 1 ? "" : "s"} tagged
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 6, alignItems: "center", flexShrink: 0 }}>
                    {myPlan && (
                      <span className={PLAN_BADGE[myPlan]} style={{ padding: "2px 8px", borderRadius: 20, fontSize: 11, fontWeight: 700 }}>
                        {PLAN_STATUSES.find((p) => p.value === myPlan)?.label}
                      </span>
                    )}
                    <select
                      value={myPlan}
                      disabled={savingPlanId === ev.id || !college?.id}
                      onChange={(e) => savePlan(ev.id, e.target.value)}
                      style={{ border: "1px solid var(--gray-200)", borderRadius: 6, padding: "4px 6px", fontSize: 12 }}
                    >
                      {PLAN_STATUSES.map((p) => (
                        <option key={p.value} value={p.value}>
                          {p.label}
                        </option>
                      ))}
                    </select>
                    <Link href={`/events/${ev.id}`} className="btn btn-sm">
                      Details
                    </Link>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
