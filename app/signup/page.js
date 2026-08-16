"use client";import{useState as n}from"react";import{useRouter as N}from"next/navigation";import S from"next/link";import{getSupabaseBrowserClient as A}from"@/lib/supabase/client";const D=[{value:"college_coach",label:"College Coach / Recruiting Staff"},{value:"athletic_director",label:"Athletic Director / Administrator"},{value:"hs_coach",label:"High School Head Coach"},{value:"verifier",label:"Database Researcher / Verification Staff"},{value:"sysadmin",label:"System Administrator"}];export default function E(){const i=A(),b=N(),[a,y]=n({name:"",email:"",password:"",collegeName:"",role:"college_coach",title:""}),[m,u]=n(""),[s,d]=n(""),[g,f]=n(!1);function l(e,t){y(r=>({...r,[e]:t}))}async function w(e){e.preventDefault(),u(""),d(""),f(!0);try{const{data:t,error:r}=await i.auth.signUp({email:a.email,password:a.password});if(r)throw r;const p=t.user?.id,v=t.session;let c=null;if(a.collegeName.trim()){const{data:o}=await i.from("colleges").select("id").ilike("name",a.collegeName.trim()).maybeSingle();if(o)c=o.id;else if(v){const{data:C,error:h}=await i.from("colleges").insert({name:a.collegeName.trim()}).select("id").single();if(h)throw h;c=C.id}}if(p&&v){const{error:o}=await i.from("profiles").insert({id:p,full_name:a.name,role:a.role,title:a.title||null,college_id:c});if(o)throw o;b.push("/dashboard");return}d("Account created — check your email to confirm your address, then sign in. You'll finish setting up your profile (college, role) right after you log in.")}catch(t){u(t.message||"Something went wrong creating your account.")}finally{f(!1)}}return<div className="auth-wrap">
      <div className="auth-card"style={{width:"min(480px,92vw)"}}>
        <h1>Create your CSD CoachConnect account</h1>
        <p className="sub">First account for a new college becomes its founding member automatically.</p>
        {m&&<div className="notice danger"style={{marginBottom:12}}>{m}</div>}
        {s&&<div className="notice info"style={{marginBottom:12}}>{s}</div>}
        {!s&&<form onSubmit={w}>
            <div className="form-field">
              <label>Full name</label>
              <input required value={a.name}onChange={e=>l("name",e.target.value)}/>
            </div>
            <div className="form-field">
              <label>Email</label>
              <input type="email"required value={a.email}onChange={e=>l("email",e.target.value)}/>
            </div>
            <div className="form-field">
              <label>Password</label>
              <input type="password"required minLength={6}value={a.password}onChange={e=>l("password",e.target.value)}/>
            </div>
            <div className="form-field">
              <label>College / Organization</label>
              <input required value={a.collegeName}onChange={e=>l("collegeName",e.target.value)}placeholder="e.g. Collegiate Sports Data"/>
            </div>
            <div className="form-field">
              <label>Title (optional)</label>
              <input value={a.title}onChange={e=>l("title",e.target.value)}placeholder="Recruiting Coordinator"/>
            </div>
            <div className="form-field">
              <label>Role</label>
              <select value={a.role}onChange={e=>l("role",e.target.value)}>
                {D.map(e=><option key={e.value}value={e.value}>{e.label}</option>)}
              </select>
            </div>
            <button className="btn btn-gold"style={{width:"100%",justifyContent:"center",marginTop:6}}disabled={g}>
              {g?"Creating account…":"Create Account"}
            </button>
          </form>}
        <p style={{fontSize:12.5,color:"#697386",marginTop:16,textAlign:"center"}}>
          Already have an account? <S href="/login">Sign in</S>
        </p>
      </div>
    </div>}