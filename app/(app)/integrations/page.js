"use client";
import { useEffect, useState } from "react";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { useAuth } from "@/lib/auth-context";

const INTEGRATIONS_ADMIN_ROLES = ["sysadmin", "athletic_director"];

const EVENTS = [
  {
    name: "contact_logged",
    when: "A coach logs a call, email, text, visit, or evaluation against a school.",
  },
  {
    name: "school_watchlisted",
    when: "A school is added to your college's watchlist.",
  },
  {
    name: "recruiting_status_changed",
    when: "Your college's status on a prospect changes to Watching, Offered, or Committed.",
  },
];

export default function IntegrationsPage() {
  const supabase = getSupabaseBrowserClient();
  const { profile } = useAuth();
  const canManage = INTEGRATIONS_ADMIN_ROLES.includes(profile?.role);

  const [sub, setSub] = useState(null);
  const [loading, setLoading] = useState(true);
  const [urlDraft, setUrlDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [testResult, setTestResult] = useState(null);
  const [testing, setTesting] = useState(false);
  const [showSecret, setShowSecret] = useState(false);

  async function authedFetch(path, options = {}) {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    const res = await fetch(path, {
      ...options,
      headers: {
        ...(options.headers || {}),
        Authorization: `Bearer ${session?.access_token}`,
      },
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || "Something went wrong.");
    return json;
  }

  async function load() {
    setLoading(true);
    setError("");
    try {
      const json = await authedFetch("/api/integrations/webhook");
      setSub(json.subscription);
      setUrlDraft(json.subscription?.url || "");
    } catch (err) {
      setError(err.message || "Could not load your integration settings.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function save(regenerateSecret) {
    setError("");
    setNotice("");
    setTestResult(null);
    setSaving(true);
    try {
      const json = await authedFetch("/api/integrations/webhook", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: urlDraft.trim(), regenerate_secret: !!regenerateSecret, is_active: sub?.is_active !== false }),
      });
      setNotice(regenerateSecret ? "Saved — the signing secret was regenerated. Update it wherever you verify signatures." : "Saved.");
      await load();
    } catch (err) {
      setError(err.message || "Could not save.");
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive() {
    if (!sub) return;
    setError("");
    setSaving(true);
    try {
      await authedFetch("/api/integrations/webhook", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: sub.url, regenerate_secret: false, is_active: !sub.is_active }),
      });
      await load();
    } catch (err) {
      setError(err.message || "Could not update.");
    } finally {
      setSaving(false);
    }
  }

  async function removeWebhook() {
    setError("");
    setNotice("");
    setSaving(true);
    try {
      await authedFetch("/api/integrations/webhook", { method: "DELETE" });
      setSub(null);
      setUrlDraft("");
      setTestResult(null);
      setNotice("Webhook removed.");
    } catch (err) {
      setError(err.message || "Could not remove the webhook.");
    } finally {
      setSaving(false);
    }
  }

  async function sendTest() {
    setError("");
    setTestResult(null);
    setTesting(true);
    try {
      const json = await authedFetch("/api/integrations/webhook/test", { method: "POST" });
      setTestResult(json);
    } catch (err) {
      setError(err.message || "Could not send the test webhook.");
    } finally {
      setTesting(false);
    }
  }

  function copySecret() {
    if (!sub?.secret) return;
    navigator.clipboard?.writeText(sub.secret);
    setNotice("Secret copied to clipboard.");
  }

  return (
    <div className="view">
      <div className="view-header">
        <div>
          <h1>Integrations</h1>
          <p>Send CoachConnect activity to HubSpot, Zapier, Make, or any tool that can receive a webhook.</p>
        </div>
      </div>

      {!canManage && (
        <div className="notice" style={{ marginBottom: 14, fontSize: 11.5 }}>
          Contact your System Admin or Athletic Director to set up or change integrations for your program. You can still see the current status below.
        </div>
      )}

      {error && <div className="notice danger" style={{ marginBottom: 14 }}>{error}</div>}
      {notice && <div className="notice" style={{ marginBottom: 14 }}>{notice}</div>}

      <div className="card" style={{ marginBottom: 14 }}>
        <h3>Outbound Webhook</h3>
        {loading ? (
          <div className="empty-state">Loading…</div>
        ) : (
          <>
            <p style={{ fontSize: 12.5, color: "#697386", marginTop: 0 }}>
              Give us a URL — a Zapier or Make &quot;Catch Hook&quot; trigger, a HubSpot workflow webhook trigger, or your own endpoint — and CoachConnect will POST a signed JSON event to it whenever something happens in your recruiting activity. This isn&apos;t locked to HubSpot: it works with any tool that can receive a webhook.
            </p>

            <div style={{ marginBottom: 12 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: "#3a4557", display: "block", marginBottom: 4 }}>Webhook URL</label>
              <input
                value={urlDraft}
                onChange={(e) => setUrlDraft(e.target.value)}
                placeholder="https://hooks.zapier.com/hooks/catch/..."
                disabled={!canManage}
                style={{ width: "100%", maxWidth: 480 }}
              />
            </div>

            {canManage && (
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
                <button className="btn btn-sm btn-primary" disabled={saving || !urlDraft.trim()} onClick={() => save(false)}>
                  {saving ? "Saving…" : sub ? "Save URL" : "Enable Webhook"}
                </button>
                {sub && (
                  <>
                    <button className="btn btn-sm" disabled={saving} onClick={toggleActive}>
                      {sub.is_active ? "Pause" : "Resume"}
                    </button>
                    <button className="btn btn-sm" disabled={testing} onClick={sendTest}>
                      {testing ? "Sending…" : "Send Test Webhook"}
                    </button>
                    <button className="btn btn-sm" disabled={saving} onClick={() => save(true)}>
                      Regenerate Secret
                    </button>
                    <button className="btn btn-sm" disabled={saving} onClick={removeWebhook} style={{ color: "#b3261e" }}>
                      Remove
                    </button>
                  </>
                )}
              </div>
            )}

            {testResult && (
              <div className={`notice ${testResult.ok ? "" : "danger"}`} style={{ marginBottom: 14, fontSize: 12 }}>
                Test sent — received HTTP {testResult.status ?? "—"} {testResult.ok ? "(success)" : "(check your endpoint)"}.
                {testResult.detail ? <div style={{ marginTop: 4, fontFamily: "monospace", fontSize: 11 }}>{testResult.detail}</div> : null}
              </div>
            )}

            {sub ? (
              <div className="kv">
                <div className="k">Status</div>
                <div className="v">{sub.is_active ? "Active" : "Paused"}</div>
                <div className="k">Signing secret</div>
                <div className="v" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontFamily: "monospace", fontSize: 12 }}>
                    {showSecret ? sub.secret : "•".repeat(24)}
                  </span>
                  <button type="button" className="btn btn-sm" onClick={() => setShowSecret((v) => !v)}>
                    {showSecret ? "Hide" : "Reveal"}
                  </button>
                  <button type="button" className="btn btn-sm" onClick={copySecret}>
                    Copy
                  </button>
                </div>
                <div className="k">Last triggered</div>
                <div className="v">{sub.last_triggered_at ? `${new Date(sub.last_triggered_at).toLocaleString()} — ${sub.last_event}` : "Never yet"}</div>
              </div>
            ) : (
              <div className="empty-state">No webhook configured yet.</div>
            )}
          </>
        )}
      </div>

      <div className="card">
        <h3>What gets sent</h3>
        <p style={{ fontSize: 12.5, color: "#697386", marginTop: 0 }}>
          Every event is a JSON POST with a <code>X-CoachConnect-Signature: sha256=...</code> header (HMAC-SHA256 of the raw request body, using the signing secret above) so your endpoint can verify it really came from CoachConnect.
        </p>
        <div className="table-wrap" style={{ boxShadow: "none", border: "none" }}>
          <table>
            <thead>
              <tr>
                <th>Event</th>
                <th>Fires when…</th>
              </tr>
            </thead>
            <tbody>
              {EVENTS.map((e) => (
                <tr key={e.name}>
                  <td style={{ fontFamily: "monospace", fontSize: 12 }}>{e.name}</td>
                  <td style={{ fontSize: 12.5 }}>{e.when}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <pre
          style={{
            background: "#0b1f3a",
            color: "#e6ebf3",
            fontSize: 11,
            padding: 12,
            borderRadius: 8,
            marginTop: 10,
            overflow: "auto",
          }}
        >
{`{
  "event": "contact_logged",
  "college_id": "...",
  "occurred_at": "2026-08-21T14:03:00Z",
  "data": { "school_name": "...", "contact_type": "Call", "note": "...", "logged_by_name": "..." }
}`}
        </pre>
      </div>
    </div>
  );
}
