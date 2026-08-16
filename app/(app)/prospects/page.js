"use client";import{useEffect as B,useState as o,useCallback as T,useRef as D}from"react";import C from"next/link";import{getSupabaseBrowserClient as E}from"@/lib/supabase/client";import{useAuth as j}from"@/lib/auth-context";const q={submitted:"Submitted",reviewed:"Reviewed",contacted:"Contacted"},I=["","FBS","FCS","D2","D3","NAIA","JUCO","Prep/Post-Grad"];export default function W(){const i=E(),{college:n,user:g,profile:r}=j(),[p,S]=o([]),[c,w]=o([]),[a,l]=o({athlete_name:"",grad_year:"",position:"",jersey_number:"",height:"",weight:"",gpa:"",athlete_email:"",athlete_cell:"",city:"",state:"",hudl_url:"",x_url:"",coach_evaluation:"",guardian_authorized:!1,level_of_play:""}),[f,d]=o(""),[u,h]=o([]),[b,m]=o(null),v=D(null),[x,k]=o(!1),[_,y]=o(""),N=r?.role==="verifier"||r?.role==="sysadmin",s=T(async()=>{if(n?.id){const{data:t}=await i.from("watchlist_items").select("*, schools(id,name,city,state)").eq("college_id",n.id);S(t||[])}const{data:e}=await i.from("prospects").select("*, schools(id,name,city,state)").order("created_at",{ascending:!1}).limit(50);w(e||[])},[i,n]);B(()=>{s()},[s]);async function P(e){await i.from("watchlist_items").delete().eq("college_id",n.id).eq("school_id",e),s()}function z(e){if(d(e),m(null),v.current&&clearTimeout(v.current),e.trim().length<2){h([]);return}v.current=setTimeout(async()=>{const{data:t}=await i.from("schools").select("id,name,city,state").ilike("name",`%${e.trim()}%`).order("name",{ascending:!0}).limit(8);h(t||[])},250)}function A(e){m(e),d(`${e.name} — ${e.city}, ${e.state}`),h([])}async function $(e){if(e.preventDefault(),y(""),!a.athlete_name.trim())return;const{error:t}=await i.from("prospects").insert({submitted_by:g.id,athlete_name:a.athlete_name,grad_year:a.grad_year?parseInt(a.grad_year,10):null,position:a.position||null,jersey_number:a.jersey_number||null,height:a.height||null,weight:a.weight||null,gpa:a.gpa?parseFloat(a.gpa):null,athlete_email:a.athlete_email||null,athlete_cell:a.athlete_cell||null,city:a.city||null,state:a.state||null,school_id:b?.id||null,level_of_play:a.level_of_play||null,hudl_url:a.hudl_url||null,x_url:a.x_url||null,coach_evaluation:a.coach_evaluation||null,guardian_authorized:a.guardian_authorized});if(t){y(t.message);return}l({athlete_name:"",grad_year:"",position:"",jersey_number:"",height:"",weight:"",gpa:"",athlete_email:"",athlete_cell:"",city:"",state:"",hudl_url:"",x_url:"",coach_evaluation:"",guardian_authorized:!1,level_of_play:""}),d(""),m(null),k(!0),s()}async function L(e){confirm("Delete this prospect? This cannot be undone.")&&(await i.from("prospects").delete().eq("id",e),s())}const R=r?.role==="hs_coach";return<div className="view">
      <div className="view-header">
        <div><h1>Prospect Management</h1><p>Submission portal for high-school coaches, and watchlist tools for college staff</p></div>
        {N&&<C href="/prospects/bulk-add"className="btn btn-sm btn-primary">Bulk Add Prospects (CSV)</C>}
      </div>
      <div className="grid grid-2">
        <div className="card">
          <h3>Submit a Prospect {R?"":<span style={{fontWeight:400,color:"#697386",fontSize:12}}>— typically used by HS coaches</span>}</h3>
          {x&&<div className="notice info"style={{marginBottom:10}}>Prospect submitted — it&apos;s now visible to college coaches below.</div>}
          {_&&<div className="notice danger"style={{marginBottom:10}}>{_}</div>}
          <form onSubmit={$}>
            <div className="grid grid-2"style={{marginBottom:10}}>
              <div className="form-field"><label>Athlete Name</label><input required value={a.athlete_name}onChange={e=>l(t=>({...t,athlete_name:e.target.value}))}/></div>
              <div className="form-field"><label>Graduation Year</label><input value={a.grad_year}onChange={e=>l(t=>({...t,grad_year:e.target.value}))}placeholder="2027"/></div>
              <div className="form-field"style={{position:"relative"}}>
                <label>School</label>
                <input value={f}onChange={e=>z(e.target.value)}placeholder="Start typing a school name…"autoComplete="off"/>
                {u.length>0&&<div style={{position:"absolute",top:"100%",left:0,right:0,zIndex:10,background:"#fff",border:"1px solid #dde1e7",borderRadius:8,boxShadow:"0 4px 14px rgba(11,31,58,.12)",maxHeight:180,overflow:"auto"}}>
                    {u.map(e=><div key={e.id}onClick={()=>A(e)}style={{padding:"7px 10px",fontSize:13,cursor:"pointer",borderBottom:"1px solid #f2f3f5"}}>
                        <strong>{e.name}</strong> <span style={{color:"#697386"}}>— {e.city}, {e.state}</span>
                      </div>)}
                  </div>}
                {!b&&f.trim().length>=2&&u.length===0&&<div style={{fontSize:11,color:"#697386",marginTop:3}}>No match yet — keep typing or leave unlinked.</div>}
              </div>
              <div className="form-field">
                <label>Level of Play</label>
                <select value={a.level_of_play}onChange={e=>l(t=>({...t,level_of_play:e.target.value}))}>
                  {I.map(e=><option key={e}value={e}>{e||"Not specified"}</option>)}
                </select>
              </div>
              <div className="form-field"><label>Position</label><input value={a.position}onChange={e=>l(t=>({...t,position:e.target.value}))}placeholder="WR"/></div>
              <div className="form-field"><label>Jersey #</label><input value={a.jersey_number}onChange={e=>l(t=>({...t,jersey_number:e.target.value}))}/></div>
              <div className="form-field"><label>Height</label><input value={a.height}onChange={e=>l(t=>({...t,height:e.target.value}))}placeholder="6'1&quot;"/></div>
              <div className="form-field"><label>Weight</label><input value={a.weight}onChange={e=>l(t=>({...t,weight:e.target.value}))}placeholder="185 lbs"/></div>
              <div className="form-field"><label>GPA</label><input value={a.gpa}onChange={e=>l(t=>({...t,gpa:e.target.value}))}placeholder="3.4"/></div>
              <div className="form-field"><label>Hudl URL</label><input value={a.hudl_url}onChange={e=>l(t=>({...t,hudl_url:e.target.value}))}/></div>
              <div className="form-field"><label>X (Twitter) URL</label><input value={a.x_url}onChange={e=>l(t=>({...t,x_url:e.target.value}))}placeholder="https://x.com/username"/></div>
              <div className="form-field"><label>Athlete Email</label><input type="email"value={a.athlete_email}onChange={e=>l(t=>({...t,athlete_email:e.target.value}))}placeholder="athlete@email.com"/></div>
              <div className="form-field"><label>Athlete Cell</label><input value={a.athlete_cell}onChange={e=>l(t=>({...t,athlete_cell:e.target.value}))}placeholder="(555) 555-5555"/></div>
              <div className="form-field"><label>City</label><input value={a.city}onChange={e=>l(t=>({...t,city:e.target.value}))}/></div>
              <div className="form-field"><label>State</label><input value={a.state}maxLength={2}onChange={e=>l(t=>({...t,state:e.target.value.toUpperCase()}))}placeholder="TX"/></div>
            </div>
            <div className="form-field"><label>Coach Evaluation</label><input value={a.coach_evaluation}onChange={e=>l(t=>({...t,coach_evaluation:e.target.value}))}placeholder="Athletic upside, coachability…"/></div>
            <label style={{display:"flex",gap:6,alignItems:"center",fontSize:12.5,margin:"10px 0"}}>
              <input type="checkbox"checked={a.guardian_authorized}onChange={e=>l(t=>({...t,guardian_authorized:e.target.checked}))}/>
              I have authorization from a parent/guardian to submit this athlete&apos;s information, including contact details (required if under 18)
            </label>
            <button className="btn btn-primary">Submit for Review</button>
          </form>
        </div>
        <div>
          <div className="card"style={{marginBottom:14}}>
            <h3>Your Watchlist</h3>
            {p.length?p.map(e=><div className="log-item"key={e.id}><strong>{e.schools?.name}</strong> — {e.schools?.city}, {e.schools?.state}
                <button className="btn btn-sm"style={{float:"right"}}onClick={()=>P(e.school_id)}>Remove</button>
              </div>):<div className="empty-state">No schools on your watchlist yet. Add from a school profile or the map.</div>}
          </div>
          <div className="card">
            <h3>Recently Submitted Prospects ({c.length})</h3>
            {c.length?c.map(e=>{const t=N||e.submitted_by===g?.id;return<div className="log-item"key={e.id}style={{display:"flex",justifyContent:"space-between",gap:8,alignItems:"flex-start"}}>
                  <C href={`/prospects/${e.id}`}style={{textDecoration:"none",color:"inherit",flex:1}}>
                    <span className="when">{q[e.status]||e.status}</span>
                    <strong>{e.athlete_name}</strong> {e.grad_year?`· Class of ${e.grad_year}`:""} {e.position?`· ${e.position}`:""} {e.level_of_play?`· ${e.level_of_play}`:""}
                    <div style={{fontSize:11.5,color:"#697386",marginTop:2}}>
                      {e.schools?.name?`${e.schools.name} · `:""}{e.city||e.schools?.city}{e.state||e.schools?.state?`, ${e.state||e.schools?.state}`:""}
                      {e.athlete_email?` · ${e.athlete_email}`:""}{e.athlete_cell?` · ${e.athlete_cell}`:""}
                    </div>
                  </C>
                  {t&&<button className="btn btn-sm btn-danger"onClick={()=>L(e.id)}>Delete</button>}
                </div>}):<div className="empty-state">No prospects submitted yet.</div>}
          </div>
        </div>
      </div>
    </div>}