"use client";
import { useEffect, useState, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { useAuth } from "@/lib/auth-context";

function fmtPhone(v) {
  if (!v) return "";
  const digits = String(v).replace(/\D/g, "");
  return digits.length === 10 ? `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}` : v;
}

const INTAKE_STATUSES = ["submitted", "reviewed", "contacted"];
const LEVELS_OF_PLAY = ["", "FBS", "FCS", "D2", "D3", "NAIA", "JUCO", "Prep/Post-Grad"];

// Per-college recruiting interest -- separate from the intake status above.
// Intake status ("submitted/reviewed/contacted") tracks whether college
// staff have processed an HS coach's submission; recruiting status tracks
// where THIS college actually stands with the athlete, same idea as a
// physical recruiting board. Every college sees/sets its own value on the
// same shared prospect record (see prospect_recruiting_status table).
const RECRUITING_STATUSES = ["watching", "offered", "committed"];
const RECRUITING_LABEL = { watching: "Watching", offered: "Offered", committed: "Committed" };
const RECRUITING_BADGE_CLASS = { watching: "badge-watching", offered: "badge-offered", committed: "badge-committed" };

// Predefined scouting tags -- kept as a fixed list so the board stays
// consistent/filterable across a whole staff. See prospect_tags table.
const TAG_OPTIONS = ["Priority", "Sleeper", "Needs Film", "Camp Invite", "Grayshirt", "Preferred Walk-on", "Do Not Pursue"];

export default function ProspectDetailPage() {
  const { id } = useParams();
  const router = useRouter();
  const supabase = getSupabaseBrowserClient();
  const { user, profile, college } = useAuth();

  const [prospect, setProspect] = useState(null);
  const [loading, setLoading] = useState(true);

  const [statusSaving, setStatusSaving] = useState(false);
  const [statusError, setStatusError] = useState("");

  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");

  const [editingContact, setEditingContact] = useState(false);
  const [contactForm, setContactForm] = useState({
    athlete_email: "",
    athlete_cell: "",
    guardian_authorized: false,
    guardian_first_name: "",
    guardian_last_name: "",
    guardian_email: "",
    guardian_cell: "",
  });
  const [contactSaving, setContactSaving] = useState(false);
  const [contactError, setContactError] = useState("");

  const [editingOutcome, setEditingOutcome] = useState(false);
  const [outcomeForm, setOutcomeForm] = useState({ offers_received: "", committed_to: "" });
  const [outcomeSaving, setOutcomeSaving] = useState(false);
  const [outcomeError, setOutcomeError] = useState("");

  const [editingLinks, setEditingLinks] = useState(false);
  const [linksForm, setLinksForm] = useState({ hudl_url: "", x_url: "", level_of_play: "" });
  const [linksSaving, setLinksSaving] = useState(false);
  const [linksError, setLinksError] = useState("");

  // Recruiting interest (this college's own watching/offered/committed mark).
  const [recruitingStatus, setRecruitingStatus] = useState(null); // null = not tracked yet
  const [recruitingLoading, setRecruitingLoading] = useState(true);
  const [recruitingSaving, setRecruitingSaving] = useState(false);
  const [recruitingError, setRecruitingError] = useState("");

  // Scouting: this college's own private 1-5 star rating, predefined tags,
  // and timestamped notes on this athlete. See prospect_ratings,
  // prospect_tags, and prospect_notes tables.
  const [scoutingRating, setScoutingRating] = useState(0);
  const [scoutingTags, setScoutingTags] = useState([]);
  const [scoutingNotes, setScoutingNotes] = useState([]);
  const [scoutingLoading, setScoutingLoading] = useState(true);
  const [ratingSaving, setRatingSaving] = useState(false);
  const [tagSaving, setTagSaving] = useState("");
  const [noteDraft, setNoteDraft] = useState("");
  const [noteSaving, setNoteSaving] = useState(false);
  const [scoutingError, setScoutingError] = useState("");

  const canManageIntake = profile?.role === "verifier" || profile?.role === "sysadmin" || prospect?.submitted_by === user?.id;
  const canSetRecruitingStatus = !!college?.id;

  const load = useCallback(async () => {
    const { data } = await supabase
      .from("prospects")
      .select("*, schools(id,name,city,state,hc_first_name,hc_last_name,hc_email,hc_cell,hc_office)")
      .eq("id", id)
      .maybeSingle();
    setProspect(data || null);
    setLoading(false);
  }, [supabase, id]);

  useEffect(() => {
    load();
  }, [load]);

  // On Watchlist / Last Contact -- same data the Recruiting Board shows,
  // sourced from the linked school so it stays in sync with one source of
  // truth. Read-only here; managed from the school profile page.
  const [schoolContext, setSchoolContext] = useState({ watchlisted: false, lastContact: null });
  const [schoolContextLoading, setSchoolContextLoading] = useState(true);

  const loadSchoolContext = useCallback(async () => {
    if (!college?.id || !prospect?.school_id) {
      setSchoolContext({ watchlisted: false, lastContact: null });
      setSchoolContextLoading(false);
      return;
    }
    setSchoolContextLoading(true);
    const [{ data: watch }, { data: contacts }] = await Promise.all([
      supabase.from("watchlist_items").select("id").eq("college_id", college.id).eq("school_id", prospect.school_id).maybeSingle(),
      supabase
        .from("contact_logs")
        .select("contact_date,contact_type")
        .eq("college_id", college.id)
        .eq("school_id", prospect.school_id)
        .order("contact_date", { ascending: false })
        .limit(1),
    ]);
    setSchoolContext({ watchlisted: !!watch, lastContact: contacts?.[0] || null });
    setSchoolContextLoading(false);
  }, [supabase, college, prospect]);

  useEffect(() => {
    loadSchoolContext();
  }, [loadSchoolContext]);

  const loadRecruitingStatus = useCallback(async () => {
    if (!college?.id) {
      setRecruitingLoading(false);
      return;
    }
    setRecruitingLoading(true);
    const { data } = await supabase
      .from("prospect_recruiting_status")
      .select("status")
      .eq("college_id", college.id)
      .eq("prospect_id", id)
      .maybeSingle();
    setRecruitingStatus(data?.status || null);
    setRecruitingLoading(false);
  }, [supabase, college, id]);

  useEffect(() => {
    loadRecruitingStatus();
  }, [loadRecruitingStatus]);

  const loadScouting = useCallback(async () => {
    if (!college?.id) {
      setScoutingLoading(false);
      return;
    }
    setScoutingLoading(true);
    const [{ data: ratingRow }, { data: tagRows }, { data: noteRows }] = await Promise.all([
      supabase.from("prospect_ratings").select("rating").eq("college_id", college.id).eq("prospect_id", id).maybeSingle(),
      supabase.from("prospect_tags").select("tag").eq("college_id", college.id).eq("prospect_id", id),
      supabase.from("prospect_notes").select("id,note,created_at").eq("college_id", college.id).eq("prospect_id", id).order("created_at", { ascending: false }),
    ]);
    setScoutingRating(ratingRow?.rating || 0);
    setScoutingTags((tagRows || []).map((t) => t.tag));
    setScoutingNotes(noteRows || []);
    setScoutingLoading(false);
  }, [supabase, college, id]);

  useEffect(() => {
    loadScouting();
  }, [loadScouting]);

  async function setRating(next) {
    if (!college?.id) return;
    setScoutingError("");
    setRatingSaving(true);
    try {
      if (scoutingRating === next) {
        const { error } = await supabase.from("prospect_ratings").delete().eq("college_id", college.id).eq("prospect_id", id);
        if (error) throw error;
        setScoutingRating(0);
      } else {
        const { error } = await supabase
          .from("prospect_ratings")
          .upsert(
            { college_id: college.id, prospect_id: Number(id), rating: next, rated_by: user.id, updated_at: new Date().toISOString() },
            { onConflict: "college_id,prospect_id" }
          );
        if (error) throw error;
        setScoutingRating(next);
      }
    } catch (err) {
      setScoutingError(err.message || "Could not save rating.");
    } finally {
      setRatingSaving(false);
    }
  }

  async function toggleTag(tag) {
    if (!college?.id) return;
    setScoutingError("");
    setTagSaving(tag);
    try {
      if (scoutingTags.includes(tag)) {
        const { error } = await supabase.from("prospect_tags").delete().eq("college_id", college.id).eq("prospect_id", id).eq("tag", tag);
        if (error) throw error;
        setScoutingTags((prev) => prev.filter((t) => t !== tag));
      } else {
        const { error } = await supabase.from("prospect_tags").insert({ college_id: college.id, prospect_id: Number(id), tag, tagged_by: user.id });
        if (error) throw error;
        setScoutingTags((prev) => [...prev, tag]);
      }
    } catch (err) {
      setScoutingError(err.message || "Could not update tags.");
    } finally {
      setTagSaving("");
    }
  }

  async function addNote(e) {
    e.preventDefault();
    if (!college?.id || !noteDraft.trim()) return;
    setScoutingError("");
    setNoteSaving(true);
    try {
      const { error } = await supabase.from("prospect_notes").insert({ college_id: college.id, prospect_id: Number(id), note: noteDraft.trim(), written_by: user.id });
      if (error) throw error;
      setNoteDraft("");
      loadScouting();
    } catch (err) {
      setScoutingError(err.message || "Could not save note.");
    } finally {
      setNoteSaving(false);
    }
  }

  async function setIntakeStatus(next) {
    setStatusError("");
    setStatusSaving(true);
    const { error } = await supabase.from("prospects").update({ status: next }).eq("id", id);
    setStatusSaving(false);
    if (error) {
      setStatusError(error.message);
      return;
    }
    load();
  }

  async function setRecruiting(next) {
    if (!college?.id) return;
    setRecruitingError("");
    setRecruitingSaving(true);
    const { error } = await supabase
      .from("prospect_recruiting_status")
      .upsert(
        { college_id: college.id, prospect_id: Number(id), status: next, updated_by: user.id, updated_at: new Date().toISOString() },
        { onConflict: "college_id,prospect_id" }
      );
    setRecruitingSaving(false);
    if (error) {
      setRecruitingError(error.message || "Could not update recruiting status.");
      return;
    }
    setRecruitingStatus(next);
  }

  function startEditContact() {
    setContactForm({
      athlete_email: prospect.athlete_email || "",
      athlete_cell: prospect.athlete_cell || "",
      guardian_authorized: !!prospect.guardian_authorized,
      guardian_first_name: prospect.guardian_first_name || "",
      guardian_last_name: prospect.guardian_last_name || "",
      guardian_email: prospect.guardian_email || "",
      guardian_cell: prospect.guardian_cell || "",
    });
    setContactError("");
    setEditingContact(true);
  }

  async function saveContact(e) {
    e.preventDefault();
    setContactError("");
    setContactSaving(true);
    const { error } = await supabase
      .from("prospects")
      .update({
        athlete_email: contactForm.athlete_email.trim() || null,
        athlete_cell: contactForm.athlete_cell.trim() || null,
        guardian_authorized: contactForm.guardian_authorized,
        guardian_first_name: contactForm.guardian_first_name.trim() || null,
        guardian_last_name: contactForm.guardian_last_name.trim() || null,
        guardian_email: contactForm.guardian_email.trim() || null,
        guardian_cell: contactForm.guardian_cell.trim() || null,
      })
      .eq("id", id);
    setContactSaving(false);
    if (error) {
      setContactError(error.message);
      return;
    }
    setEditingContact(false);
    load();
  }

  function startEditOutcome() {
    setOutcomeForm({ offers_received: prospect.offers_received || "", committed_to: prospect.committed_to || "" });
    setOutcomeError("");
    setEditingOutcome(true);
  }

  async function saveOutcome(e) {
    e.preventDefault();
    setOutcomeError("");
    setOutcomeSaving(true);
    const { error } = await supabase
      .from("prospects")
      .update({
        offers_received: outcomeForm.offers_received.trim() || null,
        committed_to: outcomeForm.committed_to.trim() || null,
      })
      .eq("id", id);
    setOutcomeSaving(false);
    if (error) {
      setOutcomeError(error.message);
      return;
    }
    setEditingOutcome(false);
    load();
  }

  function startEditLinks() {
    setLinksForm({ hudl_url: prospect.hudl_url || "", x_url: prospect.x_url || "", level_of_play: prospect.level_of_play || "" });
    setLinksError("");
    setEditingLinks(true);
  }

  async function saveLinks(e) {
    e.preventDefault();
    setLinksError("");
    setLinksSaving(true);
    const { error } = await supabase
      .from("prospects")
      .update({
        hudl_url: linksForm.hudl_url.trim() || null,
        x_url: linksForm.x_url.trim() || null,
        level_of_play: linksForm.level_of_play || null,
      })
      .eq("id", id);
    setLinksSaving(false);
    if (error) {
      setLinksError(error.message);
      return;
    }
    setEditingLinks(false);
    load();
  }

  async function deleteProspect() {
    if (!confirm(`Delete ${prospect.athlete_name}? This cannot be undone.`)) return;
    setDeleteError("");
    setDeleting(true);
    const { error } = await supabase.from("prospects").delete().eq("id", id);
    setDeleting(false);
    if (error) {
      setDeleteError(error.message);
      return;
    }
    router.push("/prospects");
  }

  if (loading) {
    return (
      <div className="view">
        <div className="empty-state">Loading prospect…</div>
      </div>
    );
  }

  if (!prospect) {
    return (
      <div className="view">
        <div className="notice danger">Prospect not found.</div>
      </div>
    );
  }

  return (
    <div className="view">
      <button className="btn btn-sm" style={{ marginBottom: 12 }} onClick={() => router.back()}>
        ← Back
      </button>
      <div className="view-header">
        <div>
          <h1>{prospect.athlete_name}</h1>
          <p>
            {prospect.grad_year ? `Class of ${prospect.grad_year}` : "Grad year not on file"}
            {prospect.position ? ` · ${prospect.position}` : ""}
            {prospect.jersey_number ? ` · #${prospect.jersey_number}` : ""}
            {prospect.level_of_play ? ` · ${prospect.level_of_play}` : ""}
          </p>
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          {prospect.committed_to && <span className="badge badge-committed">Committed — {prospect.committed_to}</span>}
          {recruitingStatus && <span className={`badge ${RECRUITING_BADGE_CLASS[recruitingStatus]}`}>{RECRUITING_LABEL[recruitingStatus]}</span>}
          <span className="badge badge-contacted">{prospect.status}</span>
        </div>
      </div>

      <div className="grid grid-2">
        <div>
          <div className="card" style={{ marginBottom: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
              <h3 style={{ margin: 0 }}>Athlete Info</h3>
              {canManageIntake && !editingLinks && (
                <button className="btn btn-sm" onClick={startEditLinks}>
                  Edit
                </button>
              )}
            </div>
            <div className="kv" style={{ marginTop: 10 }}>
              <div className="k">Height / Weight</div>
              <div className="v">{prospect.height || "—"} {prospect.weight ? `/ ${prospect.weight}` : ""}</div>
              <div className="k">GPA</div>
              <div className="v">{prospect.gpa ?? "—"}</div>
              <div className="k">City / State</div>
              <div className="v">
                {prospect.city || prospect.schools?.city || "—"}
                {prospect.state || prospect.schools?.state ? `, ${prospect.state || prospect.schools?.state}` : ""}
              </div>
              <div className="k">High School</div>
              <div className="v">
                {prospect.schools ? (
                  <Link href={`/schools/${prospect.schools.id}`}>{prospect.schools.name}</Link>
                ) : (
                  <span className="empty-state">not linked to a school</span>
                )}
              </div>
              <div className="k">HS Head Coach</div>
              <div className="v">
                {prospect.schools?.hc_first_name || prospect.schools?.hc_last_name ? (
                  `${prospect.schools?.hc_first_name || ""} ${prospect.schools?.hc_last_name || ""}`.trim()
                ) : (
                  <span className="empty-state">not on file</span>
                )}
              </div>
              <div className="k">HC Email</div>
              <div className="v">{prospect.schools?.hc_email || <span className="empty-state">not on file</span>}</div>
              <div className="k">HC Cell</div>
              <div className="v">{fmtPhone(prospect.schools?.hc_cell) || <span className="empty-state">not on file</span>}</div>
              <div className="k">HC Office</div>
              <div className="v">{fmtPhone(prospect.schools?.hc_office) || <span className="empty-state">not on file</span>}</div>
              {!editingLinks && (
                <>
                  <div className="k">Level of Play</div>
                  <div className="v">{prospect.level_of_play || "—"}</div>
                  <div className="k">Hudl</div>
                  <div className="v">
                    {prospect.hudl_url ? (
                      <a href={prospect.hudl_url} target="_blank" rel="noopener noreferrer">
                        {prospect.hudl_url}
                      </a>
                    ) : (
                      "—"
                    )}
                  </div>
                  <div className="k">X (Twitter)</div>
                  <div className="v">
                    {prospect.x_url ? (
                      <a href={prospect.x_url} target="_blank" rel="noopener noreferrer">
                        {prospect.x_url}
                      </a>
                    ) : (
                      "—"
                    )}
                  </div>
                </>
              )}
            </div>

            {editingLinks && (
              <form onSubmit={saveLinks} style={{ marginTop: 10, borderTop: "1px solid #eef0f3", paddingTop: 12 }}>
                {linksError && <div className="notice danger" style={{ marginBottom: 10 }}>{linksError}</div>}
                <div className="form-field">
                  <label>Level of Play</label>
                  <select value={linksForm.level_of_play} onChange={(e) => setLinksForm((f) => ({ ...f, level_of_play: e.target.value }))}>
                    {LEVELS_OF_PLAY.map((l) => (
                      <option key={l} value={l}>
                        {l || "— Select —"}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="form-field">
                  <label>Hudl URL</label>
                  <input value={linksForm.hudl_url} onChange={(e) => setLinksForm((f) => ({ ...f, hudl_url: e.target.value }))} placeholder="https://www.hudl.com/profile/…" />
                </div>
                <div className="form-field">
                  <label>X (Twitter) URL</label>
                  <input value={linksForm.x_url} onChange={(e) => setLinksForm((f) => ({ ...f, x_url: e.target.value }))} placeholder="https://x.com/username" />
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button className="btn btn-sm btn-primary" disabled={linksSaving}>
                    {linksSaving ? "Saving…" : "Save"}
                  </button>
                  <button type="button" className="btn btn-sm" onClick={() => setEditingLinks(false)} disabled={linksSaving}>
                    Cancel
                  </button>
                </div>
              </form>
            )}
          </div>

          <div className="card">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
              <h3 style={{ margin: 0 }}>Contact Info</h3>
              {canManageIntake && !editingContact && (
                <button className="btn btn-sm" onClick={startEditContact}>
                  {prospect.athlete_email || prospect.athlete_cell ? "Edit" : "Add email / cell"}
                </button>
              )}
            </div>

            {!editingContact && !prospect.guardian_authorized && (
              <div className="notice" style={{ marginBottom: 10 }}>
                Guardian authorization not confirmed for this submission — contact carefully and verify eligibility to be reached directly.
              </div>
            )}

            {editingContact ? (
              <form onSubmit={saveContact} style={{ marginTop: 8 }}>
                {contactError && <div className="notice danger" style={{ marginBottom: 10 }}>{contactError}</div>}
                <div className="form-field">
                  <label>Email</label>
                  <input type="email" value={contactForm.athlete_email} onChange={(e) => setContactForm((f) => ({ ...f, athlete_email: e.target.value }))} placeholder="athlete@email.com" />
                </div>
                <div className="form-field">
                  <label>Cell</label>
                  <input value={contactForm.athlete_cell} onChange={(e) => setContactForm((f) => ({ ...f, athlete_cell: e.target.value }))} placeholder="(555) 555-5555" />
                </div>
                <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12.5, margin: "10px 0" }}>
                  <input type="checkbox" checked={contactForm.guardian_authorized} onChange={(e) => setContactForm((f) => ({ ...f, guardian_authorized: e.target.checked }))} />
                  Guardian authorization confirmed for contacting this athlete directly (required if under 18)
                </label>
                <div style={{ borderTop: "1px solid #eef0f3", paddingTop: 10, marginBottom: 10 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 600, color: "#3a4557", marginBottom: 6 }}>Parent / Guardian Contact</div>
                  <div className="grid grid-2">
                    <div className="form-field">
                      <label>Guardian First Name</label>
                      <input value={contactForm.guardian_first_name} onChange={(e) => setContactForm((f) => ({ ...f, guardian_first_name: e.target.value }))} />
                    </div>
                    <div className="form-field">
                      <label>Guardian Last Name</label>
                      <input value={contactForm.guardian_last_name} onChange={(e) => setContactForm((f) => ({ ...f, guardian_last_name: e.target.value }))} />
                    </div>
                    <div className="form-field">
                      <label>Guardian Email</label>
                      <input type="email" value={contactForm.guardian_email} onChange={(e) => setContactForm((f) => ({ ...f, guardian_email: e.target.value }))} placeholder="parent@email.com" />
                    </div>
                    <div className="form-field">
                      <label>Guardian Cell</label>
                      <input value={contactForm.guardian_cell} onChange={(e) => setContactForm((f) => ({ ...f, guardian_cell: e.target.value }))} placeholder="(555) 555-5555" />
                    </div>
                  </div>
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button className="btn btn-sm btn-primary" disabled={contactSaving}>
                    {contactSaving ? "Saving…" : "Save"}
                  </button>
                  <button type="button" className="btn btn-sm" onClick={() => setEditingContact(false)} disabled={contactSaving}>
                    Cancel
                  </button>
                </div>
              </form>
            ) : (
              <div className="kv">
                <div className="k">Email</div>
                <div className="v">{prospect.athlete_email || <span className="empty-state">not on file</span>}</div>
                <div className="k">Cell</div>
                <div className="v">{fmtPhone(prospect.athlete_cell) || <span className="empty-state">not on file</span>}</div>
                <div className="k">Guardian Auth.</div>
                <div className="v">{prospect.guardian_authorized ? "Confirmed" : "Not confirmed"}</div>
                <div className="k">Guardian Name</div>
                <div className="v">
                  {prospect.guardian_first_name || prospect.guardian_last_name ? (
                    `${prospect.guardian_first_name || ""} ${prospect.guardian_last_name || ""}`.trim()
                  ) : (
                    <span className="empty-state">not on file</span>
                  )}
                </div>
                <div className="k">Guardian Email</div>
                <div className="v">{prospect.guardian_email || <span className="empty-state">not on file</span>}</div>
                <div className="k">Guardian Cell</div>
                <div className="v">{fmtPhone(prospect.guardian_cell) || <span className="empty-state">not on file</span>}</div>
              </div>
            )}
          </div>
        </div>

        <div>
          <div className="card" style={{ marginBottom: 14 }}>
            <h3>Coach Evaluation</h3>
            <p style={{ margin: 0, fontSize: 13.5 }}>{prospect.coach_evaluation || <span className="empty-state">No evaluation submitted.</span>}</p>
          </div>

          {canSetRecruitingStatus && (
            <div className="card" style={{ marginBottom: 14 }}>
              <h3>Scouting ({college?.name || "your college"})</h3>
              <p style={{ fontSize: 12.5, color: "#697386", marginTop: -4 }}>
                Your college&apos;s own rating, tags, and notes on this athlete — private to your staff, not visible to other colleges.
              </p>
              {scoutingError && <div className="notice danger" style={{ marginBottom: 10 }}>{scoutingError}</div>}
              {scoutingLoading ? (
                <div className="empty-state">Loading…</div>
              ) : (
                <>
                  <div style={{ marginBottom: 12 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: "#3a4557", marginBottom: 4 }}>Rating</div>
                    <div style={{ display: "flex", gap: 3 }}>
                      {[1, 2, 3, 4, 5].map((n) => (
                        <button
                          key={n}
                          type="button"
                          title={`${n} star${n > 1 ? "s" : ""} — click again to clear`}
                          onClick={() => setRating(n)}
                          disabled={ratingSaving}
                          style={{ border: "none", background: "none", cursor: "pointer", padding: 0, fontSize: 22, lineHeight: 1, color: n <= scoutingRating ? "#c9971f" : "#dde1e7" }}
                        >
                          ★
                        </button>
                      ))}
                    </div>
                  </div>

                  <div style={{ marginBottom: 12 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: "#3a4557", marginBottom: 6 }}>Tags</div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                      {TAG_OPTIONS.map((tag) => {
                        const active = scoutingTags.includes(tag);
                        return (
                          <button
                            key={tag}
                            type="button"
                            className="btn btn-sm"
                            disabled={tagSaving === tag}
                            onClick={() => toggleTag(tag)}
                            style={active ? { background: "#131a2b", color: "#fff", borderColor: "#131a2b" } : undefined}
                          >
                            {tag}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  <div>
                    <div style={{ fontSize: 12, fontWeight: 600, color: "#3a4557", marginBottom: 6 }}>Notes</div>
                    <form onSubmit={addNote} style={{ display: "flex", gap: 6, marginBottom: 10 }}>
                      <input
                        value={noteDraft}
                        onChange={(e) => setNoteDraft(e.target.value)}
                        placeholder="Add a scouting note…"
                        style={{ flex: 1 }}
                      />
                      <button className="btn btn-sm btn-primary" disabled={noteSaving || !noteDraft.trim()}>
                        {noteSaving ? "Saving…" : "Add"}
                      </button>
                    </form>
                    {scoutingNotes.length ? (
                      scoutingNotes.map((n) => (
                        <div className="log-item" key={n.id}>
                          <span className="when">{new Date(n.created_at).toLocaleString()}</span>
                          <div style={{ fontSize: 13 }}>{n.note}</div>
                        </div>
                      ))
                    ) : (
                      <div className="empty-state">No notes yet.</div>
                    )}
                  </div>
                </>
              )}
            </div>
          )}

          <div className="card" style={{ marginBottom: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
              <h3 style={{ margin: 0 }}>Offers &amp; Commitment</h3>
              {canManageIntake && !editingOutcome && (
                <button className="btn btn-sm" onClick={startEditOutcome}>
                  Edit
                </button>
              )}
            </div>
            <p style={{ fontSize: 12.5, color: "#697386", marginTop: -4 }}>
              Self- or coach-reported, independent of any one college&apos;s own Recruiting Interest above.
            </p>
            {editingOutcome ? (
              <form onSubmit={saveOutcome} style={{ marginTop: 8 }}>
                {outcomeError && <div className="notice danger" style={{ marginBottom: 10 }}>{outcomeError}</div>}
                <div className="form-field">
                  <label>Offers Received</label>
                  <input value={outcomeForm.offers_received} onChange={(e) => setOutcomeForm((f) => ({ ...f, offers_received: e.target.value }))} placeholder="Texas A&amp;M, Ole Miss, Duke" />
                </div>
                <div className="form-field">
                  <label>Committed To</label>
                  <input value={outcomeForm.committed_to} onChange={(e) => setOutcomeForm((f) => ({ ...f, committed_to: e.target.value }))} placeholder="Leave blank if uncommitted" />
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button className="btn btn-sm btn-primary" disabled={outcomeSaving}>
                    {outcomeSaving ? "Saving…" : "Save"}
                  </button>
                  <button type="button" className="btn btn-sm" onClick={() => setEditingOutcome(false)} disabled={outcomeSaving}>
                    Cancel
                  </button>
                </div>
              </form>
            ) : (
              <div className="kv">
                <div className="k">Offers Received</div>
                <div className="v">{prospect.offers_received || <span className="empty-state">none on file</span>}</div>
                <div className="k">Committed To</div>
                <div className="v">{prospect.committed_to || <span className="empty-state">not yet committed</span>}</div>
              </div>
            )}
          </div>

          {canSetRecruitingStatus && (
            <div className="card" style={{ marginBottom: 14 }}>
              <h3>Watchlist &amp; Contact ({college?.name || "your college"})</h3>
              <p style={{ fontSize: 12.5, color: "#697386", marginTop: -4 }}>
                Same data shown on the Recruiting Board, tied to this athlete&apos;s high school.
              </p>
              {schoolContextLoading ? (
                <div className="empty-state">Loading…</div>
              ) : !prospect.school_id ? (
                <div className="empty-state">Not linked to a school yet.</div>
              ) : (
                <div className="kv">
                  <div className="k">On Watchlist</div>
                  <div className="v">
                    {schoolContext.watchlisted ? <span className="badge badge-contacted">Watchlisted</span> : "No"}
                  </div>
                  <div className="k">Last Contact</div>
                  <div className="v">
                    {schoolContext.lastContact ? (
                      `${schoolContext.lastContact.contact_date} — ${schoolContext.lastContact.contact_type}`
                    ) : (
                      <span className="badge badge-not-contacted">None logged</span>
                    )}
                  </div>
                </div>
              )}
              {prospect.schools?.id && (
                <Link href={`/schools/${prospect.schools.id}`} className="btn btn-sm" style={{ marginTop: 10, display: "inline-flex" }}>
                  Manage on school profile →
                </Link>
              )}
            </div>
          )}

          {canSetRecruitingStatus && (
            <div className="card" style={{ marginBottom: 14 }}>
              <h3>Recruiting Interest</h3>
              <p style={{ fontSize: 12.5, color: "#697386", marginTop: -4 }}>
                Your college&apos;s own board status for this athlete — separate from the submission status below, and not visible to other colleges.
              </p>
              {recruitingError && <div className="notice danger" style={{ marginBottom: 10 }}>{recruitingError}</div>}
              {recruitingLoading ? (
                <div className="empty-state">Loading…</div>
              ) : (
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {RECRUITING_STATUSES.map((s) => (
                    <button
                      key={s}
                      className={`btn btn-sm ${recruitingStatus === s ? "btn-gold" : ""}`}
                      disabled={recruitingSaving || recruitingStatus === s}
                      onClick={() => setRecruiting(s)}
                    >
                      {RECRUITING_LABEL[s]}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {canManageIntake && (
            <div className="card" style={{ marginBottom: 14 }}>
              <h3>Submission Status</h3>
              <p style={{ fontSize: 12.5, color: "#697386", marginTop: -4 }}>Where this submission stands in the intake/review pipeline.</p>
              {statusError && <div className="notice danger" style={{ marginBottom: 10 }}>{statusError}</div>}
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {INTAKE_STATUSES.map((s) => (
                  <button
                    key={s}
                    className={`btn btn-sm ${prospect.status === s ? "btn-primary" : ""}`}
                    disabled={statusSaving || prospect.status === s}
                    onClick={() => setIntakeStatus(s)}
                  >
                    {s.charAt(0).toUpperCase() + s.slice(1)}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="card" style={{ marginBottom: 14 }}>
            <h3>Submission Info</h3>
            <div className="kv">
              <div className="k">Submitted</div>
              <div className="v">{new Date(prospect.created_at).toLocaleDateString()}</div>
            </div>
          </div>

          {canManageIntake && (
            <div className="card">
              <h3>Danger Zone</h3>
              {deleteError && <div className="notice danger" style={{ marginBottom: 10 }}>{deleteError}</div>}
              <button className="btn btn-sm btn-danger" onClick={deleteProspect} disabled={deleting}>
                {deleting ? "Deleting…" : "Delete Prospect"}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
