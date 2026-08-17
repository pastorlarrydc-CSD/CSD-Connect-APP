"use client";
import { useEffect, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { pathDistance } from "@/lib/routeOptimizer";
import "@/lib/auth-context";

const STATUS_LABEL = { planning: "Planning", active: "Active", completed: "Completed" };
const VISIT_LABEL = { planned: "Planned", visited: "Visited", skipped: "Skipped" };

// Formats a school's address as one printable line.
function addressLine(school) {
  if (!school) return "";
  const parts = [school.addr1, school.addr2].filter(Boolean).join(", ");
  const cityState = [school.city, school.state].filter(Boolean).join(", ");
  return [parts, [cityState, school.zip].filter(Boolean).join(" ")].filter(Boolean).join(" · ");
}

function directionsUrl(school) {
  if (!school) return null;
  const parts = [school.addr1, school.city, school.state, school.zip].filter(Boolean);
  if (!parts.length) return null;
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(parts.join(", "))}`;
}

// day_number is 1-based and purely sequential -- if the trip has a
// start_date, Day 1 = start_date, Day 2 = start_date + 1, etc. This is a
// display-only convenience; day_number itself never changes.
function dateForDay(startDate, dayNumber) {
  if (!startDate) return null;
  const d = new Date(`${startDate}T00:00:00`);
  d.setDate(d.getDate() + (dayNumber - 1));
  return d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" });
}

export default function TripItineraryPage() {
  const { id } = useParams();
  const supabase = getSupabaseBrowserClient();

  const [trip, setTrip] = useState(null);
  const [stops, setStops] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const { data: t } = await supabase.from("trips").select("*").eq("id", id).maybeSingle();
    setTrip(t || null);
    if (t) {
      const { data: s } = await supabase
        .from("trip_stops")
        .select("*, schools(id,name,city,state,zip,addr1,addr2,hc_first_name,hc_last_name,hc_email,hc_cell,hc_office,lat,lon)")
        .eq("trip_id", id)
        .order("day_number", { ascending: true })
        .order("sequence_order", { ascending: true });
      setStops(s || []);
    }
    setLoading(false);
  }, [supabase, id]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) return <div className="view"><div className="empty-state">Loading itinerary…</div></div>;
  if (!trip) return <div className="view"><div className="notice danger">Trip not found.</div></div>;

  const byDay = stops.reduce((acc, s) => {
    (acc[s.day_number] = acc[s.day_number] || []).push(s);
    return acc;
  }, {});
  const dayNumbers = Object.keys(byDay).map(Number).sort((a, b) => a - b);

  const hasStartEnd = trip.start_lat != null && trip.start_lon != null && trip.end_lat != null && trip.end_lon != null;

  return (
    <div className="view itinerary-view">
      <div className="no-print" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16, flexWrap: "wrap", gap: 8 }}>
        <Link href={`/trips/${id}`} className="btn btn-sm" style={{ display: "inline-flex" }}>
          ← Back to Trip
        </Link>
        <button className="btn btn-sm btn-gold" onClick={() => window.print()}>
          🖨️ Print / Save as PDF
        </button>
      </div>

      <div className="itinerary-header">
        <h1 style={{ margin: "0 0 2px" }}>{trip.name}</h1>
        <p style={{ margin: 0, color: "#697386", fontSize: 13 }}>
          {trip.start_date || "No dates set"}
          {trip.end_date && trip.end_date !== trip.start_date ? ` – ${trip.end_date}` : ""}
          {" · "}
          {STATUS_LABEL[trip.status] || trip.status}
          {" · "}
          {stops.length} school{stops.length === 1 ? "" : "s"} across {dayNumbers.length} day{dayNumbers.length === 1 ? "" : "s"}
        </p>
        <div className="kv" style={{ marginTop: 10, gridTemplateColumns: "110px 1fr" }}>
          <div className="k">Starting from</div>
          <div className="v" style={{ fontWeight: 400 }}>{trip.start_location || "—"}</div>
          <div className="k">Ending at</div>
          <div className="v" style={{ fontWeight: 400 }}>{trip.end_location || trip.start_location || "—"}</div>
        </div>
      </div>

      {stops.length === 0 && (
        <div className="empty-state" style={{ marginTop: 16 }}>No schools added to this trip yet.</div>
      )}

      {dayNumbers.map((day) => {
        const dayStops = byDay[day];
        const dateLabel = dateForDay(trip.start_date, day);

        // Distance for the day exactly as currently sequenced (no
        // re-optimizing here -- this is a read-only itinerary).
        let dayMiles = null;
        if (hasStartEnd) {
          const pts = dayStops
            .filter((s) => s.schools?.lat != null && s.schools?.lon != null)
            .map((s) => ({ lat: s.schools.lat, lon: s.schools.lon }));
          if (pts.length === dayStops.length && pts.length > 0) {
            const start = { lat: trip.start_lat, lon: trip.start_lon };
            const end = { lat: trip.end_lat, lon: trip.end_lon };
            dayMiles = pathDistance([start, ...pts, end]);
          }
        }

        return (
          <div className="itinerary-day" key={day}>
            <div className="itinerary-day-header">
              <h2>Day {day}{dateLabel ? ` — ${dateLabel}` : ""}</h2>
              <div className="itinerary-day-sub">
                {dayStops.length} stop{dayStops.length === 1 ? "" : "s"}
                {dayMiles != null ? ` · approx. ${dayMiles.toFixed(0)} driving miles (straight-line estimate)` : ""}
              </div>
            </div>

            {dayStops.map((stop, idx) => {
              const school = stop.schools;
              const dirUrl = directionsUrl(school);
              return (
                <div className="itinerary-stop" key={stop.id}>
                  <div className="itinerary-stop-num">{idx + 1}</div>
                  <div className="itinerary-stop-body">
                    <div className="itinerary-stop-title">
                      <strong>{school?.name || "Unknown school"}</strong>
                      {stop.is_fixed_appointment && (
                        <span className="badge badge-unverified" style={{ marginLeft: 8 }}>
                          Fixed{stop.appointment_time ? `: ${stop.appointment_time}` : ""}
                        </span>
                      )}
                      <span
                        className={
                          stop.visit_status === "visited"
                            ? "badge badge-public"
                            : stop.visit_status === "skipped"
                            ? "badge badge-private"
                            : "badge badge-not-contacted"
                        }
                        style={{ marginLeft: 8 }}
                      >
                        {VISIT_LABEL[stop.visit_status] || stop.visit_status}
                      </span>
                    </div>
                    <div className="itinerary-stop-detail">{addressLine(school) || "No address on file"}</div>
                    <div className="itinerary-stop-detail">
                      Head Coach: {[school?.hc_first_name, school?.hc_last_name].filter(Boolean).join(" ") || "—"}
                      {school?.hc_cell ? ` · ${school.hc_cell}` : ""}
                      {school?.hc_office ? ` (office: ${school.hc_office})` : ""}
                      {school?.hc_email ? ` · ${school.hc_email}` : ""}
                    </div>
                    {dirUrl && (
                      <div className="itinerary-stop-detail no-print">
                        <a href={dirUrl} target="_blank" rel="noopener noreferrer">📍 Directions</a>
                      </div>
                    )}
                    {stop.notes && <div className="itinerary-stop-notes">📝 {stop.notes}</div>}
                  </div>
                </div>
              );
            })}
          </div>
        );
      })}

      <div className="no-print footer-note" style={{ marginTop: 20 }}>
        Generated from CSD CoachConnect on {new Date().toLocaleDateString()}.
      </div>
    </div>
  );
}
