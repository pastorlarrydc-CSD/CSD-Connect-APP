"use client";
import { useEffect, useState } from "react";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { useAuth } from "@/lib/auth-context";
import { mileageRateForDate } from "@/lib/mileageRates";

export default function ReportsPage() {
  const supabase = getSupabaseBrowserClient();
  const { college } = useAuth();
  const [data, setData] = useState(null);

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
      });
    }
    load();
  }, [supabase, college]);

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
