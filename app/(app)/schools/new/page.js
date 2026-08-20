"use client";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { useAuth } from "@/lib/auth-context";

const STATES = ["AL","AK","AS","AZ","AR","CA","CO","CT","DE","DC","FL","GA","HI","ID","IL","IN","IA","KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT","VA","WA","WV","WI","WY"];

const EMPTY_FORM = {
  name: "",
  school_type: "",
  addr1: "",
  addr2: "",
  city: "",
  county: "",
  state: "",
  zip: "",
  classification: "",
  phone: "",
  website: "",
  hc_first_name: "",
  hc_last_name: "",
  hc_email: "",
  hc_cell: "",
  hc_office: "",
  x_twitter: "",
};

export default function AddSchoolPage() {
  const router = useRouter();
  const supabase = getSupabaseBrowserClient();
  const { user, profile } = useAuth();

  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const canAdd = profile?.role === "verifier" || profile?.role === "sysadmin";

  function set(field, value) {
    setForm((f) => ({ ...f, [field]: value }));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");

    const name = form.name.trim();
    const state = form.state.trim().toUpperCase();
    if (!name) {
      setError("School name is required.");
      return;
    }
    if (!state) {
      setError("State is required.");
      return;
    }

    setSaving(true);
    try {
      // Guard against accidentally creating a duplicate of a school that's
      // already on file -- exact name + state match only, since a fuzzier
      // check belongs in the bulk-add tool's preview, not a blocking check
      // here.
      const { data: existing, error: dupErr } = await supabase
        .from("schools")
        .select("id,name,city,state")
        .ilike("name", name)
        .eq("state", state)
        .limit(1);
      if (dupErr) throw dupErr;
      if (existing && existing.length) {
        setError(`A school named "${existing[0].name}" already exists in ${existing[0].state} (${existing[0].city || "city unknown"}). Open that record instead, or adjust the name if this is actually a different school.`);
        setSaving(false);
        return;
      }

      const payload = {
        name,
        state,
        school_type: form.school_type.trim() || null,
        addr1: form.addr1.trim() || null,
        addr2: form.addr2.trim() || null,
        city: form.city.trim() || null,
        county: form.county.trim() || null,
        zip: form.zip.trim() || null,
        classification: form.classification.trim() || null,
        phone: form.phone.trim() || null,
        website: form.website.trim() || null,
        hc_first_name: form.hc_first_name.trim() || null,
        hc_last_name: form.hc_last_name.trim() || null,
        hc_email: form.hc_email.trim() || null,
        hc_cell: form.hc_cell.trim() || null,
        hc_office: form.hc_office.trim() || null,
        x_twitter: form.x_twitter.trim() || null,
        verification_status: "verified",
        confidence_score: 70,
        last_verified_at: new Date().toISOString(),
        source: "Manually added by staff",
      };

      const { data: created, error: insertErr } = await supabase.from("schools").insert(payload).select("id").single();
      if (insertErr) throw insertErr;

      await supabase.from("school_change_log").insert({
        school_id: created.id,
        field_name: "created",
        old_value: null,
        new_value: name,
        source: "Manually added by staff",
        changed_by: user.id,
      });

      router.push(`/schools/${created.id}`);
    } catch (err) {
      setError(err.message || "Could not save this school.");
      setSaving(false);
    }
  }

  if (!canAdd) {
    return (
      <div className="view">
        <div className="notice danger">Adding schools is limited to Verification Staff and System Admins.</div>
      </div>
    );
  }

  return (
    <div className="view">
      <Link href="/search" className="btn btn-sm" style={{ marginBottom: 12, display: "inline-flex" }}>
        ← Back to Search
      </Link>
      <div className="view-header">
        <div>
          <h1>Add a New School</h1>
          <p>Adds a single school directly to the national database. To add many schools at once, use Bulk Add Schools (CSV) from the Admin page instead.</p>
        </div>
      </div>

      <form className="card" onSubmit={handleSubmit} style={{ maxWidth: 720 }}>
        {error && <div className="notice danger" style={{ marginBottom: 12 }}>{error}</div>}

        <div className="grid grid-2" style={{ marginBottom: 8 }}>
          <div className="field">
            <label>School name *</label>
            <input value={form.name} onChange={(e) => set("name", e.target.value)} required />
          </div>
          <div className="field">
            <label>Type</label>
            <select value={form.school_type} onChange={(e) => set("school_type", e.target.value)}>
              <option value="">—</option>
              <option value="Public">Public</option>
              <option value="Private">Private</option>
            </select>
          </div>
        </div>

        <div className="grid grid-2" style={{ marginBottom: 8 }}>
          <div className="field">
            <label>Address line 1</label>
            <input value={form.addr1} onChange={(e) => set("addr1", e.target.value)} />
          </div>
          <div className="field">
            <label>Address line 2</label>
            <input value={form.addr2} onChange={(e) => set("addr2", e.target.value)} />
          </div>
        </div>

        <div className="grid grid-4" style={{ marginBottom: 8 }}>
          <div className="field">
            <label>City</label>
            <input value={form.city} onChange={(e) => set("city", e.target.value)} />
          </div>
          <div className="field">
            <label>County</label>
            <input value={form.county} onChange={(e) => set("county", e.target.value)} />
          </div>
          <div className="field">
            <label>State *</label>
            <select value={form.state} onChange={(e) => set("state", e.target.value)} required>
              <option value="">—</option>
              {STATES.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>Zip</label>
            <input value={form.zip} onChange={(e) => set("zip", e.target.value)} />
          </div>
        </div>

        <div className="grid grid-2" style={{ marginBottom: 8 }}>
          <div className="field">
            <label>Classification</label>
            <input placeholder="e.g. 4A, D2, GRP 1" value={form.classification} onChange={(e) => set("classification", e.target.value)} />
          </div>
          <div className="field">
            <label>Main phone</label>
            <input value={form.phone} onChange={(e) => set("phone", e.target.value)} />
          </div>
        </div>

        <div className="field" style={{ marginBottom: 8 }}>
          <label>Website</label>
          <input placeholder="www.example.k12.us" value={form.website} onChange={(e) => set("website", e.target.value)} />
        </div>

        <h3 style={{ marginTop: 16, marginBottom: 8 }}>Head Coach</h3>
        <div className="grid grid-2" style={{ marginBottom: 8 }}>
          <div className="field">
            <label>First name</label>
            <input value={form.hc_first_name} onChange={(e) => set("hc_first_name", e.target.value)} />
          </div>
          <div className="field">
            <label>Last name</label>
            <input value={form.hc_last_name} onChange={(e) => set("hc_last_name", e.target.value)} />
          </div>
        </div>
        <div className="grid grid-2" style={{ marginBottom: 8 }}>
          <div className="field">
            <label>Email</label>
            <input type="email" value={form.hc_email} onChange={(e) => set("hc_email", e.target.value)} />
          </div>
          <div className="field">
            <label>X (Twitter)</label>
            <input value={form.x_twitter} onChange={(e) => set("x_twitter", e.target.value)} />
          </div>
        </div>
        <div className="grid grid-2" style={{ marginBottom: 16 }}>
          <div className="field">
            <label>Cell</label>
            <input value={form.hc_cell} onChange={(e) => set("hc_cell", e.target.value)} />
          </div>
          <div className="field">
            <label>Office</label>
            <input value={form.hc_office} onChange={(e) => set("hc_office", e.target.value)} />
          </div>
        </div>

        <button type="submit" className="btn btn-gold" disabled={saving}>
          {saving ? "Saving…" : "Add School"}
        </button>
      </form>
    </div>
  );
}
