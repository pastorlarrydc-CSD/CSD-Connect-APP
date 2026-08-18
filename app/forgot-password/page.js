"use client";
import { useState } from "react";
import Link from "next/link";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";

export default function ForgotPasswordPage() {
  const supabase = getSupabaseBrowserClient();

  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    setSubmitting(true);
    const { error: resetError } = await supabase.auth.resetPasswordForEmail(email.trim(), {
      redirectTo: `${window.location.origin}/reset-password`,
    });
    setSubmitting(false);
    // Always show the same confirmation regardless of whether the email is
    // registered -- doesn't leak which addresses have accounts.
    if (resetError) {
      setError(resetError.message || "Something went wrong. Please try again.");
      return;
    }
    setSent(true);
  }

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <h1>Reset your password</h1>
        <p className="sub">Enter your account email and we&apos;ll send a link to reset your password.</p>
        {error && <div className="notice danger" style={{ marginBottom: 12 }}>{error}</div>}
        {sent ? (
          <div className="notice info">
            If an account exists for <strong>{email}</strong>, a password reset link is on its way. Check your inbox (and spam folder) — the link expires after a while, so use it soon.
          </div>
        ) : (
          <form onSubmit={handleSubmit}>
            <div className="form-field">
              <label>Email</label>
              <input type="email" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@college.edu" />
            </div>
            <button className="btn btn-primary" style={{ width: "100%", justifyContent: "center", marginTop: 6 }} disabled={submitting}>
              {submitting ? "Sending…" : "Send Reset Link"}
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
