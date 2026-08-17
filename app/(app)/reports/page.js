"use client";import{useEffect as w,useState as S}from"react";import{getSupabaseBrowserClient as b}from"@/lib/supabase/client";import{useAuth as y}from"@/lib/auth-context";import{mileageRateForDate as MR}from"@/lib/mileageRates";export default function x(){const e=b(),{college:s}=y(),[t,r]=S(null);if(w(()=>{async function a(){const{data:o}=await e.from("schools").select("state"),c={};(o||[]).forEach(i=>{c[i.state]=(c[i.state]||0)+1});const m=Object.entries(c).sort((i,l)=>l[1]-i[1]).slice(0,10),[{count:u},{count:g},{count:f},{count:p}]=await Promise.all([e.from("schools").select("*",{count:"exact",head:!0}),e.from("schools").select("*",{count:"exact",head:!0}).not("hc_email","is",null).neq("hc_email",""),e.from("schools").select("*",{count:"exact",head:!0}).not("hc_cell","is",null).neq("hc_cell",""),e.from("schools").select("*",{count:"exact",head:!0}).eq("school_type","Public")]);let d=0,v=0,n=0;if(s?.id){const[{count:i},{count:l},{count:N}]=await Promise.all([e.from("coach_assignments").select("*",{count:"exact",head:!0}).eq("college_id",s.id),e.from("contact_logs").select("*",{count:"exact",head:!0}).eq("college_id",s.id),e.from("watchlist_items").select("*",{count:"exact",head:!0}).eq("college_id",s.id)]);d=i||0,v=l||0,n=N||0}let mi=0,rb=0,tc=0;if(s?.id){const{data:tr}=await e.from("trips").select("actual_miles,start_date").eq("college_id",s.id).not("actual_miles","is",null);(tr||[]).forEach(j=>{const am=Number(j.actual_miles)||0;mi+=am;rb+=am*MR(j.start_date);tc+=1});}r({topStates:m,total:u,withEmail:g,withCell:f,publicCount:p,assigned:d,contacted:v,watch:n,totalMiles:mi,totalReimbursement:rb,tripsWithMiles:tc})}a()},[e,s]),!t)return<div className="view"><div className="empty-state">Loading reports…</div></div>;const h=Math.max(...t.topStates.map(a=>a[1]),1);return<div className="view">
      <div className="view-header"><div><h1>Reports</h1><p>Live coverage and activity, computed from the production database</p></div></div>
      <div className="grid grid-2"style={{marginBottom:14}}>
        <div className="card">
          <h3>Schools by State (top 10)</h3>
          {t.topStates.map(([a,o])=><div key={a}style={{display:"flex",alignItems:"center",gap:8,marginBottom:6}}>
              <div style={{width:32,fontSize:12,fontWeight:700}}>{a}</div>
              <div style={{flex:1,background:"#eef0f3",borderRadius:4,height:14}}>
                <div style={{width:`${o/h*100}%`,background:"#0b1f3a",height:"100%",borderRadius:4}}/>
              </div>
              <div style={{width:50,fontSize:12,textAlign:"right"}}>{o.toLocaleString()}</div>
            </div>)}
        </div>
        <div className="card">
          <h3>Contact Field Coverage</h3>
          <div className="kv">
            <div className="k">Total schools</div><div className="v">{t.total.toLocaleString()}</div>
            <div className="k">With head coach email</div><div className="v">{t.withEmail.toLocaleString()} ({Math.round(t.withEmail/t.total*100)}%)</div>
            <div className="k">With head coach cell</div><div className="v">{t.withCell.toLocaleString()} ({Math.round(t.withCell/t.total*100)}%)</div>
            <div className="k">Public schools</div><div className="v">{t.publicCount.toLocaleString()} ({Math.round(t.publicCount/t.total*100)}%)</div>
          </div>
        </div>
      </div>
      <div className="card">
        <h3>Your College&apos;s Territory Coverage</h3>
        <div className="kv">
          <div className="k">Assigned</div><div className="v">{t.assigned}</div>
          <div className="k">Contacted</div><div className="v">{t.contacted}</div>
          <div className="k">Watchlist</div><div className="v">{t.watch}</div>
        </div>
      </div>
      <div className="card" style={{marginTop:14}}>
        <h3>Recruiting Trip Mileage</h3>
        {t.tripsWithMiles ? (
          <div className="kv">
            <div className="k">Trips with mileage logged</div><div className="v">{t.tripsWithMiles}</div>
            <div className="k">Total actual miles</div><div className="v">{t.totalMiles.toLocaleString(undefined,{maximumFractionDigits:0})} mi</div>
            <div className="k">Est. total reimbursement</div><div className="v">${t.totalReimbursement.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</div>
          </div>
        ) : (
          <div className="empty-state">No trips have actual mileage logged yet. Log it from any trip&apos;s detail page after you drive it.</div>
        )}
        <div className="notice" style={{marginTop:10,fontSize:11.5}}>
          Reimbursement estimate uses the IRS standard mileage rate in effect on each trip&apos;s start date — reference only, not tax advice.
        </div>
      </div>
    </div>}