"use client";
import { useEffect, useState, useCallback, useRef } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { optimizeRoute } from "@/lib/routeOptimizer";
import "@/lib/auth-context";

const STATUS_LABEL = { planning: "Planning", active: "Active", completed: "Completed" };

export default function TripDetailPage() {
  const { id } = useParams();
  const router = useRouter();
  const supabase = getSupabaseBrowserClient();

  const [trip, setTrip] = useState(null);
  const [stops, setStops] = useState([]);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");

  // school search / add-stop state
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [selectedSchool, setSelectedSchool] = useState(null);
  const [addDay, setAddDay] = useState(1);
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState("");
  const searchTimer = useRef(null);
  const [removingId, setRemovingId] = useState(null);

  // reorder state
  const [movingId, setMovingId] = useState(null);
  const [moveError, setMoveError] = useState("");

  // route optimizer state
  const [optimizingDay, setOptimizingDay] = useState(null);
  const [optimizeError, setOptimizeError] = useState({});
  const [optimizeSummary, setOptimizeSummary] = useState({});

  // fixed-appointment editor state
  const [editingStopId, setEditingStopId] = useState(null);
  const [editFixed, setEditFixed] = useState(false);
  const [editTime, setEditTime] = useState("");
  const [savingFixed, setSavingFixed] = useState(false);
  const [fixedError, setFixedError] = useState("");

  const load = useCallback(async () => {
    const { data: t } = await supabase.from("trips").select("*").eq("id", id).maybeSingle();
    setTrip(t || null);
    if (t) {
      const { data: s } = await supabase
        .from("trip_stops")
        .select("*, schools(id,name,city,state,hc_first_name,hc_last_name,hc_email,hc_cell,addr1,lat,lon)")
        .eq("trip_id", id)
        .order("day_number", { ascending: true })
        .order("sequence_order", { ascending: true });
      setStops(s || []);
      // default the "add" day to the last day used, or 1 if none yet
      if (s && s.length) {
        setAddDay(Math.max(...s.map((row) => row.day_number || 1)));
      }
    }
    setLoading(false);
  }, [supabase, id]);

  useEffect(() => {
    load();
  }, [load]);

  function searchSchools(value) {
    setQuery(value);
    setSelectedSchool(null);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    if (value.trim().length < 2) {
      setResults([]);
      return;
    }
    searchTimer.current = setTimeout(async () => {
      const { data } = await supabase
        .from("schools")
        .select("id,name,city,state")
        .or(`name.ilike.%${value.trim()}%,city.ilike.%${value.trim()}%`)
        .order("name", { ascending: true })
        .limit(8);
      setResults(data || []);
    }, 250);
  }

  function pickSchool(school) {
    setSelectedSchool(school);
    setQuery(`${school.name} — ${school.city}, ${school.state}`);
    setResults([]);
  }

  async function addStop(e) {
    e.preventDefault();
    setAddError("");
    if (!selectedSchool) {
      setAddError("Search for a school and select it from the list first.");
      return;
    }
    // avoid adding the same school to the trip twice
    if (stops.some((s) => s.school_id === selectedSchool.id)) {
      setAddError("That school is already on this trip.");
      return;
    }
    setAdding(true);
    try {
      const day = Math.max(1, parseInt(addDay, 10) || 1);
      const stopsOnDay = stops.filter((s) => s.day_number === day);
      const nextSeq = stopsOnDay.length ? Math.max(...stopsOnDay.map((s) => s.sequence_order || 0)) + 1 : 0;
      const { error } = await supabase.from("trip_stops").insert({
        trip_id: id,
        college_id: trip.college_id,
        school_id: selectedSchool.id,
        day_number: day,
        sequence_order: nextSeq,
      });
      if (error) throw error;
      setQuery("");
      setSelectedSchool(null);
      load();
    } catch (err) {
      setAddError(err.message || "Could not add this school to the trip.");
    } finally {
      setAdding(false);
    }
  }

  async function removeStop(stopId) {
    if (!confirm("Remove this school from the trip?")) return;
    setRemovingId(stopId);
    const { error } = await supabase.from("trip_stops").delete().eq("id", stopId);
    setRemovingId(null);
    if (!error) load();
  }

  async function moveStop(dayStops, stop, direction) {
    const idx = dayStops.findIndex((s) => s.id === stop.id);
    const swapIdx = direction === "up" ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= dayStops.length) return;
    const other = dayStops[swapIdx];
    setMoveError("");
    setMovingId(stop.id);
    try {
      const { error: e1 } = await supabase.from("trip_stops").update({ sequence_order: other.sequence_order }).eq("id", stop.id);
      if (e1) throw e1;
      const { error: e2 } = await supabase.from("trip_stops").update({ sequence_order: stop.sequence_order }).eq("id", other.id);
      if (e2) throw e2;
      await load();
    } catch (err) {
      setMoveError(err.message || "Could not reorder these stops.");
    } finally {
      setMovingId(null);
    }
  }

  function openFixedEditor(stop) {
    setFixedError("");
    setEditingStopId(stop.id);
    setEditFixed(!!stop.is_fixed_appointment);
    setEditTime(stop.appointment_time || "");
  }

  function cancelFixedEditor() {
    setEditingStopId(null);
    setFixedError("");
  }

  async function saveFixedAppointment(e) {
    e.preventDefault();
    setFixedError("");
    setSavingFixed(true);
    try {
      const { error } = await supabase
        .from("trip_stops")
        .update({
          is_fixed_appointment: editFixed,
          appointment_time: editFixed ? editTime.trim() || null : null,
        })
        .eq("id", editingStopId);
      if (error) throw error;
      setEditingStopId(null);
      await load();
    } catch (err) {
      setFixedError(err.message || "Could not save this appointment.");
    } finally {
      setSavingFixed(false);
    }
  }

  // Optimizes one day's route. Fixed-appointment stops (is_fixed_appointment)
  // stay exactly where they are -- they act as anchors, and the flexible
  // stops around them get optimized within the segment between anchors.
  async function optimizeDay(day, dayStops) {
    setOptimizeError((prev) => ({ ...prev, [day]: "" }));
    setOptimizeSummary((prev) => ({ ...prev, [day]: null }));

    if (trip.start_lat == null || trip.start_lon == null || trip.end_lat == null || trip.end_lon == null) {
      setOptimizeError((prev) => ({
        ...prev,
        [day]: "This trip needs a geocoded starting and ending location before routes can be optimized. Edit the trip's locations and try again.",
      }));
      return;
    }

    const missingCoords = dayStops.filter((s) => s.schools?.lat == null || s.schools?.lon == null);
    if (missingCoords.length) {
      setOptimizeError((prev) => ({
        ...prev,
        [day]: `${missingCoords.length} school${missingCoords.length === 1 ? "" : "s"} on this day (${missingCoords
          .map((s) => s.schools?.name || "unknown")
          .join(", ")}) don't have map coordinates on file, so this day can't be optimized yet.`,
      }));
      return;
    }

    setOptimizingDay(day);
    try {
      const globalStart = { lat: trip.start_lat, lon: trip.start_lon };
      const globalEnd = { lat: trip.end_lat, lon: trip.end_lon };

      // Walk the day in order, splitting into segments of flexible stops
      // bounded by fixed-appointment anchors (or the trip's start/end).
      const finalOrder = [];
      let segmentStart = globalStart;
      let buffer = [];
      let totalBefore = 0;
      let totalAfter = 0;

      const flushBuffer = (segmentEnd) => {
        if (!buffer.length) return;
        const asPoints = buffer.map((s) => ({ ...s, lat: s.schools.lat, lon: s.schools.lon }));
        const result = optimizeRoute({ start: segmentStart, stops: asPoints, end: segmentEnd });
        totalBefore += result.unoptimizedMiles;
        totalAfter += result.totalMiles;
        // result.stops are the reordered `asPoints` entries -- map back to the
        // original stop objects by id.
        result.stops.forEach((pt) => {
          finalOrder.push(buffer.find((b) => b.id === pt.id));
        });
        buffer = [];
      };

      for (const stop of dayStops) {
        if (stop.is_fixed_appointment) {
          flushBuffer({ lat: stop.schools.lat, lon: stop.schools.lon });
          finalOrder.push(stop);
          segmentStart = { lat: stop.schools.lat, lon: stop.schools.lon };
        } else {
          buffer.push(stop);
        }
      }
      flushBuffer(globalEnd);

      // Persist new sequence_order values (only where changed).
      const updates = finalOrder
        .map((stop, idx) => ({ stop, idx }))
        .filter(({ stop, idx }) => stop.sequence_order !== idx);

      for (const { stop, idx } of updates) {
        const { error } = await supabase.from("trip_stops").update({ sequence_order: idx }).eq("id", stop.id);
        if (error) throw error;
      }

      setOptimizeSummary((prev) => ({
        ...prev,
        [day]: { before: totalBefore, after: totalAfter, changed: updates.length > 0 },
      }));
      await load();
    } catch (err) {
      setOptimizeError((prev) => ({ ...prev, [day]: err.message || "Could not optimize this day's route." }));
    } finally {
      setOptimizingDay(null);
    }
  }

  async function deleteTrip() {
    if (!confirm(`Delete "${trip.name}"? This cannot be undone.`)) return;
    setDeleteError("");
    setDeleting(true);
    const { error } = await supabase.from("trips").delete().eq("id", id);
    setDeleting(false);
    if (error) {
      setDeleteError(error.message);
      return;
    }
    router.push("/trips");
  }

  if (loading) return <div className="view"><div className="empty-state">Loading trip…</div></div>;
  if (!trip) return <div className="view"><div className="notice danger">Trip not found.</div></div>;

  const byDay = stops.reduce((acc, s) => {
    (acc[s.day_number] = acc[s.day_number] || []).push(s);
    return acc;
  }, {});
  const dayNumbers = Object.keys(byDay).map(Number).sort((a, b) => a - b);

  return (
    <div className="view">
      <Link href="/trips" className="btn btn-sm" style={{ marginBottom: 12, display: "inline-flex" }}>
        ← Back to Trips
      </Link>
      <div className="view-header">
        <div>
          <h1>{trip.name}</h1>
          <p>
            {trip.start_date || "No dates set"}
            {trip.end_date && trip.end_date !== trip.start_date ? ` – ${trip.end_date}` : ""}
            {" · "}
            {stops.length} school{stops.length === 1 ? "" : "s"}
          </p>
        </div>
        <span className="badge badge-contacted">{STATUS_LABEL[trip.status] || trip.status}</span>
      </div>

      <div className="grid grid-2">
        <div>
          <div className="card" style={{ marginBottom: 14 }}>
            <h3>Trip Details</h3>
            <div className="kv">
              <div className="k">Starting from</div>
              <div className="v">{trip.start_location || "—"}</div>
              <div className="k">Ending at</div>
              <div className="v">{trip.end_location || "—"}</div>
            </div>
          </div>

          <div className="card" style={{ marginBottom: 14 }}>
            <h3>Add a School</h3>
            {addError && <div className="notice danger" style={{ marginBottom: 10 }}>{addError}</div>}
            <form onSubmit={addStop}>
              <div className="grid grid-2" style={{ marginBottom: 8 }}>
                <div className="form-field" style={{ position: "relative" }}>
                  <label>School</label>
                  <input
                    value={query}
                    onChange={(e) => searchSchools(e.target.value)}
                    placeholder="Start typing a school name or city…"
                    autoComplete="off"
                  />
                  {results.length > 0 && (
                    <div
                      style={{
                        position: "absolute",
                        top: "100%",
                        left: 0,
                        right: 0,
                        zIndex: 10,
                        background: "#fff",
                        border: "1px solid #dde1e7",
                        borderRadius: 8,
                        boxShadow: "0 4px 14px rgba(11,31,58,.12)",
                        maxHeight: 200,
                        overflow: "auto",
                      }}
                    >
                      {results.map((s) => (
                        <div
                          key={s.id}
                          onClick={() => pickSchool(s)}
                          style={{ padding: "7px 10px", fontSize: 13, cursor: "pointer", borderBottom: "1px solid #f2f3f5" }}
                        >
                          <strong>{s.name}</strong> <span style={{ color: "#697386" }}>— {s.city}, {s.state}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                <div className="form-field">
                  <label>Day</label>
                  <input
                    type="number"
                    min={1}
                    value={addDay}
                    onChange={(e) => setAddDay(e.target.value)}
                  />
                </div>
              </div>
              <button className="btn btn-gold btn-sm" disabled={adding}>
                {adding ? "Adding…" : "Add to Trip"}
              </button>
            </form>
          </div>

          <div className="card">
            <h3>Schools on this Trip</h3>
            {moveError && <div className="notice danger" style={{ marginBottom: 10 }}>{moveError}</div>}
            {stops.length ? (
              dayNumbers.map((day) => {
                const dayStops = byDay[day];
                const summary = optimizeSummary[day];
                const dayError = optimizeError[day];
                return (
                  <div key={day} style={{ marginBottom: 18 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                      <div style={{ fontSize: 12, fontWeight: 700, color: "#697386", textTransform: "uppercase" }}>
                        Day {day}
                      </div>
                      <button
                        className="btn btn-sm"
                        onClick={() => optimizeDay(day, dayStops)}
                        disabled={optimizingDay === day || dayStops.length < 2}
                        title={dayStops.length < 2 ? "Add at least 2 schools to this day to optimize" : "Reorder this day's stops for the shortest route"}
                      >
                        {optimizingDay === day ? "Optimizing…" : "Optimize Route"}
                      </button>
                    </div>

                    {dayError && <div className="notice danger" style={{ marginBottom: 8, fontSize: 12.5 }}>{dayError}</div>}
                    {summary && (
                      <div className="notice info" style={{ marginBottom: 8, fontSize: 12.5 }}>
                        {summary.changed
                          ? `Optimized: ${summary.after.toFixed(1)} mi (was ${summary.before.toFixed(1)} mi, ${Math.round(
                              (1 - summary.after / summary.before) * 100
                            )}% shorter).`
                          : `Already the shortest order at ${summary.after.toFixed(1)} mi.`}
                      </div>
                    )}

                    {dayStops.map((stop, idx) => (
                      <div key={stop.id}>
                        <div className="log-item" style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
                          <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                            <div style={{ display: "flex", flexDirection: "column", gap: 2, marginTop: 1 }}>
                              <button
                                className="btn btn-sm"
                                style={{ padding: "1px 7px", lineHeight: 1.4 }}
                                onClick={() => moveStop(dayStops, stop, "up")}
                                disabled={idx === 0 || movingId === stop.id}
                                title="Move up"
                              >
                                ▲
                              </button>
                              <button
                                className="btn btn-sm"
                                style={{ padding: "1px 7px", lineHeight: 1.4 }}
                                onClick={() => moveStop(dayStops, stop, "down")}
                                disabled={idx === dayStops.length - 1 || movingId === stop.id}
                                title="Move down"
                              >
                                ▼
                              </button>
                            </div>
                            <div>
                              <strong>{stop.schools?.name}</strong> — {stop.schools?.city}, {stop.schools?.state}
                              {stop.is_fixed_appointment && (
                                <span className="badge badge-unverified" style={{ marginLeft: 8 }}>
                                  Fixed{stop.appointment_time ? `: ${stop.appointment_time}` : ""}
                                </span>
                              )}
                            </div>
                          </div>
                          <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                            <button className="btn btn-sm" onClick={() => openFixedEditor(stop)}>
                              {stop.is_fixed_appointment ? "Edit Time" : "Set Fixed Time"}
                            </button>
                            <button
                              className="btn btn-sm btn-danger"
                              onClick={() => removeStop(stop.id)}
                              disabled={removingId === stop.id}
                            >
                              {removingId === stop.id ? "…" : "Remove"}
                            </button>
                          </div>
                        </div>

                        {editingStopId === stop.id && (
                          <form
                            onSubmit={saveFixedAppointment}
                            style={{ background: "#f7f8fa", border: "1px solid #dde1e7", borderRadius: 8, padding: 10, marginTop: -4, marginBottom: 8 }}
                          >
                            {fixedError && <div className="notice danger" style={{ marginBottom: 8 }}>{fixedError}</div>}
                            <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12.5, marginBottom: 8 }}>
                              <input
                                type="checkbox"
                                checked={editFixed}
                                onChange={(e) => setEditFixed(e.target.checked)}
                              />
                              This is a fixed appointment — lock it in place so Optimize Route won't move it
                            </label>
                            {editFixed && (
                              <div className="form-field" style={{ marginBottom: 8 }}>
                                <label>Appointment time</label>
                                <input
                                  value={editTime}
                                  onChange={(e) => setEditTime(e.target.value)}
                                  placeholder="e.g. 10:00 AM"
                                />
                              </div>
                            )}
                            <div style={{ display: "flex", gap: 8 }}>
                              <button className="btn btn-sm btn-primary" disabled={savingFixed}>
                                {savingFixed ? "Saving…" : "Save"}
                              </button>
                              <button type="button" className="btn btn-sm" onClick={cancelFixedEditor} disabled={savingFixed}>
                                Cancel
                              </button>
                            </div>
                          </form>
                        )}
                      </div>
                    ))}
                  </div>
                );
              })
            ) : (
              <div className="empty-state">No schools added yet. Search above to add the first stop.</div>
            )}
          </div>
        </div>

        <div>
          <div className="card">
            <h3>Danger Zone</h3>
            {deleteError && <div className="notice danger" style={{ marginBottom: 10 }}>{deleteError}</div>}
            <button className="btn btn-sm btn-danger" onClick={deleteTrip} disabled={deleting}>
              {deleting ? "Deleting…" : "Delete Trip"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
