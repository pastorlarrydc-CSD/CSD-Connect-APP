"use client";
import { createContext, useContext, useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { getSupabaseBrowserClient } from "./supabase/client";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const supabase = getSupabaseBrowserClient();
  const router = useRouter();
  const [session, setSession] = useState(undefined);
  const [profile, setProfile] = useState(null);
  // Tracks whether we've actually resolved a profile lookup for the
  // *current* session, separate from `profile` itself. Without this, the
  // gap between "session resolved" (loading -> false) and "profile fetch
  // finished" (a real network round trip) reads as `!profile` in the
  // layout -- which incorrectly renders the "finish setting up your
  // account" onboarding form for a split second on every cold page load,
  // even for accounts that already have a profile. profileLoading starts
  // true so that gap is covered by the normal loading spinner instead.
  const [profileLoading, setProfileLoading] = useState(true);
  const [college, setCollege] = useState(null);

  const loadProfile = useCallback(
    async function loadProfileAttempt(userId, attempt = 0) {
      if (!userId) {
        setProfile(null);
        setCollege(null);
        setProfileLoading(false);
        return;
      }
      if (attempt === 0) setProfileLoading(true);
      const { data, error } = await supabase.from("profiles").select("*").eq("id", userId).maybeSingle();
      // A failed/interrupted request -- e.g. right after a back/forward
      // navigation, or a background token refresh landing mid-flight --
      // comes back with `error` set and `data` null. That used to look
      // identical to "this account has no profile row yet" and would
      // flash the "finish setting up your account" form at a fully
      // set-up user. Retry a couple of times (with backoff) before
      // accepting the fetch actually came back empty.
      if (error && attempt < 2) {
        await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
        return loadProfileAttempt(userId, attempt + 1);
      }
      if (error) {
        // Still failing after retries -- don't blow away a previously
        // good profile/college over a bad request, just stop the
        // spinner so the user isn't stuck on "Loading…" forever.
        setProfileLoading(false);
        return;
      }
      setProfile(data || null);
      if (data?.college_id) {
        const { data: c } = await supabase.from("colleges").select("*").eq("id", data.college_id).maybeSingle();
        setCollege(c || null);
      } else {
        setCollege(null);
      }
      setProfileLoading(false);
    },
    [supabase]
  );

  useEffect(() => {
    // MFA defense in depth: this check runs ONLY against the session
    // restored on initial page load (a persisted/cached session from a
    // previous visit) -- never against the live sign-in flow below via
    // onAuthStateChange. That distinction matters: the login page's own
    // MFA step intentionally holds a fresh session at aal1 while it waits
    // for the user's 6-digit code, and if this same check ran on that
    // SIGNED_IN event it would sign the user right back out before they
    // could ever enter the code, locking out exactly the accounts that
    // enabled MFA. Restricting it to the initial getSession() call instead
    // only catches the case of a stale cached session from *before* MFA
    // was enabled on the account -- accounts with no enrolled factor are
    // never affected either way (their nextLevel always equals aal1).
    supabase.auth.getSession().then(async ({ data }) => {
      const restored = data.session || null;
      if (restored) {
        const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
        if (aal && aal.nextLevel === "aal2" && aal.nextLevel !== aal.currentLevel) {
          await supabase.auth.signOut();
          setSession(null);
          loadProfile(null);
          return;
        }
      }
      setSession(restored);
      loadProfile(restored?.user?.id);
    });

    const { data: listener } = supabase.auth.onAuthStateChange((event, newSession) => {
      setSession(newSession || null);
      // TOKEN_REFRESHED fires automatically in the background every time
      // Supabase silently rotates the access token to keep a long browser
      // session alive -- it means the JWT changed, NOT that the signed-in
      // user or their profile did. Re-running loadProfile() here flips
      // profileLoading (and therefore `loading`, below) to true for the
      // length of that fetch, which makes AppLayout swap `children` for a
      // bare "Loading..." placeholder -- unmounting whatever page the
      // person is on and wiping out any client-side state it was holding
      // (an in-progress bulk-review batch and selections, for example).
      // Skipping the profile refetch on this one event keeps a long
      // working session on a page stable while still reloading the
      // profile on every event that can actually change it (sign in/out,
      // profile updates, MFA step-up, etc).
      if (event === "TOKEN_REFRESHED") return;
      loadProfile(newSession?.user?.id);
    });
    return () => listener.subscription.unsubscribe();
  }, [supabase, loadProfile]);

  const signOut = async () => {
    await supabase.auth.signOut();
    router.push("/login");
  };
  const refreshProfile = () => loadProfile(session?.user?.id);

  return (
    <AuthContext.Provider
      value={{
        session,
        user: session?.user || null,
        profile,
        college,
        loading: session === undefined || (!!session && profileLoading),
        signOut,
        refreshProfile,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
