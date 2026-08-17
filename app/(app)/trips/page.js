"use client";import{useEffect as _,useState as r,useCallback as b}from"react";import N from"next/link";import{getSupabaseBrowserClient as k}from"@/lib/supabase/client";import{useAuth as w}from"@/lib/auth-context";const T={planning:"Planning",active:"Active",completed:"Completed"};export default function L(){const i=k(),{college:s}=w(),[t,y]=r([]),[h,a]=r(!0),d=b(async()=>{if(!s?.id){a(!1);return}const{data:e}=await i.from("trips").select("*, trip_stops(id)").eq("college_id",s.id).order("start_date",{ascending:!0,nullsFirst:!1}).order("created_at",{ascending:!1});y(e||[]),a(!1)},[i,s]);return _(()=>{d()},[d]),<div className="view">
      <div className="view-header">
        <div><h1>Recruiting Trips</h1><p>Plan, optimize, and run multi-day recruiting trips built from your school database</p></div>
        <N href="/trips/new"className="btn btn-gold">+ New Trip</N>
      </div>

      {h?<div className="empty-state">Loading trips…</div>:t.length?<div className="grid grid-2">
          {t.map(e=><N key={e.id}href={`/trips/${e.id}`}className="card"style={{textDecoration:"none",color:"inherit",display:"block"}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
                <h3 style={{margin:0}}>{e.name}</h3>
                <span className="badge badge-contacted">{T[e.status]||e.status}</span>
              </div>
              <div className="kv"style={{marginTop:10}}>
                <div className="k">Dates</div><div className="v">{e.start_date||"—"}{e.end_date&&e.end_date!==e.start_date?` – ${e.end_date}`:""}</div>
                <div className="k">Stops</div><div className="v">{e.trip_stops?.length||0} school{e.trip_stops?.length===1?"":"s"}</div>
                <div className="k">Starting from</div><div className="v">{e.start_location||"—"}</div>{e.actual_miles!=null?<><div className="k">Actual mileage</div><div className="v">{Number(e.actual_miles).toFixed(0)} mi</div></>:null}
              </div>
            </N>)}
        </div>:<div className="card"><div className="empty-state">No recruiting trips yet. Click &quot;New Trip&quot; to build your first optimized route.</div></div>}
    </div>}