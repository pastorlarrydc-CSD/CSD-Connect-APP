"use client";
import { useState, useEffect, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { useAuth } from "@/lib/auth-context";

const BILLING_ADMIN_ROLES = ["sysadmin", "athletic_director"];

const STATUS_LABEL = {
  no_subscription: "No active subscription",
  trialing: "Free trial",
  active: "Active",
  past_due: "Payment past due",
  canceled: "Canceled",
  unpaid: "Unpaid",
  internal: "Internal account",
};

const STATUS_CLASS = {
  no_subscription: "notice",
  trialing: "notice info",
  active: "notice info",
  past_due: "notice danger",
  canceled: "notice danger",
  unpaid: "notice danger",
  internal: "notice info",
};

function fmtDate(d) {
  if (!d) return null;
  return new Date(d).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
}

function BillingContent() {
  const supabase = getSupabaseBrowserClient();
  const { profile, college, refreshProfile } = useAuth();
  const params = useSearchParams();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const canManage = BILLING_ADMIN_ROLES.includes(profile?.role);
  const status = college?.subscription_status || "no_subscription";
  const checkoutResult = params.get("checkout");

  useEffect(() => {
    // Coming back from a successful Checkout redirect -- the webhook may
    // land a second or two after Stripe redirects the browser back here,
    // so give it a moment then refresh the college record we already have
    // in context.
    if (checkoutResult === "success") {
      const t = setTimeout(() => refreshProfile(), 2000);
      return () => clearTimeout(t);
    }
  }, [checkoutResult, refreshProfile]);

  async function callBillingApi(path) {
    setError("");
    setBusy(true);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData?.session?.access_token;
      if (!token) throw new Error("Please sign in again.");
      const res = await fetch(path, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Something went wrong.");
      window.location.href = json.url;
    } catch (err) {
      setError(err.message || "Something went wrong.");
      setBusy(false);
    }
  }

  return (
    <div className="view">
      <div className="view-header">
        <div>
          <h1>Billing</h1>
          <p>{college?.name || "no college linked"}</p>
        </div>
      </div>

      {checkoutResult === "success" && (
        <div className="notice info" style={{ marginBottom: 14 }}>
          Thanks! Your subscription is being set up — this page will update automatically in a moment.
        </div>
      )}
      {checkoutResult === "cancelled" && (
        <div className="notice" style={{ marginBottom: 14 }}>
          Checkout was cancelled — no changes were made.
        </div>
      )}

      <div className="card" style={{ maxWidth: 640 }}>
        <div className="kv">
          <div className="k">Plan</div>
          <div className="v">CoachConnect Access — $99.00 / month</div>
        </div>
        <div className="kv">
          <div className="k">Status</div>
          <div className="v">{STATUS_LABEL[status] || status}</div>
        </div>
        {status === "trialing" && college?.trial_ends_at && (
          <div className="kv">
            <div className="k">Trial ends</div>
            <div className="v">{fmtDate(college.trial_ends_at)}</div>
          </div>
        )}
        {(status === "active" || status === "past_due") && college?.current_period_end && (
          <div className="kv">
            <div className="k">{status === "past_due" ? "Was due" : "Renews"}</div>
            <div className="v">{fmtDate(college.current_period_end)}</div>
          </div>
        )}

        <div className={STATUS_CLASS[status] || "notice"} style={{ marginTop: 14, marginBottom: 14 }}>
          {status === "no_subscription" && "Start a 14-day free trial — a card is required up front, but you won't be charged until the trial ends."}
          {status === "trialing" && "You're on a free trial. You can cancel any time before it ends from Manage Billing and you won't be charged."}
          {status === "active" && "Your subscription is active. Manage your card, invoices, or cancellation from Manage Billing."}
          {status === "past_due" && "Your last payment failed. Update your card from Manage Billing to keep access."}
          {(status === "canceled" || status === "unpaid") && "There's no active subscription on this account."}
          {status === "internal" && "This is an internal Collegiate Sports Data account and isn't billed."}
        </div>

        {error && <div className="notice danger" style={{ marginBottom: 14 }}>{error}</div>}

        {!canManage ? (
          <div className="notice" style={{ fontSize: 11.5 }}>
            Contact your System Admin or Athletic Director to manage billing for your program.
          </div>
        ) : status === "internal" ? null : ["no_subscription", "canceled", "unpaid"].includes(status) ? (
          <button className="btn btn-primary" disabled={busy} onClick={() => callBillingApi("/api/stripe/create-checkout-session")}>
            {busy ? "Starting…" : "Start 14-Day Free Trial"}
          </button>
        ) : (
          <button className="btn" disabled={busy} onClick={() => callBillingApi("/api/stripe/create-portal-session")}>
            {busy ? "Opening…" : "Manage Billing"}
          </button>
        )}
      </div>
    </div>
  );
}

export default function BillingPage() {
  return (
    <Suspense fallback={<div className="view"><div className="view-header"><h1>Billing</h1></div></div>}>
      <BillingContent />
    </Suspense>
  );
}
