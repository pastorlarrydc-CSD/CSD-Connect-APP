"use client";import{useEffect as O,useState as i,useCallback as W}from"react";import{useParams as X,useRouter as Z}from"next/navigation";import J from"next/link";import{getSupabaseBrowserClient as K}from"@/lib/supabase/client";import{useAuth as M}from"@/lib/auth-context";function Q(s){if(!s)return"";const l=String(s).replace(/\D/g,"");return l.length===10?`(${l.slice(0,3)}) ${l.slice(3,6)}-${l.slice(6)}`:s}const V=["submitted","reviewed","contacted"];export default function Y(){const{id:s}=X(),l=Z(),n=K(),{user:T,profile:N}=M(),[e,P]=i(null),[A,I]=i(!0),[q,k]=i(!1),[C,S]=i(""),[w,x]=i(!1),[E,L]=i(""),[u,v]=i(!1),[o,d]=i({athlete_email:"",athlete_cell:"",guardian_authorized:!1}),[h,B]=i(!1),[z,p]=i(""),[f,g]=i(!1),[c,b]=i({hudl_url:"",x_url:""}),[y,D]=i(!1),[$,_]=i(""),m=N?.role==="verifier"||N?.role==="sysadmin"||e?.submitted_by===T?.id,r=W(async()=>{const{data:t}=await n.from("prospects").select("*, schools(id,name,city,state)").eq("id",s).maybeSingle();P(t||null),I(!1)},[n,s]);O(()=>{r()},[r]);async function G(t){S(""),k(!0);const{error:a}=await n.from("prospects").update({status:t}).eq("id",s);if(k(!1),a){S(a.message);return}r()}function j(){d({athlete_email:e.athlete_email||"",athlete_cell:e.athlete_cell||"",guardian_authorized:!!e.guardian_authorized}),p(""),v(!0)}async function F(t){t.preventDefault(),p(""),B(!0);const{error:a}=await n.from("prospects").update({athlete_email:o.athlete_email.trim()||null,athlete_cell:o.athlete_cell.trim()||null,guardian_authorized:o.guardian_authorized}).eq("id",s);if(B(!1),a){p(a.message);return}v(!1),r()}function H(){b({hudl_url:e.hudl_url||"",x_url:e.x_url||""}),_(""),g(!0)}async function U(t){t.preventDefault(),_(""),D(!0);const{error:a}=await n.from("prospects").update({hudl_url:c.hudl_url.trim()||null,x_url:c.x_url.trim()||null}).eq("id",s);if(D(!1),a){_(a.message);return}g(!1),r()}async function R(){if(!confirm(`Delete ${e.athlete_name}? This cannot be undone.`))return;L(""),x(!0);const{error:t}=await n.from("prospects").delete().eq("id",s);if(x(!1),t){L(t.message);return}l.push("/prospects")}return A?<div className="view"><div className="empty-state">Loading prospect…</div></div>:e?<div className="view">
      <button className="btn btn-sm"style={{marginBottom:12}}onClick={()=>l.back()}>← Back</button>
      <div className="view-header">
        <div>
          <h1>{e.athlete_name}</h1>
          <p>
            {e.grad_year?`Class of ${e.grad_year}`:"Grad year not on file"}
            {e.position?` · ${e.position}`:""}
            {e.jersey_number?` · #${e.jersey_number}`:""}
            {e.level_of_play?` · ${e.level_of_play}`:""}
          </p>
        </div>
        <span className="badge badge-contacted">{e.status}</span>
      </div>

      <div className="grid grid-2">
        <div>
          <div className="card"style={{marginBottom:14}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4}}>
              <h3 style={{margin:0}}>Athlete Info</h3>
              {m&&!f&&<button className="btn btn-sm"onClick={H}>Edit links</button>}
            </div>
            <div className="kv"style={{marginTop:10}}>
              <div className="k">Height / Weight</div><div className="v">{e.height||"—"} {e.weight?`/ ${e.weight}`:""}</div>
              <div className="k">GPA</div><div className="v">{e.gpa??"—"}</div>
              <div className="k">Level of Play</div><div className="v">{e.level_of_play||"—"}</div>
              <div className="k">City / State</div><div className="v">{e.city||e.schools?.city||"—"}{e.state||e.schools?.state?`, ${e.state||e.schools?.state}`:""}</div>
              <div className="k">High School</div><div className="v">
                {e.schools?<J href={`/schools/${e.schools.id}`}>{e.schools.name}</J>:<span className="empty-state">not linked to a school</span>}
              </div>
              {!f&&<>
                  <div className="k">Hudl</div><div className="v">{e.hudl_url?<a href={e.hudl_url}target="_blank"rel="noopener noreferrer">{e.hudl_url}</a>:"—"}</div>
                  <div className="k">X (Twitter)</div><div className="v">{e.x_url?<a href={e.x_url}target="_blank"rel="noopener noreferrer">{e.x_url}</a>:"—"}</div>
                </>}
            </div>

            {f&&<form onSubmit={U}style={{marginTop:10,borderTop:"1px solid #eef0f3",paddingTop:12}}>
                {$&&<div className="notice danger"style={{marginBottom:10}}>{$}</div>}
                <div className="form-field">
                  <label>Hudl URL</label>
                  <input value={c.hudl_url}onChange={t=>b(a=>({...a,hudl_url:t.target.value}))}placeholder="https://www.hudl.com/profile/…"/>
                </div>
                <div className="form-field">
                  <label>X (Twitter) URL</label>
                  <input value={c.x_url}onChange={t=>b(a=>({...a,x_url:t.target.value}))}placeholder="https://x.com/username"/>
                </div>
                <div style={{display:"flex",gap:8}}>
                  <button className="btn btn-sm btn-primary"disabled={y}>{y?"Saving…":"Save"}</button>
                  <button type="button"className="btn btn-sm"onClick={()=>g(!1)}disabled={y}>Cancel</button>
                </div>
              </form>}
          </div>

          <div className="card">
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4}}>
              <h3 style={{margin:0}}>Contact Info</h3>
              {m&&!u&&<button className="btn btn-sm"onClick={j}>
                  {e.athlete_email||e.athlete_cell?"Edit":"Add email / cell"}
                </button>}
            </div>

            {!u&&!e.guardian_authorized&&<div className="notice"style={{marginBottom:10}}>Guardian authorization not confirmed for this submission — contact carefully and verify eligibility to be reached directly.</div>}

            {u?<form onSubmit={F}style={{marginTop:8}}>
                {z&&<div className="notice danger"style={{marginBottom:10}}>{z}</div>}
                <div className="form-field">
                  <label>Email</label>
                  <input type="email"value={o.athlete_email}onChange={t=>d(a=>({...a,athlete_email:t.target.value}))}placeholder="athlete@email.com"/>
                </div>
                <div className="form-field">
                  <label>Cell</label>
                  <input value={o.athlete_cell}onChange={t=>d(a=>({...a,athlete_cell:t.target.value}))}placeholder="(555) 555-5555"/>
                </div>
                <label style={{display:"flex",gap:6,alignItems:"center",fontSize:12.5,margin:"10px 0"}}>
                  <input type="checkbox"checked={o.guardian_authorized}onChange={t=>d(a=>({...a,guardian_authorized:t.target.checked}))}/>
                  Guardian authorization confirmed for contacting this athlete directly (required if under 18)
                </label>
                <div style={{display:"flex",gap:8}}>
                  <button className="btn btn-sm btn-primary"disabled={h}>{h?"Saving…":"Save"}</button>
                  <button type="button"className="btn btn-sm"onClick={()=>v(!1)}disabled={h}>Cancel</button>
                </div>
              </form>:<div className="kv">
                <div className="k">Email</div><div className="v">{e.athlete_email||<span className="empty-state">not on file</span>}</div>
                <div className="k">Cell</div><div className="v">{Q(e.athlete_cell)||<span className="empty-state">not on file</span>}</div>
                <div className="k">Guardian Auth.</div><div className="v">{e.guardian_authorized?"Confirmed":"Not confirmed"}</div>
              </div>}
          </div>
        </div>

        <div>
          <div className="card"style={{marginBottom:14}}>
            <h3>Coach Evaluation</h3>
            <p style={{margin:0,fontSize:13.5}}>{e.coach_evaluation||<span className="empty-state">No evaluation submitted.</span>}</p>
          </div>

          {m&&<div className="card"style={{marginBottom:14}}>
              <h3>Status</h3>
              {C&&<div className="notice danger"style={{marginBottom:10}}>{C}</div>}
              <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                {V.map(t=><button key={t}className={`btn btn-sm ${e.status===t?"btn-primary":""}`}disabled={q||e.status===t}onClick={()=>G(t)}>
                    {t.charAt(0).toUpperCase()+t.slice(1)}
                  </button>)}
              </div>
            </div>}

          <div className="card"style={{marginBottom:14}}>
            <h3>Submission Info</h3>
            <div className="kv">
              <div className="k">Submitted</div><div className="v">{new Date(e.created_at).toLocaleDateString()}</div>
            </div>
          </div>

          {m&&<div className="card">
              <h3>Danger Zone</h3>
              {E&&<div className="notice danger"style={{marginBottom:10}}>{E}</div>}
              <button className="btn btn-sm btn-danger"onClick={R}disabled={w}>
                {w?"Deleting…":"Delete Prospect"}
              </button>
            </div>}
        </div>
      </div>
    </div>:<div className="view"><div className="notice danger">Prospect not found.</div></div>}