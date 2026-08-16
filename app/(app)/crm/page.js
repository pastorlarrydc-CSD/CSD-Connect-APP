"use client";import{useEffect as N,useState as n,useCallback as b}from"react";import{useRouter as w}from"next/navigation";import{getSupabaseBrowserClient as y}from"@/lib/supabase/client";import{useAuth as C}from"@/lib/auth-context";export default function L(){const a=y(),m=w(),{college:s}=C(),[r,h]=n([]),[c,u]=n({assigned:0,logged:0,watch:0}),[v,g]=n(!0),d=b(async()=>{if(!s?.id){g(!1);return}const{data:t}=await a.from("coach_assignments").select("*, schools(id,name,state)").eq("college_id",s.id),o=(t||[]).map(e=>e.school_id);let i={};if(o.length){const{data:e}=await a.from("contact_logs").select("school_id, contact_date, contact_type").eq("college_id",s.id).in("school_id",o).order("created_at",{ascending:!1});(e||[]).forEach(l=>{i[l.school_id]||(i[l.school_id]=l)})}const[{count:_},{count:f}]=await Promise.all([a.from("contact_logs").select("*",{count:"exact",head:!0}).eq("college_id",s.id),a.from("watchlist_items").select("*",{count:"exact",head:!0}).eq("college_id",s.id)]);h((t||[]).map(e=>({...e,lastLog:i[e.school_id]}))),u({assigned:t?.length||0,logged:_||0,watch:f||0}),g(!1)},[a,s]);N(()=>{d()},[d]);async function p(t){await a.from("coach_assignments").delete().eq("college_id",s.id).eq("school_id",t),d()}return<div className="view">
      <div className="view-header"><div><h1>Recruiting CRM</h1><p>{s?.name||"Your college"} territory, contact history, and watchlist</p></div></div>
      <div className="grid grid-3"style={{marginBottom:14}}>
        <div className="card stat-card"><div className="label">Schools Assigned</div><div className="num">{c.assigned}</div></div>
        <div className="card stat-card"><div className="label">Logged Contacts</div><div className="num">{c.logged}</div></div>
        <div className="card stat-card"><div className="label">Watchlist</div><div className="num">{c.watch}</div></div>
      </div>
      <div className="table-wrap">
        <table>
          <thead><tr><th>School</th><th>State</th><th>Last Contact</th><th>Status</th><th/></tr></thead>
          <tbody>
            {v?<tr><td colSpan={5}><div className="empty-state">Loading…</div></td></tr>:r.length?r.map(t=><tr key={t.id}onClick={()=>m.push(`/schools/${t.school_id}`)}>
                  <td><strong>{t.schools?.name}</strong></td>
                  <td>{t.schools?.state}</td>
                  <td>{t.lastLog?`${t.lastLog.contact_date} — ${t.lastLog.contact_type}`:<span className="empty-state">none logged</span>}</td>
                  <td>{t.lastLog?<span className="badge badge-contacted">Contacted</span>:<span className="badge badge-not-contacted">Pending</span>}</td>
                  <td><button className="btn btn-sm"onClick={o=>{o.stopPropagation(),p(t.school_id)}}>Unassign</button></td>
                </tr>):<tr><td colSpan={5}><div className="empty-state">No schools assigned yet. Open a school profile from Search or Map and click &quot;Assign to me.&quot;</div></td></tr>}
          </tbody>
        </table>
      </div>
    </div>}