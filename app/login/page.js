"use client";import{useState as t}from"react";import{useRouter as g}from"next/navigation";import S from"next/link";import{getSupabaseBrowserClient as C}from"@/lib/supabase/client";export default function N(){const u=C(),c=g(),[a,d]=t(""),[r,m]=t(""),[n,o]=t(""),[i,s]=t(!1);async function p(e){e.preventDefault(),o(""),s(!0);const{error:l}=await u.auth.signInWithPassword({email:a,password:r});if(s(!1),l){o(l.message);return}c.push("/dashboard")}return<div className="auth-wrap">
      <div className="auth-card">
        <h1>CSD CoachConnect</h1>
        <p className="sub">Sign in to your recruiting account</p>
        {n&&<div className="notice danger"style={{marginBottom:12}}>{n}</div>}
        <form onSubmit={p}>
          <div className="form-field">
            <label>Email</label>
            <input type="email"required value={a}onChange={e=>d(e.target.value)}placeholder="you@college.edu"/>
          </div>
          <div className="form-field">
            <label>Password</label>
            <input type="password"required value={r}onChange={e=>m(e.target.value)}placeholder="••••••••"/>
          </div>
          <button className="btn btn-primary"style={{width:"100%",justifyContent:"center",marginTop:6}}disabled={i}>
            {i?"Signing in…":"Sign In"}
          </button>
        </form>
        <p style={{fontSize:12.5,color:"#697386",marginTop:16,textAlign:"center"}}>
          New here? <S href="/signup">Create an account</S>
        </p>
      </div>
    </div>}