"use client";import{useEffect as d}from"react";import{usePathname as m,useRouter as p}from"next/navigation";import C from"next/link";import{useAuth as S}from"@/lib/auth-context";import N from"@/components/CompleteProfileForm";const A=[{href:"/dashboard",label:"Dashboard"},{href:"/search",label:"Search Database"},{href:"/map",label:"Territory Map"},{href:"/crm",label:"Recruiting CRM"},{href:"/prospects",label:"Prospects"},{href:"/trips",label:"Recruiting Trips"},{href:"/reports",label:"Reports"},{href:"/admin",label:"Admin"}],L={college_coach:"College Coach / Staff",athletic_director:"Athletic Director",hs_coach:"HS Head Coach",verifier:"Verification Staff",sysadmin:"System Admin"};export default function R({children:r}){const{session:a,profile:i,college:o,signOut:s,loading:t}=S(),l=p(),n=m();if(d(()=>{!t&&a===null&&l.replace("/login")},[t,a,l]),t||a===null)return<div style={{padding:40,textAlign:"center",color:"#697386"}}>Loading…</div>;const c=(i?.full_name||a?.user?.email||"?").split(" ").map(e=>e[0]).slice(0,2).join("").toUpperCase();return<div>
      <div className="demo-banner">
        LIVE PRODUCTION DATABASE — CSD CoachConnect (Phase 1). Real Supabase-backed data, authentication, and per-college isolation.
      </div>
      <div className="topbar">
        <div className="brand"><span className="dot"/>CSD CoachConnect<small>Collegiate Sports Data · Recruiting Intelligence</small></div>
        <div className="nav">
          {A.map(e=><C key={e.href}href={e.href}className={n.startsWith(e.href)?"active":""}>{e.label}</C>)}
        </div>
        <div className="topbar-right">
          <div className="user-chip">
            <span className="avatar">{c}</span>
            <div>
              <div>{i?.full_name||a?.user?.email}</div>
              <div style={{fontSize:10.5,color:"#9fb0cc"}}>{L[i?.role]||"…"} {o?`· ${o.name}`:""}</div>
            </div>
          </div>
          <button className="btn btn-sm"onClick={s}>Sign out</button>
        </div>
      </div>
      {!i&&<N/>}
      {i&&r}
      <div className="footer-note">CSD CoachConnect — Phase 1 production build. Live database, real authentication, per-college data isolation via Row Level Security.</div>
    </div>}