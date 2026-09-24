"use client";
import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { useAuth } from "@/lib/auth-context";

// Sysadmin-only 360-degree account lookup: search any login account by
// email, see identity + role + which college/school they're tied to +
// (when relevant) subscription status all in one card, and edit the
// profile-side fields directly -- built after Larry asked to "search the
// database via email and pull up and edit any account." Scoped to LOGIN
// accounts only (auth.users + profiles), not the hc_email/ad_email contact
// info already searchable via "Find & Edit a School" on the Data Quality
// page -- high school coaches don't have logins. Edit scope is
// deliberately "profile basics" only (name, title, role, college/school) --
// no password reset, suspend, or delete in this first pass; see
// app/api/admin/accounts/update/route.js's own comment.
const MIN_QUERY_LENGTH = 3;

const ROLE_LABEL = {
  college_coach: "College Coach",
  athletic_director: "Athletic Director",
  hs_coach: "HS Coach",
  verifier: "Verifier",
  sysadmin: "System Admin",
};
const ROLE_OPTIONS = Object.keys(ROLE_LABEL);

// Same vocabulary as app/(app)/admin/business/page.js's STATUS_LABEL/
// STATUS_BADGE -- kept in sync with that file rather than importing from
// it, same reasoning that file's own comment gives for not importing from
// app/(app)/billing/page.js.
const STATUS_LABEL = {
  no_subscription: "No subscription",
  trialing: "Trialing",
  active: "Active",
  past_due: "Past due",
  canceled: "Canceled",
  unpaid: "Unpaid",
  internal: "Internal",
};
const STATUS_BADGE = {
  no_subscription: "badge-not-contacted",
  trialing: "badge-unverified",
  active: "badge-public",
  past_due: "badge-private",
  canceled: "badge-not-contacted",
  unpaid: "badge-private",
  internal: "badge-contacted",
};

function fmtDateTime(d) {
  if (!d) return "—";
  return new Date(d).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export default function AccountsPage() {
  const supabase = getSupabaseBrowserClient();
  const { profile, user } = useAuth();
  const isOwner = profile?.role === "sysadmin";

  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [hasSearched, setHasSearched] = useState(false);
  const [accounts, setAccounts] = useState([]);

  const [colleges, setColleges] = useState([]);

  const [editingId, setEditingId] = useState(null);
  const [editDraft, setEditDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [justSavedId, setJustSavedId] = useState(null);

  const [schoolLookup, setSchoolLookup] = useState({ id: "", status: "idle", result: null });

  const loadColleges = useCallback(async () => {
    if (!isOwner) return;
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const res = await fetch("/api/admin/accounts/colleges", { headers: { Authorization: `Bearer ${session?.access_token}` } });
      const json = await res.json().catch(() => ({}));
      if (res.ok) setColleges(json.colleges || []);
    } catch (_) {
      // Non-fatal -- the college dropdown just falls back to empty if this
      // fails; the rest of the page still works.
    }
  }, [supabase, isOwner]);

  useEffect(() => {
    loadColleges();
  }, [loadColleges]);

  async function runSearch(e) {
    e.preventDefault();
    const q = query.trim();
    if (q.length < MIN_QUERY_LENGTH) {
      setSearchError(`Enter at least ${MIN_QUERY_LENGTH} characters to search.`);
      return;
    }
    setSearching(true);
    setSearchError("");
    setHasSearched(true);
    setEditingId(null);
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const res = await fetch(`/api/admin/accounts/search?email=${encodeURIComponent(q)}`, {
        headers: { Authorization: `Bearer ${session?.access_token}` },
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Could not search accounts.");
      setAccounts(json.accounts || []);
    } catch (err) {
      setSearchError(err.message || "Could not search accounts.");
      setAccounts([]);
    } finally {
      setSearching(false);
    }
  }

  function startEdit(account) {
    setEditingId(account.id);
    setSaveError("");
    setJustSavedId(null);
    setEditDraft({
      full_name: account.profile?.full_name || "",
      title: account.profile?.title || "",
      role: account.profile?.role || "hs_coach",
      college_id: account.profile?.college_id || "",
      school_id: account.profile?.school_id ?? "",
    });
    setSchoolLookup({ id: account.profile?.school_id != null ? String(account.profile.school_id) : "", status: "idle", result: account.school || null });
  }
  function cancelEdit() {
    setEditingId(null);
    setEditDraft(null);
    setSaveError("");
  }

  async function lookupSchool() {
    const id = (schoolLookup.id || "").trim();
    if (!id || !/^\d+$/.test(id)) {
      setSchoolLookup((prev) => ({ ...prev, status: "error", result: null }));
      return;
    }
    setSchoolLookup((prev) => ({ ...prev, status: "loading" }));
    try {
      const { data, error } = await supabase.from("schools").select("id,name,city,state").eq("id", Number(id)).maybeSingle();
      if (error) throw error;
      setSchoolLookup({ id, status: data ? "found" : "not_found", result: data || null });
      if (data) setEditDraft((prev) => ({ ...prev, school_id: data.id }));
    } catch (_) {
      setSchoolLookup({ id, status: "error", result: null });
    }
  }

  async function saveEdit(account) {
    setSaving(true);
    setSaveError("");
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const res = await fetch("/api/admin/accounts/update", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token}` },
        body: JSON.stringify({
          userId: account.id,
          full_name: editDraft.full_name,
          title: editDraft.title,
          role: editDraft.role,
          college_id: editDraft.college_id || null,
          school_id: editDraft.school_id === "" ? null : editDraft.school_id,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Could not save this account.");
      const updatedCollege = editDraft.college_id ? colleges.find((c) => c.id === editDraft.college_id) || null : null;
      setAccounts((prev) =>
        prev.map((a) =>
          a.id === account.id
            ? { ...a, profile: { ...a.profile, ...json.profile }, college: updatedCollege, school: schoolLookup.result || a.school }
            : a
        )
      );
      setEditingId(null);
      setJustSavedId(account.id);
    } catch (err) {
      setSaveError(err.message || "Could not save this account.");
    } finally {
      setSaving(false);
    }
  }

  if (!isOwner) {
    return (
      <div className="view">
        <div className="notice danger">Account search is limited to System Admins.</div>
      </div>
    );
  }

  return (
    <div className="view">
      <Link href="/admin" className="btn btn-sm" style={{ marginBottom: 12, display: "inline-flex" }}>
        ← Back to Admin
      </Link>
      <div className="view-header">
        <div>
          <h1>Accounts</h1>
          <p>Search any login account by email — coaches, ADs, verifiers, sysadmins — and edit their profile basics. Not visible to customers.</p>
        </div>
      </div>

      <form onSubmit={runSearch} className="filters" style={{ marginBottom: 14 }}>
        <div className="field" style={{ flex: 1, minWidth: 260 }}>
          <label>Email</label>
          <input
            type="text"
            placeholder="Search by email (or part of it)…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            style={{ width: "100%" }}
          />
        </div>
        <button className="btn btn-sm btn-primary" type="submit" disabled={searching} style={{ alignSelf: "flex-end" }}>
          {searching ? "Searching…" : "Search"}
        </button>
      </form>

      {searchError && (
        <div className="notice danger" style={{ marginBottom: 14 }}>
          {searchError}
        </div>
      )}

      {!hasSearched ? (
        <div className="empty-state">Search by email to pull up an account.</div>
      ) : accounts.length === 0 && !searching ? (
        <div className="empty-state">No accounts matched that email.</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {accounts.map((a) => {
            const isEditing = editingId === a.id;
            const isSelf = a.id === user?.id;
            return (
              <div key={a.id} className="card">
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 10 }}>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 15 }}>
                      {a.profile?.full_name || <span style={{ color: "var(--gray-500)", fontStyle: "italic" }}>No name on file</span>}
                      {isSelf && <span className="badge badge-contacted" style={{ marginLeft: 8 }}>You</span>}
                    </div>
                    <div style={{ color: "var(--gray-500)", fontSize: 13 }}>{a.email}</div>
                  </div>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                    {a.profile ? (
                      <span className="badge badge-contacted">{ROLE_LABEL[a.profile.role] || a.profile.role}</span>
                    ) : (
                      <span className="badge badge-not-contacted">No profile row</span>
                    )}
                    {a.college && (
                      <span className={`badge ${STATUS_BADGE[a.college.subscription_status] || "badge-not-contacted"}`}>
                        {a.college.name} — {STATUS_LABEL[a.college.subscription_status] || a.college.subscription_status}
                      </span>
                    )}
                    {!a.email_confirmed_at && <span className="badge badge-private">Email unconfirmed</span>}
                  </div>
                </div>

                <div className="kv" style={{ marginTop: 12 }}>
                  <div className="k">Title</div>
                  <div className="v">{a.profile?.title || "—"}</div>
                  <div className="k">School</div>
                  <div className="v">{a.school ? `${a.school.name} — ${a.school.city}, ${a.school.state}` : "—"}</div>
                  <div className="k">Account created</div>
                  <div className="v">{fmtDateTime(a.created_at)}</div>
                  <div className="k">Last signed in</div>
                  <div className="v">{fmtDateTime(a.last_sign_in_at)}</div>
                </div>

                {justSavedId === a.id && !isEditing && (
                  <div className="notice info" style={{ marginTop: 12 }}>
                    ✓ Saved.
                  </div>
                )}

                {!isEditing ? (
                  <div style={{ marginTop: 12 }}>
                    <button
                      className="btn btn-sm btn-primary"
                      onClick={() => startEdit(a)}
                      disabled={!a.profile}
                      title={!a.profile ? "This account has no profile row yet — nothing to edit here." : undefined}
                    >
                      Edit
                    </button>
                  </div>
                ) : (
                  <div style={{ marginTop: 14, paddingTop: 14, borderTop: "1px solid var(--gray-200)" }}>
                    <div className="grid grid-2" style={{ marginBottom: 10 }}>
                      <div className="form-field">
                        <label>Full Name</label>
                        <input
                          type="text"
                          value={editDraft.full_name}
                          onChange={(e) => setEditDraft((prev) => ({ ...prev, full_name: e.target.value }))}
                        />
                      </div>
                      <div className="form-field">
                        <label>Title</label>
                        <input
                          type="text"
                          value={editDraft.title}
                          onChange={(e) => setEditDraft((prev) => ({ ...prev, title: e.target.value }))}
                        />
                      </div>
                      <div className="form-field">
                        <label>Role</label>
                        <select value={editDraft.role} onChange={(e) => setEditDraft((prev) => ({ ...prev, role: e.target.value }))}>
                          {ROLE_OPTIONS.map((r) => (
                            <option key={r} value={r}>
                              {ROLE_LABEL[r]}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="form-field">
                        <label>College</label>
                        <select
                          value={editDraft.college_id || ""}
                          onChange={(e) => setEditDraft((prev) => ({ ...prev, college_id: e.target.value }))}
                        >
                          <option value="">— None —</option>
                          {colleges.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.name} {c.state ? `(${c.state})` : ""}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>

                    <div className="form-field" style={{ maxWidth: 420 }}>
                      <label>School (for HS coaches — enter the school ID)</label>
                      <div style={{ display: "flex", gap: 6 }}>
                        <input
                          type="text"
                          placeholder="School ID"
                          value={schoolLookup.id}
                          onChange={(e) => setSchoolLookup({ id: e.target.value, status: "idle", result: null })}
                          style={{ width: 120 }}
                        />
                        <button type="button" className="btn btn-sm" onClick={lookupSchool}>
                          Look up
                        </button>
                        {schoolLookup.id && (
                          <button
                            type="button"
                            className="btn btn-sm"
                            onClick={() => {
                              setSchoolLookup({ id: "", status: "idle", result: null });
                              setEditDraft((prev) => ({ ...prev, school_id: "" }));
                            }}
                          >
                            Clear
                          </button>
                        )}
                      </div>
                      {schoolLookup.status === "found" && schoolLookup.result && (
                        <div style={{ fontSize: 12.5, color: "var(--green)", marginTop: 4 }}>
                          ✓ {schoolLookup.result.name} — {schoolLookup.result.city}, {schoolLookup.result.state}
                        </div>
                      )}
                      {schoolLookup.status === "not_found" && (
                        <div style={{ fontSize: 12.5, color: "var(--red)", marginTop: 4 }}>No school with that ID.</div>
                      )}
                      {schoolLookup.status === "error" && (
                        <div style={{ fontSize: 12.5, color: "var(--red)", marginTop: 4 }}>Enter a numeric school ID.</div>
                      )}
                    </div>

                    {saveError && (
                      <div className="notice danger" style={{ marginTop: 10 }}>
                        {saveError}
                      </div>
                    )}

                    <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
                      <button className="btn btn-sm btn-gold" onClick={() => saveEdit(a)} disabled={saving}>
                        {saving ? "Saving…" : "Save"}
                      </button>
                      <button type="button" className="btn btn-sm" onClick={cancelEdit} disabled={saving}>
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
