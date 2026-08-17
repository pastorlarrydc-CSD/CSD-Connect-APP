"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";

export default function LoginPage() {
  const supabase = getSupabaseBrowserClient();
  const router = useRouter();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Set only for accounts that have a verified authenticator factor
  // enrolled (see /account) -- everyone else never sees this state, so
  // enabling MFA on one account has zero effect on any other account.
  const [mfaFactorId, setMfaFactorId] = useState(null);
  const [mfaCode, setMfaCode] = useState("");
  const [mfaError, setMfaError] = useState("");
  const [verifyingMfa, setVerifyingMfa] = useState(false);

  async function handlePasswordSubmit(e) {
    e.preventDefault();
    setError("");
    setSubmitting(true);
    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
    if (signInError) {
      setSubmitting(false);
      setError(signInError.message);
      return;
    }

    // Password was correct. Now check whether this account needs a second
    // factor before the session is fully trusted (aal2). Accounts with no
    // enrolled authenticator always come back with nextLevel === currentLevel,
    // so this is a no-op for them -- straight through to the dashboard.
    const { data: aal, error: aalError } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    setSubmitting(false);
    if (aalError) {
      setError(aalError.message);
      return;
    }
    if (aal.nextLevel === "aal2" && aal.nextLevel !== aal.currentLevel) {
      const { data: factorsData, error: factorsError } = await supabase.auth.mfa.listFactors();
      const factor = factorsData?.totp?.[0];
      if (factorsError || !factor) {
        setError("Your account requires two-factor verification, but no authenticator was found. Contact a System Admin.");
        return;
      }
      setMfaFactorId(factor.id);
      return; // hold here for the code -- do not navigate yet
    }
    router.push("/dashboard");
  }

  async function handleMfaSubmit(e) {
    e.preventDefault();
    setMfaError("");
    setVerifyingMfa(true);
    const { error: verifyError } = await supabase.auth.mfa.challengeAndVerify({
      factorId: mfaFactorId,
      code: mfaCode.trim(),
    });
    setVerifyingMfa(false);
    if (verifyError) {
      setMfaError(verifyError.message);
      return;
    }
    router.push("/dashboard");
  }

  async function backToPasswordForm() {
    // The password step already created a session; drop it so a wrong
    // account / device isn't left half-authenticated in the background.
    await supabase.auth.signOut();
    setMfaFactorId(null);
    setMfaCode("");
    setMfaError("");
    setPassword("");
  }

  if (mfaFactorId) {
    return (
      <div className="auth-wrap">
        <div className="auth-card">
          <h1>Two-Factor Verification</h1>
          <p className="sub">Enter the 6-digit code from your authenticator app</p>
          {mfaError && <div className="notice danger" style={{ marginBottom: 12 }}>{mfaError}</div>}
          <form onSubmit={handleMfaSubmit}>
            <div className="form-field">
              <label>Authentication code</label>
              <input
                value={mfaCode}
                onChange={(e) => setMfaCode(e.target.value)}
                placeholder="123456"
                inputMode="numeric"
                autoComplete="one-time-code"
                autoFocus
                required
              />
            </div>
            <button
              className="btn btn-primary"
              style={{ width: "100%", justifyContent: "center", marginTop: 6 }}
              disabled={verifyingMfa || mfaCode.trim().length < 6}
            >
              {verifyingMfa ? "Verifying…" : "Verify"}
            </button>
          </form>
          <p style={{ fontSize: 12.5, color: "#697386", marginTop: 16, textAlign: "center" }}>
            <button type="button" className="btn btn-sm" onClick={backToPasswordForm}>
              ← Back to sign in
            </button>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <h1>CSD CoachConnect</h1>
        <p className="sub">Sign in to your recruiting account</p>
        {error && <div className="notice danger" style={{ marginBottom: 12 }}>{error}</div>}
        <form onSubmit={handlePasswordSubmit}>
          <div className="form-field">
            <label>Email</label>
            <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@college.edu" />
          </div>
          <div className="form-field">
            <label>Password</label>
            <input type="password" required value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" />
          </div>
          <button className="btn btn-primary" style={{ width: "100%", justifyContent: "center", marginTop: 6 }} disabled={submitting}>
            {submitting ? "Signing in…" : "Sign In"}
          </button>
        </form>
        <p style={{ fontSize: 12.5, color: "#697386", marginTop: 16, textAlign: "center" }}>
          New here? <Link href="/signup">Create an account</Link>
        </p>
      </div>
    </div>
  );
}
