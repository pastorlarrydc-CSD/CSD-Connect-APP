import { NextResponse } from "next/server";
import { getSupabaseRouteClient } from "@/lib/supabase/routeClient";
import { withProtocol } from "@/lib/schoolRecheck";

const REVIEWER_ROLES = ["verifier", "sysadmin"];
const FETCH_TIMEOUT_MS = 8000;
const MAX_BYTES = 400_000;
const MAX_CHARS_PER_SOURCE = 6000;
const USER_AGENT = "CSD-CoachConnect-Verifier/1.0 (+https://csd-coachconnect)";
const MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001";

// AI auto-fill for the Quick Fix panel: instead of a human reading a
// school's athletics site/website by hand to find and retype the head
// football coach's name, email, and phone, this reads the page(s) itself
// and hands back a suggestion for the reviewer to confirm (or correct)
// before saving. Same non-authoritative contract as "Find MaxPreps page"
// and "Find athletics page" -- this NEVER writes to the schools table on
// its own; the reviewer still has to review the suggestion and click
// Save & Mark Verified.
//
// Deliberately reads ONLY athletics_url and website -- never maxpreps_url.
// MaxPreps' Terms of Use prohibit scraping/crawling its own site (see the
// discover-maxpreps route for the fuller explanation of why that route
// only ever searches for a MaxPreps link instead of touching MaxPreps
// itself), and MaxPreps team pages rarely carry a coach's email/phone
// anyway -- a school's own athletics or general site is a far better
// source for actual contact information, and it's the site CSD has an
// unambiguous right to read.
//
// Costs a real Anthropic API call, so -- same as the two Serper-backed
// discovery routes -- this is gated to verifier/sysadmin and only ever
// runs when a human clicks the button. Never on a schedule, never in bulk.

function htmlToText(html) {
  // Same approach as lib/schoolRecheck.js's stripToText, but deliberately
  // does NOT lowercase the result -- that helper only needs to substring-
  // match a last name, but here the extracted text is handed to the model
  // to read names/emails out of, and preserving original capitalization
  // gives it a much better shot at getting a name's casing right.
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchPageText(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: { "User-Agent": USER_AGENT },
    });
    if (!res.ok) return { ok: false, httpStatus: res.status };
    const buf = await res.arrayBuffer();
    const truncated = buf.byteLength > MAX_BYTES ? buf.slice(0, MAX_BYTES) : buf;
    return { ok: true, text: htmlToText(Buffer.from(truncated).toString("utf-8")) };
  } catch (fetchErr) {
    return { ok: false, timedOut: fetchErr.name === "AbortError" };
  } finally {
    clearTimeout(timeout);
  }
}

const SYSTEM_PROMPT = `You are helping a college football recruiting staff verify high-school program contact information. You will be given raw text read from a school's athletics website and/or general website, plus whatever is currently on file. Find the CURRENT HEAD FOOTBALL COACH's name, email, and phone number, if they appear anywhere in the text.

Rules:
- Only extract information about FOOTBALL. Ignore coaches of other sports (basketball, baseball, soccer, track, etc.) even if they're listed right next to the football staff.
- If the page names an Athletic Director or a general athletics-office contact but no specific football head coach, do NOT use that person's name as the coach -- leave the name fields empty rather than guessing. A general office phone/email is still worth returning as a fallback office contact even with no coach named.
- Never invent or guess a name, email, or phone number that isn't actually present in the text. Return empty strings for anything not found.
- If the text mentions a recent coaching change ("new head coach", "interim head coach", "as of [date]"), prefer the most current name and say so in notes.
- Only fill hc_cell if a number is explicitly labeled as a cell/mobile/direct line for that coach. Otherwise put any phone number found in hc_office.
- Set confidence to "high" only when a name is clearly labeled as the football head coach. Use "medium" for real but ambiguous matches (e.g. no clear title, or inferred from a roster/schedule page). Use "low" if you are only partially confident.
- Respond with ONLY a single JSON object, no other text, in exactly this shape:
{"hc_first_name": "", "hc_last_name": "", "hc_email": "", "hc_office": "", "hc_cell": "", "confidence": "high", "source": "athletics site", "notes": "one sentence describing what was found, or why fields were left empty"}`;

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

    const { data: school, error: schoolErr } = await supabase
      .from("schools")
      .select("id,name,city,state,athletics_url,website,hc_first_name,hc_last_name,hc_email,hc_cell,hc_office")
      .eq("id", schoolId)
      .maybeSingle();
    if (schoolErr || !school) {
      return NextResponse.json({ error: "School not found." }, { status: 404 });
    }

    const athleticsUrl = withProtocol(school.athletics_url);
    const websiteUrl = withProtocol(school.website);
    if (!athleticsUrl && !websiteUrl) {
      return NextResponse.json(
        { error: "This school has no athletics site or general website on file to read from. Add one via Quick Fix, then try again." },
        { status: 400 }
      );
    }

    const sources = [];
    if (athleticsUrl) sources.push({ label: "athletics site", url: school.athletics_url, fetchUrl: athleticsUrl });
    if (websiteUrl) sources.push({ label: "general website", url: school.website, fetchUrl: websiteUrl });

    const fetched = await Promise.all(
      sources.map(async (src) => {
        const result = await fetchPageText(src.fetchUrl);
        return { ...src, result };
      })
    );

    const usableBlocks = fetched.filter((f) => f.result.ok && f.result.text);
    if (usableBlocks.length === 0) {
      const failure = fetched[0];
      const reason = failure?.result?.timedOut
        ? "took too long to respond"
        : failure?.result?.httpStatus
        ? `responded with HTTP ${failure.result.httpStatus}`
        : "could not be reached";
      return NextResponse.json({ error: `Could not read this school's site right now -- it ${reason}. Try again in a moment, or check the URL on file.` }, { status: 502 });
    }

    const textBlocks = usableBlocks
      .map((b) => `--- Text from the ${b.label} (${b.url}) ---\n${b.result.text.slice(0, MAX_CHARS_PER_SOURCE)}`)
      .join("\n\n");

    const currentlyOnFile = [
      school.hc_first_name || school.hc_last_name ? `Head coach on file: ${[school.hc_first_name, school.hc_last_name].filter(Boolean).join(" ")}` : "Head coach on file: none",
      school.hc_email ? `Email on file: ${school.hc_email}` : "Email on file: none",
      school.hc_cell ? `Cell on file: ${school.hc_cell}` : null,
      school.hc_office ? `Office phone on file: ${school.hc_office}` : null,
    ]
      .filter(Boolean)
      .join("\n");

    const userMessage = `School: ${school.name}, ${school.city || ""}, ${school.state || ""}\n\n${currentlyOnFile}\n\n${textBlocks}`;

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
        messages: [{ role: "user", content: userMessage }],
      }),
    });

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

    return NextResponse.json({
      hc_first_name: (parsed.hc_first_name || "").toString().trim(),
      hc_last_name: (parsed.hc_last_name || "").toString().trim(),
      hc_email: (parsed.hc_email || "").toString().trim(),
      hc_office: (parsed.hc_office || "").toString().trim(),
      hc_cell: (parsed.hc_cell || "").toString().trim(),
      confidence: ["high", "medium", "low"].includes(parsed.confidence) ? parsed.confidence : "low",
      source: (parsed.source || usableBlocks.map((b) => b.label).join(" + ")).toString(),
      notes: (parsed.notes || "").toString().trim(),
    });
  } catch (err) {
    console.error("discover-coach-info error", err);
    return NextResponse.json({ error: "Could not look up coach info right now. Please try again." }, { status: 500 });
  }
}
