 import { NextResponse } from "next/server";
import { getSupabaseRouteClient } from "@/lib/supabase/routeClient";

const REVIEWER_ROLES = ["verifier", "sysadmin"];
const FETCH_TIMEOUT_MS = 8000;

// Auto-discover a school's MaxPreps team/roster page URL via Google's
// Programmable Search Engine (Custom Search JSON API), restricted to
// maxpreps.com -- MaxPreps has no public API of its own, and its Terms of
// Use explicitly prohibit scraping or crawling its own site, so this asks
// Google's index where the page lives instead of touching MaxPreps'
// servers at all.
//
// Deliberately non-authoritative: this only returns candidate links for a
// human to review and pick from in the Data Quality "Quick Fix" panel --
// it NEVER writes to the schools table itself. A wrong MaxPreps URL would
// quietly poison the Coach-Change Radar fallback check (see
// lib/schoolRecheck.js), so a person has to be the one who confirms it's
// actually the right school's page before it's saved.
//
// Each search costs money once past Google's free daily quota, so this is
// gated to verifier/sysadmin and only ever runs when a human clicks the
// "Find MaxPreps page" button -- never on a schedule, never in bulk.
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
      return NextResponse.json({ error: "Only verification staff or a system admin can look up MaxPreps pages." }, { status: 403 });
    }

    const apiKey = process.env.GOOGLE_CSE_API_KEY;
    const cx = process.env.GOOGLE_CSE_ID;
    if (!apiKey || !cx) {
      return NextResponse.json(
        { error: "MaxPreps discovery isn't set up yet -- GOOGLE_CSE_API_KEY and GOOGLE_CSE_ID need to be added in Vercel Project Settings -> Environment Variables." },
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

    const q = `site:maxpreps.com "${school.name}" ${school.city || ""} ${school.state || ""} football roster`;
    const searchUrl = `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(apiKey)}&cx=${encodeURIComponent(cx)}&q=${encodeURIComponent(q)}&num=5`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let payload;
    try {
      const res = await fetch(searchUrl, { signal: controller.signal });
      payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        const message = payload?.error?.message || `Google search failed with HTTP ${res.status}.`;
        return NextResponse.json({ error: message }, { status: 502 });
      }
    } catch (fetchErr) {
      return NextResponse.json(
        { error: fetchErr.name === "AbortError" ? "The search took too long to respond." : "Could not reach Google's search API." },
        { status: 502 }
      );
    } finally {
      clearTimeout(timeout);
    }

    const candidates = (payload.items || [])
      .filter((item) => item.link && item.link.includes("maxpreps.com"))
      .slice(0, 5)
      .map((item) => ({ title: item.title, link: item.link, snippet: item.snippet }));

    return NextResponse.json({ candidates });
  } catch (err) {
    console.error("maxpreps discovery error", err);
    return NextResponse.json({ error: "Could not search for a MaxPreps page. Please try again." }, { status: 500 });
  }
}
