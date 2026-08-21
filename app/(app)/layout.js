"use client";
import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import { useAuth } from "@/lib/auth-context";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import CompleteProfileForm from "@/components/CompleteProfileForm";

const NAV_LINKS = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/alerts", label: "Alerts" },
  { href: "/search", label: "Search Database" },
  { href: "/map", label: "Territory Map" },
  { href: "/crm", label: "Recruiting CRM" },
  { href: "/prospects", label: "Prospects" },
  { href: "/trips", label: "Recruiting Trips" },
  { href: "/territories", label: "Territories" },
  { href: "/reports", label: "Reports" },
  { href: "/admin", label: "Admin" },
  { href: "/integrations", label: "Integrations" },
  { href: "/billing", label: "Billing" },
  { href: "/account", label: "Account Security" },
];

const ROLE_LABEL = {
  college_coach: "College Coach / Staff",
  athletic_director: "Athletic Director",
  hs_coach: "HS Head Coach",
  verifier: "Verification Staff",
  sysadmin: "System Admin",
};

// Pages that stay reachable even when a college's subscription has
// lapsed -- otherwise nobody could ever get back to /billing to fix it,
// or to /account to sign out and back in as a different user.
const BILLING_EXEMPT_PATHS = ["/billing", "/account"];

// Roles that are never gated by subscription status -- sysadmin is CSD's
// own internal staff, not a paying customer's seat.
const BILLING_EXEMPT_ROLES = ["sysadmin"];

const ACTIVE_SUBSCRIPTION_STATUSES = ["trialing", "active", "internal"];

export default function AppLayout({ children }) {
  const { session, profile, college, signOut, loading } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  const [unseenAlerts, setUnseenAlerts] = useState(0);

  useEffect(() => {
    if (!loading && session === null) router.replace("/login");
  }, [loading, session, router]);

  // Refetched on every route change so the badge clears right after a
  // visit to /alerts marks its notifications as read.
  useEffect(() => {
    if (!college?.id) return;
    const supabase = getSupabaseBrowserClient();
    supabase
      .from("coach_change_notifications")
      .select("*", { count: "exact", head: true })
      .eq("college_id", college.id)
      .is("seen_at", null)
      .then(({ count }) => setUnseenAlerts(count || 0));
  }, [college, pathname]);

  if (loading || session === null) {
    return <div style={{ padding: 40, textAlign: "center", color: "#697386" }}>Loading…</div>;
  }

  const initials = (profile?.full_name || session?.user?.email || "?")
    .split(" ")
    .map((s) => s[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  const billingBlocked =
    profile &&
    college &&
    !BILLING_EXEMPT_ROLES.includes(profile.role) &&
    !ACTIVE_SUBSCRIPTION_STATUSES.includes(college.subscription_status || "no_subscription") &&
    !BILLING_EXEMPT_PATHS.some((p) => pathname.startsWith(p));

  return (
    <div>
      <div className="demo-banner">
        LIVE PRODUCTION DATABASE — CSD CoachConnect (Phase 1). Real Supabase-backed data, authentication, and per-college isolation.
      </div>
      <div className="topbar">
        <div className="brand">
          <span className="dot" />
          CSD CoachConnect
          <small>Collegiate Sports Data · Recruiting Intelligence</small>
        </div>
        <div className="nav">
          {NAV_LINKS.map((link) => (
            <Link key={link.href} href={link.href} className={pathname.startsWith(link.href) ? "active" : ""}>
              {link.label}
              {link.href === "/alerts" && unseenAlerts > 0 && (
                <span
                  style={{
                    marginLeft: 5,
                    background: "#d4a017",
                    color: "#0b1f3a",
                    borderRadius: 10,
                    padding: "1px 6px",
                    fontSize: 10.5,
                    fontWeight: 700,
                  }}
                >
                  {unseenAlerts}
                </span>
              )}
            </Link>
          ))}
        </div>
        <div className="topbar-right">
          <div className="user-chip">
            <span className="avatar">{initials}</span>
            <div>
              <div>{profile?.full_name || session?.user?.email}</div>
              <div style={{ fontSize: 10.5, color: "#9fb0cc" }}>
                {ROLE_LABEL[profile?.role] || "…"} {college ? `· ${college.name}` : ""}
              </div>
            </div>
          </div>
          <button className="btn btn-sm" onClick={signOut}>
            Sign out
          </button>
        </div>
      </div>

      {!profile && <CompleteProfileForm />}
      {profile && billingBlocked && <BillingGate status={college?.subscription_status} />}
      {profile && !billingBlocked && children}

      <div className="footer-note">
        CSD CoachConnect — Phase 1 production build. Live database, real authentication, per-college data isolation via Row Level Security.
      </div>
    </div>
  );
}

function BillingGate({ status }) {
  const copy =
    status === "past_due"
      ? "Your last payment didn't go through. Update your card to keep using CoachConnect."
      : status === "canceled" || status === "unpaid"
      ? "Your subscription has ended. Reactivate it to keep using CoachConnect."
      : "This account doesn't have an active subscription yet. Start your 14-day free trial to unlock CoachConnect.";

  return (
    <div className="view">
      <div className="card" style={{ maxWidth: 520, margin: "60px auto", textAlign: "center" }}>
        <h1 style={{ marginBottom: 10 }}>Subscription required</h1>
        <p style={{ color: "#697386", marginBottom: 20 }}>{copy}</p>
        <Link href="/billing" className="btn btn-primary">
          Go to Billing
        </Link>
      </div>
    </div>
  );
}
