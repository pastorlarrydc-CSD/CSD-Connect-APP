import { NextResponse } from "next/server";
import { getSupabaseRouteClient } from "@/lib/supabase/routeClient";
import { withProtocol } from "@/lib/schoolRecheck";
import { fetchPageText, searchWeb, SYSTEM_PROMPT, parseModelJson, normalizeSuggestion, buildSourceBlocks, buildSearchQuery, MODEL } from "@/lib/coachInfoLookup";

const REVIEWER_ROLES = ["verifier", "sysadmin"];
// Every other network call in this route (fetchPageText, searchWeb) is
// already bounded by lib/coachInfoLookup's own FETCH_TIMEOUT_MS -- this
// route's own call to Anthropic wasn't. An unbounded fetch() meant that on
// the rare occasion the AI call itself stalled (a dropped connection, a
// slow upstream response), this route would hang until Vercel's own
// platform-level function timeout killed it -- and the "Suggest Coach Info
// (AI)" button's own fetch() had no timeout either, so it just sat on
// "Looking…" forever with no error. See the matching client-side fix in
// the Quick Fix / school profile pages for the other half of this.
const AI_TIMEOUT_MS = 20000;
export const maxDuration = 35; // fetch/search stage (up to ~8s) + AI_TIMEOUT_MS, plus headroom

// AI auto-fill for the Quick Fix panel: instead of a human reading a
// school's site by hand (or Googling it) to find and retype the head
// football coach's name, email, and phone, this looks it up itself and
// hands back a suggestion for the reviewer to confirm (or correct) before
// saving. Same non-authoritative contract as "Find MaxPreps page" and
// "Find athletics page" -- this NEVER writes to the schools table on its
// own; the reviewer still has to review the suggestion and click Save &
// Mark Verified.
//
// A web search (via Serper.dev, same search proxy the MaxPreps/athletics
// discovery buttons already use) is now the PRIMARY source, run on every
// click regardless of what's on file. Originally this route only read the
// school's saved athletics_url/website -- but that meant it flatly
// couldn't help on any school missing one of those (a hard "add a website
// first" dead end), and even when a URL WAS on file, a stale or wrong one
// silently sank the whole lookup with no fallback. A live search sidesteps
// both problems: it works whether or not anything is saved, and it isn't
// undone by one bad URL. When athletics_url/website ARE on file, that page
// is still fetched too and handed to the model alongside the search
// results -- a school's own staff directory is usually the best place to
// find an actual email address, so it's kept as a bonus source rather than
// the single point of failure it used to be.
//
// Deliberately never fetches maxpreps.com itself -- MaxPreps' Terms of Use
// prohibit scraping/crawling its own site (see the discover-maxpreps route
// for the fuller explanation). A MaxPreps result CAN still show up as a
// search snippet below, same as it can in a Google search anyone would run
// by hand -- that's Serper's own indexed summary, not us reading the page
// -- but its two-line snippet rarely carries an email/phone anyway, so a
// school's own athletics or general site (when reachable) remains the best
// source for actual contact info.
//
// Costs a real Anthropic call plus a Serper search on every click, so --
// same as the other AI/search-backed discovery routes -- this is gated to
// verifier/sysadmin and only ever runs when a human clicks the button.
// Never on a schedule, never in bulk against every school one at a time --
// see app/api/admin/batch-coach-info for the overnight Batch API version,
// which reuses the exact same prompt/parsing logic from lib/coachInfoLookup
// so the two never drift apart, but runs at Anthropic's Batch API pricing
// against many schools in one submission instead of a live call per click.
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
      return NextResponse.json({ error: "Only verification staff or a system admin can use AI coach-info lookup." }, { status: 403 });
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: "AI coach-info lookup isn't configured yet -- ANTHROPIC_API_KEY is missing from the server environment." },
        { status: 500 }
      );
    }
    const serperKey = process.env.SERPER_API_KEY;
    if (!serperKey) {
      return NextResponse.json(
        { error: "AI coach-info lookup isn't fully configured yet -- SERPER_API_KEY needs to be added in Vercel Project Settings -> Environment Variables (sign up free at serper.dev)." },
        { status: 500 }
      );
    }

    const { data: school, error: schoolErr } = await supabase
      .from("schools")
      .select("id,name,city,state,athletics_url,website,hc_first_name,hc_last_name,hc_email,hc_cell,hc_office,hc_twitter,hc_facebook")
      .eq("id", schoolId)
      .maybeSingle();
    if (schoolErr || !school) {
      return NextResponse.json({ error: "School not found." }, { status: 404 });
    }

    const athleticsUrl = withProtocol(school.athletics_url);
    const websiteUrl = withProtocol(school.website);

    // Name-targeted search when a coach is already on file -- e.g. a
    // reviewer re-running this on a school that has a name but no email
    // yet. See buildSearchQuery: falls back to the original school-only
    // query (no exact-phrase quoting around school.name, since a school's
    // public-facing name in search results sometimes differs slightly from
    // the legal/CSD name) when no name is on file yet.
    const searchQuery = buildSearchQuery(school);

    const [athleticsFetch, websiteFetch, searchResults] = await Promise.all([
      athleticsUrl ? fetchPageText(athleticsUrl) : Promise.resolve(null),
      websiteUrl ? fetchPageText(websiteUrl) : Promise.resolve(null),
      searchWeb(searchQuery, serperKey),
    ]);

    const { hasUsableContent, userMessage, defaultSource } = buildSourceBlocks({ school, athleticsFetch, websiteFetch, searchResults, searchQuery });

    if (!hasUsableContent) {
      return NextResponse.json(
        { error: "Couldn't find anything about this school's football staff online right now. Try again in a moment, or add a website/athletics URL via Quick Fix." },
        { status: 502 }
      );
    }

    const aiController = new AbortController();
    const aiTimeout = setTimeout(() => aiController.abort(), AI_TIMEOUT_MS);
    let aiRes;
    try {
      aiRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 400,
          system: SYSTEM_PROMPT,
          messages: [{ role: "user", content: userMessage }],
        }),
        signal: aiController.signal,
      });
    } catch (aiFetchErr) {
      console.error("Anthropic API fetch error (discover-coach-info)", aiFetchErr);
      return NextResponse.json(
        { error: aiFetchErr.name === "AbortError" ? "The AI lookup took too long to respond. Please try again." : "Could not reach the AI lookup service. Please try again." },
        { status: 502 }
      );
    } finally {
      clearTimeout(aiTimeout);
    }

    if (!aiRes.ok) {
      const detail = await aiRes.text().catch(() => "");
      console.error("Anthropic API error (discover-coach-info)", aiRes.status, detail);
      return NextResponse.json({ error: "The AI lookup service returned an error. Please try again in a moment." }, { status: 502 });
    }

    const aiJson = await aiRes.json();
    const rawText = aiJson?.content?.[0]?.text || "";
    const parsed = parseModelJson(rawText);
    if (!parsed) {
      console.error("Could not parse AI response (discover-coach-info)", rawText);
      return NextResponse.json({ error: "Could not parse the AI response. Please try again." }, { status: 502 });
    }

    return NextResponse.json(normalizeSuggestion(parsed, defaultSource));
  } catch (err) {
    console.error("discover-coach-info error", err);
    return NextResponse.json({ error: "Could not look up coach info right now. Please try again." }, { status: 500 });
  }
}
