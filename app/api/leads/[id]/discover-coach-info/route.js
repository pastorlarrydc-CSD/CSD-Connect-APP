import { NextResponse } from "next/server";
import { getSupabaseRouteClient } from "@/lib/supabase/routeClient";
import { searchWebWithGraph, parseModelJson, MODEL, RESPONSE_MAX_TOKENS } from "@/lib/coachInfoLookup";
import { COLLEGE_SYSTEM_PROMPT, buildLeadSearchQuery, findLeadDirectoryPage, buildLeadSourceBlocks, normalizeCollegeSuggestion } from "@/lib/collegeCoachInfoLookup";

const REVIEWER_ROLES = ["verifier", "sysadmin"];
// See the matching constant's comment in app/api/schools/[id]/discover-coach-info
// -- same reasoning, just one search + one conditional fetch instead of two
// fetches + three searches, so a shorter ceiling is enough here.
const AI_TIMEOUT_MS = 20000;
export const maxDuration = 35;

// College-lead counterpart to app/api/schools/[id]/discover-coach-info --
// "Find Coach Info (AI)" on a lead's edit form, for when a lead is missing
// (or might have stale) contact info for its coach/recruiting contact.
// Same non-authoritative contract as the schools version: this only ever
// returns a suggestion for a human to review and apply from the edit form;
// it never writes to college_leads on its own.
export async function POST(req, { params }) {
  try {
    const leadId = Number(params.id);
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

    const { data: lead, error: leadErr } = await supabase
      .from("college_leads")
      .select("id,college_name,division,state,role_category,title,coach_first_name,coach_last_name,email,mobile,office_phone")
      .eq("id", leadId)
      .maybeSingle();
    if (leadErr || !lead) {
      return NextResponse.json({ error: "Lead not found." }, { status: 404 });
    }

    const searchQuery = buildLeadSearchQuery(lead);

    const [primarySearch, directoryResult] = await Promise.all([
      searchWebWithGraph(searchQuery, serperKey),
      findLeadDirectoryPage({ lead, serperKey }),
    ]);

    const { hasUsableContent, userMessage, defaultSource } = buildLeadSourceBlocks({
      lead,
      searchResults: primarySearch.organic,
      searchQuery,
      directoryPage: directoryResult.page,
      directorySearchResults: directoryResult.results,
      knowledgeGraph: primarySearch.knowledgeGraph,
      answerBox: primarySearch.answerBox,
    });

    if (!hasUsableContent) {
      return NextResponse.json(
        { error: "Couldn't find anything about this program's staff online right now. Try again in a moment." },
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
          max_tokens: RESPONSE_MAX_TOKENS,
          system: COLLEGE_SYSTEM_PROMPT,
          messages: [{ role: "user", content: userMessage }],
        }),
        signal: aiController.signal,
      });
    } catch (aiFetchErr) {
      console.error("Anthropic API fetch error (leads discover-coach-info)", aiFetchErr);
      return NextResponse.json(
        { error: aiFetchErr.name === "AbortError" ? "The AI lookup took too long to respond. Please try again." : "Could not reach the AI lookup service. Please try again." },
        { status: 502 }
      );
    } finally {
      clearTimeout(aiTimeout);
    }

    if (!aiRes.ok) {
      const detail = await aiRes.text().catch(() => "");
      console.error("Anthropic API error (leads discover-coach-info)", aiRes.status, detail);
      return NextResponse.json({ error: "The AI lookup service returned an error. Please try again in a moment." }, { status: 502 });
    }

    const aiJson = await aiRes.json();
    const rawText = aiJson?.content?.[0]?.text || "";
    const parsed = parseModelJson(rawText);
    if (!parsed) {
      console.error("Could not parse AI response (leads discover-coach-info)", rawText);
      return NextResponse.json({ error: "Could not parse the AI response. Please try again." }, { status: 502 });
    }

    return NextResponse.json(normalizeCollegeSuggestion(parsed, defaultSource));
  } catch (err) {
    console.error("leads discover-coach-info error", err);
    return NextResponse.json({ error: "Could not look up coach info right now. Please try again." }, { status: 500 });
  }
}
