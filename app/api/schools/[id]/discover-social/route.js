import { NextResponse } from "next/server";
import { getSupabaseRouteClient } from "@/lib/supabase/routeClient";

const REVIEWER_ROLES = ["verifier", "sysadmin"];
const FETCH_TIMEOUT_MS = 8000;
const RESULT_COUNT = 5;

// Dedicated Twitter/X + Facebook search for the school's head football
// coach -- a deliberately separate, opt-in action from "Suggest Coach
// Info (AI)" above it. That route only ever sees a handle/link if it's
// already sitting as plain visible text on the school's athletics page
// or turns up in a general search for "[school] head football coach" --
// see htmlToText in discover-coach-info/route.js, which strips all HTML
// including href attributes, so an icon-only social button on a coach's
// bio page is invisible to it no matter how findable it is to a human.
// This route instead runs two targeted searches scoped to the coach's
// own name, restricted to each platform's domain via Google's site:
// operator (which Serper passes straight through), and returns candidate
// links for a human to pick from -- same non-authoritative, pick-a-link
// pattern as Find MaxPreps/Find Athletics, not another AI call. No
// Anthropic cost here, just two Serper queries.
//
// Needs an actual coach name to search on -- without one this is just
// guessing at "[school] twitter", which mostly finds the school's own
// account rather than the coach's. The name comes from the client's
// current (possibly unsaved) Quick Fix form values, not necessarily
// what's on file yet, so this can run right after Suggest Coach Info or
// Mark Coach Change fills in a new name, before that's been saved.
export async function POST(req, { params }) {
  try {
    const schoolId = Number(params.id);
    const authHeader = req.headers.get("authorization") || "";
    const token = authHeader.replace(/^Bearer\s+/i, "");
    if (!token) {
      return NextResponse.json({ error: "Not signed in." }, { status: 401 });
    }

    const supabase = getSupabaseRouteClient(token);
    const { data: userData, error: userErr } = await supabase.auth.getUser();
    if (userErr || !userData?.user) {
      return NextResponse.json({ error: "Not signed in." }, { status: 401 });
    }

    const { data: profile } = await supabase.from("profiles").select("role").eq("id", userData.user.id).maybeSingle();
    if (!profile || !REVIEWER_ROLES.includes(profile.role)) {
      return NextResponse.json({ error: "Only verification staff or a system admin can look up social media." }, { status: 403 });
    }

    const apiKey = process.env.SERPER_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: "Social media discovery isn't set up yet -- SERPER_API_KEY needs to be added in Vercel Project Settings -> Environment Variables (sign up free at serper.dev)." },
        { status: 500 }
      );
    }

    const { data: school, error: schoolErr } = await supabase
      .from("schools")
      .select("id,name,city,state")
      .eq("id", schoolId)
      .maybeSingle();
    if (schoolErr || !school) {
      return NextResponse.json({ error: "School not found." }, { status: 404 });
    }

    const body = await req.json().catch(() => ({}));
    const firstName = (body.hc_first_name || "").toString().trim();
    const lastName = (body.hc_last_name || "").toString().trim();
    const fullName = [firstName, lastName].filter(Boolean).join(" ");
    if (!fullName) {
      return NextResponse.json({ error: "Enter the coach's name first -- social search needs a name to look for." }, { status: 400 });
    }

    // site: restricts Google (and so Serper, which proxies Google) to
    // just that domain -- x.com/twitter.com both still resolve real
    // profiles depending how long ago a given account migrated, so both
    // are searched together rather than picking one.
    const twitterQuery = `(site:x.com OR site:twitter.com) "${fullName}" ${school.name} ${school.city || ""} ${school.state || ""}`;
    const facebookQuery = `site:facebook.com "${fullName}" ${school.name} ${school.city || ""} ${school.state || ""}`;

    async function search(q) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      try {
        const res = await fetch("https://google.serper.dev/search", {
          method: "POST",
          headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
          body: JSON.stringify({ q, num: 8 }),
          signal: controller.signal,
        });
        const payload = await res.json().catch(() => ({}));
        if (!res.ok) return { candidates: [], error: payload?.message || payload?.error || `Serper search failed with HTTP ${res.status}.` };
        const candidates = (payload.organic || [])
          .filter((item) => item.title && item.link)
          .slice(0, RESULT_COUNT)
          .map((item) => ({ title: item.title, link: item.link, snippet: item.snippet || "" }));
        return { candidates, error: null };
      } catch (fetchErr) {
        return { candidates: [], error: fetchErr.name === "AbortError" ? "The search took too long to respond." : "Could not reach the search service." };
      } finally {
        clearTimeout(timeout);
      }
    }

    // Best-effort per platform -- one platform's search failing shouldn't
    // sink the other. If BOTH fail, that failure is surfaced below.
    const [twitterResult, facebookResult] = await Promise.all([search(twitterQuery), search(facebookQuery)]);

    if (twitterResult.error && facebookResult.error) {
      return NextResponse.json({ error: twitterResult.error }, { status: 502 });
    }

    return NextResponse.json({ twitter: twitterResult.candidates, facebook: facebookResult.candidates });
  } catch (err) {
    console.error("social discovery error", err);
    return NextResponse.json({ error: "Could not search for social media. Please try again." }, { status: 500 });
  }
}
