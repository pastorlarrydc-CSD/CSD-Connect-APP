"use client";import{useState as s}from"react";import{useRouter as y}from"next/navigation";import C from"next/link";import{getSupabaseBrowserClient as S}from"@/lib/supabase/client";import{useAuth as k}from"@/lib/auth-context";async function h(d){const i=(d||"").trim();if(!i)return null;try{const l=await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(i)}`);if(!l.ok)return null;const a=await l.json();return!a||!a.length?null:{lat:parseFloat(a[0].lat),lon:parseFloat(a[0].lon)}}catch{return null}}export default function B(){const d=S(),i=y(),{user:l,college:a}=k(),[t,_]=s({name:"",start_date:"",end_date:"",start_location:"",end_location:""}),[u,m]=s(!1),[p,c]=s(""),[f,v]=s("");function n(e,o){_(r=>({...r,[e]:o}))}async function b(e){if(e.preventDefault(),c(""),!!t.name.trim()){if(!a?.id){c("Your account isn't linked to a college yet.");return}m(!0),v("");try{const[o,r]=await Promise.all([h(t.start_location),h(t.end_location||t.start_location)]);t.start_location.trim()&&!o&&v("Couldn't pinpoint the starting address — trip will save without map coordinates for it. You can edit it later.");const{data:N,error:g}=await d.from("trips").insert({college_id:a.id,created_by:l.id,name:t.name.trim(),start_date:t.start_date||null,end_date:t.end_date||null,start_location:t.start_location.trim()||null,start_lat:o?.lat??null,start_lon:o?.lon??null,end_location:(t.end_location||t.start_location).trim()||null,end_lat:r?.lat??null,end_lon:r?.lon??null}).select("id").single();if(g)throw g;i.push(`/trips/${N.id}`)}catch(o){c(o.message||"Could not create this trip.")}finally{m(!1)}}}return<div className="view">
      <C href="/trips"className="btn btn-sm"style={{marginBottom:12,display:"inline-flex"}}>← Back to Trips</C>
      <div className="view-header">
        <div><h1>New Recruiting Trip</h1><p>Set the basics — you&apos;ll add schools and optimize the route next.</p></div>
      </div>
      <div className="card"style={{maxWidth:560}}>
        {p&&<div className="notice danger"style={{marginBottom:12}}>{p}</div>}
        {f&&<div className="notice"style={{marginBottom:12}}>{f}</div>}
        <form onSubmit={b}>
          <div className="form-field">
            <label>Trip Name</label>
            <input required value={t.name}onChange={e=>n("name",e.target.value)}placeholder="West Texas Swing — Sept 2026"/>
          </div>
          <div className="grid grid-2"style={{marginBottom:4}}>
            <div className="form-field">
              <label>Start Date</label>
              <input type="date"value={t.start_date}onChange={e=>n("start_date",e.target.value)}/>
            </div>
            <div className="form-field">
              <label>End Date</label>
              <input type="date"value={t.end_date}onChange={e=>n("end_date",e.target.value)}/>
            </div>
          </div>
          <div className="form-field">
            <label>Starting Location</label>
            <input value={t.start_location}onChange={e=>n("start_location",e.target.value)}placeholder="Your campus, hotel, or airport address"/>
          </div>
          <div className="form-field">
            <label>Ending Location <span style={{fontWeight:400,color:"#697386"}}>(optional — defaults to starting location)</span></label>
            <input value={t.end_location}onChange={e=>n("end_location",e.target.value)}placeholder="Leave blank to return to start"/>
          </div>
          <button className="btn btn-gold"disabled={u}>{u?"Creating…":"Create Trip"}</button>
        </form>
      </div>
    </div>}