"use client";
import { useEffect, useState, useCallback, useRef } from "react";
import { useParams, useRouter } from "next/navigation";
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

function fmtDateRange(start, end) {
  if (!start) return "";
  const s = new Date(start + "T00:00:00").toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });
  if (!end || end === start) return s;
  const e = new Date(end + "T00:00:00").toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });
  return `${s} – ${e}`;
}

function withProtocol(v) {
  if (!v) return null;
  const trimmed = v.trim();
  if (!trimmed) return null;
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

export default function EventDetailPage() {
  const { id } = useParams();
  const router = useRouter();
  const supabase = getSupabaseBrowserClient();
  const { user, profile, college } = useAuth();
  const canModerate = profile?.role === "verifier" || profile?.role === "sysadmin";

  const [event, setEvent] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  const [editing, setEditing] = useState(false);
  const [editForm, setEditForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [deleting, setDeleting] = useState(false);

  const [myPlan, setMyPlan] = useState(null);
  const [planStatus, setPlanStatus] = useState("");
  const [planNotes, setPlanNotes] = useState("");
  const [savingPlan, setSavingPlan] = useState(false);

  const [linked, setLinked] = useState([]);
  const [loadingLinked, setLoadingLinked] = useState(true);
  const [removingId, setRemovingId] = useState(null);

  const [prospectQuery, setProspectQuery] = useState("");
  const [prospectResults, setProspectResults] = useState([]);
  const [addingId, setAddingId] = useState(null);
  const [addNote, setAddNote] = useState("");
  const debounceRef = useRef(null);

  const canEdit = event && user && (event.created_by === user.id || canModerate);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    const { data, error } = await supabase.from("events").select("*").eq("id", id).maybeSingle();
    if (error) {
      setLoadError(error.message);
      setLoading(false);
      return;
    }
    if (!data) {
      setLoadError("Event not found.");
      setLoading(false);
      return;
    }
    setEvent(data);
    setLoading(false);

    if (college?.id) {
      const { data: plan } = await supabase.from("college_event_plans").select("*").eq("college_id", college.id).eq("event_id", id).maybeSingle();
      setMyPlan(plan || null);
      setPlanStatus(plan?.status || "");
      setPlanNotes(plan?.notes || "");
    }
  }, [supabase, id, college]);

  const loadLinked = useCallback(async () => {
    setLoadingLinked(true);
    const { data } = await supabase
      .from("prospect_events")
      .select("id,note,added_by,created_at,prospects(id,athlete_name,grad_year,position,level_of_play,school_id,schools(name,city,state))")
      .eq("event_id", id)
      .order("created_at", { ascending: false });
    setLinked(data || []);
    setLoadingLinked(false);
  }, [supabase, id]);

  useEffect(() => {
    load();
    loadLinked();
  }, [load, loadLinked]);

  function startEdit() {
    setEditForm({
      name: event.name,
      event_type: event.event_type,
      event_date: event.event_date,
      end_date: event.end_date || "",
      city: event.city || "",
      state: event.state || "",
      level_of_play: event.level_of_play || "",
      source_url: event.source_url || "",
      notes: event.notes || "",
    });
    setSaveError("");
    setEditing(true);
  }

  async function saveEdit(e) {
    e.preventDefault();
    setSaveError("");
    if (!editForm.name.trim() || !editForm.event_date) {
      setSaveError("Event name and date are required.");
      return;
    }
    setSaving(true);
    try {
      const { error } = await supabase
        .from("events")
        .update({
          name: editForm.name.trim(),
          event_type: editForm.event_type,
          event_date: editForm.event_date,
          end_date: editForm.end_date || null,
          city: editForm.city.trim() || null,
          state: editForm.state.trim().slice(0, 2).toUpperCase() || null,
          level_of_play: editForm.level_of_play.trim() || null,
          source_url: editForm.source_url.trim() || null,
          notes: editForm.notes.trim() || null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", id);
      if (error) throw error;
      setEditing(false);
      await load();
    } catch (err) {
      setSaveError(err.message || "Could not save changes.");
    } finally {
      setSaving(false);
    }
  }

  async function deleteEvent() {
    if (!confirm(`Delete "${event.name}"? This also removes every prospect tag and college plan for it. This cannot be undone.`)) return;
    setDeleting(true);
    try {
      const { error } = await supabase.from("events").delete().eq("id", id);
      if (error) throw error;
      router.push("/events");
    } catch (err) {
      alert(err.message || "Could not delete this event.");
      setDeleting(false);
    }
  }

  async function savePlan() {
    if (!college?.id) return;
    setSavingPlan(true);
    try {
      if (!planStatus) {
        await supabase.from("college_event_plans").delete().eq("college_id", college.id).eq("event_id", id);
        setMyPlan(null);
      } else {
        await supabase
          .from("college_event_plans")
          .upsert(
            { college_id: college.id, event_id: id, status: planStatus, notes: planNotes.trim() || null, updated_at: new Date().toISOString(), created_by: user.id },
            { onConflict: "college_id,event_id" }
          );
      }
    } finally {
      setSavingPlan(false);
    }
  }

  function searchProspects(value) {
    setProspectQuery(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (value.trim().length < 2) {
      setProspectResults([]);
      return;
    }
    debounceRef.current = setTimeout(async () => {
      const { data } = await supabase
        .from("prospects")
        .select("id,athlete_name,grad_year,position,schools(name)")
        .ilike("athlete_name", `%${value.trim()}%`)
        .limit(8);
      setProspectResults(data || []);
    }, 250);
  }

  async function addProspect(prospect) {
    setAddingId(prospect.id);
    try {
      const { error } = await supabase.from("prospect_events").insert({ prospect_id: prospect.id, event_id: id, note: addNote.trim() || null, added_by: user.id });
      if (error) throw error;
      setProspectQuery("");
      setProspectResults([]);
      setAddNote("");
      await loadLinked();
    } catch (err) {
      alert(err.message || "Could not add this prospect.");
    } finally {
      setAddingId(null);
    }
  }

  async function removeLink(linkId, addedBy) {
    if (!(addedBy === user.id || canModerate)) return;
    if (!confirm("Remove this prospect from the event?")) return;
    setRemovingId(linkId);
    try {
      await supabase.from("prospect_events").delete().eq("id", linkId);
      await loadLinked();
    } finally {
      setRemovingId(null);
    }
  }

  if (loading) {
    return (
      <div className="view">
        <div className="empty-state">Loading…</div>
      </div>
    );
  }
  if (loadError || !event) {
    return (
      <div className="view">
        <Link href="/events" className="btn btn-sm" style={{ marginBottom: 12, display: "inline-flex" }}>
          ← Back to Events
        </Link>
        <div className="notice danger">{loadError || "Event not found."}</div>
      </div>
    );
  }

  return (
    <div className="view">
      <Link href="/events" className="btn btn-sm" style={{ marginBottom: 12, display: "inline-flex" }}>
        ← Back to Events
      </Link>

      <div className="view-header">
        <div>
          <h1>
            {event.name}{" "}
            <span className={TYPE_BADGE[event.event_type]} style={{ padding: "3px 9px", borderRadius: 20, fontSize: 12, fontWeight: 700, verticalAlign: "middle" }}>
              {TYPE_LABEL[event.event_type]}
            </span>
          </h1>
          <p>
            {fmtDateRange(event.event_date, event.end_date)}
            {(event.city || event.state) ? ` · ${[event.city, event.state].filter(Boolean).join(", ")}` : ""}
          </p>
        </div>
        {canEdit && !editing && (
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn btn-sm" onClick={startEdit}>
              Edit
            </button>
            <button className="btn btn-sm btn-danger" onClick={deleteEvent} disabled={deleting}>
              {deleting ? "Deleting…" : "Delete"}
            </button>
          </div>
        )}
      </div>

      {editing ? (
        <div className="card" style={{ marginBottom: 14 }}>
          <h3>Edit Event</h3>
          {saveError && <div className="notice danger" style={{ marginBottom: 10 }}>{saveError}</div>}
          <form onSubmit={saveEdit}>
            <div className="grid grid-2" style={{ marginBottom: 8 }}>
              <div className="form-field">
                <label>Event Name</label>
                <input required value={editForm.name} onChange={(e) => setEditForm((f) => ({ ...f, name: e.target.value }))} />
              </div>
              <div className="form-field">
                <label>Type</label>
                <select value={editForm.event_type} onChange={(e) => setEditForm((f) => ({ ...f, event_type: e.target.value }))}>
                  {EVENT_TYPES.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="form-field">
                <label>Start Date</label>
                <input required type="date" value={editForm.event_date} onChange={(e) => setEditForm((f) => ({ ...f, event_date: e.target.value }))} />
              </div>
              <div className="form-field">
                <label>End Date (optional)</label>
                <input type="date" value={editForm.end_date} onChange={(e) => setEditForm((f) => ({ ...f, end_date: e.target.value }))} />
              </div>
              <div className="form-field">
                <label>City</label>
                <input value={editForm.city} onChange={(e) => setEditForm((f) => ({ ...f, city: e.target.value }))} />
              </div>
              <div className="form-field">
                <label>State</label>
                <input value={editForm.state} onChange={(e) => setEditForm((f) => ({ ...f, state: e.target.value }))} maxLength={2} />
              </div>
              <div className="form-field">
                <label>Level of Play (optional)</label>
                <input value={editForm.level_of_play} onChange={(e) => setEditForm((f) => ({ ...f, level_of_play: e.target.value }))} />
              </div>
              <div className="form-field">
                <label>Source URL (optional)</label>
                <input value={editForm.source_url} onChange={(e) => setEditForm((f) => ({ ...f, source_url: e.target.value }))} />
              </div>
            </div>
            <div className="form-field">
              <label>Notes (optional)</label>
              <input value={editForm.notes} onChange={(e) => setEditForm((f) => ({ ...f, notes: e.target.value }))} />
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn btn-sm btn-gold" disabled={saving}>
                {saving ? "Saving…" : "Save"}
              </button>
              <button type="button" className="btn btn-sm" onClick={() => setEditing(false)} disabled={saving}>
                Cancel
              </button>
            </div>
          </form>
        </div>
      ) : (
        (event.level_of_play || event.source_url || event.notes) && (
          <div className="card" style={{ marginBottom: 14 }}>
            <div className="kv">
              {event.level_of_play && (
                <>
                  <div className="k">Level of Play</div>
                  <div className="v">{event.level_of_play}</div>
                </>
              )}
              {event.source_url && (
                <>
                  <div className="k">More Info</div>
                  <div className="v">
                    <a href={withProtocol(event.source_url)} target="_blank" rel="noreferrer">
                      {event.source_url}
                    </a>
                  </div>
                </>
              )}
              {event.notes && (
                <>
                  <div className="k">Notes</div>
                  <div className="v" style={{ fontWeight: 400 }}>{event.notes}</div>
                </>
              )}
            </div>
          </div>
        )
      )}

      <div className="grid grid-2" style={{ marginBottom: 14 }}>
        <div className="card">
          <h3>{college?.name || "Your College"}&apos;s Plan</h3>
          <div className="form-field">
            <label>Status</label>
            <select value={planStatus} onChange={(e) => setPlanStatus(e.target.value)}>
              {PLAN_STATUSES.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>
          <div className="form-field">
            <label>Notes (optional, private to your college)</label>
            <input value={planNotes} onChange={(e) => setPlanNotes(e.target.value)} placeholder="Who's going, travel plans…" />
          </div>
          <button className="btn btn-sm btn-primary" onClick={savePlan} disabled={savingPlan || !college?.id}>
            {savingPlan ? "Saving…" : "Save Plan"}
          </button>
          {myPlan && <div style={{ fontSize: 11.5, color: "#697386", marginTop: 8 }}>Last updated {new Date(myPlan.updated_at).toLocaleDateString()}</div>}
        </div>

        <div className="card">
          <h3>Tag a Prospect</h3>
          <div className="form-field">
            <label>Search Prospects</label>
            <input value={prospectQuery} onChange={(e) => searchProspects(e.target.value)} placeholder="Athlete name…" />
          </div>
          {prospectResults.length > 0 && (
            <div style={{ border: "1px solid var(--gray-200)", borderRadius: 8, marginBottom: 8, maxHeight: 220, overflow: "auto" }}>
              {prospectResults.map((p) => (
                <div key={p.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 10px", borderBottom: "1px solid var(--gray-100)" }}>
                  <div style={{ fontSize: 12.5 }}>
                    {p.athlete_name}
                    {p.grad_year ? ` · ${p.grad_year}` : ""}
                    {p.position ? ` · ${p.position}` : ""}
                    {p.schools?.name ? ` · ${p.schools.name}` : ""}
                  </div>
                  <button className="btn btn-sm btn-primary" onClick={() => addProspect(p)} disabled={addingId === p.id}>
                    {addingId === p.id ? "Adding…" : "+ Add"}
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="form-field">
            <label>Note (optional, applies to next add)</label>
            <input value={addNote} onChange={(e) => setAddNote(e.target.value)} placeholder="e.g. confirmed via Hudl DM" />
          </div>
        </div>
      </div>

      <div className="card">
        <h3>Prospects Attending ({linked.length})</h3>
        {loadingLinked ? (
          <div className="empty-state">Loading…</div>
        ) : linked.length === 0 ? (
          <div className="empty-state">No prospects tagged to this event yet. Search above to add one.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Athlete</th>
                  <th>Grad Year</th>
                  <th>Position</th>
                  <th>School</th>
                  <th>Note</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {linked.map((l) => (
                  <tr key={l.id}>
                    <td>
                      <Link href={`/prospects/${l.prospects?.id}`}>{l.prospects?.athlete_name || "—"}</Link>
                    </td>
                    <td>{l.prospects?.grad_year || "—"}</td>
                    <td>{l.prospects?.position || "—"}</td>
                    <td>{l.prospects?.schools?.name ? `${l.prospects.schools.name}${l.prospects.schools.state ? `, ${l.prospects.schools.state}` : ""}` : "—"}</td>
                    <td>{l.note || "—"}</td>
                    <td>
                      {(l.added_by === user?.id || canModerate) && (
                        <button className="btn btn-sm btn-danger" onClick={() => removeLink(l.id, l.added_by)} disabled={removingId === l.id}>
                          {removingId === l.id ? "…" : "Remove"}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
