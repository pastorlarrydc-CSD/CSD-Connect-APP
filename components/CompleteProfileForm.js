"use client";import{useState as r}from"react";import{getSupabaseBrowserClient as b}from"@/lib/supabase/client";import{useAuth as S}from"@/lib/auth-context";const y=[{value:"college_coach",label:"College Coach / Recruiting Staff"},{value:"athletic_director",label:"Athletic Director / Administrator"},{value:"hs_coach",label:"High School Head Coach"},{value:"verifier",label:"Database Researcher / Verification Staff"},{value:"sysadmin",label:"System Administrator"}];export default function N(){const o=b(),{user:n,refreshProfile:f}=S(),[l,v]=r({name:"",collegeName:"",role:"college_coach",title:""}),[s,c]=r(""),[m,u]=r(!1);function t(e,a){v(i=>({...i,[e]:a}))}async function h(e){e.preventDefault(),c(""),u(!0);try{let a=null;if(l.collegeName.trim()){const{data:d}=await o.from("colleges").select("id").ilike("name",l.collegeName.trim()).maybeSingle();if(d)a=d.id;else{const{data:p,error:g}=await o.from("colleges").insert({name:l.collegeName.trim()}).select("id").single();if(g)throw g;a=p.id}}const{error:i}=await o.from("profiles").insert({id:n.id,full_name:l.name,role:l.role,title:l.title||null,college_id:a});if(i)throw i;await f()}catch(a){c(a.message||"Something went wrong finishing your account setup.")}finally{u(!1)}}return<div className="view">
      <div className="card"style={{maxWidth:480,margin:"40px auto"}}>
        <h3>Finish setting up your account</h3>
        <p style={{fontSize:12.5,color:"#697386",marginTop:-6,marginBottom:14}}>
          You're signed in as {n?.email}. Just need a couple more details.
        </p>
        {s&&<div className="notice danger"style={{marginBottom:12}}>{s}</div>}
        <form onSubmit={h}>
          <div className="form-field">
            <label>Full name</label>
            <input required value={l.name}onChange={e=>t("name",e.target.value)}/>
          </div>
          <div className="form-field">
            <label>College / Organization</label>
            <input required value={l.collegeName}onChange={e=>t("collegeName",e.target.value)}placeholder="e.g. Collegiate Sports Data"/>
          </div>
          <div className="form-field">
            <label>Title (optional)</label>
            <input value={l.title}onChange={e=>t("title",e.target.value)}placeholder="Recruiting Coordinator"/>
          </div>
          <div className="form-field">
            <label>Role</label>
            <select value={l.role}onChange={e=>t("role",e.target.value)}>
              {y.map(e=><option key={e.value}value={e.value}>{e.label}</option>)}
            </select>
          </div>
          <button className="btn btn-gold"style={{width:"100%",justifyContent:"center",marginTop:6}}disabled={m}>
            {m?"Saving…":"Finish Setup"}
          </button>
        </form>
      </div>
    </div>}