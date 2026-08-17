"use client";
import { useEffect, useState, useCallback } from "react";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { useAuth } from "@/lib/auth-context";

export default function AccountSecurityPage() {
  const supabase = getSupabaseBrowserClient();
  const { user, profile, college } = useAuth();

  const [factors, setFactors] = useState([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState("");

  // enrollment flow state
  const [enrollData, setEnrollData] = useState(null); // { factorId, qrCode, secret }
  const [starting, setStarting] = useState(false);
  const [code, setCode] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [enrollError, setEnrollError] = useState("");
  const [successNote, setSuccessNote] = useState("");

  const [removingId, setRemovingId] = useState(null);
  const [removeError, setRemoveError] = useState("");

  const loadFactors = useCallback(async () => {
    setLoading(true);
    setListError("");
    const { data, error } = await supabase.auth.mfa.listFactors();
    if (error) {
      setListError(error.message || "Could not load your security settings.");
    } else {
      setFactors(data?.totp || []);
    }
    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    loadFactors();
  }, [loadFactors]);

  async function startEnroll() {
    setEnrollError("");
    setSuccessNote("");
    setStarting(true);
    try {
      const { data, error } = await supabase.auth.mfa.enroll({
        factorType: "totp",
        friendlyName: `Authenticator (${new Date().toLocaleDateString()})`,
      });
      if (error) throw error;
      setEnrollData({ factorId: data.id, qrCode: data.totp.qr_code, secret: data.totp.secret });
      setCode("");
    } catch (err) {
      setEnrollError(err.message || "Could not start setup. Try again.");
    } finally {
      setStarting(false);
    }
  }

  // Backs out of an in-progress enrollment cleanly -- unenrolls the
  // half-finished (unverified) factor rather than leaving it dangling.
  async function cancelEnroll() {
    if (enrollData) {
      await supabase.auth.mfa.unenroll({ factorId: enrollData.factorId });
    }
    setEnrollData(null);
    setCode("");
    setEnrollError("");
  }

  async function confirmEnroll(e) {
    e.preventDefault();
    setEnrollError("");
    setVerifying(true);
    try {
      const { error } = await supabase.auth.mfa.challengeAndVerify({
        factorId: enrollData.factorId,
        code: code.trim(),
      });
      if (error) throw error;
      setEnrollData(null);
      setCode("");
      setSuccessNote("Two-factor authentication is now enabled on your account.");
      await loadFactors();
    } catch (err) {
      setEnrollError(err.message || "That code didn't match. Check your app and try again.");
    } finally {
      setVerifying(false);
    }
  }

  async function removeFactor(factorId) {
    if (!confirm("Remove this authenticator? You'll be able to sign in with just your password afterward.")) return;
    setRemoveError("");
    setRemovingId(factorId);
    try {
      const { error } = await supabase.auth.mfa.unenroll({ factorId });
      if (error) throw error;
      await loadFactors();
    } catch (err) {
      setRemoveError(err.message || "Could not remove this authenticator.");
    } finally {
      setRemovingId(null);
    }
  }

  return (
    <div className="view">
      <div className="view-header">
        <div>
          <h1>Account Security</h1>
          <p>{profile?.full_name || user?.email} — {college?.name || "no college linked"}</p>
        </div>
      </div>

      <div className="card" style={{ maxWidth: 640 }}>
        <h3>Two-Factor Authentication</h3>
        <p style={{ fontSize: 12.5, color: "#697386", marginTop: -4 }}>
          Add an authenticator app (Google Authenticator, Authy, 1Password, etc.) as a second step at login, in addition to your password. Completely optional — turning it on only affects your own account.
        </p>

        {listError && <div className="notice danger" style={{ marginBottom: 10 }}>{listError}</div>}
        {successNote && <div className="notice info" style={{ marginBottom: 10 }}>{successNote}</div>}

        {loading ? (
          <div className="empty-state">Loading…</div>
        ) : enrollData ? (
          <div>
            {enrollError && <div className="notice danger" style={{ marginBottom: 10 }}>{enrollError}</div>}
            <p style={{ fontSize: 13 }}>1. Scan this QR code with your authenticator app:</p>
            <img src={enrollData.qrCode} alt="Authenticator QR code" style={{ width: 180, height: 180, border: "1px solid #dde1e7", borderRadius: 8, marginBottom: 8 }} />
            <div className="kv" style={{ marginBottom: 12, gridTemplateColumns: "110px 1fr" }}>
              <div className="k">Can&apos;t scan?</div>
              <div className="v" style={{ fontWeight: 400, fontFamily: "monospace", fontSize: 12, wordBreak: "break-all" }}>{enrollData.secret}</div>
            </div>
            <form onSubmit={confirmEnroll}>
              <p style={{ fontSize: 13 }}>2. Enter the 6-digit code it generates:</p>
              <div className="form-field" style={{ maxWidth: 200 }}>
                <input
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="123456"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  autoFocus
                />
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button className="btn btn-gold btn-sm" disabled={verifying || code.trim().length < 6}>
                  {verifying ? "Verifying…" : "Verify & Enable"}
                </button>
                <button type="button" className="btn btn-sm" onClick={cancelEnroll} disabled={verifying}>
                  Cancel
                </button>
              </div>
            </form>
          </div>
        ) : factors.length ? (
          <div>
            <div className="notice info" style={{ marginBottom: 10 }}>Enabled — you&apos;ll be asked for a code from your app each time you sign in.</div>
            {removeError && <div className="notice danger" style={{ marginBottom: 10 }}>{removeError}</div>}
            {factors.map((f) => (
              <div className="log-item" key={f.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <strong>{f.friendly_name || "Authenticator app"}</strong>
                  <div style={{ fontSize: 12, color: "#697386" }}>Added {new Date(f.created_at).toLocaleDateString()}</div>
                </div>
                <button className="btn btn-sm btn-danger" onClick={() => removeFactor(f.id)} disabled={removingId === f.id}>
                  {removingId === f.id ? "Removing…" : "Remove"}
                </button>
              </div>
            ))}
          </div>
        ) : (
          <button className="btn btn-primary btn-sm" onClick={startEnroll} disabled={starting}>
            {starting ? "Starting…" : "Set Up Authenticator App"}
          </button>
        )}

        <div className="notice" style={{ marginTop: 14, fontSize: 11.5 }}>
          Lost access to your authenticator app? Contact a System Admin — they can remove it from your account directly so you can sign back in with just your password.
        </div>
      </div>
    </div>
  );
}
