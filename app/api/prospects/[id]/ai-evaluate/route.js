import { NextResponse } from "next/server";
import { getSupabaseRouteClient } from "@/lib/supabase/routeClient";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";

// On-demand AI scouting layer for a single prospect. Deliberately NOT
// automatic/bulk -- it only runs when a signed-in user clicks "Generate AI
// Insight" on a prospect's profile, so cost stays proportional to actual
// usage. Output is always kept separate from verified/self-reported facts:
// it's written to its own ai_* columns (see prospects table) and the UI is
// responsible for labeling it "AI-generated -- not verified".
//
// This is a DIFFERENT signal than prospects.is_underexposed (a free,
// always-on, rules-only computed column -- see the
// add_prospect_measurables_and_ai_evaluation migration). That one costs
// nothing and runs on every row automatically. This route is the deeper,
// opt-in AI pass a coach can request for a prospect they're already
// looking at.
const MODEL = process.env.ANTHROPIC_MODEL || "claude-3-5-haiku-20241022";
const CACHE_WINDOW_MS = 60 * 1000; // avoid double-click / accidental re-spend

const SYSTEM_PROMPT = `You are a football recruiting analyst helping small-college coaches (D2, D3, NAIA, JUCO) quickly evaluate high-school prospects. You will be given structured facts about one athlete -- measurables, offers, coach notes, whether film is on file, and their current school's classification. Write a short, honest scouting take.

Rules:
- Base your summary ONLY on the facts given. Never invent stats, offers, or accomplishments that were not provided.
- If key information is missing (e.g. no measurables, no film), say so plainly rather than guessing.
- Keep the summary factual and useful to a recruiter deciding whether to spend time on this prospect -- not hype.
- "sleeper" means: this athlete looks like they could be a legitimate contributor at the small-college level but appears to have little recruiting attention yet (few or no offers). Judge this from the facts given, not just the absence of offers alone.
- Respond with ONLY a single JSON object, no other text, in exactly this shape:
{"summary": "2-3 sentence scouting take", "sleeper": true or false, "sleeper_reason": "one sentence explaining the sleeper judgment, or empty string if sleeper is false"}`;

function buildFactSheet(prospect) {
  const lines = [];
  lines.push(`Name: ${prospect.athlete_name}`);
  if (prospect.grad_year) lines.push(`Graduation year: ${prospect.grad_year}`);
  if (prospect.position) lines.push(`Position: ${prospect.position}`);
  if (prospect.level_of_play) lines.push(`Self-reported target level: ${prospect.level_of_play}`);
  if (prospect.height || prospect.weight) lines.push(`Size: ${prospect.height || "unknown height"}, ${prospect.weight || "unknown weight"}`);
  if (prospect.gpa != null) lines.push(`GPA: ${prospect.gpa}`);
  const measurables = [];
  if (prospect.forty_yard_dash != null) measurables.push(`40-yard dash: ${prospect.forty_yard_dash}s`);
  if (prospect.vertical_jump != null) measurables.push(`Vertical jump: ${prospect.vertical_jump}in`);
  if (prospect.broad_jump != null) measurables.push(`Broad jump: ${prospect.broad_jump}in`);
  if (prospect.bench_press_reps != null) measurables.push(`Bench press: ${prospect.bench_press_reps} reps at 225lbs`);
  if (prospect.shuttle_time != null) measurables.push(`Shuttle: ${prospect.shuttle_time}s`);
  lines.push(measurables.length ? `Measurables on file: ${measurables.join("; ")}` : "Measurables on file: none");
  lines.push(`Film (Hudl) on file: ${prospect.hudl_url ? "yes" : "no"}`);
  lines.push(`Offers received (self/coach reported): ${prospect.offers_received ? prospect.offers_received : "none on file"}`);
  lines.push(`Committed to: ${prospect.committed_to || "not committed"}`);
  lines.push(`Coach evaluation on file: ${prospect.coach_evaluation ? `"${prospect.coach_evaluation}"` : "none"}`);
  if (prospect.schools?.name) {
    lines.push(`High school: ${prospect.schools.name}, ${prospect.schools.city || "unknown city"}, ${prospect.schools.state || ""}`.trim());
    if (prospect.schools.classification) lines.push(`School classification: ${prospect.schools.classification}`);
  } else {
    lines.push("High school: not linked in our system");
  }
  return lines.join("\n");
}

function parseModelJson(text) {
  const trimmed = (text || "").trim();
  try {
    return JSON.parse(trimmed);
  } catch (_) {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch (_) {
        return null;
      }
    }
    return null;
  }
}

export async function POST(req, { params }) {
  try {
    const prospectId = Number(params.id);
    const authHeader = req.headers.get("authorization") || "";
    const token = authHeader.replace(/^Bearer\s+/i, "");
    if (!token) {
      return NextResponse.json({ error: "Not signed in." }, { status: 401 });
    }

    const routeClient = getSupabaseRouteClient(token);
    const { data: userData, error: userErr } = await routeClient.auth.getUser();
    if (userErr || !userData?.user) {
      return NextResponse.json({ error: "Not signed in." }, { status: 401 });
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: "AI evaluation isn't configured yet -- ANTHROPIC_API_KEY is missing from the server environment." },
        { status: 500 }
      );
    }

    const admin = getSupabaseAdminClient();
    const { data: prospect, error: prospectErr } = await admin
      .from("prospects")
      .select(
        "id,athlete_name,grad_year,position,height,weight,gpa,forty_yard_dash,vertical_jump,broad_jump,bench_press_reps,shuttle_time,hudl_url,offers_received,committed_to,coach_evaluation,level_of_play,ai_summary,ai_sleeper_flag,ai_sleeper_reason,ai_evaluated_at,schools(name,city,state,classification)"
      )
      .eq("id", prospectId)
      .maybeSingle();
    if (prospectErr || !prospect) {
      return NextResponse.json({ error: "Prospect not found." }, { status: 404 });
    }

    // Serve a cached result if this was just generated -- guards against a
    // double click firing two paid API calls back to back.
    if (prospect.ai_evaluated_at && Date.now() - new Date(prospect.ai_evaluated_at).getTime() < CACHE_WINDOW_MS) {
      return NextResponse.json({
        summary: prospect.ai_summary,
        sleeper: prospect.ai_sleeper_flag,
        sleeper_reason: prospect.ai_sleeper_reason,
        evaluated_at: prospect.ai_evaluated_at,
        cached: true,
      });
    }

    const factSheet = buildFactSheet(prospect);

    const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
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
        messages: [{ role: "user", content: factSheet }],
      }),
    });

    if (!aiRes.ok) {
      const detail = await aiRes.text().catch(() => "");
      console.error("Anthropic API error", aiRes.status, detail);
      return NextResponse.json({ error: "The AI evaluation service returned an error. Please try again in a moment." }, { status: 502 });
    }

    const aiJson = await aiRes.json();
    const rawText = aiJson?.content?.[0]?.text || "";
    const parsed = parseModelJson(rawText);
    if (!parsed || typeof parsed.summary !== "string") {
      console.error("Could not parse AI response", rawText);
      return NextResponse.json({ error: "Could not parse the AI response. Please try again." }, { status: 502 });
    }

    const evaluatedAt = new Date().toISOString();
    const update = {
      ai_summary: parsed.summary.trim(),
      ai_sleeper_flag: !!parsed.sleeper,
      ai_sleeper_reason: parsed.sleeper_reason ? String(parsed.sleeper_reason).trim() : null,
      ai_evaluated_at: evaluatedAt,
    };

    const { error: updateErr } = await admin.from("prospects").update(update).eq("id", prospectId);
    if (updateErr) {
      console.error("Failed to save AI evaluation", updateErr);
      return NextResponse.json({ error: "Generated the evaluation but could not save it. Please try again." }, { status: 500 });
    }

    return NextResponse.json({
      summary: update.ai_summary,
      sleeper: update.ai_sleeper_flag,
      sleeper_reason: update.ai_sleeper_reason,
      evaluated_at: evaluatedAt,
      cached: false,
    });
  } catch (err) {
    console.error("AI evaluate error", err);
    return NextResponse.json({ error: "Could not generate an AI evaluation right now. Please try again." }, { status: 500 });
  }
}
