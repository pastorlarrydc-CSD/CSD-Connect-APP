import { NextResponse } from "next/server";
import { getSupabaseRouteClient } from "@/lib/supabase/routeClient";

// On-demand coach-change check against a school's own website -- the
// "first pass" of automated verification. Strips HTML down to plain text
// and looks for the on-file head coach's last name; any signed-in user can
// trigger it (read-only against the target site, and it never writes to
// the schools table itself -- only logs the result and, on a miss, opens a
// flag in the same review queue a human "flag as outdated" already uses).
const FETCH_TIMEOUT_MS = 8000;
const MAX_BYTES = 400_000;

function withProtocol(v) {
  const trimmed = (v || "").trim();
  if (!trimmed) return null;
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

function stripToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .toLowerCase();
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

    const { data: school, error: schoolErr } = await supabase
      .from("schools")
      .select("id,name,website,hc_first_name,hc_last_name")
      .eq("id", schoolId)
      .maybeSingle();
    if (schoolErr || !school) {
      return NextResponse.json({ error: "School not found." }, { status: 404 });
    }

    async function logAndReturn(result, detail) {
      await supabase.from("school_recheck_log").insert({
        school_id: schoolId,
        checked_by: userData.user.id,
        website_checked: school.website || null,
        coach_name_checked: [school.hc_first_name, school.hc_last_name].filter(Boolean).join(" ") || null,
        result,
        detail,
      });
      return NextResponse.json({ result, detail, checked_at: new Date().toISOString() });
    }

    const lastName = (school.hc_last_name || "").trim();
    if (!lastName) {
      return logAndReturn("no_coach_on_file", "No head coach name on file to check against the website.");
    }

    const url = withProtocol(school.website);
    if (!url) {
      return logAndReturn("no_website", "No website on file for this school.");
    }

    let text;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      const res = await fetch(url, {
        signal: controller.signal,
        redirect: "follow",
        headers: { "User-Agent": "CSD-CoachConnect-Verifier/1.0 (+https://csd-coachconnect)" },
      });
      clearTimeout(timeout);
      if (!res.ok) {
        return logAndReturn("fetch_error", `Site responded with HTTP ${res.status}.`);
      }
      const buf = await res.arrayBuffer();
      const truncated = buf.byteLength > MAX_BYTES ? buf.slice(0, MAX_BYTES) : buf;
      text = stripToText(Buffer.from(truncated).toString("utf-8"));
    } catch (fetchErr) {
      return logAndReturn("fetch_error", fetchErr.name === "AbortError" ? "The site took too long to respond." : "Could not reach this website.");
    }

    const found = text.includes(lastName.toLowerCase());
    if (found) {
      return logAndReturn("confirmed", `"${lastName}" was found on ${school.website}.`);
    }

    // A miss doesn't mean the coach is definitely gone -- rosters pages
    // vary wildly -- but it's worth a human verifier's eyes, so this opens
    // the same review queue "flag as outdated" already feeds.
    await supabase.from("school_flags").insert({
      school_id: schoolId,
      flagged_by: userData.user.id,
      reason: `Automated recheck: "${lastName}" was not found on ${school.website}. May be outdated -- please verify.`,
    });

    return logAndReturn("not_found", `"${lastName}" was not found on ${school.website}. Flagged for a verifier to review.`);
  } catch (err) {
    console.error("school recheck error", err);
    return NextResponse.json({ error: "Could not run this check. Please try again." }, { status: 500 });
  }
}
