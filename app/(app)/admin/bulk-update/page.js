"use client";import{useState as r,useCallback as ce,useRef as re}from"react";import _e from"next/link";import Y from"papaparse";import{getSupabaseBrowserClient as we}from"@/lib/supabase/client";import{useAuth as be}from"@/lib/auth-context";const Ne=[["name","School name"],["school_type","Type (Public/Private)"],["addr1","Address line 1"],["addr2","Address line 2"],["city","City"],["county","County"],["state","State"],["zip","Zip"],["classification","Classification"],["phone","Main phone"],["website","Website"],["hc_first_name","HC first name"],["hc_last_name","HC last name"],["hc_email","HC email"],["hc_cell","HC cell"],["hc_office","HC office"],["x_twitter","X (Twitter)"]],Se=["id","name","school_type","addr1","addr2","city","county","state","zip","classification","phone","website","hc_first_name","hc_last_name","hc_email","hc_cell","hc_office","x_twitter"],R=300;function m(f){return f==null?"":String(f).trim()}export default function Ce(){const f=we(),{user:ee,profile:U}=be(),E=re(null),[z,O]=r(!1),[P,F]=r(""),[I,T]=r(!1),[V,k]=r(""),[D,M]=r(""),[i,B]=r([]),[j,x]=r(0),[v,H]=r([]),[W,X]=r(!1),[te,Z]=r(""),[q,L]=r(""),[y,$]=r(null),ae=U?.role==="verifier"||U?.role==="sysadmin",G=ce(async e=>{const a=[];let n=0;for(;;){const{data:l,error:o}=await f.from("schools").select(e).order("id",{ascending:!0}).range(n,n+1e3-1);if(o)throw o;if(a.push(...l||[]),!l||l.length<1e3)break;n+=1e3}return a},[f]);async function oe(){F(""),O(!0);try{const e=await G([...Se,"record_updated","record_last_updated_at"].join(",")),a=Y.unparse({fields:["school_id",...Se.slice(1),"record_updated","record_last_updated_at"],data:e.map(o=>[...Se.map(fld=>o[fld]),o.record_updated?"Yes":"No",o.record_last_updated_at||""])}),s=new Blob([a],{type:"text/csv;charset=utf-8;"}),n=URL.createObjectURL(s),l=document.createElement("a");l.href=n,l.download=`csd_school_export_${new Date().toISOString().slice(0,10)}.csv`,document.body.appendChild(l),l.click(),l.remove(),URL.revokeObjectURL(n)}catch(e){F(e.message||"Could not export schools.")}finally{O(!1)}}function se(){B([]),x(0),H([]),k(""),$(null),L(""),M(""),E.current&&(E.current.value="")}async function ne(e){const a=e.target.files?.[0];if(a){se(),M(a.name),T(!0),k("");try{const s=await a.text(),n=Y.parse(s,{header:!0,skipEmptyLines:!0});if(n.errors?.length)throw new Error(n.errors[0].message);const l=(n.data||[]).map(t=>{const p={};return Object.keys(t).forEach(b=>{p[b.trim().toLowerCase()]=t[b]}),p});if(!l.length)throw new Error("The file has no data rows.");const o=await G(["id",...Se.slice(1)].join(",")),_=new Map(o.map(t=>[String(t.id),t])),c=new Map;o.forEach(t=>{const p=`${m(t.name).toLowerCase()}|${m(t.state).toUpperCase()}`;c.has(p)||c.set(p,[]),c.get(p).push(t)});const d=[],w=[];let K=0;l.forEach((t,p)=>{const b=t.school_name||t.name||`Row ${p+2}`;let g=null;const N=m(t.school_id||t.id);if(N&&_.has(N))g=_.get(N);else{const u=m(t.school_name||t.name),S=m(t.state).toUpperCase();if(u&&S){const C=`${u.toLowerCase()}|${S}`;let h=c.get(C)||[];if(h.length>1&&t.city){const Q=h.filter(le=>m(le.city).toLowerCase()===m(t.city).toLowerCase());Q.length&&(h=Q)}if(h.length===1)g=h[0];else if(h.length>1){w.push({row:b,reason:`${h.length} schools match "${u}, ${S}" — add a city or school_id column to disambiguate.`});return}}}if(!g){w.push({row:b,reason:N?`No school found with id ${N}.`:"Could not match on school_id or school_name + state."});return}const A=[];Ne.forEach(([u,S])=>{if(!(u in t))return;const C=m(t[u]);if(C==="")return;const h=m(g[u]);C!==h&&A.push({field:u,label:S,old:h||"—",new:C})}),A.length?d.push({id:g.id,name:g.name,city:g.city,state:g.state,fields:A}):K+=1}),B(d),x(K),H(w)}catch(s){k(s.message||"Could not read this file.")}finally{T(!1)}}}async function ie(){X(!0),L(""),$(null);try{let e=0;const a=new Date().toISOString();for(let s=0;s<i.length;s+=R){const n=i.slice(s,s+R);Z(`Applying ${s+1}–${Math.min(s+R,i.length)} of ${i.length}…`);const l=n.map(c=>{const d={id:c.id,verification_status:"verified",last_verified_at:a};return c.fields.forEach(w=>{d[w.field]=w.new}),d}),{error:o}=await f.from("schools").upsert(l,{onConflict:"id"});if(o)throw o;const _=[];if(n.forEach(c=>{c.fields.forEach(d=>{_.push({school_id:c.id,field_name:d.field,old_value:d.old==="—"?null:d.old,new_value:d.new,source:"Bulk school update (CSV)",changed_by:ee.id})})}),_.length){const{error:c}=await f.from("school_change_log").insert(_);if(c)throw c}e+=n.length}$({schools:e,fields:i.reduce((s,n)=>s+n.fields.length,0)}),B([]),x(0)}catch(e){L(e.message||"Something went wrong applying these changes.")}finally{X(!1),Z("")}}if(!ae)return<div className="view">
        <div className="notice danger">Bulk updates are limited to Verification Staff and System Admins.</div>
      </div>;const J=i.reduce((e,a)=>e+a.fields.length,0);return<div className="view">
      <_e href="/admin"className="btn btn-sm"style={{marginBottom:12,display:"inline-flex"}}>← Back to Admin</_e>
      <div className="view-header">
        <div><h1>Bulk Update Schools</h1><p>Export the current database, edit any field in a spreadsheet, then re-upload to apply changes across many schools at once.</p></div>
      </div>

      <div className="grid grid-2"style={{marginBottom:14}}>
        <div className="card">
          <h3>Step 1 — Export current data</h3>
          <p style={{fontSize:12.5,color:"#697386",marginTop:-4}}>
            Downloads every school with every editable field. Edit any column in Excel/Sheets — leave <code>school_id</code> untouched so we can match rows back up.
          </p>
          {P&&<div className="notice danger"style={{marginBottom:10}}>{P}</div>}
          <button className="btn btn-primary btn-sm"onClick={oe}disabled={z}>
            {z?"Exporting…":"Download CSV"}
          </button>
        </div>
        <div className="card">
          <h3>Step 2 — Upload your edited file</h3>
          <p style={{fontSize:12.5,color:"#697386",marginTop:-4}}>
            Columns read: <code>school_id</code> (preferred) or <code>school_name</code> + <code>state</code> (+ <code>city</code> to break ties), plus any of <code>name, school_type, addr1, addr2, city, county, state, zip, classification, phone, website, hc_first_name, hc_last_name, hc_email, hc_cell, hc_office, x_twitter</code>. Blank cells are left unchanged.
          </p>
          <div className="notice"style={{marginBottom:10,fontSize:12}}>
            Renaming a school or moving it to a new state? Match that row on <code>school_id</code>, not <code>school_name</code> + <code>state</code> — the name/state columns are also used to find the row, so changing them in a name+state-matched row can cause a miss.
          </div>
          {V&&<div className="notice danger"style={{marginBottom:10}}>{V}</div>}
          <input ref={E}type="file"accept=".csv"onChange={ne}disabled={I}/>
          {I&&<div className="empty-state"style={{marginTop:8}}>Reading {D}…</div>}
        </div>
      </div>

      {(i.length>0||v.length>0||j>0)&&!y&&<div className="card"style={{marginBottom:14}}>
          <h3>Preview — {D}</h3>
          <div className="grid grid-3"style={{marginBottom:12}}>
            <div className="stat-card"><div className="label">Schools to update</div><div className="num">{i.length}</div><div className="sub">{J} field{J===1?"":"s"} changing</div></div>
            <div className="stat-card"><div className="label">Already up to date</div><div className="num">{j}</div><div className="sub">no differences found</div></div>
            <div className="stat-card"><div className="label">Unmatched rows</div><div className="num">{v.length}</div><div className="sub">need school_id or name+state</div></div>
          </div>

          {q&&<div className="notice danger"style={{marginBottom:10}}>{q}</div>}

          {v.length>0&&<div className="notice danger"style={{marginBottom:12}}>
              <strong>{v.length} row(s) could not be matched:</strong>
              <div style={{maxHeight:140,overflow:"auto",marginTop:6}}>
                {v.slice(0,50).map((e,a)=><div key={a}style={{fontSize:12,padding:"3px 0"}}>{e.row}: {e.reason}</div>)}
                {v.length>50&&<div style={{fontSize:12}}>…and {v.length-50} more.</div>}
              </div>
            </div>}

          {i.length>0&&<>
              <div className="table-wrap"style={{marginBottom:12,maxHeight:360,overflow:"auto"}}>
                <table>
                  <thead><tr><th>School</th><th>Field</th><th>Current</th><th>New</th></tr></thead>
                  <tbody>
                    {i.slice(0,500).flatMap(e=>e.fields.map((a,s)=><tr key={`${e.id}-${a.field}`}>
                        {s===0?<td rowSpan={e.fields.length}><strong>{e.name}</strong><div style={{color:"#697386",fontSize:11.5}}>{e.city}, {e.state}</div></td>:null}
                        <td>{a.label}</td>
                        <td>{a.old}</td>
                        <td style={{color:"#1e7145",fontWeight:700}}>{a.new}</td>
                      </tr>))}
                  </tbody>
                </table>
              </div>
              {i.length>500&&<div className="notice"style={{marginBottom:12}}>Showing the first 500 of {i.length} schools. All {i.length} will be applied.</div>}
              <button className="btn btn-gold"onClick={ie}disabled={W}>
                {W?te||"Applying…":`Apply ${i.length} school update${i.length===1?"":"s"}`}
              </button>
            </>}
        </div>}

      {y&&<div className="notice info"style={{marginBottom:14}}>
          Applied {y.fields} field change{y.fields===1?"":"s"} across {y.schools} school{y.schools===1?"":"s"}. Records are marked Verified and logged in the school change history.
        </div>}
    </div>}
