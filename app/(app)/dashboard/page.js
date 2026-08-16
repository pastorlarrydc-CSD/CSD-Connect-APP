"use client";import{useEffect as R,useState as i}from"react";import N from"next/link";import{getSupabaseBrowserClient as A}from"@/lib/supabase/client";import{useAuth as B}from"@/lib/auth-context";export default function D(){const a=A(),{profile:y,college:t}=B(),[e,b]=i(null),[c,p]=i([]),[w,_]=i(!0);if(R(()=>{async function s(){const[{count:L},{count:S},{count:x}]=await Promise.all([a.from("schools").select("*",{count:"exact",head:!0}),a.from("schools").select("*",{count:"exact",head:!0}).not("hc_email","is",null).neq("hc_email",""),a.from("schools").select("*",{count:"exact",head:!0}).not("hc_cell","is",null).neq("hc_cell","")]);let o=0,l=0,d=0,n=[];if(t?.id){const[{count:k},{count:q},{count:E},{data:P}]=await Promise.all([a.from("coach_assignments").select("*",{count:"exact",head:!0}).eq("college_id",t.id),a.from("contact_logs").select("school_id",{count:"exact",head:!0}).eq("college_id",t.id),a.from("watchlist_items").select("*",{count:"exact",head:!0}).eq("college_id",t.id),a.from("contact_logs").select("*, schools(name)").eq("college_id",t.id).order("created_at",{ascending:!1}).limit(5)]);o=k||0,l=q||0,d=E||0,n=P||[]}b({total:L,withEmail:S,withCell:x,assignedCount:o,contactedCount:l,watchCount:d}),p(n),_(!1)}s()},[a,t]),w||!e)return<div className="view"><div className="empty-state">Loading dashboard…</div></div>;const C=e.total?Math.round((e.withEmail||0)/e.total*100):0;return<div className="view">
      <div className="view-header">
        <div><h1>Dashboard</h1><p>Welcome back, {y?.full_name} — {t?.name||"no college linked yet"}</p></div>
        <div style={{display:"flex",gap:8}}>
          <N href="/search"className="btn btn-gold">Search Database</N>
          <N href="/map"className="btn btn-primary">Open Territory Map</N>
        </div>
      </div>

      <div className="grid grid-4"style={{marginBottom:14}}>
        <div className="card stat-card"><div className="label">Schools Indexed</div><div className="num">{(e.total||0).toLocaleString()}</div><div className="sub">Live national database</div></div>
        <div className="card stat-card"><div className="label">Head Coach Emails</div><div className="num">{C}%</div><div className="sub">{(e.withEmail||0).toLocaleString()} schools with an email on file</div></div>
        <div className="card stat-card"><div className="label">Head Coach Cells</div><div className="num">{(e.withCell||0).toLocaleString()}</div><div className="sub">mobile numbers on file</div></div>
        <div className="card stat-card"><div className="label">Your Activity</div><div className="num">{e.contactedCount}</div><div className="sub">{e.assignedCount} assigned · {e.watchCount} watchlisted</div></div>
      </div>

      <div className="grid grid-2">
        <div className="card">
          <h3>Recent Contact Activity ({t?.name||"your college"})</h3>
          {c.length?c.map(s=><div className="log-item"key={s.id}>
              <span className="when">{s.contact_date}</span>
              <strong>{s.contact_type}</strong> with {s.schools?.name||"a school"} {s.note?`— "${s.note}"`:""}
            </div>):<div className="empty-state">No contact activity logged yet. Log calls, emails, texts and visits from any school profile.</div>}
        </div>
        <div className="card">
          <h3>Getting Started</h3>
          <div className="notice info"style={{marginBottom:8}}>Search the database, assign schools to your territory, and log outreach — all changes save to your college's private CRM instantly.</div>
          <div className="notice">Only your college's staff can see your assignments, notes, and contact history (enforced by database-level Row Level Security).</div>
        </div>
      </div>
    </div>}