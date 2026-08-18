"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";

export default function ResetPasswordPage() {
  const supabase = getSupabaseBrowserClient();
  const router = useRouter();

  // The Supabase client parses the recovery link's token out of the URL on
  // load and exchanges it for a session -- that's what PASSWORD_RECOVERY
  // fires for. This is deliberately the ONLY thing that unlocks the form:
  // an already-signed-in visitor who just navigates here (e.g. an unlocked
  // shared device) must not be able to set a new password without going
  // through the emailed link -- that's what /account's Change Password
  // card is for, which re-verifies the current password first.
  const [checking, setChecking] = useState(true);
  const [ready, setReady] = useState(false);

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  useEffect(() => {
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY") {
        setReady(true);
        setChecking(false);
      }
    });

    // Give the client a few seconds to parse the link and fire the event
    // above; if it never does (broken/expired/missing link), fall through
    // to the invalid-link state instead of hanging on "Verifying…" forever.
    const timeout = setTimeout(() => setChecking(false), 4000);

    return () => {
      subscription.unsubscribe();
      clearTimeout(timeout);
    };
  }, [supabase]);

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    if (password.length < 6) {
      setError("Password must be at least 6 characters.");
      return;
    }
    if (password !== confirm) {
      setError("Passwords don't match.");
      return;
    }
    setSubmitting(true);
    const { error: updateError } = await supabase.auth.updateUser({ password });
    setSubmitting(false);
    if (updateError) {
      setError(updateError.message || "Could not update your password.");
      return;
    }
    setDone(true);
    setTimeout(() => router.push("/dashboard"), 1800);
  }

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <h1>Set a new password</h1>
        <p className="sub">Choose a new password for your CoachConnect account.</p>

        {checking ? (
          <div className="empty-state">Verifying your reset link…</div>
        ) : done ? (
          <div className="notice info">Password updated. Taking you to your dashboard…</div>
        ) : !ready ? (
          <div>
            <div className="notice danger" style={{ marginBottom: 12 }}>
              This reset link is invalid or has expired.
            </div>
            <Link href="/forgot-password" className="btn btn-primary" style={{ width: "100%", justifyContent: "center" }}>
              Request a new link
            </Link>
          </div>
        ) : (
          <form onSubmit={handleSubmit}>
            {error && <div className="notice danger" style={{ marginBottom: 12 }}>{error}</div>}
            <div className="form-field">
              <label>New password</label>
              <input type="password" required minLength={6} autoFocus value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" />
            </div>
            <div className="form-field">
              <label>Confirm new password</label>
              <input type="password" required minLength={6} value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="••••••••" />
            </div>
            <button className="btn btn-primary" style={{ width: "100%", justifyContent: "center", marginTop: 6 }} disabled={submitting}>
              {submitting ? "Updating…" : "Update Password"}
            </button>
          </form>
        )}

        <p style={{ fontSize: 12.5, color: "#697386", marginTop: 16, textAlign: "center" }}>
          <Link href="/login">← Back to sign in</Link>
        </p>
      </div>
    </div>
  );
}
