"use client";
import { useEffect, useState, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { useAuth } from "@/lib/auth-context";

function fmtPhone(v) {
  if (!v) return "";
  const digits = v.replace(/\D/g, "");
  return digits.length === 10 ? `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}` : v;
}

function withProtocol(v) {
  if (!v) return null;
  const trimmed = v.trim();
  if (!trimmed) return null;
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

const SUGGESTION_STATUS_LABEL = { pending: "Pending review", approved: "Approved — now live", rejected: "Not approved" };
const CLAIM_STATUS_LABEL = { pending: "Pending review", approved: "Approved", rejected: "Not approved" };
const EMPTY_COACH_FORM = { hc_first_name: "", hc_last_name: "", hc_email: "", hc_cell: "", hc_office: "", note: "" };

export default function SchoolProfilePage() {
  const { id } = useParams();
  const router = useRouter();
  const supabase = getSupabaseBrowserClient();
  const { college, user, profile } = useAuth();

  const [school, setSchool] = useState(null);
  const [contactLogs, setContactLogs] = useState([]);
  const [assignment, setAssignment] = useState(null);
  const [watchlisted, setWatchlisted] = useState(false);
  const [notes, setNotes] = useState([]);
  const [contactForm, setContactForm] = useState({ contact_type: "Call", note: "", contact_date: new Date().toISOString().slice(0, 10) });
  const [noteText, setNoteText] = useState("");
  const [loading, setLoading] = useState(true);

  // Suggest-a-correction (existing flow, for anyone who isn't the verified owner)
  const [showCorrectionForm, setShowCorrectionForm] = useState(false);
  const [correctionForm, setCorrectionForm] = useState(EMPTY_COACH_FORM);
  const [mySuggestion, setMySuggestion] = useState(null);
  const [submittingCorrection, setSubmittingCorrection] = useState(false);
  const [correctionError, setCorrectionError] = useState("");

  // Claim this school (HS coach self-service)
  const [showClaimForm, setShowClaimForm] = useState(false);
  const [claimNote, setClaimNote] = useState("");
  const [myClaim, setMyClaim] = useState(null);
  const [submittingClaim, setSubmittingClaim] = useState(false);
  const [claimError, setClaimError] = useState("");

  // Direct self-update, once a claim is approved and this is "your" school
  const [ownerForm, setOwnerForm] = useState(EMPTY_COACH_FORM);
  const [savingOwnerForm, setSavingOwnerForm] = useState(false);
  const [ownerFormError, setOwnerFormError] = useState("");
  const [ownerFormSaved, setOwnerFormSaved] = useState(false);

  // Flag as possibly outdated (anyone)
  const [showFlagForm, setShowFlagForm] = useState(false);
  const [flagReason, setFlagReason] = useState("");
  const [myFlag, setMyFlag] = useState(null);
  const [submittingFlag, setSubmittingFlag] = useState(false);
  const [flagError, setFlagError] = useState("");

  const isOwner = !!(profile?.school_id && school?.id && Number(profile.school_id) === Number(school.id));
  const canClaim = profile?.role === "hs_coach" && !profile?.school_id;

  const load = useCallback(async () => {
    const { data: schoolData } = await supabase.from("schools").select("*").eq("id", id).maybeSingle();
    setSchool(schoolData);
    if (schoolData) {
      setCorrectionForm({
        hc_first_name: schoolData.hc_first_name || "",
        hc_last_name: schoolData.hc_last_name || "",
        hc_email: schoolData.hc_email || "",
        hc_cell: schoolData.hc_cell || "",
        hc_office: schoolData.hc_office || "",
        note: "",
      });
      setOwnerForm({
        hc_first_name: schoolData.hc_first_name || "",
        hc_last_name: schoolData.hc_last_name || "",
        hc_email: schoolData.hc_email || "",
        hc_cell: schoolData.hc_cell || "",
        hc_office: schoolData.hc_office || "",
        note: "",
      });
    }

    if (user?.id) {
      const [{ data: suggestion }, { data: claim }, { data: flag }] = await Promise.all([
        supabase
          .from("school_edit_suggestions")
          .select("*")
          .eq("school_id", id)
          .eq("suggested_by", user.id)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
        supabase
          .from("school_claims")
          .select("*")
          .eq("school_id", id)
          .eq("user_id", user.id)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
        supabase
          .from("school_flags")
          .select("*")
          .eq("school_id", id)
          .eq("flagged_by", user.id)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
      ]);
      setMySuggestion(suggestion || null);
      setMyClaim(claim || null);
      setMyFlag(flag || null);
    }

    if (college?.id) {
      const [{ data: logs }, { data: assign }, { data: watch }, { data: noteRows }] = await Promise.all([
        supabase.from("contact_logs").select("*").eq("college_id", college.id).eq("school_id", id).order("created_at", { ascending: false }),
        supabase.from("coach_assignments").select("*").eq("college_id", college.id).eq("school_id", id).maybeSingle(),
        supabase.from("watchlist_items").select("*").eq("college_id", college.id).eq("school_id", id).maybeSingle(),
        supabase.from("school_notes").select("*").eq("college_id", college.id).eq("school_id", id).order("created_at", { ascending: false }),
      ]);
      setContactLogs(logs || []);
      setAssignment(assign || null);
      setWatchlisted(!!watch);
      setNotes(noteRows || []);
    }
    setLoading(false);
  }, [supabase, id, college, user]);

  useEffect(() => {
    load();
  }, [load]);

  async function toggleWatchlist() {
    if (!college?.id) return;
    if (watchlisted) {
      await supabase.from("watchlist_items").delete().eq("college_id", college.id).eq("school_id", id);
    } else {
      await supabase.from("watchlist_items").insert({ college_id: college.id, school_id: id, added_by: user.id });
    }
    load();
  }

  async function assignToMe() {
    if (!college?.id) return;
    await supabase
      .from("coach_assignments")
      .upsert({ college_id: college.id, school_id: id, assigned_to: user.id, assigned_by: user.id }, { onConflict: "college_id,school_id" });
    load();
  }

  async function logContact(e) {
    e.preventDefault();
    if (!college?.id) return;
    await supabase.from("contact_logs").insert({
      college_id: college.id,
      school_id: id,
      logged_by: user.id,
      contact_type: contactForm.contact_type,
      note: contactForm.note,
      contact_date: contactForm.contact_date,
    });
    setContactForm({ contact_type: "Call", note: "", contact_date: new Date().toISOString().slice(0, 10) });
    load();
  }

  async function addNote(e) {
    e.preventDefault();
    if (!college?.id || !noteText.trim()) return;
    await supabase.from("school_notes").insert({ college_id: college.id, school_id: id, written_by: user.id, note: noteText.trim() });
    setNoteText("");
    load();
  }

  async function submitCorrection(e) {
    e.preventDefault();
    setCorrectionError("");
    setSubmittingCorrection(true);
    try {
      const { error } = await supabase.from("school_edit_suggestions").insert({
        school_id: id,
        suggested_by: user.id,
        suggested_by_college_id: college?.id || null,
        hc_first_name: correctionForm.hc_first_name.trim() || null,
        hc_last_name: correctionForm.hc_last_name.trim() || null,
        hc_email: correctionForm.hc_email.trim() || null,
        hc_cell: correctionForm.hc_cell.trim() || null,
        hc_office: correctionForm.hc_office.trim() || null,
        note: correctionForm.note.trim() || null,
      });
      if (error) throw error;
      setShowCorrectionForm(false);
      load();
    } catch (err) {
      setCorrectionError(err.message || "Could not submit correction.");
    } finally {
      setSubmittingCorrection(false);
    }
  }

  async function submitClaim(e) {
    e.preventDefault();
    setClaimError("");
    setSubmittingClaim(true);
    try {
      const { error } = await supabase.from("school_claims").insert({
        school_id: id,
        user_id: user.id,
        note: claimNote.trim() || null,
      });
      if (error) throw error;
      setShowClaimForm(false);
      setClaimNote("");
      load();
    } catch (err) {
      setClaimError(err.message || "Could not submit your claim.");
    } finally {
      setSubmittingClaim(false);
    }
  }

  async function saveOwnerForm(e) {
    e.preventDefault();
    setOwnerFormError("");
    setOwnerFormSaved(false);
    setSavingOwnerForm(true);
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const res = await fetch(`/api/schools/${id}/self-update`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token}` },
        body: JSON.stringify({
          hc_first_name: ownerForm.hc_first_name,
          hc_last_name: ownerForm.hc_last_name,
          hc_email: ownerForm.hc_email,
          hc_cell: ownerForm.hc_cell,
          hc_office: ownerForm.hc_office,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || "Could not save your listing.");
      setOwnerFormSaved(true);
      load();
    } catch (err) {
      setOwnerFormError(err.message || "Could not save your listing.");
    } finally {
      setSavingOwnerForm(false);
    }
  }

  async function submitFlag(e) {
    e.preventDefault();
    setFlagError("");
    setSubmittingFlag(true);
    try {
      const { error } = await supabase.from("school_flags").insert({
        school_id: id,
        flagged_by: user.id,
        flagged_by_college_id: college?.id || null,
        reason: flagReason.trim() || null,
      });
      if (error) throw error;
      setShowFlagForm(false);
      setFlagReason("");
      load();
    } catch (err) {
      setFlagError(err.message || "Could not submit this flag.");
    } finally {
      setSubmittingFlag(false);
    }
  }

  if (loading) return <div className="view"><div className="empty-state">Loading school profile…</div></div>;
  if (!school) return <div className="view"><div className="notice danger">School not found.</div></div>;

  const collegeName = college?.name || "your college";

  return (
    <div className="view">
      <button className="btn btn-sm" style={{ marginBottom: 12 }} onClick={() => router.back()}>
        ← Back
      </button>
      <div className="view-header">
        <div>
          <h1>{school.name}</h1>
          <p>
            {school.city}, {school.state} {school.zip} · {school.school_type} {school.classification ? `· ${school.classification}` : ""}
          </p>
        </div>
      </div>

      <div className="grid grid-2">
        <div>
          <div className="card" style={{ marginBottom: 14 }}>
            <h3>Verification</h3>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6, flexWrap: "wrap" }}>
              <span className="badge badge-unverified">{school.verification_status === "verified" ? "Verified" : "Not yet verified"}</span>
              <span style={{ fontSize: 12, color: "#697386" }}>{school.confidence_score}% data completeness</span>
              {school.claimed_by && <span className="badge badge-contacted">Coach-verified listing</span>}
            </div>
            <div className="notice">Source: {school.source || "CSD Master Coaches Database"}.</div>

            {!showFlagForm && !(myFlag && myFlag.status === "pending") && (
              <button className="btn btn-sm" style={{ marginTop: 10 }} onClick={() => setShowFlagForm(true)}>
                Flag as possibly outdated
              </button>
            )}
            {myFlag && myFlag.status === "pending" && !showFlagForm && (
              <div className="notice" style={{ marginTop: 10 }}>
                You flagged this listing on {new Date(myFlag.created_at).toLocaleDateString()} — a verifier will take a look.
              </div>
            )}
            {showFlagForm && (
              <form onSubmit={submitFlag} style={{ marginTop: 10, borderTop: "1px solid #eef0f3", paddingTop: 10 }}>
                {flagError && <div className="notice danger" style={{ marginBottom: 8 }}>{flagError}</div>}
                <div className="form-field">
                  <label>Why does this look outdated? (optional)</label>
                  <input value={flagReason} onChange={(e) => setFlagReason(e.target.value)} placeholder="Called the office, they said this coach left…" />
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button className="btn btn-sm btn-primary" disabled={submittingFlag}>
                    {submittingFlag ? "Submitting…" : "Submit flag"}
                  </button>
                  <button type="button" className="btn btn-sm" onClick={() => setShowFlagForm(false)} disabled={submittingFlag}>
                    Cancel
                  </button>
                </div>
              </form>
            )}
          </div>

          <div className="card" style={{ marginBottom: 14 }}>
            <h3>School Info</h3>
            <div className="kv">
              <div className="k">Address</div>
              <div className="v">
                {school.addr1}
                {school.addr2 ? `, ${school.addr2}` : ""}
              </div>
              <div className="k">County</div>
              <div className="v">{school.county}</div>
              <div className="k">Main phone</div>
              <div className="v">{fmtPhone(school.phone) || "—"}</div>
              <div className="k">Website</div>
              <div className="v">
                {school.website ? (
                  <a href={withProtocol(school.website)} target="_blank" rel="noopener noreferrer">
                    {school.website}
                  </a>
                ) : (
                  "—"
                )}
              </div>
              <div className="k">Classification</div>
              <div className="v">{school.classification || "—"}</div>
            </div>
          </div>

          <div className="card">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
              <h3 style={{ margin: 0 }}>Head Football Coach</h3>
              {!isOwner && (
                <button className="btn btn-sm" onClick={() => setShowCorrectionForm((v) => !v)}>
                  {showCorrectionForm ? "Cancel" : "Suggest a correction"}
                </button>
              )}
            </div>
            <div className="kv" style={{ marginTop: 10 }}>
              <div className="k">Name</div>
              <div className="v">
                {school.hc_first_name || school.hc_last_name ? `${school.hc_first_name} ${school.hc_last_name}` : <span className="empty-state">not on file</span>}
              </div>
              <div className="k">Email</div>
              <div className="v">{school.hc_email || <span className="empty-state">not on file</span>}</div>
              <div className="k">Cell</div>
              <div className="v">{fmtPhone(school.hc_cell) || <span className="empty-state">not on file</span>}</div>
              <div className="k">Office</div>
              <div className="v">{fmtPhone(school.hc_office) || <span className="empty-state">not on file</span>}</div>
            </div>

            {isOwner && (
              <form onSubmit={saveOwnerForm} style={{ marginTop: 14, borderTop: "1px solid #eef0f3", paddingTop: 12 }}>
                <div className="notice info" style={{ marginBottom: 10 }}>
                  This is your claimed listing — changes save immediately, no review needed.
                </div>
                {ownerFormError && <div className="notice danger" style={{ marginBottom: 10 }}>{ownerFormError}</div>}
                {ownerFormSaved && <div className="notice info" style={{ marginBottom: 10 }}>Saved.</div>}
                <div className="grid grid-2" style={{ marginBottom: 8 }}>
                  <div className="form-field">
                    <label>First name</label>
                    <input value={ownerForm.hc_first_name} onChange={(e) => setOwnerForm((v) => ({ ...v, hc_first_name: e.target.value }))} />
                  </div>
                  <div className="form-field">
                    <label>Last name</label>
                    <input value={ownerForm.hc_last_name} onChange={(e) => setOwnerForm((v) => ({ ...v, hc_last_name: e.target.value }))} />
                  </div>
                  <div className="form-field">
                    <label>Email</label>
                    <input type="email" value={ownerForm.hc_email} onChange={(e) => setOwnerForm((v) => ({ ...v, hc_email: e.target.value }))} />
                  </div>
                  <div className="form-field">
                    <label>Cell</label>
                    <input value={ownerForm.hc_cell} onChange={(e) => setOwnerForm((v) => ({ ...v, hc_cell: e.target.value }))} />
                  </div>
                  <div className="form-field">
                    <label>Office</label>
                    <input value={ownerForm.hc_office} onChange={(e) => setOwnerForm((v) => ({ ...v, hc_office: e.target.value }))} />
                  </div>
                </div>
                <button className="btn btn-gold btn-sm" disabled={savingOwnerForm}>
                  {savingOwnerForm ? "Saving…" : "Save my listing"}
                </button>
              </form>
            )}

            {!isOwner && canClaim && !showClaimForm && !(myClaim && myClaim.status === "pending") && (
              <div style={{ marginTop: 14, borderTop: "1px solid #eef0f3", paddingTop: 12 }}>
                <button className="btn btn-sm btn-primary" onClick={() => setShowClaimForm(true)}>
                  This is my school
                </button>
              </div>
            )}
            {!isOwner && myClaim && !showClaimForm && (
              <div className={`notice ${myClaim.status === "rejected" ? "danger" : "info"}`} style={{ marginTop: 14 }}>
                Your claim on this listing ({new Date(myClaim.created_at).toLocaleDateString()}): {CLAIM_STATUS_LABEL[myClaim.status]}
                {myClaim.review_note ? ` — "${myClaim.review_note}"` : ""}
              </div>
            )}
            {showClaimForm && (
              <form onSubmit={submitClaim} style={{ marginTop: 14, borderTop: "1px solid #eef0f3", paddingTop: 12 }}>
                <div className="notice" style={{ marginBottom: 10 }}>
                  Claims are reviewed by our verification staff. Once approved, you can update this listing directly, any time.
                </div>
                {claimError && <div className="notice danger" style={{ marginBottom: 10 }}>{claimError}</div>}
                <div className="form-field">
                  <label>Anything that helps us verify it's you? (optional)</label>
                  <input value={claimNote} onChange={(e) => setClaimNote(e.target.value)} placeholder="I'm the head coach here, started 2024…" />
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button className="btn btn-gold btn-sm" disabled={submittingClaim}>
                    {submittingClaim ? "Submitting…" : "Submit claim"}
                  </button>
                  <button type="button" className="btn btn-sm" onClick={() => setShowClaimForm(false)} disabled={submittingClaim}>
                    Cancel
                  </button>
                </div>
              </form>
            )}

            {mySuggestion && !showCorrectionForm && !isOwner && (
              <div className={`notice ${mySuggestion.status === "rejected" ? "danger" : "info"}`} style={{ marginTop: 12 }}>
                Your last suggested correction ({new Date(mySuggestion.created_at).toLocaleDateString()}): {SUGGESTION_STATUS_LABEL[mySuggestion.status]}
                {mySuggestion.review_note ? ` — "${mySuggestion.review_note}"` : ""}
              </div>
            )}

            {showCorrectionForm && !isOwner && (
              <form onSubmit={submitCorrection} style={{ marginTop: 14, borderTop: "1px solid #eef0f3", paddingTop: 12 }}>
                <div className="notice" style={{ marginBottom: 10 }}>
                  Corrections are reviewed by our verification staff before they go live, so the whole database stays accurate.
                </div>
                {correctionError && <div className="notice danger" style={{ marginBottom: 10 }}>{correctionError}</div>}
                <div className="grid grid-2" style={{ marginBottom: 8 }}>
                  <div className="form-field">
                    <label>First name</label>
                    <input value={correctionForm.hc_first_name} onChange={(e) => setCorrectionForm((v) => ({ ...v, hc_first_name: e.target.value }))} />
                  </div>
                  <div className="form-field">
                    <label>Last name</label>
                    <input value={correctionForm.hc_last_name} onChange={(e) => setCorrectionForm((v) => ({ ...v, hc_last_name: e.target.value }))} />
                  </div>
                  <div className="form-field">
                    <label>Email</label>
                    <input type="email" value={correctionForm.hc_email} onChange={(e) => setCorrectionForm((v) => ({ ...v, hc_email: e.target.value }))} />
                  </div>
                  <div className="form-field">
                    <label>Cell</label>
                    <input value={correctionForm.hc_cell} onChange={(e) => setCorrectionForm((v) => ({ ...v, hc_cell: e.target.value }))} />
                  </div>
                  <div className="form-field">
                    <label>Office</label>
                    <input value={correctionForm.hc_office} onChange={(e) => setCorrectionForm((v) => ({ ...v, hc_office: e.target.value }))} />
                  </div>
                </div>
                <div className="form-field">
                  <label>Why the change? (optional)</label>
                  <input value={correctionForm.note} onChange={(e) => setCorrectionForm((v) => ({ ...v, note: e.target.value }))} placeholder="New head coach hired May 2026…" />
                </div>
                <button className="btn btn-gold btn-sm" disabled={submittingCorrection}>
                  {submittingCorrection ? "Submitting…" : "Submit correction"}
                </button>
              </form>
            )}
          </div>
        </div>

        <div>
          <div className="card" style={{ marginBottom: 14 }}>
            <h3>
              Territory &amp; Outreach ({collegeName})
            </h3>
            <div style={{ display: "flex", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
              <button className="btn btn-sm btn-primary" onClick={assignToMe}>
                {assignment ? "Reassign to me" : "Assign to me"}
              </button>
              <button className={`btn btn-sm ${watchlisted ? "btn-danger" : ""}`} onClick={toggleWatchlist}>
                {watchlisted ? "Remove from watchlist" : "Add to watchlist"}
              </button>
            </div>
            {contactLogs[0] && (
              <div className="notice info" style={{ marginBottom: 8 }}>
                Last contact logged by a staff member on {contactLogs[0].contact_date} — visible to your whole college to prevent duplicate outreach.
              </div>
            )}
            <form onSubmit={logContact} style={{ marginBottom: 10 }}>
              <div className="grid grid-2" style={{ marginBottom: 8 }}>
                <div className="form-field">
                  <label>Type</label>
                  <select value={contactForm.contact_type} onChange={(e) => setContactForm((v) => ({ ...v, contact_type: e.target.value }))}>
                    <option>Call</option>
                    <option>Email</option>
                    <option>Text</option>
                    <option>Visit</option>
                    <option>Evaluation</option>
                  </select>
                </div>
                <div className="form-field">
                  <label>Date</label>
                  <input type="date" value={contactForm.contact_date} onChange={(e) => setContactForm((v) => ({ ...v, contact_date: e.target.value }))} />
                </div>
              </div>
              <div className="form-field">
                <label>Note</label>
                <input value={contactForm.note} onChange={(e) => setContactForm((v) => ({ ...v, note: e.target.value }))} placeholder="Spoke with coach about prospects…" />
              </div>
              <button className="btn btn-gold btn-sm">Log Contact</button>
            </form>
            {contactLogs.length ? (
              contactLogs.map((log) => (
                <div className="log-item" key={log.id}>
                  <span className="when">{log.contact_date}</span>
                  <strong>{log.contact_type}</strong>
                  {log.note ? `: ${log.note}` : ""}
                </div>
              ))
            ) : (
              <div className="empty-state">No contact logged yet.</div>
            )}
          </div>

          <div className="card">
            <h3>Private Notes (visible to your college only)</h3>
            <form onSubmit={addNote} style={{ marginBottom: 10, display: "flex", gap: 8 }}>
              <input
                style={{ flex: 1, border: "1px solid #dde1e7", borderRadius: 7, padding: "7px 9px" }}
                value={noteText}
                onChange={(e) => setNoteText(e.target.value)}
                placeholder="Add a note…"
              />
              <button className="btn btn-sm btn-primary">Add</button>
            </form>
            {notes.length ? (
              notes.map((n) => (
                <div className="log-item" key={n.id}>
                  <span className="when">{new Date(n.created_at).toLocaleDateString()}</span>
                  {n.note}
                </div>
              ))
            ) : (
              <div className="empty-state">No notes yet.</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
