"use client";
import { useEffect, useRef, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { useAuth } from "@/lib/auth-context";

const US_STATES = [
  "AL", "AK", "AS", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL", "GA", "HI", "ID", "IL", "IN", "IA", "KS", "KY",
  "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK",
  "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY",
];

export default function MapPage() {
  const supabase = getSupabaseBrowserClient();
  const router = useRouter();
  const { college } = useAuth();
  const mapContainerRef = useRef(null);
  const mapInstanceRef = useRef(null);
  const clusterGroupRef = useRef(null);
  const [stateFilter, setStateFilter] = useState("");
  const [visibleCount, setVisibleCount] = useState(0);

  const loadWatchlistedSchoolIds = useCallback(async () => {
    if (!college?.id) return [];
    const { data } = await supabase.from("watchlist_items").select("school_id").eq("college_id", college.id);
    return (data || []).map((w) => w.school_id);
  }, [supabase, college]);

  // A closed school is never a real recruiting target -- see the
  // add_school_closed_status migration. Same reasoning as Search: this is
  // a discovery surface, so closed schools are dropped from the map
  // entirely rather than plotted with a badge. A school already on a
  // college's watchlist still keeps its own profile page and its
  // watchlist card -- this filter only affects what gets plotted here.
  const loadMap = useCallback(async () => {
    const L = (await import("leaflet")).default;
    await import("leaflet.markercluster");

    let query = supabase
      .from("schools")
      .select("id,name,city,state,hc_first_name,hc_last_name,lat,lon")
      .not("lat", "is", null)
      .eq("is_closed", false)
      .limit(3000);
    if (stateFilter) query = query.eq("state", stateFilter);

    const { data: schools } = await query;
    const watchlistedIds = await loadWatchlistedSchoolIds();

    if (!mapInstanceRef.current) {
      mapInstanceRef.current = L.map(mapContainerRef.current).setView([39.5, -98.35], 4);
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: "&copy; OpenStreetMap contributors",
        maxZoom: 18,
      }).addTo(mapInstanceRef.current);
      clusterGroupRef.current = L.markerClusterGroup({ maxClusterRadius: 45 });
      mapInstanceRef.current.addLayer(clusterGroupRef.current);
    }

    clusterGroupRef.current.clearLayers();

    (schools || []).forEach((school) => {
      const color = watchlistedIds.includes(school.id) ? "#d4a017" : "#697386";
      const marker = L.circleMarker([school.lat, school.lon], {
        radius: 6,
        color,
        fillColor: color,
        fillOpacity: 0.85,
        weight: 1,
      });
      const popupEl = document.createElement("div");
      popupEl.innerHTML = `<strong>${school.name}</strong><br/>${school.city}, ${school.state}<br/>HC: ${school.hc_first_name || ""} ${school.hc_last_name || ""}<br/><button id="view-${school.id}" style="margin-top:6px;cursor:pointer">View profile</button>`;
      marker.bindPopup(popupEl);
      marker.on("popupopen", () => {
        const btn = document.getElementById(`view-${school.id}`);
        if (btn) btn.onclick = () => router.push(`/schools/${school.id}`);
      });
      clusterGroupRef.current.addLayer(marker);
    });

    setVisibleCount((schools || []).length);

    if (stateFilter && schools?.length) {
      const avgLat = schools.reduce((sum, s) => sum + s.lat, 0) / schools.length;
      const avgLon = schools.reduce((sum, s) => sum + s.lon, 0) / schools.length;
      mapInstanceRef.current.setView([avgLat, avgLon], 6);
    } else {
      mapInstanceRef.current.setView([39.5, -98.35], 4);
    }
  }, [supabase, stateFilter, loadWatchlistedSchoolIds, router]);

  useEffect(() => {
    if (!document.getElementById("leaflet-css")) {
      const leafletCss = document.createElement("link");
      leafletCss.id = "leaflet-css";
      leafletCss.rel = "stylesheet";
      leafletCss.href = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css";
      document.head.appendChild(leafletCss);

      const clusterCss = document.createElement("link");
      clusterCss.rel = "stylesheet";
      clusterCss.href = "https://cdnjs.cloudflare.com/ajax/libs/leaflet.markercluster/1.5.3/MarkerCluster.css";
      document.head.appendChild(clusterCss);

      const clusterDefaultCss = document.createElement("link");
      clusterDefaultCss.rel = "stylesheet";
      clusterDefaultCss.href = "https://cdnjs.cloudflare.com/ajax/libs/leaflet.markercluster/1.5.3/MarkerCluster.Default.css";
      document.head.appendChild(clusterDefaultCss);
    }
    loadMap();
  }, [loadMap]);

  return (
    <div className="view">
      <div className="view-header">
        <div>
          <h1>Recruiting Territory Map</h1>
          <p>Live map of the national database — {visibleCount.toLocaleString()} schools in view</p>
        </div>
      </div>
      <div className="filters">
        <div className="field">
          <label>State</label>
          <select value={stateFilter} onChange={(e) => setStateFilter(e.target.value)}>
            <option value="">All states</option>
            {US_STATES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>&nbsp;</label>
          <div style={{ fontSize: 12, color: "#697386", display: "flex", gap: 12, alignItems: "center" }}>
            <span>
              <span style={{ display: "inline-block", width: 10, height: 10, borderRadius: "50%", background: "#d4a017", marginRight: 4 }} />
              Watchlisted
            </span>
            <span>
              <span style={{ display: "inline-block", width: 10, height: 10, borderRadius: "50%", background: "#697386", marginRight: 4 }} />
              Not watchlisted
            </span>
          </div>
        </div>
      </div>
      <div id="leaflet-map" ref={mapContainerRef} />
    </div>
  );
}
