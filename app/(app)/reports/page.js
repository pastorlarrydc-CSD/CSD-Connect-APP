"use client";
import { useEffect, useMemo, useState } from "react";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { useAuth } from "@/lib/auth-context";
import { mileageRateForDate } from "@/lib/mileageRates";

const CONTACT_TYPES = ["Call", "Email", "Text", "Visit", "Evaluation"];
const LEADERBOARD_RANGES = [
  { label: "Last 30 days", days: 30 },
  { label: "Last 90 days", days: 90 },
  { label: "Last 12 months", days: 365 },
  { label: "All time", days: null },
];

function monthKey(dateStr) {
  const d = new Date(dateStr);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
function monthLabel(key) {
  const [y, m] = key.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: "short", year: "2-digit" });
}

export default function ReportsPage() {
  const supabase = getSupabaseBrowserClient();
  const { college } = useAuth();
  const [data, setData] = useState(null);
  const [leaderboardDays, setLeaderboardDays] = useState(90);

  useEffect(() => {
    async function load() {
      const { data: schoolStates } = await supabase.from("schools").select("state");
      const stateCounts = {};
      (schoolStates || []).forEach((s) => {
        stateCounts[s.state] = (stateCounts[s.state] || 0) + 1;
      });
      const topStates = Object.entries(stateCounts).sort((a, b) => b[1] - a[1]).slice(0, 10);

      const [{ count: total }, { count: withEmail }, { count: withCell }, { count: publicCount }] = await Promise.all([
        supabase.from("schools").select("*", { count: "exact", head: true }),
        supabase.from("schools").select("*", { count: "exact", head: true }).not("hc_email", "is", null).neq("hc_email", ""),
        supabase.from("schools").select("*", { count: "exact", head: true }).not("hc_cell", "is", null).neq("hc_cell", ""),
        supabase.from("schools").select("*", { count: "exact", head: true }).eq("school_type", "Public"),
      ]);

      let assigned = 0;
      let contacted = 0;
      let watch = 0;
      let totalMiles = 0;
      let totalReimbursement = 0;
      let tripsWithMiles = 0;
      let territoryCoverage = [];
      let monthlyTrend = [];
      let outreachEffectiveness = [];
      let activityRows = [];
      let staffNames = {};

      if (college?.id) {
        const [{ count: assignedCount }, { count: contactedCount }, { count: watchCount }] = await Promise.all([
          supabase.from("coach_assignments").select("*", { count: "exact", head: true }).eq("college_id", college.id),
          supabase.from("contact_logs").select("*", { count: "exact", head: true }).eq("college_id", college.id),
          supabase.from("watchlist_items").select("*", { count: "exact", head: true }).eq("college_id", college.id),
        ]);
        assigned = assignedCount || 0;
        contacted = contactedCount || 0;
        watch = watchCount || 0;

        const { data: trips } = await supabase
          .from("trips")
          .select("actual_miles,start_date")
          .eq("college_id", college.id)
          .not("actual_miles", "is", null);
        (trips || []).forEach((t) => {
          const miles = Number(t.actual_miles) || 0;
          totalMiles += miles;
          totalReimbursement += miles * mileageRateForDate(t.start_date);
          tripsWithMiles += 1;
        });

        // Coverage by named territory: for each territory, how many schools
        // fall in its states vs. how many of those this college has actually
        // logged a contact against. Two lightweight passes -- one count
        // query per territory for the denominator, one shared query for all
        // of this college's contacted schools (joined to state) for the
        // numerator -- rather than a query per territory for both sides.
        const { data: territories } = await supabase
          .from("territories")
          .select("id,name,states")
          .eq("college_id", college.id)
          .order("created_at", { ascending: true });

        if (territories?.length) {
          const { data: contactedSchools } = await supabase
            .from("contact_logs")
            .select("school_id, schools(state)")
            .eq("college_id", college.id);

          const contactedIdsByState = {};
          (contactedSchools || []).forEach((row) => {
            const st = row.schools?.state;
            if (!st) return;
            (contactedIdsByState[st] = contactedIdsByState[st] || new Set()).add(row.school_id);
          });

          territoryCoverage = await Promise.all(
            territories.map(async (t) => {
              const { count: schoolsInTerritory } = await supabase
                .from("schools")
                .select("*", { count: "exact", head: true })
                .in("state", t.states || []);
              const contactedInTerritory = (t.states || []).reduce((sum, st) => {
                return sum + (contactedIdsByState[st]?.size || 0);
              }, 0);
              return {
                id: t.id,
                name: t.name,
                states: t.states || [],
                total: schoolsInTerritory || 0,
                contacted: contactedInTerritory,
              };
            })
          );
        }

        // Activity trend + outreach-type effectiveness + staff leaderboard --
        // all derived from this college's own contact_logs, fetched once and
        // sliced client-side (small dataset for a program-sized team) so the
        // leaderboard's date-range selector doesn't need a fresh query.
        const [{ data: logs }, { data: profileRows }, { data: statusRows }] = await Promise.all([
          supabase
            .from("contact_logs")
            .select("id,school_id,contact_type,contact_date,logged_by")
            .eq("college_id", college.id),
          supabase.from("profiles").select("id,full_name").eq("college_id", college.id),
          supabase
            .from("prospect_recruiting_status")
            .select("status, prospects(school_id)")
            .eq("college_id", college.id)
            .in("status", ["offered", "committed"]),
        ]);
        activityRows = logs || [];
        (profileRows || []).forEach((p) => {
          staffNames[p.id] = p.full_name;
        });

        // Monthly trend -- last 6 months, total + per contact_type.
        const now = new Date();
        const months = [];
        for (let i = 5; i >= 0; i--) {
          const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
          months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
        }
        const byMonth = {};
        months.forEach((k) => {
          byMonth[k] = { key: k, label: monthLabel(k), total: 0, byType: {} };
        });
        activityRows.forEach((row) => {
          if (!row.contact_date) return;
          const k = monthKey(row.contact_date);
          if (!byMonth[k]) return; // outside the 6-month window
          byMonth[k].total += 1;
          byMonth[k].byType[row.contact_type] = (byMonth[k].byType[row.contact_type] || 0) + 1;
        });
        monthlyTrend = months.map((k) => byMonth[k]);

        // Outreach-type effectiveness -- a proxy, not strict attribution:
        // of the schools this college contacted via each channel, how many
        // now have a prospect this college has marked Offered/Committed.
        const engagedSchoolIds = new Set();
        (statusRows || []).forEach((r) => {
          if (r.prospects?.school_id) engagedSchoolIds.add(r.prospects.school_id);
        });
        const schoolsByType = {};
        activityRows.forEach((row) => {
          const t = row.contact_type || "Other";
          (schoolsByType[t] = schoolsByType[t] || new Set()).add(row.school_id);
        });
        outreachEffectiveness = Object.entries(schoolsByType)
          .map(([type, schoolSet]) => {
            let engaged = 0;
            schoolSet.forEach((sid) => {
              if (engagedSchoolIds.has(sid)) engaged += 1;
            });
            return { type, schoolsContacted: schoolSet.size, engaged, pct: schoolSet.size ? Math.round((engaged / schoolSet.size) * 100) : 0 };
          })
          .sort((a, b) => b.schoolsContacted - a.schoolsContacted);
      }

      setData({
        topStates,
        total,
        withEmail,
        withCell,
        publicCount,
        assigned,
        contacted,
        watch,
        totalMiles,
        totalReimbursement,
        tripsWithMiles,
        territoryCoverage,
        monthlyTrend,
        outreachEffectiveness,
        activityRows,
        staffNames,
      });
    }
    load();
  }, [supabase, college]);

  const staffLeaderboard = useMemo(() => {
    if (!data) return [];
    const cutoff = leaderboardDays ? Date.now() - leaderboardDays * 24 * 60 * 60 * 1000 : null;
    const byStaff = {};
    (data.activityRows || []).forEach((row) => {
      if (cutoff && row.contact_date && new Date(row.contact_date).getTime() < cutoff) return;
      const key = row.logged_by || "unknown";
      if (!byStaff[key]) {
        byStaff[key] = { id: key, name: data.staffNames?.[key] || "Unknown", total: 0, byType: {}, schools: new Set() };
      }
      byStaff[key].total += 1;
      byStaff[key].byType[row.contact_type] = (byStaff[key].byType[row.contact_type] || 0) + 1;
      byStaff[key].schools.add(row.school_id);
    });
    return Object.values(byStaff)
      .map((s) => ({ ...s, schoolCount: s.schools.size }))
      .sort((a, b) => b.total - a.total);
  }, [data, leaderboardDays]);

  if (!data) return <div className="view"><div className="empty-state">Loading reports…</div></div>;

  const maxStateCount = Math.max(...data.topStates.map((s) => s[1]), 1);

  return (
    <div className="view">
      <div className="view-header">
        <div>
          <h1>Reports</h1>
          <p>Live coverage and activity, computed from the production database</p>
        </div>
      </div>

      <div className="grid grid-2" style={{ marginBottom: 14 }}>
        <div className="card">
          <h3>Schools by State (top 10)</h3>
          {data.topStates.map(([state, count]) => (
            <div key={state} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
              <div style={{ width: 32, fontSize: 12, fontWeight: 700 }}>{state}</div>
              <div style={{ flex: 1, background: "#eef0f3", borderRadius: 4, height: 14 }}>
                <div style={{ width: `${(count / maxStateCount) * 100}%`, background: "#0b1f3a", height: "100%", borderRadius: 4 }} />
              </div>
              <div style={{ width: 50, fontSize: 12, textAlign: "right" }}>{count.toLocaleString()}</div>
            </div>
          ))}
        </div>
        <div className="card">
          <h3>Contact Field Coverage</h3>
          <div className="kv">
            <div className="k">Total schools</div>
            <div className="v">{data.total.toLocaleString()}</div>
            <div className="k">With head coach email</div>
            <div className="v">{data.withEmail.toLocaleString()} ({Math.round((data.withEmail / data.total) * 100)}%)</div>
            <div className="k">With head coach cell</div>
            <div className="v">{data.withCell.toLocaleString()} ({Math.round((data.withCell / data.total) * 100)}%)</div>
            <div className="k">Public schools</div>
            <div className="v">{data.publicCount.toLocaleString()} ({Math.round((data.publicCount / data.total) * 100)}%)</div>
          </div>
        </div>
      </div>

      <div className="card">
        <h3>Your College&apos;s Territory Coverage</h3>
        <div className="kv">
          <div className="k">Assigned</div>
          <div className="v">{data.assigned}</div>
          <div className="k">Contacted</div>
          <div className="v">{data.contacted}</div>
          <div className="k">Watchlist</div>
          <div className="v">{data.watch}</div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <h3>Recruiting Coverage by Territory</h3>
        {data.territoryCoverage.length ? (
          <div className="table-wrap" style={{ boxShadow: "none", border: "none" }}>
            <table>
              <thead>
                <tr>
                  <th>Territory</th>
                  <th>States</th>
                  <th>Schools</th>
                  <th>Contacted</th>
                  <th>Coverage</th>
                </tr>
              </thead>
              <tbody>
                {data.territoryCoverage.map((t) => {
                  const pct = t.total ? Math.round((t.contacted / t.total) * 100) : 0;
                  return (
                    <tr key={t.id}>
                      <td>{t.name}</td>
                      <td>{t.states.join(", ")}</td>
                      <td>{t.total.toLocaleString()}</td>
                      <td>{t.contacted.toLocaleString()}</td>
                      <td>{pct}%</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty-state">
            No territories set up yet. Create one on the Territories page to see coverage broken out by region here.
          </div>
        )}
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <h3>Activity Trend (Last 6 Months)</h3>
        {data.monthlyTrend.some((m) => m.total > 0) ? (
          <>
            <div style={{ display: "flex", alignItems: "flex-end", gap: 14, height: 130, marginBottom: 10, paddingTop: 6 }}>
              {data.monthlyTrend.map((m) => {
                const max = Math.max(...data.monthlyTrend.map((x) => x.total), 1);
                return (
                  <div key={m.key} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "flex-end", height: "100%" }}>
                    <div style={{ fontSize: 11, fontWeight: 700, marginBottom: 4 }}>{m.total || ""}</div>
                    <div
                      style={{
                        width: "100%",
                        maxWidth: 42,
                        height: `${Math.max((m.total / max) * 100, m.total ? 4 : 0)}%`,
                        background: "#0b1f3a",
                        borderRadius: "4px 4px 0 0",
                      }}
                    />
                    <div style={{ fontSize: 11, color: "#697386", marginTop: 6 }}>{m.label}</div>
                  </div>
                );
              })}
            </div>
            <div className="table-wrap" style={{ boxShadow: "none", border: "none" }}>
              <table>
                <thead>
                  <tr>
                    <th>Month</th>
                    {CONTACT_TYPES.map((t) => (
                      <th key={t}>{t}</th>
                    ))}
                    <th>Total</th>
                  </tr>
                </thead>
                <tbody>
                  {data.monthlyTrend.map((m) => (
                    <tr key={m.key}>
                      <td>{m.label}</td>
                      {CONTACT_TYPES.map((t) => (
                        <td key={t}>{m.byType[t] || 0}</td>
                      ))}
                      <td style={{ fontWeight: 700 }}>{m.total}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : (
          <div className="empty-state">No contact activity logged yet — trends will appear here once you start logging calls, emails, texts, or visits.</div>
        )}
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <h3>Outreach-Type Effectiveness</h3>
        {data.outreachEffectiveness.length ? (
          <>
            <div className="table-wrap" style={{ boxShadow: "none", border: "none" }}>
              <table>
                <thead>
                  <tr>
                    <th>Contact Type</th>
                    <th>Schools Contacted</th>
                    <th>Now Offered/Committed</th>
                    <th>Rate</th>
                  </tr>
                </thead>
                <tbody>
                  {data.outreachEffectiveness.map((row) => (
                    <tr key={row.type}>
                      <td>{row.type}</td>
                      <td>{row.schoolsContacted}</td>
                      <td>{row.engaged}</td>
                      <td>{row.pct}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="notice" style={{ marginTop: 10, fontSize: 11.5 }}>
              A proxy signal, not strict cause-and-effect: for each contact type, the share of schools you reached that way which now have at least one prospect your program has marked Offered or Committed on the Recruiting CRM.
            </div>
          </>
        ) : (
          <div className="empty-state">No contact activity logged yet.</div>
        )}
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
          <h3 style={{ margin: 0 }}>Staff Activity Leaderboard</h3>
          <select value={leaderboardDays ?? "all"} onChange={(e) => setLeaderboardDays(e.target.value === "all" ? null : Number(e.target.value))} style={{ width: 170 }}>
            {LEADERBOARD_RANGES.map((r) => (
              <option key={r.label} value={r.days ?? "all"}>
                {r.label}
              </option>
            ))}
          </select>
        </div>
        {staffLeaderboard.length ? (
          <div className="table-wrap" style={{ boxShadow: "none", border: "none", marginTop: 10 }}>
            <table>
              <thead>
                <tr>
                  <th>Staff</th>
                  <th>Total Contacts</th>
                  <th>Schools Touched</th>
                  {CONTACT_TYPES.map((t) => (
                    <th key={t}>{t}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {staffLeaderboard.map((s) => (
                  <tr key={s.id}>
                    <td>{s.name}</td>
                    <td style={{ fontWeight: 700 }}>{s.total}</td>
                    <td>{s.schoolCount}</td>
                    {CONTACT_TYPES.map((t) => (
                      <td key={t}>{s.byType[t] || 0}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty-state" style={{ marginTop: 10 }}>No contact activity in this range.</div>
        )}
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <h3>Recruiting Trip Mileage</h3>
        {data.tripsWithMiles ? (
          <div className="kv">
            <div className="k">Trips with mileage logged</div>
            <div className="v">{data.tripsWithMiles}</div>
            <div className="k">Total actual miles</div>
            <div className="v">{data.totalMiles.toLocaleString(undefined, { maximumFractionDigits: 0 })} mi</div>
            <div className="k">Est. total reimbursement</div>
            <div className="v">${data.totalReimbursement.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
          </div>
        ) : (
          <div className="empty-state">No trips have actual mileage logged yet. Log it from any trip&apos;s detail page after you drive it.</div>
        )}
        <div className="notice" style={{ marginTop: 10, fontSize: 11.5 }}>
          Reimbursement estimate uses the IRS standard mileage rate in effect on each trip&apos;s start date — reference only, not tax advice.
        </div>
      </div>
    </div>
  );
}
