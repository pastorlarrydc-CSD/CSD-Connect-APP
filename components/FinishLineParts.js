// components/FinishLineParts.js
//
// The building blocks of the Finish Line page (app/(app)/admin/finish-line):
// the headline, one row per state, and ONE CARD PER SCHOOL that gathers
// everything waiting for that school in a single place. Presentational only --
// the page owns all data loading. Kept in its own file so it can be tested.
import Link from "next/link";

const GREEN = "#1e7145";
const AMBER = "#8a6100";
const RED = "#b3261e";
const MUTED = "#697386";

export const LANES = [
  { key: "answer_ready", label: "AI answer waiting", color: GREEN },
  { key: "flagged", label: "Flagged for review", color: RED },
  { key: "not_checked", label: "Not checked yet", color: AMBER },
  { key: "checked_no_answer", label: "Checked, no answer", color: MUTED },
];

export function fmt(n) {
  return Number(n || 0).toLocaleString("en-US");
}

export function pct(part, whole) {
  if (!whole) return 0;
  return Math.round((part / whole) * 1000) / 10;
}

export function ProgressBar({ value, color = GREEN, height = 10 }) {
  const v = Math.max(0, Math.min(100, value));
  return (
    <div style={{ background: "#eef0f3", borderRadius: 999, height, overflow: "hidden", width: "100%" }} aria-hidden="true">
      <div style={{ width: `${v}%`, height: "100%", background: color, borderRadius: 999 }} />
    </div>
  );
}

function Chip({ children, color = MUTED, bg = "#f2f4f7", title }) {
  return (
    <span title={title} style={{ display: "inline-block", fontSize: 11.5, fontWeight: 700, color, background: bg, borderRadius: 999, padding: "2px 9px", marginRight: 6, marginTop: 4 }}>
      {children}
    </span>
  );
}

// ---- headline --------------------------------------------------------------

export function Headline({ totals }) {
  const done = totals.verified;
  const total = totals.total_open;
  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div style={{ display: "flex", gap: 24, flexWrap: "wrap", alignItems: "flex-end", justifyContent: "space-between" }}>
        <div>
          <div style={{ fontSize: 12, fontWeight: 700, color: MUTED, textTransform: "uppercase" }}>Schools left to finish</div>
          <div style={{ fontSize: 44, fontWeight: 800, color: "#0b1f3a", lineHeight: 1.1 }}>{fmt(totals.remaining)}</div>
          <div style={{ fontSize: 13, color: MUTED }}>
            {fmt(done)} of {fmt(total)} open schools verified ({pct(done, total)}%)
          </div>
        </div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <Stat n={totals.ai_ready} label="AI answer already waiting" color={GREEN} />
          <Stat n={totals.flagged} label="Flagged for review" color={RED} />
          <Stat n={totals.never_checked} label="Never AI-checked" color={AMBER} />
        </div>
      </div>
      <div style={{ marginTop: 14 }}>
        <ProgressBar value={pct(done, total)} height={14} />
      </div>
    </div>
  );
}

function Stat({ n, label, color }) {
  return (
    <div style={{ border: "1px solid #dde1e7", borderRadius: 10, padding: "8px 14px", minWidth: 150 }}>
      <div style={{ fontSize: 22, fontWeight: 800, color }}>{fmt(n)}</div>
      <div style={{ fontSize: 12, color: MUTED, fontWeight: 600 }}>{label}</div>
    </div>
  );
}

// The single most useful next move, in plain words.
export function nextMove(totals, states) {
  if (totals.remaining === 0) return { text: "Every open school is verified. Nothing left to finish.", href: null };
  if (totals.ai_ready > 0) {
    return {
      text: `Review the ${fmt(totals.ai_ready)} AI answers already waiting. They are the fastest wins, because the checking is already done.`,
      href: "/admin/batch-coach-info",
      cta: "Open Batch Coach-Info",
    };
  }
  const small = states.filter((s) => s.never_checked > 0).sort((a, b) => a.remaining - b.remaining)[0];
  if (small) {
    return {
      text: `Run the AI check on ${small.state}: ${fmt(small.never_checked)} schools there have never been checked. It is the smallest state with unchecked schools.`,
      href: `/admin/batch-coach-info?state=${encodeURIComponent(small.state)}&mode=re_verify`,
      cta: `Check ${small.state}`,
    };
  }
  return { text: "Work through the flagged schools in the list below.", href: "/admin/needs-review", cta: "Open Needs Review" };
}

export function NextMove({ move }) {
  return (
    <div className="notice info" style={{ marginBottom: 14, display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", justifyContent: "space-between" }}>
      <div style={{ fontSize: 13.5 }}>
        <strong>Best next move:</strong> {move.text}
      </div>
      {move.href && (
        <Link href={move.href} className="btn btn-sm btn-gold">
          {move.cta} →
        </Link>
      )}
    </div>
  );
}

// ---- one row per state -----------------------------------------------------

export function StateRow({ row, open, onToggle }) {
  const donePct = pct(row.verified, row.total_open);
  return (
    <div className="card" style={{ marginBottom: 8, padding: "10px 14px", borderColor: open ? "#0b1f3a" : undefined }}>
      <div style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          style={{ background: "none", border: "none", padding: 0, textAlign: "left", minWidth: 150, cursor: "pointer" }}
        >
          <span style={{ fontSize: 17, fontWeight: 800, color: "#0b1f3a" }}>{row.state}</span>
          {row.is_priority_state && <span style={{ fontSize: 10.5, fontWeight: 700, color: "#8a6a12", marginLeft: 6 }}>PRIORITY</span>}
          <div style={{ fontSize: 12.5, color: MUTED }}>
            {fmt(row.remaining)} left of {fmt(row.total_open)}
          </div>
        </button>
        <div style={{ flex: "1 1 200px", minWidth: 160 }}>
          <ProgressBar value={donePct} />
          <div style={{ fontSize: 11.5, color: MUTED, marginTop: 3 }}>{donePct}% verified</div>
        </div>
        <div style={{ flex: "2 1 260px" }}>
          {row.ai_ready > 0 && <Chip color={GREEN} bg="#e6f0ea">{fmt(row.ai_ready)} AI answer{row.ai_ready === 1 ? "" : "s"} waiting</Chip>}
          {row.flagged > 0 && <Chip color={RED} bg="#fdeeed">{fmt(row.flagged)} flagged</Chip>}
          {row.never_checked > 0 && <Chip color={AMBER} bg="#fff2df">{fmt(row.never_checked)} not checked yet</Chip>}
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <button type="button" className="btn btn-sm btn-primary" onClick={onToggle}>
            {open ? "Hide list" : "Open list"}
          </button>
          {row.never_checked > 0 && (
            <Link href={`/admin/batch-coach-info?state=${encodeURIComponent(row.state)}&mode=re_verify`} className="btn btn-sm btn-gold" title="Starts a Batch Coach-Info run on this state's unchecked schools (you confirm it on that page)">
              Run AI check ({fmt(row.never_checked)})
            </Link>
          )}
          {row.flagged > 0 && (
            <Link href={`/admin/needs-review?state=${encodeURIComponent(row.state)}`} className="btn btn-sm">
              Needs Review
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}

// ---- one card per school ---------------------------------------------------

function laneOf(key) {
  return LANES.find((l) => l.key === key) || LANES[3];
}

function AiBlock({ card }) {
  const ai = card.ai;
  if (!ai) return null;
  const ev = ai.evidence;
  const sp = ai.second_pass;
  const verdict =
    ai.status === "matches"
      ? "Same coach and email as on file"
      : ai.status === "name_ok"
      ? "Same coach; the email differs or was not found"
      : ai.status === "differs"
      ? "A DIFFERENT head coach than on file"
      : "No usable coach found";
  const vColor = ai.status === "matches" ? GREEN : ai.status === "differs" ? RED : AMBER;
  return (
    <div style={{ marginTop: 8, padding: "8px 10px", background: "#f7f8fa", border: "1px solid #eef0f3", borderRadius: 8, fontSize: 12.5 }}>
      <div>
        <strong>AI answer</strong>
        {ai.confidence ? <span style={{ color: ai.confidence === "high" ? GREEN : ai.confidence === "medium" ? AMBER : RED, fontWeight: 700 }}> · {ai.confidence} confidence</span> : null}
        {ai.age_days != null && <span style={{ color: MUTED }}> · {ai.age_days === 0 ? "today" : `${ai.age_days} day${ai.age_days === 1 ? "" : "s"} old`}</span>}
      </div>
      <div style={{ color: vColor, fontWeight: 700 }}>{verdict}</div>
      {(ai.suggested_name || ai.suggested_email) && (
        <div style={{ color: "#3c4658" }}>
          {ai.suggested_name || "(no name)"}
          {ai.suggested_email ? ` · ${ai.suggested_email}${ai.email_estimated ? " (guessed pattern, not seen on a page)" : ""}` : ""}
        </div>
      )}
      <div>
        {ev && ev.quote_verified === true && <Chip color={GREEN} bg="#e6f0ea">proof found on page</Chip>}
        {ev && ev.quote_verified === false && <Chip color={RED} bg="#fdeeed">proof not found on page</Chip>}
        {ev && ev.freshness === "current" && <Chip color={GREEN} bg="#e6f0ea">current season</Chip>}
        {ev && ev.freshness && ev.freshness !== "current" && <Chip color={AMBER} bg="#fff2df">{ev.freshness === "undated" ? "no date shown" : ev.freshness === "older" ? "last season's page" : "old page"}</Chip>}
        {ev && ev.email_on_file_only && <Chip color={AMBER} bg="#fff2df">email on file, not re-confirmed</Chip>}
        {sp && sp.verdict === "contradicted" && <Chip color={RED} bg="#fdeeed">second look found a conflict</Chip>}
        {sp && sp.verdict === "supported" && <Chip color={GREEN} bg="#e6f0ea">second look agrees</Chip>}
        {ai.confirmable && <Chip color={GREEN} bg="#e6f0ea">safe to confirm</Chip>}
      </div>
      {ai.notes ? <div style={{ color: MUTED, marginTop: 4 }}>{ai.notes}</div> : null}
      {ai.run_id ? (
        <div style={{ marginTop: 6 }}>
          <Link href={`/admin/batch-coach-info?run=${ai.run_id}&q=${encodeURIComponent(card.name || "")}`} className="btn btn-sm btn-gold" target="_blank" rel="noopener noreferrer">
            Review this answer →
          </Link>
        </div>
      ) : null}
    </div>
  );
}

export function SchoolCard({ card }) {
  const lane = laneOf(card.lane);
  return (
    <div className="card" style={{ marginBottom: 8, padding: "10px 14px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
        <div>
          <Link href={`/schools/${card.id}`} target="_blank" rel="noopener noreferrer" title="Opens in a new tab so this list stays open" style={{ fontWeight: 800, fontSize: 14.5 }}>
            {card.name}
          </Link>
          <span style={{ color: MUTED, fontSize: 12.5 }}>{card.city ? ` · ${card.city}` : ""}</span>
          <div style={{ fontSize: 12.5, color: "#3c4658", marginTop: 2 }}>
            {card.coach || "No coach on file"}
            {card.email ? ` · ${card.email}` : ""}
            {card.cell ? ` · ${card.cell}` : card.office ? ` · ${card.office}` : ""}
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          <Chip color={lane.color} bg="#f2f4f7">{lane.label}</Chip>
          {card.needs_review && card.lane !== "flagged" && <Chip color={RED} bg="#fdeeed">flagged</Chip>}
          {card.verification_status === "verified" && <Chip color={GREEN} bg="#e6f0ea">verified, but flagged</Chip>}
        </div>
      </div>

      {card.needs_review && (
        <div style={{ marginTop: 6, fontSize: 12.5, color: "#8c1d18" }}>
          <strong>Why it's flagged:</strong> {card.needs_review_note || "(no reason was written)"}
          {card.flagged_days != null ? <span style={{ color: MUTED }}> · {card.flagged_days === 0 ? "today" : `${card.flagged_days} days ago`}</span> : null}
        </div>
      )}

      <AiBlock card={card} />

      {card.finds.length > 0 && (
        <div style={{ marginTop: 8, fontSize: 12.5 }}>
          <strong>Other finds waiting:</strong>
          {card.finds.map((f, i) => (
            <div key={`${f.kind}-${i}`} style={{ color: "#3c4658" }}>
              {f.kind}:{" "}
              <a href={f.value} target="_blank" rel="noopener noreferrer">
                {f.value}
              </a>
              {f.confidence ? <span style={{ color: MUTED }}> ({f.confidence})</span> : null}
            </div>
          ))}
        </div>
      )}

      {card.lane === "not_checked" && !card.has_site && <div style={{ marginTop: 6, fontSize: 12, color: AMBER }}>No website or athletics link on file, so the AI check has little to read.</div>}
    </div>
  );
}
