"use client";import{useEffect as A,useState as c,useCallback as _}from"react";import{useRouter as k}from"next/navigation";import{getSupabaseBrowserClient as x}from"@/lib/supabase/client";const l=25,q=["AL","AK","AS","AZ","AR","CA","CO","CT","DE","DC","FL","GA","HI","ID","IL","IN","IA","KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT","VA","WA","WV","WI","WY"];function v(i){if(!i)return"";const o=i.replace(/\D/g,"");return o.length===10?`(${o.slice(0,3)}) ${o.slice(3,6)}-${o.slice(6)}`:i}function w(i){const n=i??0;return n>=70?"#1d7a4c":n>=40?"#a17a00":"#b3312c"}export default function E(){const i=x(),o=k(),[t,b]=c({q:"",state:"",type:"",classification:"",confidence:"",hasEmail:!1,hasCell:!1}),[a,r]=c(0),[m,g]=c([]),[s,y]=c(0),[N,u]=c(!0),f=_(async()=>{u(!0);let e=i.from("schools").select("*",{count:"exact"});if(t.q){const d=t.q.trim();e=e.or(`name.ilike.%${d}%,city.ilike.%${d}%,hc_last_name.ilike.%${d}%,zip.ilike.%${d}%`)}t.state&&(e=e.eq("state",t.state)),t.type&&(e=e.eq("school_type",t.type)),t.classification&&(e=e.ilike("classification",`%${t.classification.trim()}%`)),t.confidence==="high"&&(e=e.gte("confidence_score",70)),t.confidence==="medium"&&(e=e.gte("confidence_score",40).lt("confidence_score",70)),t.confidence==="low"&&(e=e.lt("confidence_score",40)),t.hasEmail&&(e=e.not("hc_email","is",null).neq("hc_email","")),t.hasCell&&(e=e.not("hc_cell","is",null).neq("hc_cell","")),e=e.order("name",{ascending:!0}).range(a*l,a*l+l-1);const{data:h,count:p,error:S}=await e;S||(g(h||[]),y(p||0)),u(!1)},[i,t,a]);A(()=>{f()},[f]);function n(e,h){b(p=>({...p,[e]:h})),r(0)}const C=Math.max(1,Math.ceil(s/l));return<div className="view">
      <div className="view-header">
        <div><h1>National High School Database</h1><p>{s.toLocaleString()} schools · live query against production database</p></div>
      </div>
      <div className="filters">
        <div className="field"style={{minWidth:220}}>
          <label>Keyword</label>
          <input placeholder="School, city, coach last name, zip"value={t.q}onChange={e=>n("q",e.target.value)}/>
        </div>
        <div className="field">
          <label>State</label>
          <select value={t.state}onChange={e=>n("state",e.target.value)}>
            <option value="">All</option>
            {q.map(e=><option key={e}value={e}>{e}</option>)}
          </select>
        </div>
        <div className="field">
          <label>Type</label>
          <select value={t.type}onChange={e=>n("type",e.target.value)}>
            <option value="">All</option>
            <option value="Public">Public</option>
            <option value="Private">Private</option>
          </select>
        </div>
        <div className="field">
          <label>Classification</label>
          <input placeholder="e.g. 4A, D2, GRP 1"value={t.classification}onChange={e=>n("classification",e.target.value)}/>
        </div>
        <div className="field">
          <label>Confidence</label>
          <select value={t.confidence}onChange={e=>n("confidence",e.target.value)}>
            <option value="">All</option>
            <option value="high">High (70%+)</option>
            <option value="medium">Medium (40-69%)</option>
            <option value="low">Low (&lt;40%)</option>
          </select>
        </div>
        <div className="field">
          <label>&nbsp;</label>
          <label style={{flexDirection:"row",gap:5,textTransform:"none",fontWeight:600,color:"#131a2b",alignItems:"center",display:"flex"}}>
            <input type="checkbox"checked={t.hasEmail}onChange={e=>n("hasEmail",e.target.checked)}/> Has email
          </label>
        </div>
        <div className="field">
          <label>&nbsp;</label>
          <label style={{flexDirection:"row",gap:5,textTransform:"none",fontWeight:600,color:"#131a2b",alignItems:"center",display:"flex"}}>
            <input type="checkbox"checked={t.hasCell}onChange={e=>n("hasCell",e.target.checked)}/> Has cell
          </label>
        </div>
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>School</th><th>City / State</th><th>Type</th><th>Class</th><th>Head Coach</th><th>Email</th><th>Cell / Office</th><th>Confidence</th></tr>
          </thead>
          <tbody>
            {N?<tr><td colSpan={8}><div className="empty-state">Loading…</div></td></tr>:m.length?m.map(e=><tr key={e.id}onClick={()=>o.push(`/schools/${e.id}`)}>
                <td><strong>{e.name}</strong><div style={{color:"#697386",fontSize:11.5}}>{e.county} County</div></td>
                <td>{e.city}, {e.state} {e.zip}</td>
                <td><span className={`badge ${e.school_type==="Public"?"badge-public":"badge-private"}`}>{e.school_type}</span></td>
                <td>{e.classification||"—"}</td>
                <td>{e.hc_first_name} {e.hc_last_name}</td>
                <td>{e.hc_email||<span className="empty-state">none on file</span>}</td>
                <td>{v(e.hc_cell)||v(e.hc_office)||<span className="empty-state">none on file</span>}</td>
                <td><span style={{fontWeight:600,fontSize:12.5,color:w(e.confidence_score)}}>{e.confidence_score??0}%</span></td>
              </tr>):<tr><td colSpan={8}><div className="empty-state">No schools match these filters.</div></td></tr>}
          </tbody>
        </table>
        <div className="pager">
          <span>Showing {s?a*l+1:0}-{Math.min(a*l+l,s)} of {s.toLocaleString()}</span>
          <div style={{display:"flex",gap:6}}>
            <button className="btn btn-sm"disabled={a<=0}onClick={()=>r(e=>e-1)}>Prev</button>
            <button className="btn btn-sm"disabled={a+1>=C}onClick={()=>r(e=>e+1)}>Next</button>
          </div>
        </div>
      </div>
    </div>}
