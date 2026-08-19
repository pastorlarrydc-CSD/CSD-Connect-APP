"use client";
import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { useAuth } from "@/lib/auth-context";

// Friendly labels for the raw schools column names recorded in
// school_change_log / coach_change_notifications.
const FIELD_LABEL = {
  hc_first_name: "Head Coach — first name",
  hc_last_name: "Head Coach — last name",
  hc_email: "Head Coach — email",
  hc_cell: "Head Coach — cell",
  hc_office: "Head Coach — office",
};

export default function AlertsPage() {
  const supabase = getSupabaseBrowserClient();
  const { college } = useAuth();

  const [alerts, setAlerts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [marking, setMarking] = useState(false);

  const load = useCallback(async () => {
    if (!college?.id) {
      setLoading(false);
      return;
    }
    setLoading(true);
    const { data } = await supabase
      .from("coach_change_notifications")
      .select("id, field_name, old_value, new_value, created_at, seen_at, schools(id,name,city,state)")
      .eq("college_id", college.id)
      .order("created_at", { ascending: false })
      .limit(200);
    setAlerts(data || []);
    setLoading(false);
  }, [supabase, college]);

  useEffect(() => {
    load();
  }, [load]);

  async function markAllSeen() {
    if (!college?.id) return;
    setMarking(true);
    await supabase
      .from("coach_change_notifications")
      .update({ seen_at: new Date().toISOString() })
      .eq("college_id", college.id)
      .is("seen_at", null);
    setMarking(false);
    load();
  }

  const unseenCount = alerts.filter((a) => !a.seen_at).length;

  return (
    <div className="view">
      <div className="view-header">
        <div>
          <h1>Coach-Change Alerts</h1>
          <p>Head-coach contact changes at schools you&apos;re watchlisting or have logged a contact against.</p>
        </div>
        {unseenCount > 0 && (
          <button className="btn btn-sm btn-primary" onClick={markAllSeen} disabled={marking}>
            {marking ? "Marking…" : `Mark all ${unseenCount} as read`}
          </button>
        )}
      </div>

      <div className="card">
        {loading ? (
          <div className="empty-state">Loading…</div>
        ) : alerts.length ? (
          alerts.map((a) => (
            <div className="log-item" key={a.id}>
              {!a.seen_at && (
                <span className="badge badge-contacted" style={{ marginRight: 6 }}>
                  New
                </span>
              )}
              <span className="when">{new Date(a.created_at).toLocaleDateString()}</span>
              {a.schools?.id ? (
                <Link href={`/schools/${a.schools.id}`}>
                  <strong>{a.schools.name}</strong>
                </Link>
              ) : (
                <strong>School</strong>
              )}
              {a.schools?.city ? ` — ${a.schools.city}, ${a.schools.state}` : ""}
              <div style={{ fontSize: 12.5, color: "#697386", marginTop: 2 }}>
                {FIELD_LABEL[a.field_name] || a.field_name} changed: {a.old_value || <span className="empty-state">blank</span>} →{" "}
                {a.new_value || <span className="empty-state">blank</span>}
              </div>
            </div>
          ))
        ) : (
          <div className="empty-state">
            No coach-change alerts yet. Add schools to your watchlist or log a contact against them, and you&apos;ll see updates here the moment CSD verifies a head-coach change.
          </div>
        )}
      </div>
    </div>
  );
}
