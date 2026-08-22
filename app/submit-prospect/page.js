"use client";
import { useState, useRef } from "react";
import Link from "next/link";

// Public, no-login prospect submission page -- lives outside app/(app)/ on
// purpose, same as the marketing homepage (app/page.js) and the auth pages,
// so it isn't gated by the AppLayout auth redirect (see
// app/(app)/layout.js's `if (!loading && session === null) router.replace
// ("/login")`). The root app/layout.js still wraps this in <AuthProvider>,
// but AuthProvider itself never redirects -- it only tracks session state
// -- so an anonymous visitor lands here and stays here.
//
// Exists so a high school coach (CSD's secondary audience -- see the
// business plan: "provide prospect sheets, updated athlete info, coach
// contact details") can submit a prospect without first creating a full
// CoachConnect account, which was previously the only way in (the
// in-app "Submit a Prospect" section on app/(app)/prospects/page.js).
// That friction was very likely costing real submission volume from the
// exact audience this data pipeline depends on.
//
// Posts to app/api/public/submit-prospect, which uses the service-role
// client server-side (RLS on prospects requires an authenticated
// submitted_by, which this visitor doesn't have) -- see that route's own
// comments for the honeypot/timing/email-throttle spam mitigations, since
// there's no captcha or rate-limiting infra in this app yet.
const LEVELS_OF_PLAY = ["", "FBS", "FCS", "D2", "D3", "NAIA", "JUCO", "Prep/Post-Grad"];
const SUBMITTER_ROLES = [
  { value: "hs_coach", label: "High School Coach" },
  { value: "athletic_director", label: "High School Athletic Director" },
  { value: "parent_guardian", label: "Parent / Guardian" },
  { value: "athlete_self", label: "The Athlete" },
  { value: "other", label: "Other" },
];

const EMPTY_FORM = {
  submitter_name: "",
  submitter_email: "",
  submitter_role: "",
  athlete_name: "",
  grad_year: "",
  position: "",
  jersey_number: "",
  height: "",
  weight: "",
  gpa: "",
  forty_yard_dash: "",
  vertical_jump: "",
  broad_jump: "",
  bench_press_reps: "",
  shuttle_time: "",
  athlete_email: "",
  athlete_cell: "",
  city: "",
  state: "",
  hudl_url: "",
  x_url: "",
  coach_evaluation: "",
  guardian_authorized: false,
  guardian_first_name: "",
  guardian_last_name: "",
  guardian_email: "",
  guardian_cell: "",
  offers_received: "",
  committed_to: "",
  level_of_play: "",
};

export default function SubmitProspectPage() {
  const [form, setForm] = useState(EMPTY_FORM);
  const [website, setWebsite] = useState(""); // honeypot -- see submit-prospect route

  const [schoolQuery, setSchoolQuery] = useState("");
  const [schoolResults, setSchoolResults] = useState([]);
  const [selectedSchool, setSelectedSchool] = useState(null);
  const debounceRef = useRef(null);

  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [duplicateMatches, setDuplicateMatches] = useState([]);

  const loadedAtRef = useRef(Date.now());

  function searchSchools(value) {
    setSchoolQuery(value);
    setSelectedSchool(null);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (value.trim().length < 2) {
      setSchoolResults([]);
      return;
    }
    debounceRef.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/public/search-schools?q=${encodeURIComponent(value.trim())}`);
        const json = await res.json().catch(() => ({}));
        setSchoolResults(json.schools || []);
      } catch {
        setSchoolResults([]);
      }
    }, 250);
  }

  function pickSchool(school) {
    setSelectedSchool(school);
    setSchoolQuery(`${school.name} — ${school.city}, ${school.state}`);
    setSchoolResults([]);
    setDuplicateMatches([]);
  }

  async function doSubmit(force) {
    setSubmitError("");
    setSubmitting(true);
    try {
      const res = await fetch("/api/public/submit-prospect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          website,
          loaded_at: loadedAtRef.current,
          school_id: selectedSchool?.id || null,
          force: !!force,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setSubmitError(json.error || "Could not submit this prospect. Please try again.");
        return;
      }
      if (json.duplicates?.length) {
        setDuplicateMatches(json.duplicates);
        return;
      }
      setForm(EMPTY_FORM);
      setWebsite("");
      setSchoolQuery("");
      setSelectedSchool(null);
      setDuplicateMatches([]);
      setSubmitted(true);
    } catch {
      setSubmitError("Could not reach the server. Please check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  function handleSubmit(e) {
    e.preventDefault();
    if (!form.athlete_name.trim() || !form.submitter_name.trim() || !form.submitter_email.trim() || !form.submitter_role) return;
    doSubmit(false);
  }

  if (submitted) {
    return (
      <div className="landing">
        <div className="landing-nav">
          <Link href="/" className="brand" style={{ color: "#fff", textDecoration: "none" }}>
            <span className="dot" />
            CSD CoachConnect
            <small>Collegiate Sports Data · Recruiting Intelligence</small>
          </Link>
        </div>
        <div className="landing-section" style={{ marginTop: 64 }}>
          <div className="card" style={{ maxWidth: 520, margin: "0 auto", textAlign: "left" }}>
            <h3 style={{ color: "var(--navy)", fontSize: 16 }}>Thanks — that prospect is submitted.</h3>
            <p style={{ fontSize: 13.5, color: "var(--gray-700)", lineHeight: 1.6 }}>
              It's now in front of every college coach using CSD CoachConnect who's watching that school or territory. We
              may follow up at the email you gave us if we have questions.
            </p>
            <button className="btn btn-primary" style={{ marginTop: 6 }} onClick={() => setSubmitted(false)}>
              Submit another prospect
            </button>
          </div>
        </div>
        <div className="footer-note">
          CSD CoachConnect — Collegiate Sports Data, Spring Hill, TN. Questions?{" "}
          <a href="mailto:larry@collegiatesportsdata.com">larry@collegiatesportsdata.com</a>
        </div>
      </div>
    );
  }

  return (
    <div className="landing">
      <div className="landing-nav">
        <Link href="/" className="brand" style={{ color: "#fff", textDecoration: "none" }}>
          <span className="dot" />
          CSD CoachConnect
          <small>Collegiate Sports Data · Recruiting Intelligence</small>
        </Link>
        <div style={{ display: "flex", gap: 10 }}>
          <Link href="/login" className="btn btn-sm" style={{ background: "transparent", color: "#fff", borderColor: "#ffffff40" }}>
            Sign In
          </Link>
        </div>
      </div>

      <div className="landing-hero" style={{ paddingBottom: 30 }}>
        <h1>Submit a Prospect</h1>
        <p>
          High school coaches, athletic directors, and parents: this gets an athlete in front of D2, D3, NAIA, and JUCO
          coaching staffs nationwide who are actively recruiting — no account needed. Takes about two minutes.
        </p>
      </div>

      <div className="landing-section" style={{ maxWidth: 760, marginTop: 0 }}>
        <div className="card" style={{ textAlign: "left" }}>
          {submitError && <div className="notice danger" style={{ marginBottom: 10 }}>{submitError}</div>}

          <form onSubmit={handleSubmit}>
            {/* Honeypot -- hidden from real visitors via CSS (not removed from the DOM), see submit-prospect route */}
            <div style={{ position: "absolute", left: "-9999px", top: "auto", width: 1, height: 1, overflow: "hidden" }} aria-hidden="true">
              <label htmlFor="website">Leave this field blank</label>
              <input id="website" name="website" tabIndex={-1} autoComplete="off" value={website} onChange={(e) => setWebsite(e.target.value)} />
            </div>

            <div style={{ fontSize: 12.5, fontWeight: 600, color: "#3a4557", marginBottom: 6 }}>Your Information</div>
            <div className="grid grid-2" style={{ marginBottom: 10 }}>
              <div className="form-field">
                <label>Your Name</label>
                <input required value={form.submitter_name} onChange={(e) => setForm((f) => ({ ...f, submitter_name: e.target.value }))} />
              </div>
              <div className="form-field">
                <label>Your Email</label>
                <input
                  type="email"
                  required
                  value={form.submitter_email}
                  onChange={(e) => setForm((f) => ({ ...f, submitter_email: e.target.value }))}
                  placeholder="coach@school.edu"
                />
              </div>
              <div className="form-field">
                <label>Your Role</label>
                <select required value={form.submitter_role} onChange={(e) => setForm((f) => ({ ...f, submitter_role: e.target.value }))}>
                  <option value="">Select one…</option>
                  {SUBMITTER_ROLES.map((r) => (
                    <option key={r.value} value={r.value}>{r.label}</option>
                  ))}
                </select>
              </div>
            </div>

            <div style={{ borderTop: "1px solid #eef0f3", paddingTop: 10, marginBottom: 10 }}>
              <div style={{ fontSize: 12.5, fontWeight: 600, color: "#3a4557", marginBottom: 6 }}>Athlete Information</div>
              <div className="grid grid-2" style={{ marginBottom: 10 }}>
                <div className="form-field">
                  <label>Athlete Name</label>
                  <input
                    required
                    value={form.athlete_name}
                    onChange={(e) => {
                      setForm((f) => ({ ...f, athlete_name: e.target.value }));
                      setDuplicateMatches([]);
                    }}
                  />
                </div>
                <div className="form-field">
                  <label>Graduation Year</label>
                  <input value={form.grad_year} onChange={(e) => setForm((f) => ({ ...f, grad_year: e.target.value }))} placeholder="2027" />
                </div>
                <div className="form-field" style={{ position: "relative" }}>
                  <label>High School</label>
                  <input value={schoolQuery} onChange={(e) => searchSchools(e.target.value)} placeholder="Start typing a school name…" autoComplete="off" />
                  {schoolResults.length > 0 && (
                    <div
                      style={{
                        position: "absolute",
                        top: "100%",
                        left: 0,
                        right: 0,
                        zIndex: 10,
                        background: "#fff",
                        border: "1px solid #dde1e7",
                        borderRadius: 8,
                        boxShadow: "0 4px 14px rgba(11,31,58,.12)",
                        maxHeight: 180,
                        overflow: "auto",
                      }}
                    >
                      {schoolResults.map((sch) => (
                        <div key={sch.id} onClick={() => pickSchool(sch)} style={{ padding: "7px 10px", fontSize: 13, cursor: "pointer", borderBottom: "1px solid #f2f3f5" }}>
                          <strong>{sch.name}</strong> <span style={{ color: "#697386" }}>— {sch.city}, {sch.state}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  {!selectedSchool && schoolQuery.trim().length >= 2 && schoolResults.length === 0 && (
                    <div style={{ fontSize: 11, color: "#697386", marginTop: 3 }}>No match yet — keep typing or leave unlinked.</div>
                  )}
                </div>
                <div className="form-field">
                  <label>Level of Play Interested In</label>
                  <select value={form.level_of_play} onChange={(e) => setForm((f) => ({ ...f, level_of_play: e.target.value }))}>
                    {LEVELS_OF_PLAY.map((l) => (
                      <option key={l} value={l}>{l || "Not specified"}</option>
                    ))}
                  </select>
                </div>
                <div className="form-field">
                  <label>Position</label>
                  <input value={form.position} onChange={(e) => setForm((f) => ({ ...f, position: e.target.value }))} placeholder="WR" />
                </div>
                <div className="form-field">
                  <label>Jersey #</label>
                  <input value={form.jersey_number} onChange={(e) => setForm((f) => ({ ...f, jersey_number: e.target.value }))} />
                </div>
                <div className="form-field">
                  <label>Height</label>
                  <input value={form.height} onChange={(e) => setForm((f) => ({ ...f, height: e.target.value }))} placeholder="6'1&quot;" />
                </div>
                <div className="form-field">
                  <label>Weight</label>
                  <input value={form.weight} onChange={(e) => setForm((f) => ({ ...f, weight: e.target.value }))} placeholder="185 lbs" />
                </div>
                <div className="form-field">
                  <label>GPA</label>
                  <input value={form.gpa} onChange={(e) => setForm((f) => ({ ...f, gpa: e.target.value }))} placeholder="3.4" />
                </div>
                <div className="form-field">
                  <label>Hudl URL</label>
                  <input value={form.hudl_url} onChange={(e) => setForm((f) => ({ ...f, hudl_url: e.target.value }))} />
                </div>
                <div className="form-field">
                  <label>X (Twitter) URL</label>
                  <input value={form.x_url} onChange={(e) => setForm((f) => ({ ...f, x_url: e.target.value }))} placeholder="https://x.com/username" />
                </div>
                <div className="form-field">
                  <label>Athlete Email</label>
                  <input type="email" value={form.athlete_email} onChange={(e) => setForm((f) => ({ ...f, athlete_email: e.target.value }))} placeholder="athlete@email.com" />
                </div>
                <div className="form-field">
                  <label>Athlete Cell</label>
                  <input value={form.athlete_cell} onChange={(e) => setForm((f) => ({ ...f, athlete_cell: e.target.value }))} placeholder="(555) 555-5555" />
                </div>
                <div className="form-field">
                  <label>City</label>
                  <input value={form.city} onChange={(e) => setForm((f) => ({ ...f, city: e.target.value }))} />
                </div>
                <div className="form-field">
                  <label>State</label>
                  <input value={form.state} maxLength={2} onChange={(e) => setForm((f) => ({ ...f, state: e.target.value.toUpperCase() }))} placeholder="TX" />
                </div>
              </div>
            </div>

            <div style={{ borderTop: "1px solid #eef0f3", paddingTop: 10, marginBottom: 10 }}>
              <div style={{ fontSize: 12.5, fontWeight: 600, color: "#3a4557", marginBottom: 6 }}>Measurables (optional)</div>
              <div className="grid grid-2">
                <div className="form-field">
                  <label>40-Yard Dash (sec)</label>
                  <input value={form.forty_yard_dash} onChange={(e) => setForm((f) => ({ ...f, forty_yard_dash: e.target.value }))} placeholder="4.53" />
                </div>
                <div className="form-field">
                  <label>Vertical Jump (in)</label>
                  <input value={form.vertical_jump} onChange={(e) => setForm((f) => ({ ...f, vertical_jump: e.target.value }))} placeholder="34.5" />
                </div>
                <div className="form-field">
                  <label>Broad Jump (in)</label>
                  <input value={form.broad_jump} onChange={(e) => setForm((f) => ({ ...f, broad_jump: e.target.value }))} placeholder="118" />
                </div>
                <div className="form-field">
                  <label>Bench Press (reps @225)</label>
                  <input value={form.bench_press_reps} onChange={(e) => setForm((f) => ({ ...f, bench_press_reps: e.target.value }))} placeholder="14" />
                </div>
                <div className="form-field">
                  <label>Shuttle (sec)</label>
                  <input value={form.shuttle_time} onChange={(e) => setForm((f) => ({ ...f, shuttle_time: e.target.value }))} placeholder="4.25" />
                </div>
              </div>
            </div>

            <div className="form-field">
              <label>Coach Evaluation (optional)</label>
              <input value={form.coach_evaluation} onChange={(e) => setForm((f) => ({ ...f, coach_evaluation: e.target.value }))} placeholder="Athletic upside, coachability…" />
            </div>

            <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12.5, margin: "10px 0" }}>
              <input type="checkbox" checked={form.guardian_authorized} onChange={(e) => setForm((f) => ({ ...f, guardian_authorized: e.target.checked }))} />
              I have authorization from a parent/guardian to submit this athlete&apos;s information, including contact details (required if under 18)
            </label>

            <div style={{ borderTop: "1px solid #eef0f3", paddingTop: 10, marginBottom: 10 }}>
              <div style={{ fontSize: 12.5, fontWeight: 600, color: "#3a4557", marginBottom: 6 }}>Parent / Guardian Contact (optional)</div>
              <div className="grid grid-2">
                <div className="form-field">
                  <label>Guardian First Name</label>
                  <input value={form.guardian_first_name} onChange={(e) => setForm((f) => ({ ...f, guardian_first_name: e.target.value }))} />
                </div>
                <div className="form-field">
                  <label>Guardian Last Name</label>
                  <input value={form.guardian_last_name} onChange={(e) => setForm((f) => ({ ...f, guardian_last_name: e.target.value }))} />
                </div>
                <div className="form-field">
                  <label>Guardian Email</label>
                  <input type="email" value={form.guardian_email} onChange={(e) => setForm((f) => ({ ...f, guardian_email: e.target.value }))} placeholder="parent@email.com" />
                </div>
                <div className="form-field">
                  <label>Guardian Cell</label>
                  <input value={form.guardian_cell} onChange={(e) => setForm((f) => ({ ...f, guardian_cell: e.target.value }))} placeholder="(555) 555-5555" />
                </div>
              </div>
            </div>

            <div className="grid grid-2" style={{ marginBottom: 10 }}>
              <div className="form-field">
                <label>Offers Received (optional)</label>
                <input value={form.offers_received} onChange={(e) => setForm((f) => ({ ...f, offers_received: e.target.value }))} placeholder="Texas A&amp;M, Ole Miss, Duke" />
              </div>
              <div className="form-field">
                <label>Committed To (optional)</label>
                <input value={form.committed_to} onChange={(e) => setForm((f) => ({ ...f, committed_to: e.target.value }))} placeholder="Leave blank if uncommitted" />
              </div>
            </div>

            {duplicateMatches.length > 0 && (
              <div className="notice" style={{ marginBottom: 10 }}>
                <strong>This might already be on file at this school:</strong>
                <div style={{ marginTop: 6 }}>
                  {duplicateMatches.map((m) => (
                    <div key={m.id} style={{ fontSize: 12.5, padding: "3px 0" }}>
                      {m.athlete_name}
                      {m.grad_year ? ` · Class of ${m.grad_year}` : ""} · submitted {new Date(m.created_at).toLocaleDateString()}
                    </div>
                  ))}
                </div>
                <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                  <button type="button" className="btn btn-sm btn-primary" disabled={submitting} onClick={() => doSubmit(true)}>
                    Submit as a new prospect anyway
                  </button>
                  <button type="button" className="btn btn-sm" onClick={() => setDuplicateMatches([])}>
                    Cancel, let me check
                  </button>
                </div>
              </div>
            )}

            <button className="btn btn-primary" disabled={submitting} style={{ width: "100%", justifyContent: "center" }}>
              {submitting ? "Submitting…" : "Submit for Review"}
            </button>
          </form>
        </div>
      </div>

      <div className="footer-note">
        CSD CoachConnect — Collegiate Sports Data, Spring Hill, TN. Questions?{" "}
        <a href="mailto:larry@collegiatesportsdata.com">larry@collegiatesportsdata.com</a>
      </div>
    </div>
  );
}
