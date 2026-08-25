import { NextResponse } from "next/server";
import { getSupabaseRouteClient } from "@/lib/supabase/routeClient";
import { withProtocol } from "@/lib/schoolRecheck";
import { fetchPageText, searchWeb, buildSourceBlocks } from "@/lib/coachInfoLookup";

const REVIEWER_ROLES = ["verifier", "sysadmin"];

// Prep stage of the overnight Coach-Info Batch API job (see the spec doc in
// the project docs). Anthropic's Batch API can't fetch web pages itself --
// it only accepts already-assembled text -- so before a batch run's items
// can be submitted, each one needs its source text (athletics/website page
// text + a web search, same sources the single-school "Suggest Coach Info
// (AI)" button uses) fetched and saved ahead of time. This route does that
// for ONE item at a time; the review page (/admin/batch-coach-info) drives
// it across a whole run's items with a few requests in flight at once,
// same pattern as Bulk MaxPreps/Athletics/Social Media Discovery.
//
// Deliberately reuses fetchPageText/searchWeb/buildSourceBlocks from
// lib/coachInfoLookup -- the exact same fetch-and-assemble logic the
// single-school route uses -- so a batch item's saved source text is
// built the same way a live click would have built it.
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
      return NextResponse.json({ error: "Only verification staff or a system admin can run batch coach-info discovery." }, { status: 403 });
    }

    const serperKey = process.env.SERPER_API_KEY;
    if (!serperKey) {
      return NextResponse.json(
        { error: "Batch coach-info discovery isn't fully configured yet -- SERPER_API_KEY needs to be added in Vercel Project Settings -> Environment Variables." },
        { status: 500 }
      );
    }

    const body = await req.json().catch(() => ({}));
    const itemId = Number(body.itemId);
    if (!itemId) {
      return NextResponse.json({ error: "Missing itemId." }, { status: 400 });
    }

    const { data: item, error: itemErr } = await supabase.from("coach_info_batch_items").select("id,batch_run_id,school_id").eq("id", itemId).maybeSingle();
    if (itemErr || !item) {
      return NextResponse.json({ error: "Batch item not found." }, { status: 404 });
    }

    const { data: school, error: schoolErr } = await supabase
      .from("schools")
      .select("id,name,city,state,athletics_url,website,hc_first_name,hc_last_name,hc_email,hc_cell,hc_office,hc_twitter,hc_facebook")
      .eq("id", item.school_id)
      .maybeSingle();
    if (schoolErr || !school) {
      await supabase.from("coach_info_batch_items").update({ fetch_status: "error" }).eq("id", itemId);
      return NextResponse.json({ error: "School for this item no longer exists." }, { status: 404 });
    }

    const athleticsUrl = withProtocol(school.athletics_url);
    const websiteUrl = withProtocol(school.website);
    const searchQuery = `${school.name} ${school.city || ""} ${school.state || ""} head football coach`;

    const [athleticsFetch, websiteFetch, searchResults] = await Promise.all([
      athleticsUrl ? fetchPageText(athleticsUrl) : Promise.resolve(null),
      websiteUrl ? fetchPageText(websiteUrl) : Promise.resolve(null),
      searchWeb(searchQuery, serperKey),
    ]);

    const { hasUsableContent, userMessage, defaultSource } = buildSourceBlocks({ school, athleticsFetch, websiteFetch, searchResults, searchQuery });

    if (!hasUsableContent) {
      await supabase.from("coach_info_batch_items").update({ fetch_status: "no_content" }).eq("id", itemId);
      return NextResponse.json({ fetch_status: "no_content" });
    }

    const { error: updateErr } = await supabase
      .from("coach_info_batch_items")
      .update({ fetch_status: "ready", source_text: userMessage, source_label: defaultSource })
      .eq("id", itemId);
    if (updateErr) {
      return NextResponse.json({ error: updateErr.message || "Could not save fetched text." }, { status: 500 });
    }

    return NextResponse.json({ fetch_status: "ready", source_label: defaultSource });
  } catch (err) {
    console.error("batch-coach-info fetch-item error", err);
    return NextResponse.json({ error: "Could not fetch this school's source text. Please try again." }, { status: 500 });
  }
}
