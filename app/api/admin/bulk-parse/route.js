import { NextResponse } from "next/server";
import { getSupabaseRouteClient } from "@/lib/supabase/routeClient";
import { MODEL } from "@/lib/coachInfoLookup";
import { BULK_PARSE_SYSTEM_PROMPT, BULK_PARSE_MAX_TOKENS, BULK_PARSE_MAX_INPUT_CHARS, parseBulkSchools } from "@/lib/bulkPasteParse";

const REVIEWER_ROLES = ["verifier", "sysadmin"];
// Longer than the single-school lookup's own AI_TIMEOUT_MS (20s, in
// discover-coach-info/route.js) -- this call can cover several schools'
// worth of input and output in one pass instead of just one.
const AI_TIMEOUT_MS = 30000;
export const maxDuration = 45;

// Bulk Paste & Parse -- the AI-structuring step behind Import & Reconcile's
// "paste research text" upload path (see that page's handlePasteParse).
// Takes whatever free-text research a reviewer already has -- the exact
// same kind of messy "AI research" paste that's been handed to Claude by
// hand, one school at a time, this whole week -- and turns it into the same
// canonical row shape a CSV upload produces (see lib/bulkPasteParse.js).
//
// Deliberately NOT a web-search/verification step -- this trusts the
// human's own already-done research and only structures it, so it gets no
// same-name-school or wrong-coach backstop of its own the way
// lib/coachInfoLookup.js's normalizeSuggestion() does. Whatever comes back
// from here is fed straight into lib/importReconcile.js's categorizeRow()
// by the page, same as a CSV row would be -- so it inherits that tool's
// existing safety net automatically: an ambiguous school name+state match
// still lands in "needs_verification," and a changed coach name on an
// existing school still shows up as a "conflict" needing a human's
// field-by-field approval, exactly like an uploaded spreadsheet row.
export async function POST(req) {
  try {
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
      return NextResponse.json({ error: "Only verification staff or a system admin can use Bulk Paste & Parse." }, { status: 403 });
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: "Bulk Paste & Parse isn't configured yet -- ANTHROPIC_API_KEY is missing from the server environment." }, { status: 500 });
    }

    let body;
    try {
      body = await req.json();
    } catch (_) {
      return NextResponse.json({ error: "Missing request body." }, { status: 400 });
    }
    const text = (body?.text || "").toString().trim();
    if (!text) {
      return NextResponse.json({ error: "Paste some research text first." }, { status: 400 });
    }
    if (text.length > BULK_PARSE_MAX_INPUT_CHARS) {
      return NextResponse.json(
        {
          error: `That's ${text.length.toLocaleString()} characters -- please paste ${BULK_PARSE_MAX_INPUT_CHARS.toLocaleString()} or fewer at a time (split it into two pastes and parse each separately).`,
        },
        { status: 400 }
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
          max_tokens: BULK_PARSE_MAX_TOKENS,
          system: BULK_PARSE_SYSTEM_PROMPT,
          messages: [{ role: "user", content: text }],
        }),
        signal: aiController.signal,
      });
    } catch (aiFetchErr) {
      console.error("Anthropic API fetch error (bulk-parse)", aiFetchErr);
      return NextResponse.json(
        { error: aiFetchErr.name === "AbortError" ? "The AI parse took too long to respond. Try pasting a smaller chunk." : "Could not reach the AI parsing service. Please try again." },
        { status: 502 }
      );
    } finally {
      clearTimeout(aiTimeout);
    }

    if (!aiRes.ok) {
      const detail = await aiRes.text().catch(() => "");
      console.error("Anthropic API error (bulk-parse)", aiRes.status, detail);
      return NextResponse.json({ error: "The AI parsing service returned an error. Please try again in a moment." }, { status: 502 });
    }

    const aiJson = await aiRes.json();
    const rawText = aiJson?.content?.[0]?.text || "";
    const schools = parseBulkSchools(rawText);
    if (!schools) {
      return NextResponse.json(
        { error: "Couldn't parse the AI's response -- if you pasted a lot of text, try splitting it into smaller chunks and parsing each separately." },
        { status: 502 }
      );
    }
    if (!schools.length) {
      return NextResponse.json({ error: "Didn't find any school with both a name and a state in that text. Double check the paste includes both." }, { status: 422 });
    }

    return NextResponse.json({ schools });
  } catch (err) {
    console.error("bulk-parse error", err);
    return NextResponse.json({ error: "Could not parse this text right now. Please try again." }, { status: 500 });
  }
}
