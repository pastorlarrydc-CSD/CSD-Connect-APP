"use client";
import { useEffect, useState, useCallback, useRef } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { optimizeRoute, haversineMiles, pathDistance } from "@/lib/routeOptimizer";
import { rebalanceTrip } from "@/lib/tripRebalancer";
import { mileageRateForDate, estimateReimbursement } from "@/lib/mileageRates";
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

  // per-stop notes editor state
  const [editingNoteId, setEditingNoteId] = useState(null);
  const [noteText, setNoteText] = useState("");
  const [savingNote, setSavingNote] = useState(false);
  const [noteError, setNoteError] = useState("");

  // nearby-schools suggestion state
  const [nearbyRadius, setNearbyRadius] = useState(15);
  const [nearbySchools, setNearbySchools] = useState(null);
  const [nearbyLoading, setNearbyLoading] = useState(false);
  const [nearbyError, setNearbyError] = useState("");
  const [addingNearbyId, setAddingNearbyId] = useState(null);

  // trip status + per-stop visit tracking
  const [savingStatus, setSavingStatus] = useState(false);
  const [statusError, setStatusError] = useState("");
  const [savingVisitId, setSavingVisitId] = useState(null);

  // multi-day rebalancer state
  const [rebalancing, setRebalancing] = useState(false);
  const [rebalanceError, setRebalanceError] = useState("");
  const [rebalanceSummary, setRebalanceSummary] = useState(null);

  // actual mileage logging state
  const [actualMilesInput, setActualMilesInput] = useState("");
  const [savingMiles, setSavingMiles] = useState(false);
  const [milesError, setMilesError] = useState("");

  const load = useCallback(async () => {
    const { data: t } = await supabase.from("trips").select("*").eq("id", id).maybeSingle();
    setTrip(t || null);
    setActualMilesInput(t?.actual_miles != null ? String(t.actual_miles) : "");
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

  function openNoteEditor(stop) {
    setNoteError("");
    setEditingNoteId(stop.id);
    setNoteText(stop.notes || "");
  }

  function cancelNoteEditor() {
    setEditingNoteId(null);
    setNoteError("");
  }

  async function saveNote(e) {
    e.preventDefault();
    setNoteError("");
    setSavingNote(true);
    try {
      const { error } = await supabase
        .from("trip_stops")
        .update({ notes: noteText.trim() || null })
        .eq("id", editingNoteId);
      if (error) throw error;
      setEditingNoteId(null);
      await load();
    } catch (err) {
      setNoteError(err.message || "Could not save this note.");
    } finally {
      setSavingNote(false);
    }
  }

  function directionsUrl(school) {
    if (school?.lat != null && school?.lon != null) {
      return `https://www.google.com/maps/dir/?api=1&destination=${school.lat},${school.lon}`;
    }
    const addrParts = [school?.addr1, school?.city, school?.state].filter(Boolean).join(", ");
    if (!addrParts) return null;
    return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(addrParts)}`;
  }

  // Finds schools not already on this trip whose coordinates fall within
  // `nearbyRadius` miles of ANY existing route point (trip start/end or a
  // stop). Cheap in two stages: a lat/lon bounding-box query narrows ~14.6k
  // schools down to the local area server-side, then an exact haversine
  // check (reusing the Phase 2 optimizer's distance function) filters that
  // small candidate set precisely, client-side. No external geocoding API.
  async function findNearbySchools() {
    setNearbyError("");
    setNearbySchools(null);

    const routePoints = [];
    if (trip.start_lat != null && trip.start_lon != null) routePoints.push({ lat: trip.start_lat, lon: trip.start_lon });
    if (trip.end_lat != null && trip.end_lon != null) routePoints.push({ lat: trip.end_lat, lon: trip.end_lon });
    stops.forEach((s) => {
      if (s.schools?.lat != null && s.schools?.lon != null) routePoints.push({ lat: s.schools.lat, lon: s.schools.lon });
    });

    if (!routePoints.length) {
      setNearbyError("This trip has no geocoded stops or start/end location yet, so there's no route to search near.");
      return;
    }

    setNearbyLoading(true);
    try {
      const bufferDeg = nearbyRadius / 60; // ~60 miles per degree of latitude, a little generous on purpose
      const minLat = Math.min(...routePoints.map((p) => p.lat)) - bufferDeg;
      const maxLat = Math.max(...routePoints.map((p) => p.lat)) + bufferDeg;
      const minLon = Math.min(...routePoints.map((p) => p.lon)) - bufferDeg;
      const maxLon = Math.max(...routePoints.map((p) => p.lon)) + bufferDeg;

      const { data, error } = await supabase
        .from("schools")
        .select("id,name,city,state,lat,lon,hc_first_name,hc_last_name")
        .gte("lat", minLat)
        .lte("lat", maxLat)
        .gte("lon", minLon)
        .lte("lon", maxLon)
        .not("lat", "is", null)
        .not("lon", "is", null)
        .limit(500);
      if (error) throw error;

      const onTripIds = new Set(stops.map((s) => s.school_id));
      const withDistance = (data || [])
        .filter((school) => !onTripIds.has(school.id))
        .map((school) => {
          const distances = routePoints.map((p) => haversineMiles(p, { lat: school.lat, lon: school.lon }));
          return { ...school, distanceMiles: Math.min(...distances) };
        })
        .filter((school) => school.distanceMiles <= nearbyRadius)
        .sort((a, b) => a.distanceMiles - b.distanceMiles)
        .slice(0, 15);

      setNearbySchools(withDistance);
    } catch (err) {
      setNearbyError(err.message || "Could not search for nearby schools.");
    } finally {
      setNearbyLoading(false);
    }
  }

  async function addNearbyStop(school) {
    setNearbyError("");
    setAddingNearbyId(school.id);
    try {
      const day = Math.max(1, parseInt(addDay, 10) || 1);
      const stopsOnDay = stops.filter((s) => s.day_number === day);
      const nextSeq = stopsOnDay.length ? Math.max(...stopsOnDay.map((s) => s.sequence_order || 0)) + 1 : 0;
      const { error } = await supabase.from("trip_stops").insert({
        trip_id: id,
        college_id: trip.college_id,
        school_id: school.id,
        day_number: day,
        sequence_order: nextSeq,
      });
      if (error) throw error;
      setNearbySchools((prev) => (prev || []).filter((s) => s.id !== school.id));
      await load();
    } catch (err) {
      setNearbyError(err.message || "Could not add this school to the trip.");
    } finally {
      setAddingNearbyId(null);
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

  // Rebalances which day each flexible stop belongs to, across the whole
  // trip, to cut total mileage. Fixed appointments never move. Unlike
  // optimizeDay (which only reorders stops *within* one day), this can
  // move a stop from Day 2 to Day 1 if that's a shorter overall trip.
  async function rebalanceAllDays() {
    setRebalanceError("");
    setRebalanceSummary(null);

    if (trip.start_lat == null || trip.start_lon == null || trip.end_lat == null || trip.end_lon == null) {
      setRebalanceError(
        "This trip needs a geocoded starting and ending location before days can be rebalanced. Edit the trip's locations and try again."
      );
      return;
    }

    const missingCoords = stops.filter((s) => s.schools?.lat == null || s.schools?.lon == null);
    if (missingCoords.length) {
      setRebalanceError(
        `${missingCoords.length} school${missingCoords.length === 1 ? "" : "s"} on this trip (${missingCoords
          .map((s) => s.schools?.name || "unknown")
          .join(", ")}) don't have map coordinates on file, so the trip can't be rebalanced yet.`
      );
      return;
    }

    const dayCount = new Set(stops.map((s) => s.day_number)).size;
    if (dayCount < 2) {
      setRebalanceError("Add stops across at least 2 days before rebalancing.");
      return;
    }

    setRebalancing(true);
    try {
      const start = { lat: trip.start_lat, lon: trip.start_lon };
      const end = { lat: trip.end_lat, lon: trip.end_lon };
      const asPoints = stops.map((s) => ({ ...s, lat: s.schools.lat, lon: s.schools.lon }));

      const result = rebalanceTrip({ start, end, stops: asPoints });

      // Persist both the new day_number (where it changed) and the
      // optimized sequence_order within each day, one stop at a time.
      const updates = [];
      Object.entries(result.perDay).forEach(([day, { stops: orderedStops }]) => {
        orderedStops.forEach((pt, idx) => {
          const original = stops.find((s) => s.id === pt.id);
          const newDay = Number(day);
          if (original.day_number !== newDay || original.sequence_order !== idx) {
            updates.push({ id: pt.id, day_number: newDay, sequence_order: idx });
          }
        });
      });

      for (const u of updates) {
        const { error } = await supabase
          .from("trip_stops")
          .update({ day_number: u.day_number, sequence_order: u.sequence_order })
          .eq("id", u.id);
        if (error) throw error;
      }

      setRebalanceSummary({
        before: result.totalBefore,
        after: result.totalAfter,
        changed: result.changed,
        movedCount: updates.filter((u) => stops.find((s) => s.id === u.id)?.day_number !== u.day_number).length,
      });
      await load();
    } catch (err) {
      setRebalanceError(err.message || "Could not rebalance this trip.");
    } finally {
      setRebalancing(false);
    }
  }

  // Logs the actual miles driven for this trip (e.g. from an odometer or
  // Google Maps trip log), separate from the optimizer's planned-route
  // estimate. Used for mileage-reimbursement recordkeeping.
  async function saveActualMiles(e) {
    e.preventDefault();
    setMilesError("");
    const trimmed = actualMilesInput.trim();
    const parsed = trimmed === "" ? null : Number(trimmed);
    if (trimmed !== "" && (Number.isNaN(parsed) || parsed < 0)) {
      setMilesError("Enter a positive number of miles, or leave blank to clear it.");
      return;
    }
    setSavingMiles(true);
    try {
      const { error } = await supabase.from("trips").update({ actual_miles: parsed }).eq("id", id);
      if (error) throw error;
      await load();
    } catch (err) {
      setMilesError(err.message || "Could not save actual mileage.");
    } finally {
      setSavingMiles(false);
    }
  }

  async function updateTripStatus(newStatus) {
    setStatusError("");
    setSavingStatus(true);
    try {
      const { error } = await supabase.from("trips").update({ status: newStatus }).eq("id", id);
      if (error) throw error;
      await load();
    } catch (err) {
      setStatusError(err.message || "Could not update trip status.");
    } finally {
      setSavingStatus(false);
    }
  }

  async function updateVisitStatus(stopId, newStatus) {
    setSavingVisitId(stopId);
    try {
      await supabase.from("trip_stops").update({ visit_status: newStatus }).eq("id", stopId);
      await load();
    } finally {
      setSavingVisitId(null);
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

  // Planned mileage: current day/sequence order as-is, no re-optimizing --
  // just a straight-line (haversine) estimate for comparison against the
  // actual miles logged below. Only computed when every stop has map
  // coordinates and the trip has both a start and end location.
  let plannedMiles = null;
  if (trip.start_lat != null && trip.start_lon != null && trip.end_lat != null && trip.end_lon != null) {
    const allHaveCoords = stops.every((s) => s.schools?.lat != null && s.schools?.lon != null);
    if (allHaveCoords) {
      const start = { lat: trip.start_lat, lon: trip.start_lon };
      const end = { lat: trip.end_lat, lon: trip.end_lon };
      plannedMiles = dayNumbers.reduce((sum, day) => {
        const pts = byDay[day].map((s) => ({ lat: s.schools.lat, lon: s.schools.lon }));
        return sum + pathDistance([start, ...pts, end]);
      }, 0);
    }
  }
  const actualMilesNum = trip.actual_miles != null ? Number(trip.actual_miles) : null;
  const reimbursement = estimateReimbursement(actualMilesNum, trip.start_date);
  const mileageRate = mileageRateForDate(trip.start_date);

  return (
    <div className="view">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, flexWrap: "wrap", gap: 8 }}>
        <Link href="/trips" className="btn btn-sm" style={{ display: "inline-flex" }}>
          ← Back to Trips
        </Link>
        <Link href={`/trips/${id}/itinerary`} target="_blank" rel="noopener noreferrer" className="btn btn-sm btn-primary" style={{ display: "inline-flex" }}>
          🖨️ Print Itinerary
        </Link>
      </div>
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
        <div style={{ textAlign: "right" }}>
          <select
            value={trip.status}
            onChange={(e) => updateTripStatus(e.target.value)}
            disabled={savingStatus}
            style={{ border: "1px solid #dde1e7", borderRadius: 20, padding: "5px 10px", fontSize: 12.5, fontWeight: 700, color: "#1c5fb3", background: "#e7effc" }}
          >
            {Object.entries(STATUS_LABEL).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
          {statusError && <div className="notice danger" style={{ marginTop: 6, fontSize: 12 }}>{statusError}</div>}
        </div>
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

          <div className="card" style={{ marginBottom: 14 }}>
            <h3>Nearby Schools</h3>
            {nearbyError && <div className="notice danger" style={{ marginBottom: 10 }}>{nearbyError}</div>}
            <div style={{ display: "flex", gap: 8, alignItems: "flex-end", marginBottom: 10 }}>
              <div className="form-field" style={{ marginBottom: 0 }}>
                <label>Within</label>
                <select value={nearbyRadius} onChange={(e) => setNearbyRadius(parseInt(e.target.value, 10))}>
                  <option value={10}>10 miles</option>
                  <option value={15}>15 miles</option>
                  <option value={25}>25 miles</option>
                  <option value={50}>50 miles</option>
                </select>
              </div>
              <button className="btn btn-sm" onClick={findNearbySchools} disabled={nearbyLoading}>
                {nearbyLoading ? "Searching…" : "Find Nearby Schools"}
              </button>
            </div>
            {nearbySchools && (
              nearbySchools.length ? (
                nearbySchools.map((school) => (
                  <div key={school.id} className="log-item" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                    <div>
                      <strong>{school.name}</strong> — {school.city}, {school.state}
                      <span style={{ color: "#697386", marginLeft: 6 }}>· {school.distanceMiles.toFixed(1)} mi from route</span>
                    </div>
                    <button
                      className="btn btn-sm"
                      onClick={() => addNearbyStop(school)}
                      disabled={addingNearbyId === school.id}
                    >
                      {addingNearbyId === school.id ? "…" : `Add (Day ${Math.max(1, parseInt(addDay, 10) || 1)})`}
                    </button>
                  </div>
                ))
              ) : (
                <div className="empty-state">No schools with map coordinates found within {nearbyRadius} miles of this route.</div>
              )
            )}
          </div>

          <div className="card">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6, gap: 8, flexWrap: "wrap" }}>
              <h3 style={{ marginBottom: 0 }}>Schools on this Trip</h3>
              <button
                className="btn btn-sm"
                onClick={rebalanceAllDays}
                disabled={rebalancing || dayNumbers.length < 2}
                title={
                  dayNumbers.length < 2
                    ? "Add stops across at least 2 days to rebalance"
                    : "Move flexible stops between days to shorten the trip overall (fixed appointments stay put)"
                }
              >
                {rebalancing ? "Rebalancing…" : "Rebalance Trip"}
              </button>
            </div>
            {rebalanceError && <div className="notice danger" style={{ marginBottom: 10, fontSize: 12.5 }}>{rebalanceError}</div>}
            {rebalanceSummary && (
              <div className="notice info" style={{ marginBottom: 10, fontSize: 12.5 }}>
                {rebalanceSummary.changed
                  ? `Rebalanced ${rebalanceSummary.movedCount} stop${rebalanceSummary.movedCount === 1 ? "" : "s"} across days: ${rebalanceSummary.after.toFixed(
                      1
                    )} mi total (was ${rebalanceSummary.before.toFixed(1)} mi, ${Math.round(
                      (1 - rebalanceSummary.after / rebalanceSummary.before) * 100
                    )}% shorter). Fixed appointments were left in place.`
                  : "Already the best day split — no changes made."}
              </div>
            )}
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
                              <div style={{ display: "flex", gap: 10, marginTop: 4, fontSize: 12 }}>
                                {stop.schools?.hc_cell ? (
                                  <a href={`tel:${stop.schools.hc_cell.replace(/\D/g, "")}`}>📞 Call</a>
                                ) : (
                                  <span className="empty-state" style={{ padding: 0 }}>No cell on file</span>
                                )}
                                {stop.schools?.hc_email ? (
                                  <a href={`mailto:${stop.schools.hc_email}`}>✉️ Email</a>
                                ) : (
                                  <span className="empty-state" style={{ padding: 0 }}>No email on file</span>
                                )}
                                {directionsUrl(stop.schools) ? (
                                  <a href={directionsUrl(stop.schools)} target="_blank" rel="noopener noreferrer">
                                    📍 Directions
                                  </a>
                                ) : (
                                  <span className="empty-state" style={{ padding: 0 }}>No address on file</span>
                                )}
                              </div>
                              {stop.notes && editingNoteId !== stop.id && (
                                <div style={{ marginTop: 4, fontSize: 12.5, color: "#3c4658" }}>
                                  📝 {stop.notes}
                                </div>
                              )}
                            </div>
                          </div>
                          <div style={{ display: "flex", gap: 6, flexShrink: 0, alignItems: "center" }}>
                            <select
                              value={stop.visit_status}
                              onChange={(e) => updateVisitStatus(stop.id, e.target.value)}
                              disabled={savingVisitId === stop.id}
                              className={
                                stop.visit_status === "visited"
                                  ? "badge badge-public"
                                  : stop.visit_status === "skipped"
                                  ? "badge badge-private"
                                  : "badge badge-not-contacted"
                              }
                              style={{ border: "none", padding: "4px 6px" }}
                            >
                              <option value="planned">Planned</option>
                              <option value="visited">Visited</option>
                              <option value="skipped">Skipped</option>
                            </select>
                            <button className="btn btn-sm" onClick={() => openFixedEditor(stop)}>
                              {stop.is_fixed_appointment ? "Edit Time" : "Set Fixed Time"}
                            </button>
                            <button className="btn btn-sm" onClick={() => openNoteEditor(stop)}>
                              {stop.notes ? "Edit Note" : "Add Note"}
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

                        {editingNoteId === stop.id && (
                          <form
                            onSubmit={saveNote}
                            style={{ background: "#f7f8fa", border: "1px solid #dde1e7", borderRadius: 8, padding: 10, marginTop: -4, marginBottom: 8 }}
                          >
                            {noteError && <div className="notice danger" style={{ marginBottom: 8 }}>{noteError}</div>}
                            <div className="form-field" style={{ marginBottom: 8 }}>
                              <label>Note for this stop</label>
                              <input
                                value={noteText}
                                onChange={(e) => setNoteText(e.target.value)}
                                placeholder="Bring updated senior film, ask about the 6'3 slot receiver…"
                              />
                            </div>
                            <div style={{ display: "flex", gap: 8 }}>
                              <button className="btn btn-sm btn-primary" disabled={savingNote}>
                                {savingNote ? "Saving…" : "Save"}
                              </button>
                              <button type="button" className="btn btn-sm" onClick={cancelNoteEditor} disabled={savingNote}>
                                Cancel
                              </button>
                            </div>
                          </form>
                        )}

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
          <div className="card" style={{ marginBottom: 14 }}>
            <h3>Trip Mileage</h3>
            <div className="kv" style={{ marginBottom: 10 }}>
              <div className="k">Planned (optimized)</div>
              <div className="v">{plannedMiles != null ? `${plannedMiles.toFixed(0)} mi` : "—"}</div>
              {actualMilesNum != null && (
                <>
                  <div className="k">Actual logged</div>
                  <div className="v">{actualMilesNum.toFixed(0)} mi</div>
                  <div className="k">Est. reimbursement</div>
                  <div className="v">
                    ${reimbursement.toFixed(2)}
                    <span style={{ fontWeight: 400, color: "#697386" }}> ({(mileageRate * 100).toFixed(1)}¢/mi IRS rate)</span>
                  </div>
                </>
              )}
            </div>
            {milesError && <div className="notice danger" style={{ marginBottom: 10 }}>{milesError}</div>}
            <form onSubmit={saveActualMiles} style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
              <div className="form-field" style={{ marginBottom: 0, flex: 1 }}>
                <label>Actual miles driven</label>
                <input
                  type="number"
                  min="0"
                  step="0.1"
                  value={actualMilesInput}
                  onChange={(e) => setActualMilesInput(e.target.value)}
                  placeholder="e.g. from odometer or Google Maps"
                />
              </div>
              <button className="btn btn-sm btn-primary" disabled={savingMiles}>
                {savingMiles ? "Saving…" : "Save"}
              </button>
            </form>
            <div className="notice" style={{ marginTop: 10, fontSize: 11.5 }}>
              Reimbursement estimate uses the IRS standard mileage rate for this trip's date — reference only, not tax advice. Confirm your own rate and eligibility with a tax professional.
            </div>
          </div>

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
