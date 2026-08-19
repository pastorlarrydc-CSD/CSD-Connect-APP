"use client";
import { useEffect, useState, useCallback, useRef } from "react";
import Link from "next/link";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { useAuth } from "@/lib/auth-context";

const STATUS_LABEL = { submitted: "Submitted", reviewed: "Reviewed", contacted: "Contacted" };
const LEVELS_OF_PLAY = ["", "FBS", "FCS", "D2", "D3", "NAIA", "JUCO", "Prep/Post-Grad"];

const EMPTY_FORM = {
  athlete_name: "",
  grad_year: "",
  position: "",
  jersey_number: "",
  height: "",
  weight: "",
  gpa: "",
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

export default function ProspectsPage() {
  const supabase = getSupabaseBrowserClient();
  const { college, user, profile } = useAuth();

  const [watchlist, setWatchlist] = useState([]);
  const [prospects, setProspects] = useState([]);
  const [form, setForm] = useState(EMPTY_FORM);

  const [schoolQuery, setSchoolQuery] = useState("");
  const [schoolResults, setSchoolResults] = useState([]);
  const [selectedSchool, setSelectedSchool] = useState(null);
  const debounceRef = useRef(null);

  const [submitted, setSubmitted] = useState(false);
  const [submitError, setSubmitError] = useState("");

  const canBulkAdd = profile?.role === "verifier" || profile?.role === "sysadmin";
  const isHsCoach = profile?.role === "hs_coach";

  const load = useCallback(async () => {
    if (college?.id) {
      const { data } = await supabase.from("watchlist_items").select("*, schools(id,name,city,state)").eq("college_id", college.id);
      setWatchlist(data || []);
    }
    const { data: prospectRows } = await supabase
      .from("prospects")
      .select("*, schools(id,name,city,state)")
      .order("created_at", { ascending: false })
      .limit(50);
    setProspects(prospectRows || []);
  }, [supabase, college]);

  useEffect(() => {
    load();
  }, [load]);

  async function removeFromWatchlist(schoolId) {
    await supabase.from("watchlist_items").delete().eq("college_id", college.id).eq("school_id", schoolId);
    load();
  }

  function searchSchools(value) {
    setSchoolQuery(value);
    setSelectedSchool(null);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (value.trim().length < 2) {
      setSchoolResults([]);
      return;
    }
    debounceRef.current = setTimeout(async () => {
      const { data } = await supabase
        .from("schools")
        .select("id,name,city,state")
        .ilike("name", `%${value.trim()}%`)
        .order("name", { ascending: true })
        .limit(8);
      setSchoolResults(data || []);
    }, 250);
  }

  function pickSchool(school) {
    setSelectedSchool(school);
    setSchoolQuery(`${school.name} — ${school.city}, ${school.state}`);
    setSchoolResults([]);
  }

  async function submitProspect(e) {
    e.preventDefault();
    setSubmitError("");
    if (!form.athlete_name.trim()) return;

    const { error } = await supabase.from("prospects").insert({
      submitted_by: user.id,
      athlete_name: form.athlete_name,
      grad_year: form.grad_year ? parseInt(form.grad_year, 10) : null,
      position: form.position || null,
      jersey_number: form.jersey_number || null,
      height: form.height || null,
      weight: form.weight || null,
      gpa: form.gpa ? parseFloat(form.gpa) : null,
      athlete_email: form.athlete_email || null,
      athlete_cell: form.athlete_cell || null,
      city: form.city || null,
      state: form.state || null,
      school_id: selectedSchool?.id || null,
      level_of_play: form.level_of_play || null,
      hudl_url: form.hudl_url || null,
      x_url: form.x_url || null,
      coach_evaluation: form.coach_evaluation || null,
      guardian_authorized: form.guardian_authorized,
      guardian_first_name: form.guardian_first_name || null,
      guardian_last_name: form.guardian_last_name || null,
      guardian_email: form.guardian_email || null,
      guardian_cell: form.guardian_cell || null,
      offers_received: form.offers_received || null,
      committed_to: form.committed_to || null,
    });

    if (error) {
      setSubmitError(error.message);
      return;
    }

    setForm(EMPTY_FORM);
    setSchoolQuery("");
    setSelectedSchool(null);
    setSubmitted(true);
    load();
  }

  async function deleteProspect(id) {
    if (!confirm("Delete this prospect? This cannot be undone.")) return;
    await supabase.from("prospects").delete().eq("id", id);
    load();
  }

  return (
    <div className="view">
      <div className="view-header">
        <div>
          <h1>Prospect Management</h1>
          <p>Submission portal for high-school coaches, and watchlist tools for college staff</p>
        </div>
        {canBulkAdd && (
          <Link href="/prospects/bulk-add" className="btn btn-sm btn-primary">
            Bulk Add Prospects (CSV)
          </Link>
        )}
      </div>

      <div className="grid grid-2">
        <div className="card">
          <h3>
            Submit a Prospect {isHsCoach ? "" : <span style={{ fontWeight: 400, color: "#697386", fontSize: 12 }}>— typically used by HS coaches</span>}
          </h3>
          {submitted && <div className="notice info" style={{ marginBottom: 10 }}>Prospect submitted — it&apos;s now visible to college coaches below.</div>}
          {submitError && <div className="notice danger" style={{ marginBottom: 10 }}>{submitError}</div>}

          <form onSubmit={submitProspect}>
            <div className="grid grid-2" style={{ marginBottom: 10 }}>
              <div className="form-field">
                <label>Athlete Name</label>
                <input required value={form.athlete_name} onChange={(e) => setForm((f) => ({ ...f, athlete_name: e.target.value }))} />
              </div>
              <div className="form-field">
                <label>Graduation Year</label>
                <input value={form.grad_year} onChange={(e) => setForm((f) => ({ ...f, grad_year: e.target.value }))} placeholder="2027" />
              </div>
              <div className="form-field" style={{ position: "relative" }}>
                <label>School</label>
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
                    {schoolResults.map((s) => (
                      <div key={s.id} onClick={() => pickSchool(s)} style={{ padding: "7px 10px", fontSize: 13, cursor: "pointer", borderBottom: "1px solid #f2f3f5" }}>
                        <strong>{s.name}</strong> <span style={{ color: "#697386" }}>— {s.city}, {s.state}</span>
                      </div>
                    ))}
                  </div>
                )}
                {!selectedSchool && schoolQuery.trim().length >= 2 && schoolResults.length === 0 && (
                  <div style={{ fontSize: 11, color: "#697386", marginTop: 3 }}>No match yet — keep typing or leave unlinked.</div>
                )}
              </div>
              <div className="form-field">
                <label>Level of Play</label>
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

            <div className="form-field">
              <label>Coach Evaluation</label>
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

            <button className="btn btn-primary">Submit for Review</button>
          </form>
        </div>

        <div>
          <div className="card" style={{ marginBottom: 14 }}>
            <h3>Your Watchlist</h3>
            {watchlist.length ? (
              watchlist.map((w) => (
                <div className="log-item" key={w.id}>
                  <strong>{w.schools?.name}</strong> — {w.schools?.city}, {w.schools?.state}
                  <button className="btn btn-sm" style={{ float: "right" }} onClick={() => removeFromWatchlist(w.school_id)}>
                    Remove
                  </button>
                </div>
              ))
            ) : (
              <div className="empty-state">No schools on your watchlist yet. Add from a school profile or the map.</div>
            )}
          </div>

          <div className="card">
            <h3>Recently Submitted Prospects ({prospects.length})</h3>
            {prospects.length ? (
              prospects.map((p) => {
                const canManage = canBulkAdd || p.submitted_by === user?.id;
                return (
                  <div className="log-item" key={p.id} style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "flex-start" }}>
                    <Link href={`/prospects/${p.id}`} style={{ textDecoration: "none", color: "inherit", flex: 1 }}>
                      <span className="when">{STATUS_LABEL[p.status] || p.status}</span>
                      <strong>{p.athlete_name}</strong> {p.grad_year ? `· Class of ${p.grad_year}` : ""} {p.position ? `· ${p.position}` : ""} {p.level_of_play ? `· ${p.level_of_play}` : ""}
                      <div style={{ fontSize: 11.5, color: "#697386", marginTop: 2 }}>
                        {p.schools?.name ? `${p.schools.name} · ` : ""}{p.city || p.schools?.city}{p.state || p.schools?.state ? `, ${p.state || p.schools?.state}` : ""}
                        {p.athlete_email ? ` · ${p.athlete_email}` : ""}{p.athlete_cell ? ` · ${p.athlete_cell}` : ""}
                        {p.committed_to ? ` · Committed to ${p.committed_to}` : ""}
                      </div>
                    </Link>
                    {canManage && (
                      <button className="btn btn-sm btn-danger" onClick={() => deleteProspect(p.id)}>
                        Delete
                      </button>
                    )}
                  </div>
                );
              })
            ) : (
              <div className="empty-state">No prospects submitted yet.</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
