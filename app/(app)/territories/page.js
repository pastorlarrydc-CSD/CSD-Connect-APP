"use client";
import { useEffect, useState, useCallback } from "react";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { useAuth } from "@/lib/auth-context";

function parseStates(value) {
  return Array.from(
    new Set(
      value
        .split(",")
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean)
    )
  );
}

export default function TerritoriesPage() {
  const supabase = getSupabaseBrowserClient();
  const { college } = useAuth();

  const [territories, setTerritories] = useState([]);
  const [schoolCounts, setSchoolCounts] = useState({});
  const [loading, setLoading] = useState(true);

  const [form, setForm] = useState({ name: "", states: "", notes: "" });
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");

  const [editingId, setEditingId] = useState(null);
  const [editForm, setEditForm] = useState({ name: "", states: "", notes: "" });
  const [savingEdit, setSavingEdit] = useState(false);
  const [editError, setEditError] = useState("");
  const [deletingId, setDeletingId] = useState(null);

  const load = useCallback(async () => {
    if (!college?.id) {
      setLoading(false);
      return;
    }
    const { data } = await supabase
      .from("territories")
      .select("*")
      .eq("college_id", college.id)
      .order("created_at", { ascending: true });
    const list = data || [];
    setTerritories(list);

    // Cheap per-territory coverage count: how many schools fall in this
    // territory's states. Schools are a shared table, so this is just a
    // count query per territory, not a join -- fine at this data size.
    const counts = {};
    await Promise.all(
      list.map(async (t) => {
        if (!t.states?.length) {
          counts[t.id] = 0;
          return;
        }
        const { count } = await supabase
          .from("schools")
          .select("*", { count: "exact", head: true })
          .in("state", t.states);
        counts[t.id] = count || 0;
      })
    );
    setSchoolCounts(counts);
    setLoading(false);
  }, [supabase, college]);

  useEffect(() => {
    load();
  }, [load]);

  async function createTerritory(e) {
    e.preventDefault();
    setFormError("");
    if (!form.name.trim()) {
      setFormError("Give this territory a name.");
      return;
    }
    const states = parseStates(form.states);
    if (!states.length) {
      setFormError("Add at least one state abbreviation (e.g. TX, OK, LA).");
      return;
    }
    setSaving(true);
    try {
      const { error } = await supabase.from("territories").insert({
        college_id: college.id,
        name: form.name.trim(),
        states,
        notes: form.notes.trim() || null,
      });
      if (error) throw error;
      setForm({ name: "", states: "", notes: "" });
      await load();
    } catch (err) {
      setFormError(err.message || "Could not create this territory.");
    } finally {
      setSaving(false);
    }
  }

  function startEdit(t) {
    setEditError("");
    setEditingId(t.id);
    setEditForm({ name: t.name, states: (t.states || []).join(", "), notes: t.notes || "" });
  }

  function cancelEdit() {
    setEditingId(null);
    setEditError("");
  }

  async function saveEdit(e) {
    e.preventDefault();
    setEditError("");
    if (!editForm.name.trim()) {
      setEditError("Give this territory a name.");
      return;
    }
    const states = parseStates(editForm.states);
    if (!states.length) {
      setEditError("Add at least one state abbreviation (e.g. TX, OK, LA).");
      return;
    }
    setSavingEdit(true);
    try {
      const { error } = await supabase
        .from("territories")
        .update({ name: editForm.name.trim(), states, notes: editForm.notes.trim() || null })
        .eq("id", editingId);
      if (error) throw error;
      setEditingId(null);
      await load();
    } catch (err) {
      setEditError(err.message || "Could not save this territory.");
    } finally {
      setSavingEdit(false);
    }
  }

  async function deleteTerritory(t) {
    if (!confirm(`Delete "${t.name}"? This only removes the territory label -- schools and trips are unaffected.`)) return;
    setDeletingId(t.id);
    const { error } = await supabase.from("territories").delete().eq("id", t.id);
    setDeletingId(null);
    if (!error) load();
  }

  return (
    <div className="view">
      <div className="view-header">
        <div>
          <h1>Recruiting Territories</h1>
          <p>Group states into named regions to organize trip planning and coverage reporting</p>
        </div>
      </div>

      <div className="grid grid-2">
        <div>
          <div className="card" style={{ marginBottom: 14 }}>
            <h3>New Territory</h3>
            {formError && <div className="notice danger" style={{ marginBottom: 10 }}>{formError}</div>}
            <form onSubmit={createTerritory}>
              <div className="form-field">
                <label>Name</label>
                <input
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder="West Texas"
                />
              </div>
              <div className="form-field">
                <label>States (comma-separated)</label>
                <input
                  value={form.states}
                  onChange={(e) => setForm((f) => ({ ...f, states: e.target.value }))}
                  placeholder="TX, OK, NM"
                />
              </div>
              <div className="form-field">
                <label>Notes (optional)</label>
                <input
                  value={form.notes}
                  onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
                  placeholder="Focus on 4A/5A public schools…"
                />
              </div>
              <button className="btn btn-gold btn-sm" disabled={saving}>
                {saving ? "Creating…" : "Create Territory"}
              </button>
            </form>
          </div>
        </div>

        <div>
          {loading ? (
            <div className="empty-state">Loading territories…</div>
          ) : territories.length ? (
            territories.map((t) => (
              <div key={t.id} className="card" style={{ marginBottom: 14 }}>
                {editingId === t.id ? (
                  <form onSubmit={saveEdit}>
                    {editError && <div className="notice danger" style={{ marginBottom: 10 }}>{editError}</div>}
                    <div className="form-field">
                      <label>Name</label>
                      <input value={editForm.name} onChange={(e) => setEditForm((f) => ({ ...f, name: e.target.value }))} />
                    </div>
                    <div className="form-field">
                      <label>States (comma-separated)</label>
                      <input value={editForm.states} onChange={(e) => setEditForm((f) => ({ ...f, states: e.target.value }))} />
                    </div>
                    <div className="form-field">
                      <label>Notes</label>
                      <input value={editForm.notes} onChange={(e) => setEditForm((f) => ({ ...f, notes: e.target.value }))} />
                    </div>
                    <div style={{ display: "flex", gap: 8 }}>
                      <button className="btn btn-sm btn-primary" disabled={savingEdit}>
                        {savingEdit ? "Saving…" : "Save"}
                      </button>
                      <button type="button" className="btn btn-sm" onClick={cancelEdit} disabled={savingEdit}>
                        Cancel
                      </button>
                    </div>
                  </form>
                ) : (
                  <>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                      <h3 style={{ margin: 0 }}>{t.name}</h3>
                      <div style={{ display: "flex", gap: 6 }}>
                        <button className="btn btn-sm" onClick={() => startEdit(t)}>Edit</button>
                        <button className="btn btn-sm btn-danger" onClick={() => deleteTerritory(t)} disabled={deletingId === t.id}>
                          {deletingId === t.id ? "…" : "Delete"}
                        </button>
                      </div>
                    </div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8, marginBottom: 8 }}>
                      {(t.states || []).map((st) => (
                        <span key={st} className="badge badge-contacted">{st}</span>
                      ))}
                    </div>
                    <div className="kv">
                      <div className="k">Schools in territory</div>
                      <div className="v">{schoolCounts[t.id]?.toLocaleString() ?? "…"}</div>
                    </div>
                    {t.notes && <div className="notice" style={{ marginTop: 10 }}>{t.notes}</div>}
                  </>
                )}
              </div>
            ))
          ) : (
            <div className="card">
              <div className="empty-state">No territories yet. Create one to start grouping states for trip planning and reports.</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
