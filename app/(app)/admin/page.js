"use client";import{useEffect as T,useState as n,useCallback as L,Fragment as S}from"react";import P from"next/link";import{getSupabaseBrowserClient as O}from"@/lib/supabase/client";import{useAuth as j}from"@/lib/auth-context";const q=[["College Coach / Staff","Search, map, CRM, watchlists — own college's data only"],["Athletic Director","All coaching-staff views plus program-wide reporting"],["HS Head Coach","Claim & update own school profile, submit prospects"],["Verification Staff","Edit school records, review flagged changes"],["System Admin","Full access, manage colleges and staff"]],B=[["Row-level security isolating each college's CRM data",!0],["Authentication required for all data access",!0],["Encryption in transit (HTTPS) and at rest (managed Postgres)",!0],["Every school edit keeps a change-history record",!0],["Admin approval workflow for published record changes",!0],["Multi-factor authentication enrollment (opt-in, under Account Security)",!0],["Automated verification engine (source cross-checks)",!1],["CAN-SPAM-compliant email campaign tooling",!1]],C=[["hc_first_name","First name"],["hc_last_name","Last name"],["hc_email","Email"],["hc_cell","Cell"],["hc_office","Office"]];export default function F(){const i=O(),{college:d,profile:_,user:f}=j(),[h,k]=n([]),[E,R]=n(null),[g,A]=n([]),[x,u]=n(!0),[b,r]=n(null),[w,m]=n(""),p=_?.role==="verifier"||_?.role==="sysadmin",v=L(async()=>{if(!p){u(!1);return}u(!0);const{data:e}=await i.from("school_edit_suggestions").select("*, schools(id,name,city,state,hc_first_name,hc_last_name,hc_email,hc_cell,hc_office), colleges:suggested_by_college_id(name)").eq("status","pending").order("created_at",{ascending:!0});A(e||[]),u(!1)},[i,p]);T(()=>{async function e(){if(d?.id){const{data:s}=await i.from("profiles").select("*").eq("college_id",d.id);k(s||[])}const{count:t}=await i.from("schools").select("*",{count:"exact",head:!0});R({total:t})}e(),v()},[i,d,v]);async function D(e){m(""),r(e.id);try{const t=e.schools,s={},o=[];for(const[a,y]of C){const l=e[a];if(l==null||l==="")continue;const N=t?.[a]||null;l!==N&&(s[a]=l,o.push({school_id:e.school_id,field_name:a,old_value:N,new_value:l,source:"Coach-submitted correction (approved)",changed_by:f.id}))}if(Object.keys(s).length){s.verification_status="verified",s.last_verified_at=new Date().toISOString();const{error:a}=await i.from("schools").update(s).eq("id",e.school_id);if(a)throw a;if(o.length){const{error:y}=await i.from("school_change_log").insert(o);if(y)throw y}}const{error:c}=await i.from("school_edit_suggestions").update({status:"approved",reviewed_by:f.id,reviewed_at:new Date().toISOString()}).eq("id",e.id);if(c)throw c;v()}catch(t){m(t.message||"Could not approve this correction.")}finally{r(null)}}async function I(e){m(""),r(e.id);try{const{error:t}=await i.from("school_edit_suggestions").update({status:"rejected",reviewed_by:f.id,reviewed_at:new Date().toISOString()}).eq("id",e.id);if(t)throw t;v()}catch(t){m(t.message||"Could not reject this correction.")}finally{r(null)}}return<div className="view">
      <div className="view-header"><div><h1>Administrator Controls</h1><p>Roles, security, and data governance</p></div></div>

      {p&&<div className="card"style={{marginBottom:14}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:8}}>
            <h3 style={{margin:0}}>Pending Coach-Info Corrections ({g.length})</h3>
            <P href="/admin/leads"className="btn btn-sm btn-primary"style={{marginRight:8}}>College Outreach</P><P href="/admin/data-quality"className="btn btn-sm btn-primary"style={{marginRight:8}}>Data Quality Review</P><P href="/admin/bulk-update"className="btn btn-sm btn-primary">Bulk Update Coaches (CSV)</P>
          </div>
          {w&&<div className="notice danger"style={{marginBottom:10}}>{w}</div>}
          {x?<div className="empty-state">Loading…</div>:g.length?g.map(e=><div key={e.id}className="log-item"style={{paddingBottom:12}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",flexWrap:"wrap",gap:8}}>
                <div>
                  <strong>{e.schools?.name}</strong> — {e.schools?.city}, {e.schools?.state}
                  <div style={{fontSize:12,color:"#697386",marginTop:2}}>
                    Submitted {new Date(e.created_at).toLocaleDateString()} by {e.colleges?.name||"a coach"}
                    {e.note?` — "${e.note}"`:""}
                  </div>
                </div>
                <div style={{display:"flex",gap:6}}>
                  <button className="btn btn-sm btn-primary"disabled={b===e.id}onClick={()=>D(e)}>Approve</button>
                  <button className="btn btn-sm btn-danger"disabled={b===e.id}onClick={()=>I(e)}>Reject</button>
                </div>
              </div>
              <div className="kv"style={{gridTemplateColumns:"110px 1fr 1fr",marginTop:8,fontSize:12.5}}>
                <div className="k"/><div className="k">Current</div><div className="k">Suggested</div>
                {C.map(([t,s])=>{const o=e[t];if(o==null||o==="")return null;const c=e.schools?.[t]||"—",a=o!==c;return<S key={t}>
                      <div className="k">{s}</div>
                      <div className="v"style={{fontWeight:400}}>{c}</div>
                      <div className="v"style={{color:a?"#1e7145":void 0,fontWeight:a?700:400}}>{o}</div>
                    </S>})}
              </div>
            </div>):<div className="empty-state">No pending corrections. Coach-submitted edits from school profile pages will show up here for review.</div>}
        </div>}

      <div className="grid grid-2">
        <div className="card">
          <h3>Role Reference</h3>
          <div className="kv"style={{gridTemplateColumns:"1fr 2fr"}}>
            {q.map(([e,t])=><S key={e}>
                <div className="k">{e}</div><div className="v"style={{fontWeight:400}}>{t}</div>
              </S>)}
          </div>
        </div>
        <div className="card">
          <h3>Security &amp; Governance Status</h3>
          {B.map(([e,t])=><label key={e}style={{display:"flex",gap:8,alignItems:"center",padding:"5px 0",fontSize:13,borderBottom:"1px solid #eef0f3"}}>
              <input type="checkbox"checked={t}disabled/> {e}
            </label>)}
        </div>
      </div>
      <div className="card"style={{marginTop:14}}>
        <h3>{d?.name||"Your College"} — Staff ({h.length})</h3>
        {h.length?<div className="table-wrap">
            <table>
              <thead><tr><th>Name</th><th>Role</th><th>Title</th></tr></thead>
              <tbody>{h.map(e=><tr key={e.id}><td>{e.full_name}</td><td>{e.role}</td><td>{e.title||"—"}</td></tr>)}</tbody>
            </table>
          </div>:<div className="empty-state">No staff records found.</div>}
      </div>
      <div className="card"style={{marginTop:14}}>
        <h3>Data Provenance</h3>
        <div className="kv">
          <div className="k">Source file</div><div className="v">CSD_HS_Coaches_Database_8-9-26_MASTER.csv</div>
          <div className="k">Records live</div><div className="v">{E?.total?.toLocaleString()||"…"}</div>
          <div className="k">Database</div><div className="v">Supabase (managed Postgres)</div>
        </div>
      </div>
    </div>}