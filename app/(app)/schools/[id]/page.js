"use client";import{useEffect as V,useState as l,useCallback as G}from"react";import{useParams as H,useRouter as Y}from"next/navigation";import{getSupabaseBrowserClient as J}from"@/lib/supabase/client";import{useAuth as K}from"@/lib/auth-context";function b(i){if(!i)return"";const c=i.replace(/\D/g,"");return c.length===10?`(${c.slice(0,3)}) ${c.slice(3,6)}-${c.slice(6)}`:i}function Q(i){if(!i)return null;const c=i.trim();return c?/^https?:\/\//i.test(c)?c:`https://${c}`:null}const X={pending:"Pending review",approved:"Approved — now live",rejected:"Not approved"};export default function Z(){const{id:i}=H(),c=Y(),s=J(),{college:o,user:d}=K(),[t,x]=l(null),[f,T]=l([]),[q,D]=l(null),[h,L]=l(!1),[y,$]=l([]),[v,u]=l({contact_type:"Call",note:"",contact_date:new Date().toISOString().slice(0,10)}),[_,N]=l(""),[A,E]=l(!0),[p,w]=l(!1),[n,r]=l({hc_first_name:"",hc_last_name:"",hc_email:"",hc_cell:"",hc_office:"",note:""}),[g,F]=l(null),[C,S]=l(!1),[k,B]=l(""),m=G(async()=>{const{data:e}=await s.from("schools").select("*").eq("id",i).maybeSingle();if(x(e),e&&r({hc_first_name:e.hc_first_name||"",hc_last_name:e.hc_last_name||"",hc_email:e.hc_email||"",hc_cell:e.hc_cell||"",hc_office:e.hc_office||"",note:""}),d?.id){const{data:a}=await s.from("school_edit_suggestions").select("*").eq("school_id",i).eq("suggested_by",d.id).order("created_at",{ascending:!1}).limit(1).maybeSingle();F(a||null)}if(o?.id){const[{data:a},{data:j},{data:z},{data:U}]=await Promise.all([s.from("contact_logs").select("*").eq("college_id",o.id).eq("school_id",i).order("created_at",{ascending:!1}),s.from("coach_assignments").select("*").eq("college_id",o.id).eq("school_id",i).maybeSingle(),s.from("watchlist_items").select("*").eq("college_id",o.id).eq("school_id",i).maybeSingle(),s.from("school_notes").select("*").eq("college_id",o.id).eq("school_id",i).order("created_at",{ascending:!1})]);T(a||[]),D(j||null),L(!!z),$(U||[])}E(!1)},[s,i,o,d]);V(()=>{m()},[m]);async function I(){o?.id&&(h?await s.from("watchlist_items").delete().eq("college_id",o.id).eq("school_id",i):await s.from("watchlist_items").insert({college_id:o.id,school_id:i,added_by:d.id}),m())}async function P(){o?.id&&(await s.from("coach_assignments").upsert({college_id:o.id,school_id:i,assigned_to:d.id,assigned_by:d.id},{onConflict:"college_id,school_id"}),m())}async function O(e){e.preventDefault(),o?.id&&(await s.from("contact_logs").insert({college_id:o.id,school_id:i,logged_by:d.id,contact_type:v.contact_type,note:v.note,contact_date:v.contact_date}),u({contact_type:"Call",note:"",contact_date:new Date().toISOString().slice(0,10)}),m())}async function W(e){e.preventDefault(),!(!o?.id||!_.trim())&&(await s.from("school_notes").insert({college_id:o.id,school_id:i,written_by:d.id,note:_.trim()}),N(""),m())}async function M(e){e.preventDefault(),B(""),S(!0);try{const{error:a}=await s.from("school_edit_suggestions").insert({school_id:i,suggested_by:d.id,suggested_by_college_id:o?.id||null,hc_first_name:n.hc_first_name.trim()||null,hc_last_name:n.hc_last_name.trim()||null,hc_email:n.hc_email.trim()||null,hc_cell:n.hc_cell.trim()||null,hc_office:n.hc_office.trim()||null,note:n.note.trim()||null});if(a)throw a;w(!1),m()}catch(a){B(a.message||"Could not submit correction.")}finally{S(!1)}}const R=o?.name||"your college";return A?<div className="view"><div className="empty-state">Loading school profile…</div></div>:t?<div className="view">
      <button className="btn btn-sm"style={{marginBottom:12}}onClick={()=>c.back()}>← Back</button>
      <div className="view-header">
        <div><h1>{t.name}</h1><p>{t.city}, {t.state} {t.zip} · {t.school_type} {t.classification?`· ${t.classification}`:""}</p></div>
      </div>

      <div className="grid grid-2">
        <div>
          <div className="card"style={{marginBottom:14}}>
            <h3>Verification</h3>
            <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:6}}>
              <span className="badge badge-unverified">{t.verification_status==="verified"?"Verified":"Not yet verified"}</span>
              <span style={{fontSize:12,color:"#697386"}}>{t.confidence_score}% data completeness</span>
            </div>
            <div className="notice">Source: {t.source||"CSD Master Coaches Database"}.</div>
          </div>

          <div className="card"style={{marginBottom:14}}>
            <h3>School Info</h3>
            <div className="kv">
              <div className="k">Address</div><div className="v">{t.addr1}{t.addr2?`, ${t.addr2}`:""}</div>
              <div className="k">County</div><div className="v">{t.county}</div>
              <div className="k">Main phone</div><div className="v">{b(t.phone)||"—"}</div>
              <div className="k">Website</div><div className="v">{t.website?<a href={Q(t.website)}target="_blank"rel="noopener noreferrer">{t.website}</a>:"—"}</div>
              <div className="k">Classification</div><div className="v">{t.classification||"—"}</div>
            </div>
          </div>

          <div className="card">
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4}}>
              <h3 style={{margin:0}}>Head Football Coach</h3>
              <button className="btn btn-sm"onClick={()=>w(e=>!e)}>
                {p?"Cancel":"Suggest a correction"}
              </button>
            </div>
            <div className="kv"style={{marginTop:10}}>
              <div className="k">Name</div><div className="v">{t.hc_first_name||t.hc_last_name?`${t.hc_first_name} ${t.hc_last_name}`:<span className="empty-state">not on file</span>}</div>
              <div className="k">Email</div><div className="v">{t.hc_email||<span className="empty-state">not on file</span>}</div>
              <div className="k">Cell</div><div className="v">{b(t.hc_cell)||<span className="empty-state">not on file</span>}</div>
              <div className="k">Office</div><div className="v">{b(t.hc_office)||<span className="empty-state">not on file</span>}</div>
            </div>

            {g&&!p&&<div className={`notice ${g.status==="rejected"?"danger":"info"}`}style={{marginTop:12}}>
                Your last suggested correction ({new Date(g.created_at).toLocaleDateString()}): {X[g.status]}
                {g.review_note?` — "${g.review_note}"`:""}
              </div>}

            {p&&<form onSubmit={M}style={{marginTop:14,borderTop:"1px solid #eef0f3",paddingTop:12}}>
                <div className="notice"style={{marginBottom:10}}>
                  Corrections are reviewed by our verification staff before they go live, so the whole database stays accurate.
                </div>
                {k&&<div className="notice danger"style={{marginBottom:10}}>{k}</div>}
                <div className="grid grid-2"style={{marginBottom:8}}>
                  <div className="form-field">
                    <label>First name</label>
                    <input value={n.hc_first_name}onChange={e=>r(a=>({...a,hc_first_name:e.target.value}))}/>
                  </div>
                  <div className="form-field">
                    <label>Last name</label>
                    <input value={n.hc_last_name}onChange={e=>r(a=>({...a,hc_last_name:e.target.value}))}/>
                  </div>
                  <div className="form-field">
                    <label>Email</label>
                    <input type="email"value={n.hc_email}onChange={e=>r(a=>({...a,hc_email:e.target.value}))}/>
                  </div>
                  <div className="form-field">
                    <label>Cell</label>
                    <input value={n.hc_cell}onChange={e=>r(a=>({...a,hc_cell:e.target.value}))}/>
                  </div>
                  <div className="form-field">
                    <label>Office</label>
                    <input value={n.hc_office}onChange={e=>r(a=>({...a,hc_office:e.target.value}))}/>
                  </div>
                </div>
                <div className="form-field">
                  <label>Why the change? (optional)</label>
                  <input value={n.note}onChange={e=>r(a=>({...a,note:e.target.value}))}placeholder="New head coach hired May 2026…"/>
                </div>
                <button className="btn btn-gold btn-sm"disabled={C}>{C?"Submitting…":"Submit correction"}</button>
              </form>}
          </div>
        </div>

        <div>
          <div className="card"style={{marginBottom:14}}>
            <h3>Territory &amp; Outreach ({R})</h3>
            <div style={{display:"flex",gap:8,marginBottom:10,flexWrap:"wrap"}}>
              <button className="btn btn-sm btn-primary"onClick={P}>{q?"Reassign to me":"Assign to me"}</button>
              <button className={`btn btn-sm ${h?"btn-danger":""}`}onClick={I}>{h?"Remove from watchlist":"Add to watchlist"}</button>
            </div>
            {f[0]&&<div className="notice info"style={{marginBottom:8}}>
                Last contact logged by a staff member on {f[0].contact_date} — visible to your whole college to prevent duplicate outreach.
              </div>}
            <form onSubmit={O}style={{marginBottom:10}}>
              <div className="grid grid-2"style={{marginBottom:8}}>
                <div className="form-field">
                  <label>Type</label>
                  <select value={v.contact_type}onChange={e=>u(a=>({...a,contact_type:e.target.value}))}>
                    <option>Call</option><option>Email</option><option>Text</option><option>Visit</option><option>Evaluation</option>
                  </select>
                </div>
                <div className="form-field">
                  <label>Date</label>
                  <input type="date"value={v.contact_date}onChange={e=>u(a=>({...a,contact_date:e.target.value}))}/>
                </div>
              </div>
              <div className="form-field">
                <label>Note</label>
                <input value={v.note}onChange={e=>u(a=>({...a,note:e.target.value}))}placeholder="Spoke with coach about prospects…"/>
              </div>
              <button className="btn btn-gold btn-sm">Log Contact</button>
            </form>
            {f.length?f.map(e=><div className="log-item"key={e.id}><span className="when">{e.contact_date}</span><strong>{e.contact_type}</strong>{e.note?`: ${e.note}`:""}</div>):<div className="empty-state">No contact logged yet.</div>}
          </div>

          <div className="card">
            <h3>Private Notes (visible to your college only)</h3>
            <form onSubmit={W}style={{marginBottom:10,display:"flex",gap:8}}>
              <input style={{flex:1,border:"1px solid #dde1e7",borderRadius:7,padding:"7px 9px"}}value={_}onChange={e=>N(e.target.value)}placeholder="Add a note…"/>
              <button className="btn btn-sm btn-primary">Add</button>
            </form>
            {y.length?y.map(e=><div className="log-item"key={e.id}><span className="when">{new Date(e.created_at).toLocaleDateString()}</span>{e.note}</div>):<div className="empty-state">No notes yet.</div>}
          </div>
        </div>
      </div>
    </div>:<div className="view"><div className="notice danger">School not found.</div></div>}