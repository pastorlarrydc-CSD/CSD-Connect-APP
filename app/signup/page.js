"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { checkAuthRateLimit, rateLimitMessage } from "@/lib/authRateLimit";

const ROLE_OPTIONS = [
  { value: "college_coach", label: "College Coach / Recruiting Staff" },
  { value: "athletic_director", label: "Athletic Director / Administrator" },
  { value: "hs_coach", label: "High School Head Coach" },
  { value: "verifier", label: "Database Researcher / Verification Staff" },
  { value: "sysadmin", label: "System Administrator" },
];

export default function SignupPage() {
  const supabase = getSupabaseBrowserClient();
  const router = useRouter();

  const [form, setForm] = useState({ name: "", email: "", password: "", collegeName: "", role: "college_coach", title: "" });
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [submitting, setSubmitting] = useState(false);

  function field(key, val) {
    setForm((prev) => ({ ...prev, [key]: val }));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    setSuccess("");
    setSubmitting(true);

    // Basic abuse protection, checked before Supabase ever creates an
    // account -- see lib/authRateLimit.js. Fails open, so a hiccup in
    // this check can never block a real signup.
    const rl = await checkAuthRateLimit("signup", form.email);
    if (!rl.allowed) {
      setSubmitting(false);
      setError(rateLimitMessage(rl.retryAfterSeconds, "account-creation"));
      return;
    }

    try {
      const { data: signUpData, error: signUpError } = await supabase.auth.signUp({ email: form.email, password: form.password });
      if (signUpError) throw signUpError;

      const userId = signUpData.user?.id;
      const session = signUpData.session;
      let collegeId = null;

      if (form.collegeName.trim()) {
        const { data: existingCollege } = await supabase.from("colleges").select("id").ilike("name", form.collegeName.trim()).maybeSingle();
        if (existingCollege) {
          collegeId = existingCollege.id;
        } else if (session) {
          const { data: newCollege, error: collegeError } = await supabase
            .from("colleges")
            .insert({ name: form.collegeName.trim() })
            .select("id")
            .single();
          if (collegeError) throw collegeError;
          collegeId = newCollege.id;
        }
      }

      if (userId && session) {
        const { error: profileError } = await supabase
          .from("profiles")
          .insert({ id: userId, full_name: form.name, role: form.role, title: form.title || null, college_id: collegeId });
        if (profileError) throw profileError;
        router.push("/dashboard");
        return;
      }

      setSuccess("Account created — check your email to confirm your address, then sign in. You'll finish setting up your profile (college, role) right after you log in.");
    } catch (err) {
      setError(err.message || "Something went wrong creating your account.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="auth-wrap">
      <div className="auth-card" style={{ width: "min(480px,92vw)" }}>
        <h1>Create your CSD CoachConnect account</h1>
        <p className="sub">First account for a new college becomes its founding member automatically.</p>
        {error && <div className="notice danger" style={{ marginBottom: 12 }}>{error}</div>}
        {success && <div className="notice info" style={{ marginBottom: 12 }}>{success}</div>}
        {!success && (
          <form onSubmit={handleSubmit}>
            <div className="form-field">
              <label>Full name</label>
              <input required value={form.name} onChange={(e) => field("name", e.target.value)} />
            </div>
            <div className="form-field">
              <label>Email</label>
              <input type="email" required value={form.email} onChange={(e) => field("email", e.target.value)} />
            </div>
            <div className="form-field">
              <label>Password</label>
              <input type="password" required minLength={6} value={form.password} onChange={(e) => field("password", e.target.value)} />
            </div>
            <div className="form-field">
              <label>College / Organization</label>
              <input required value={form.collegeName} onChange={(e) => field("collegeName", e.target.value)} placeholder="e.g. Collegiate Sports Data" />
            </div>
            <div className="form-field">
              <label>Title (optional)</label>
              <input value={form.title} onChange={(e) => field("title", e.target.value)} placeholder="Recruiting Coordinator" />
            </div>
            <div className="form-field">
              <label>Role</label>
              <select value={form.role} onChange={(e) => field("role", e.target.value)}>
                {ROLE_OPTIONS.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </select>
            </div>
            <button className="btn btn-gold" style={{ width: "100%", justifyContent: "center", marginTop: 6 }} disabled={submitting}>
              {submitting ? "Creating account…" : "Create Account"}
            </button>
          </form>
        )}
        <p style={{ fontSize: 12.5, color: "#697386", marginTop: 16, textAlign: "center" }}>
          Already have an account? <Link href="/login">Sign in</Link>
        </p>
      </div>
    </div>
  );
}
