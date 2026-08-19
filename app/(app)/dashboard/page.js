"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { useAuth } from "@/lib/auth-context";

export default function DashboardPage() {
  const supabase = getSupabaseBrowserClient();
  const { profile, college } = useAuth();

  const [stats, setStats] = useState(null);
  const [recentContacts, setRecentContacts] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      const [{ count: total }, { count: withEmail }, { count: withCell }] = await Promise.all([
        supabase.from("schools").select("*", { count: "exact", head: true }),
        supabase.from("schools").select("*", { count: "exact", head: true }).not("hc_email", "is", null).neq("hc_email", ""),
        supabase.from("schools").select("*", { count: "exact", head: true }).not("hc_cell", "is", null).neq("hc_cell", ""),
      ]);

      let assignedCount = 0;
      let contactedCount = 0;
      let watchCount = 0;
      let unseenAlerts = 0;
      let contacts = [];

      if (college?.id) {
        const [{ count: a }, { count: c }, { count: w }, { count: u }, { data: recent }] = await Promise.all([
          supabase.from("coach_assignments").select("*", { count: "exact", head: true }).eq("college_id", college.id),
          supabase.from("contact_logs").select("school_id", { count: "exact", head: true }).eq("college_id", college.id),
          supabase.from("watchlist_items").select("*", { count: "exact", head: true }).eq("college_id", college.id),
          supabase.from("coach_change_notifications").select("*", { count: "exact", head: true }).eq("college_id", college.id).is("seen_at", null),
          supabase.from("contact_logs").select("*, schools(name)").eq("college_id", college.id).order("created_at", { ascending: false }).limit(5),
        ]);
        assignedCount = a || 0;
        contactedCount = c || 0;
        watchCount = w || 0;
        unseenAlerts = u || 0;
        contacts = recent || [];
      }

      setStats({ total, withEmail, withCell, assignedCount, contactedCount, watchCount, unseenAlerts });
      setRecentContacts(contacts);
      setLoading(false);
    }
    load();
  }, [supabase, college]);

  if (loading || !stats) {
    return (
      <div className="view">
        <div className="empty-state">Loading dashboard…</div>
      </div>
    );
  }

  const emailPct = stats.total ? Math.round(((stats.withEmail || 0) / stats.total) * 100) : 0;

  return (
    <div className="view">
      <div className="view-header">
        <div>
          <h1>Dashboard</h1>
          <p>
            Welcome back, {profile?.full_name} — {college?.name || "no college linked yet"}
          </p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <Link href="/search" className="btn btn-gold">
            Search Database
          </Link>
          <Link href="/map" className="btn btn-primary">
            Open Territory Map
          </Link>
        </div>
      </div>

      {stats.unseenAlerts > 0 && (
        <div className="notice" style={{ marginBottom: 14, display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
          <span>
            You have <strong>{stats.unseenAlerts}</strong> unread coach-change alert{stats.unseenAlerts === 1 ? "" : "s"} on schools you&apos;re tracking.
          </span>
          <Link href="/alerts" className="btn btn-sm btn-primary">
            View alerts →
          </Link>
        </div>
      )}

      <div className="grid grid-4" style={{ marginBottom: 14 }}>
        <div className="card stat-card">
          <div className="label">Schools Indexed</div>
          <div className="num">{(stats.total || 0).toLocaleString()}</div>
          <div className="sub">Live national database</div>
        </div>
        <div className="card stat-card">
          <div className="label">Head Coach Emails</div>
          <div className="num">{emailPct}%</div>
          <div className="sub">{(stats.withEmail || 0).toLocaleString()} schools with an email on file</div>
        </div>
        <div className="card stat-card">
          <div className="label">Head Coach Cells</div>
          <div className="num">{(stats.withCell || 0).toLocaleString()}</div>
          <div className="sub">mobile numbers on file</div>
        </div>
        <div className="card stat-card">
          <div className="label">Your Activity</div>
          <div className="num">{stats.contactedCount}</div>
          <div className="sub">
            {stats.assignedCount} assigned · {stats.watchCount} watchlisted
          </div>
        </div>
      </div>

      <div className="grid grid-2">
        <div className="card">
          <h3>Recent Contact Activity ({college?.name || "your college"})</h3>
          {recentContacts.length ? (
            recentContacts.map((c) => (
              <div className="log-item" key={c.id}>
                <span className="when">{c.contact_date}</span>
                <strong>{c.contact_type}</strong> with {c.schools?.name || "a school"} {c.note ? `— "${c.note}"` : ""}
              </div>
            ))
          ) : (
            <div className="empty-state">No contact activity logged yet. Log calls, emails, texts and visits from any school profile.</div>
          )}
        </div>
        <div className="card">
          <h3>Getting Started</h3>
          <div className="notice info" style={{ marginBottom: 8 }}>
            Search the database, assign schools to your territory, and log outreach — all changes save to your college&apos;s private CRM instantly.
          </div>
          <div className="notice">Only your college&apos;s staff can see your assignments, notes, and contact history (enforced by database-level Row Level Security).</div>
        </div>
      </div>
    </div>
  );
}
