import { NextResponse } from "next/server";
import { getSupabaseRouteClient } from "@/lib/supabase/routeClient";

const REVIEWER_ROLES = ["verifier", "sysadmin"];
const FETCH_TIMEOUT_MS = 8000;

// Domains that sometimes rank for these searches but are never a school's
// own athletics site -- MaxPreps already has its own dedicated field and
// discovery button (see discover-maxpreps), and the social/reference sites
// are never the right link to save here.
const EXCLUDED_HOSTS = ["maxpreps.com", "wikipedia.org", "facebook.com", "twitter.com", "x.com", "instagram.com", "youtube.com"];

// Auto-discover a school's dedicated athletics-department site via
// Serper.dev's Google-search proxy -- same approach as "Find MaxPreps page"
// (see app/api/schools/[id]/discover-maxpreps for the fuller writeup on why
// a search proxy instead of scraping), but NOT restricted to a single
// domain: unlike MaxPreps, an athletics site can live almost anywhere --
// a subdomain of the school's own site, or a third-party host like
// rSchoolToday, SportsEngine, or Schoolwires. So this runs a plain search
// for the school's athletics department and lets a human pick the right
// result, instead of restricting to one site: domain.
//
// Deliberately non-authoritative, same as MaxPreps discovery: only returns
// candidate links for a human to review and pick from (the "Find athletics
// page" button on the school profile page) -- it NEVER writes to the
// schools table itself. Athletics URL is checked FIRST by Coach-Change
// Radar (see lib/schoolRecheck.js), so a wrong link here would quietly
// poison that check ahead of the school's own website; a person has to
// confirm it's actually the right school's page before it's saved.
//
// Each search costs money once past Serper's free allotment, so this is
// gated to verifier/sysadmin and only ever runs when a human clicks the
// button -- never on a schedule, never in bulk.
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
      return NextResponse.json({ error: "Only verification staff or a system admin can look up athletics sites." }, { status: 403 });
    }

    const apiKey = process.env.SERPER_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: "Athletics site discovery isn't set up yet -- SERPER_API_KEY needs to be added in Vercel Project Settings -> Environment Variables (sign up free at serper.dev)." },
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

    // Same reasoning as the MaxPreps search: no exact-phrase quoting around
    // school.name, since a school's athletics site sometimes uses a
    // different public-facing name (mascot name, district branding, etc.)
    // than the legal/CSD name on file.
    const q = `${school.name} ${school.city || ""} ${school.state || ""} athletics department football`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let payload;
    try {
      const res = await fetch("https://google.serper.dev/search", {
        method: "POST",
        headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({ q, num: 8 }),
        signal: controller.signal,
      });
      payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        const message = payload?.message || payload?.error || `Serper search failed with HTTP ${res.status}.`;
        return NextResponse.json({ error: message }, { status: 502 });
      }
    } catch (fetchErr) {
      return NextResponse.json(
        { error: fetchErr.name === "AbortError" ? "The search took too long to respond." : "Could not reach the search service." },
        { status: 502 }
      );
    } finally {
      clearTimeout(timeout);
    }

    const candidates = (payload.organic || [])
      .filter((item) => item.link && !EXCLUDED_HOSTS.some((host) => item.link.includes(host)))
      .slice(0, 5)
      .map((item) => ({ title: item.title, link: item.link, snippet: item.snippet }));

    return NextResponse.json({ candidates });
  } catch (err) {
    console.error("athletics discovery error", err);
    return NextResponse.json({ error: "Could not search for an athletics site. Please try again." }, { status: 500 });
  }
}
