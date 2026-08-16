"use client";import{useState as h,useCallback as ne,useRef as Re}from"react";import _e from"next/link";import I from"papaparse";import{getSupabaseBrowserClient as $e}from"@/lib/supabase/client";import{useAuth as je}from"@/lib/auth-context";const Be=["athlete_name","grad_year","position","jersey_number","height","weight","gpa","athlete_email","athlete_cell","city","state","school_id","school_name","level_of_play","hudl_url","x_url","coach_evaluation","guardian_authorized"],U=300,Te=new Set(["true","yes","y","1"]),Ae={athlete_name:["athlete name","name","player name","prospect name"],grad_year:["graduation year","grad year","class of","class","grad"],school_id:["school id"],school_name:["school","school name","high school","hs","hs name"],level_of_play:["level of play","level","division","lop"],position:["position","pos"],jersey_number:["jersey","jersey number","jersey no","number","no","jersey #"],height:["height","ht"],weight:["weight","wt"],gpa:["gpa"],hudl_url:["hudl url","hudl","hudl link","film","film link"],x_url:["x url","x","twitter","twitter url","twitter link","x link","x (twitter) url"],athlete_email:["athlete email","email","email address"],athlete_cell:["athlete cell","cell","phone","mobile","cell phone","phone number"],city:["city"],state:["state","st"],coach_evaluation:["coach evaluation","evaluation","notes","comments","coach notes"],guardian_authorized:["guardian authorized","guardian_authorized","parent authorized","guardian auth","authorized"]};function P(n){return String(n||"").trim().toLowerCase().replace(/[^a-z0-9]+/g," ").trim()}const ve=(()=>{const n={};return Object.entries(Ae).forEach(([r,g])=>{n[P(r)]=r,g.forEach(w=>{n[P(w)]=r})}),n})();function Ie(n){const r=P(n);return ve[r]?ve[r]:r.replace(/\s+/g,"_")}function l(n){return n==null?"":String(n).trim()}const Ue=["junior senior high school","jr sr high school","senior high school","junior high school","middle high school","high school","senior high","junior high","high","hs"];function be(n){let r=String(n||"").toLowerCase().replace(/['’.]/g,"").replace(/[^a-z0-9]+/g," ").trim();for(const g of Ue){if(r===g){r="";break}if(r.endsWith(" "+g)){r=r.slice(0,r.length-g.length-1).trim();break}}return r.replace(/\s+/g," ").trim()}export default function Pe(){const n=$e(),{user:r,profile:g}=je(),w=Re(null),[O,H]=h(!1),[M,R]=h(""),[D,V]=h(""),[d,$]=h([]),[S,q]=h([]),[N,F]=h([]),[K,W]=h(!1),[we,Y]=h(""),[G,j]=h(""),[k,B]=h(null),Se=g?.role==="verifier"||g?.role==="sysadmin",[X,J]=h(!1),[Q,Z]=h(""),Ne=ne(async()=>{const t=[];let i=0;for(;;){const{data:o,error:c}=await n.from("prospects").select("athlete_name,grad_year,position,jersey_number,height,weight,gpa,athlete_email,athlete_cell,city,state,level_of_play,hudl_url,x_url,coach_evaluation,guardian_authorized,status,created_at,schools(name,city,state)").order("created_at",{ascending:!1}).range(i,i+1e3-1);if(c)throw c;if(t.push(...o||[]),!o||o.length<1e3)break;i+=1e3}return t},[n]);async function ke(){Z(""),J(!0);try{const t=await Ne(),s=I.unparse({fields:["athlete_name","grad_year","school_name","city","state","level_of_play","position","jersey_number","height","weight","gpa","athlete_email","athlete_cell","hudl_url","x_url","coach_evaluation","guardian_authorized","status","submitted_date"],data:t.map(a=>[a.athlete_name,a.grad_year||"",a.schools?.name||"",a.city||a.schools?.city||"",a.state||a.schools?.state||"",a.level_of_play||"",a.position||"",a.jersey_number||"",a.height||"",a.weight||"",a.gpa??"",a.athlete_email||"",a.athlete_cell||"",a.hudl_url||"",a.x_url||"",a.coach_evaluation||"",a.guardian_authorized?"TRUE":"FALSE",a.status||"",a.created_at?new Date(a.created_at).toISOString().slice(0,10):""])}),i=new Blob([s],{type:"text/csv;charset=utf-8;"}),o=URL.createObjectURL(i),c=document.createElement("a");c.href=o,c.download=`csd_prospects_export_${new Date().toISOString().slice(0,10)}.csv`,document.body.appendChild(c),c.click(),c.remove(),URL.revokeObjectURL(o)}catch(t){Z(t.message||"Could not export prospects.")}finally{J(!1)}}function Ee(){const t=I.unparse({fields:Be,data:[["Jordan Smith","2027","WR","8",`6'1"`,"185","3.4","jordan@email.com","5555551234","Austin","TX","","Austin High School","FBS","","https://x.com/username","Great hands, top-end speed","TRUE"]]}),s=new Blob([t],{type:"text/csv;charset=utf-8;"}),i=URL.createObjectURL(s),o=document.createElement("a");o.href=i,o.download="csd_prospect_template.csv",document.body.appendChild(o),o.click(),o.remove(),URL.revokeObjectURL(i)}function xe(){$([]),q([]),F([]),R(""),B(null),j(""),V(""),w.current&&(w.current.value="")}const ze=ne(async()=>{const t=[];let i=0;for(;;){const{data:o,error:c}=await n.from("schools").select("id,name,city,state").order("id",{ascending:!0}).range(i,i+1e3-1);if(c)throw c;if(t.push(...o||[]),!o||o.length<1e3)break;i+=1e3}return t},[n]);async function Ce(t){const s=t.target.files?.[0];if(s){xe(),V(s.name),H(!0),R("");try{const i=await s.text(),o=I.parse(i,{header:!0,skipEmptyLines:!0});if(o.errors?.length)throw new Error(o.errors[0].message);const c=(o.data||[]).map(e=>{const u={};return Object.keys(e).forEach(m=>{u[Ie(m)]=e[m]}),u});if(!c.length)throw new Error("The file has no data rows.");const a=await ze(),ee=new Map(a.map(e=>[String(e.id),e])),E=new Map,x=new Map,z=new Map,C=new Map;a.forEach(e=>{const u=l(e.name).toLowerCase(),m=l(e.state).toUpperCase(),_=`${u}|${m}`;E.has(_)||E.set(_,[]),E.get(_).push(e),x.has(u)||x.set(u,[]),x.get(u).push(e);const f=be(e.name),y=`${f}|${m}`;z.has(y)||z.set(y,[]),z.get(y).push(e),C.has(f)||C.set(f,[]),C.get(f).push(e)});const te=[],ae=[],L=[];c.forEach((e,u)=>{const m=e.athlete_name||`Row ${u+2}`,_=l(e.athlete_name);if(!_){ae.push({row:m,reason:"Missing athlete_name."});return}let f=null;const y=l(e.school_id),v=l(e.school_name),b=l(e.state).toUpperCase();if(y&&ee.has(y))f=ee.get(y).id;else if(v){const se=be(v);let p=[];b?(p=E.get(`${v.toLowerCase()}|${b}`)||[],p.length||(p=z.get(`${se}|${b}`)||[])):(p=x.get(v.toLowerCase())||[],p.length||(p=C.get(se)||[]));const le=b?`${v}, ${b}`:v;p.length===1?f=p[0].id:p.length===0?L.push(`${m}: no school matched "${le}" — prospect will import without a linked school.`):L.push(`${m}: multiple schools matched "${le}" — prospect will import without a linked school.`)}const oe=Te.has(l(e.guardian_authorized).toLowerCase());let T=l(e.athlete_email)||null,A=l(e.athlete_cell)||null;(T||A)&&!oe&&(L.push(`${m}: contact info removed — guardian_authorized was not marked TRUE.`),T=null,A=null),te.push({submitted_by:r.id,athlete_name:_,grad_year:e.grad_year&&parseInt(l(e.grad_year),10)||null,position:l(e.position)||null,jersey_number:l(e.jersey_number)||null,height:l(e.height)||null,weight:l(e.weight)||null,gpa:e.gpa&&parseFloat(l(e.gpa))||null,athlete_email:T,athlete_cell:A,city:l(e.city)||null,state:b||null,school_id:f,level_of_play:l(e.level_of_play)||null,hudl_url:l(e.hudl_url)||null,x_url:l(e.x_url)||null,coach_evaluation:l(e.coach_evaluation)||null,guardian_authorized:oe,_label:m})}),$(te),q(ae),F(L)}catch(i){R(i.message||"Could not read this file.")}finally{H(!1)}}}async function Le(){W(!0),j(""),$(null);try{let t=0;for(let s=0;s<d.length;s+=U){const i=d.slice(s,s+U).map(({_label:c,...a})=>a);Y(`Importing ${s+1}–${Math.min(s+U,d.length)} of ${d.length}…`);const{error:o}=await n.from("prospects").insert(i);if(o)throw o;t+=i.length}B({count:t}),$([])}catch(t){j(t.message||"Something went wrong importing these prospects.")}finally{W(!1),Y("")}}return Se?<div className="view">
      <_e href="/prospects"className="btn btn-sm"style={{marginBottom:12,display:"inline-flex"}}>← Back to Prospects</_e>
      <div className="view-header">
        <div><h1>Bulk Add Prospects</h1><p>Upload a CSV of prospect sheets from HS coaches to add many athletes at once.</p></div>
      </div>

      <div className="card"style={{marginBottom:14}}>
        <h3>Export Current Prospects</h3>
        <p style={{fontSize:12.5,color:"#697386",marginTop:-4}}>
          Download every prospect currently in the database as a CSV — school, level of play, contact info, Hudl/X links, and coach evaluation notes included.
        </p>
        {Q&&<div className="notice danger"style={{marginBottom:10}}>{Q}</div>}
        <button className="btn btn-primary btn-sm"onClick={ke}disabled={X}>
          {X?"Exporting…":"Download Prospects CSV"}
        </button>
      </div>

      <div className="grid grid-2"style={{marginBottom:14}}>
        <div className="card">
          <h3>Step 1 — Download the template</h3>
          <p style={{fontSize:12.5,color:"#697386",marginTop:-4}}>
            <code>athlete_name</code> is required. To link a prospect to a school, fill in <code>school_id</code> (preferred) or <code>school_name</code> + <code>state</code>. Set <code>guardian_authorized</code> to TRUE for any row that includes an email or cell — otherwise contact info is dropped on import. Column headers are flexible — plain-language headers like &quot;Athlete Name&quot;, &quot;School&quot;, or &quot;Level of Play&quot; are recognized automatically, so coaches can send their own sheets as-is.
          </p>
          <button className="btn btn-primary btn-sm"onClick={Ee}>Download CSV Template</button>
        </div>
        <div className="card">
          <h3>Step 2 — Upload your prospect list</h3>
          <p style={{fontSize:12.5,color:"#697386",marginTop:-4}}>
            Any extra columns are ignored. You can re-upload as many times as you like — nothing is saved until you click Import.
          </p>
          {M&&<div className="notice danger"style={{marginBottom:10}}>{M}</div>}
          <input ref={w}type="file"accept=".csv"onChange={Ce}disabled={O}/>
          {O&&<div className="empty-state"style={{marginTop:8}}>Reading {D}…</div>}
        </div>
      </div>

      {(d.length>0||S.length>0)&&!k&&<div className="card"style={{marginBottom:14}}>
          <h3>Preview — {D}</h3>
          <div className="grid grid-3"style={{marginBottom:12}}>
            <div className="stat-card"><div className="label">Ready to import</div><div className="num">{d.length}</div></div>
            <div className="stat-card"><div className="label">Skipped (errors)</div><div className="num">{S.length}</div><div className="sub">missing athlete_name</div></div>
            <div className="stat-card"><div className="label">Warnings</div><div className="num">{N.length}</div><div className="sub">school/contact info notes</div></div>
          </div>

          {G&&<div className="notice danger"style={{marginBottom:10}}>{G}</div>}

          {S.length>0&&<div className="notice danger"style={{marginBottom:12}}>
              <strong>{S.length} row(s) skipped:</strong>
              <div style={{maxHeight:120,overflow:"auto",marginTop:6}}>
                {S.slice(0,50).map((t,s)=><div key={s}style={{fontSize:12,padding:"3px 0"}}>{t.row}: {t.reason}</div>)}
              </div>
            </div>}

          {N.length>0&&<div className="notice"style={{marginBottom:12}}>
              <strong>{N.length} note(s):</strong>
              <div style={{maxHeight:120,overflow:"auto",marginTop:6}}>
                {N.slice(0,50).map((t,s)=><div key={s}style={{fontSize:12,padding:"3px 0"}}>{t}</div>)}
              </div>
            </div>}

          {d.length>0&&<>
              <div className="table-wrap"style={{marginBottom:12,maxHeight:360,overflow:"auto"}}>
                <table>
                  <thead><tr><th>Athlete</th><th>Grad Yr</th><th>Level</th><th>Position</th><th>City/State</th><th>Email</th><th>Cell</th><th>Guardian Auth.</th></tr></thead>
                  <tbody>
                    {d.slice(0,500).map((t,s)=><tr key={s}>
                        <td><strong>{t.athlete_name}</strong></td>
                        <td>{t.grad_year||"—"}</td>
                        <td>{t.level_of_play||"—"}</td>
                        <td>{t.position||"—"}</td>
                        <td>{t.city||"—"}{t.state?`, ${t.state}`:""}</td>
                        <td>{t.athlete_email||"—"}</td>
                        <td>{t.athlete_cell||"—"}</td>
                        <td>{t.guardian_authorized?"Yes":"No"}</td>
                      </tr>)}
                  </tbody>
                </table>
              </div>
              {d.length>500&&<div className="notice"style={{marginBottom:12}}>Showing the first 500 of {d.length}. All {d.length} will be imported.</div>}
              <button className="btn btn-gold"onClick={Le}disabled={K}>
                {K?we||"Importing…":`Import ${d.length} prospect${d.length===1?"":"s"}`}
              </button>
            </>}
        </div>}

      {k&&<div className="notice info"style={{marginBottom:14}}>
          Imported {k.count} prospect{k.count===1?"":"s"}. <_e href="/prospects">View the Prospects list</_e>.
        </div>}
    </div>:<div className="view">
        <div className="notice danger">Bulk prospect import is limited to Verification Staff and System Admins.</div>
      </div>}