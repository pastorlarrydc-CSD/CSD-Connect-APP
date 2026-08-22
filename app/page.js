"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useAuth } from "@/lib/auth-context";

const FEATURES = [
  {
    title: "National HS Coach Database",
    body:
      "Search and filter 14,600+ high school football programs by state, classification, and contact completeness. Every record shows head coach name, email, cell, and office number when it's on file — not just a school name and a guess.",
  },
  {
    title: "Recruiting Trip Planner",
    body:
      "Build multi-day recruiting swings with route optimization that sequences your stops automatically and rebalances across days to cut total drive time — without ever bumping a confirmed appointment. Print a clean day-by-day itinerary before you leave.",
  },
  {
    title: "Territory CRM",
    body:
      "Assign schools to your staff, log every call, email, text, and visit, and keep a shared watchlist so two coaches on your own staff never work the same lead without knowing it.",
  },
  {
    title: "Data You Can Actually Trust",
    body:
      "Every record carries a verification status, and our team runs it through an ongoing data-quality review — so you're not burning a Saturday morning on a disconnected number or a coach who left two years ago.",
  },
];

const STATS = [
  { num: "14,600+", label: "High school programs indexed" },
  { num: "91%", label: "With a verified head coach email" },
  { num: "50", label: "States covered" },
  { num: "100%", label: "Built for small-program budgets" },
];

export default function LandingPage() {
  const router = useRouter();
  const { session } = useAuth();

  // Signed-in visitors (Larry, staff) skip the marketing page and go
  // straight to work. Everyone else -- the actual audience for this page --
  // sees the real content below instead of being bounced straight to a
  // bare login screen.
  useEffect(() => {
    if (session) router.replace("/dashboard");
  }, [session, router]);

  if (session === undefined || session) {
    return <div style={{ padding: 40, textAlign: "center", color: "#697386" }}>Loading CSD CoachConnect…</div>;
  }

  return (
    <div className="landing">
      <div className="landing-nav">
        <div className="brand" style={{ color: "#fff" }}>
          <span className="dot" />
          CSD CoachConnect
          <small>Collegiate Sports Data · Recruiting Intelligence</small>
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <Link href="/submit-prospect" className="btn btn-sm" style={{ background: "transparent", color: "#fff", borderColor: "#ffffff40" }}>
            HS Coach? Submit a Prospect
          </Link>
          <Link href="/login" className="btn btn-sm" style={{ background: "transparent", color: "#fff", borderColor: "#ffffff40" }}>
            Sign In
          </Link>
          <Link href="/signup" className="btn btn-sm btn-gold">
            Create Free Account
          </Link>
        </div>
      </div>

      <div className="landing-hero">
        <h1>Find the prospects everyone else is missing.</h1>
        <p>
          CSD CoachConnect gives D2, D3, NAIA, and JUCO coaching staffs a live, verified database of high school
          football programs nationwide — plus a recruiting trip planner built to get you in front of more prospects
          in less time behind the wheel.
        </p>
        <div style={{ display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap" }}>
          <Link href="/signup" className="btn btn-gold" style={{ padding: "12px 22px", fontSize: 14.5 }}>
            Create Your Free Account
          </Link>
          <Link href="/login" className="btn" style={{ padding: "12px 22px", fontSize: 14.5, background: "#fff" }}>
            Sign In
          </Link>
        </div>
      </div>

      <div className="landing-stats">
        {STATS.map((s) => (
          <div key={s.label} className="landing-stat">
            <div className="num">{s.num}</div>
            <div className="label">{s.label}</div>
          </div>
        ))}
      </div>

      <div className="landing-section">
        <h2>Everything you need to run a recruiting territory</h2>
        <div className="grid grid-2" style={{ marginTop: 18 }}>
          {FEATURES.map((f) => (
            <div className="card" key={f.title}>
              <h3 style={{ color: "var(--navy)", fontSize: 15.5 }}>{f.title}</h3>
              <p style={{ margin: 0, fontSize: 13, color: "var(--gray-700)", lineHeight: 1.6 }}>{f.body}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="landing-section landing-mission">
        <h2>Built for the programs the big platforms overlook</h2>
        <p>
          The major recruiting services are built around Power 4 budgets and five-star prospects. CSD CoachConnect
          exists for the coaching staffs finding real players at real schools — the ones who show up on film, not on
          a national ranking — and for the small-school and JUCO programs who win by finding them first.
        </p>
      </div>

      <div className="landing-cta">
        <h2>Ready to see your territory differently?</h2>
        <p>Create a free account and start searching in under a minute — no credit card required.</p>
        <Link href="/signup" className="btn btn-gold" style={{ padding: "12px 26px", fontSize: 14.5 }}>
          Create Your Free Account
        </Link>
      </div>

      <div style={{ textAlign: "center", padding: "0 24px 40px", fontSize: 13, color: "var(--gray-500)" }}>
        High school coach, AD, or parent? You can{" "}
        <Link href="/submit-prospect" style={{ fontWeight: 700 }}>submit a prospect</Link> without creating an account.
      </div>

      <div className="footer-note">
        CSD CoachConnect — Collegiate Sports Data, Spring Hill, TN. Questions? <a href="mailto:larry@collegiatesportsdata.com">larry@collegiatesportsdata.com</a>
      </div>
    </div>
  );
}
