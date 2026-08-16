"use client";import{useEffect as _,useState as i,useCallback as y}from"react";import{useParams as T,useRouter as k}from"next/navigation";import D from"next/link";import{getSupabaseBrowserClient as S}from"@/lib/supabase/client";import"@/lib/auth-context";const w={planning:"Planning",active:"Active",completed:"Completed"};export default function B(){const{id:s}=T(),p=k(),n=S(),[a,u]=i(null),[o,g]=i([]),[f,h]=i(!0),[d,r]=i(!1),[l,c]=i(""),m=y(async()=>{const{data:e}=await n.from("trips").select("*").eq("id",s).maybeSingle();if(u(e||null),e){const{data:t}=await n.from("trip_stops").select("*, schools(id,name,city,state,hc_first_name,hc_last_name,hc_email,hc_cell,addr1)").eq("trip_id",s).order("day_number",{ascending:!0}).order("sequence_order",{ascending:!0});g(t||[])}h(!1)},[n,s]);_(()=>{m()},[m]);async function N(){if(!confirm(`Delete "${a.name}"? This cannot be undone.`))return;c(""),r(!0);const{error:e}=await n.from("trips").delete().eq("id",s);if(r(!1),e){c(e.message);return}p.push("/trips")}if(f)return<div className="view"><div className="empty-state">Loading trip…</div></div>;if(!a)return<div className="view"><div className="notice danger">Trip not found.</div></div>;const v=o.reduce((e,t)=>((e[t.day_number]=e[t.day_number]||[]).push(t),e),{}),b=Object.keys(v).map(Number).sort((e,t)=>e-t);return<div className="view">
      <D href="/trips"className="btn btn-sm"style={{marginBottom:12,display:"inline-flex"}}>← Back to Trips</D>
      <div className="view-header">
        <div>
          <h1>{a.name}</h1>
          <p>
            {a.start_date||"No dates set"}{a.end_date&&a.end_date!==a.start_date?` – ${a.end_date}`:""}
            {" · "}{o.length} school{o.length===1?"":"s"}
          </p>
        </div>
        <span className="badge badge-contacted">{w[a.status]||a.status}</span>
      </div>

      <div className="grid grid-2">
        <div>
          <div className="card"style={{marginBottom:14}}>
            <h3>Trip Details</h3>
            <div className="kv">
              <div className="k">Starting from</div><div className="v">{a.start_location||"—"}</div>
              <div className="k">Ending at</div><div className="v">{a.end_location||"—"}</div>
            </div>
          </div>

          <div className="card">
            <h3>Schools on this Trip</h3>
            {o.length?b.map(e=><div key={e}style={{marginBottom:14}}>
                  <div style={{fontSize:12,fontWeight:700,color:"#697386",textTransform:"uppercase",marginBottom:6}}>Day {e}</div>
                  {v[e].map(t=><div className="log-item"key={t.id}>
                      <strong>{t.schools?.name}</strong> — {t.schools?.city}, {t.schools?.state}
                      {t.is_fixed_appointment&&<span className="badge badge-unverified"style={{marginLeft:8}}>Fixed{t.appointment_time?`: ${t.appointment_time}`:""}</span>}
                    </div>)}
                </div>):<div className="empty-state">No schools added yet. School selection and route optimization are coming in the next build session.</div>}
          </div>
        </div>

        <div>
          <div className="card">
            <h3>Danger Zone</h3>
            {l&&<div className="notice danger"style={{marginBottom:10}}>{l}</div>}
            <button className="btn btn-sm btn-danger"onClick={N}disabled={d}>
              {d?"Deleting…":"Delete Trip"}
            </button>
          </div>
        </div>
      </div>
    </div>}