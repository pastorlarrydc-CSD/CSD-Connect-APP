"use client";
import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { useAuth } from "@/lib/auth-context";
import { pathDistance } from "@/lib/routeOptimizer";

// Estimated route mileage for a completed trip, computed the same way the
// live optimizer summary does: day by day, start -> stops in their saved
// sequence order -> end, summed across days. Purely for comparison against
// whatever actual mileage the coach logged -- not stored, just derived.
function estimatedMiles(trip) {
  if (trip.start_lat == null || trip.start_lon == null || trip.end_lat == null || trip.end_lon == null) {
    return null;
  }
  const byDay = {};
  (trip.trip_stops || []).forEach((s) => {
    if (s.schools?.lat == null || s.schools?.lon == null) return;
    (byDay[s.day_number] = byDay[s.day_number] || []).push(s);
  });
  if (!Object.keys(byDay).length) return null;

  let total = 0;
  Object.values(byDay).forEach((dayStops) => {
    dayStops.sort((a, b) => (a.sequence_order || 0) - (b.sequence_order || 0));
    const points = [
      { lat: trip.start_lat, lon: trip.start_lon },
      ...dayStops.map((s) => ({ lat: s.schools.lat, lon: s.schools.lon })),
      { lat: trip.end_lat, lon: trip.end_lon },
    ];
    total += pathDistance(points);
  });
  return total;
}

export default function TripHistoryPage() {
  const supabase = getSupabaseBrowserClient();
  const { college } = useAuth();
  const [trips, setTrips] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!college?.id) {
      setLoading(false);
      return;
    }
    const { data } = await supabase
      .from("trips")
      .select("*, trip_stops(id, visit_status, day_number, sequence_order, schools(lat,lon))")
      .eq("college_id", college.id)
      .eq("status", "completed")
      .order("end_date", { ascending: false, nullsFirst: false })
      .order("start_date", { ascending: false, nullsFirst: false });
    setTrips(data || []);
    setLoading(false);
  }, [supabase, college]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="view">
      <Link href="/trips" className="btn btn-sm" style={{ marginBottom: 12, display: "inline-flex" }}>
        ← Back to Trips
      </Link>
      <div className="view-header">
        <div>
          <h1>Trip History</h1>
          <p>Completed recruiting trips and how they actually went</p>
        </div>
      </div>

      {loading ? (
        <div className="empty-state">Loading trip history…</div>
      ) : trips.length ? (
        <div className="grid grid-2">
          {trips.map((trip) => {
            const stops = trip.trip_stops || [];
            const visited = stops.filter((s) => s.visit_status === "visited").length;
            const skipped = stops.filter((s) => s.visit_status === "skipped").length;
            const planned = stops.length - visited - skipped;
            const est = estimatedMiles(trip);

            return (
              <Link
                key={trip.id}
                href={`/trips/${trip.id}`}
                className="card"
                style={{ textDecoration: "none", color: "inherit", display: "block" }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                  <h3 style={{ margin: 0 }}>{trip.name}</h3>
                  <span className="badge badge-public">Completed</span>
                </div>
                <div className="kv" style={{ marginTop: 10 }}>
                  <div className="k">Dates</div>
                  <div className="v">
                    {trip.start_date || "—"}
                    {trip.end_date && trip.end_date !== trip.start_date ? ` – ${trip.end_date}` : ""}
                  </div>
                  <div className="k">Schools</div>
                  <div className="v">
                    {stops.length} total &middot; {visited} visited
                    {skipped ? ` · ${skipped} skipped` : ""}
                    {planned ? ` · ${planned} never marked` : ""}
                  </div>
                  <div className="k">Estimated miles</div>
                  <div className="v">{est != null ? `${est.toFixed(0)} mi` : "—"}</div>
                  <div className="k">Actual miles</div>
                  <div className="v">{trip.actual_miles != null ? `${Number(trip.actual_miles).toFixed(0)} mi` : "Not logged"}</div>
                </div>
              </Link>
            );
          })}
        </div>
      ) : (
        <div className="card">
          <div className="empty-state">
            No completed trips yet. Mark a trip &quot;Completed&quot; from its detail page once you&apos;ve run it, and it&apos;ll show up here.
          </div>
        </div>
      )}
    </div>
  );
}
