"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";

export default function ResetPasswordPage() {
  const supabase = getSupabaseBrowserClient();
  const router = useRouter();

  // The Supabase client parses the recovery link's token out of the URL on
  // load and exchanges it for a real (but narrowly-scoped) session -- that's
  // what PASSWORD_RECOVERY fires for. Until that resolves (or we confirm
  // there's no session at all), show a loading state rather than either form.
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

    // If the link already resolved before this listener attached (or this
    // is a plain page refresh on an already-recovered session), fall back to
    // checking for an existing session directly.
    supabase.auth.getSession().then(({ data }) => {
      if (data?.session) setReady(true);
      setChecking(false);
    });

    return () => subscription.unsubscribe();
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
