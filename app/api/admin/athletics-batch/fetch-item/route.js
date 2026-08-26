import { NextResponse } from "next/server";
import { getSupabaseRouteClient } from "@/lib/supabase/routeClient";
import { searchWeb } from "@/lib/coachInfoLookup";
import { EXCLUDED_HOSTS, buildAthleticsSourceText } from "@/lib/athleticsLookup";

const REVIEWER_ROLES = ["verifier", "sysadmin"];

// Prep stage of the overnight Athletics-URL Batch API job -- the athletics
// counterpart to app/api/admin/batch-coach-info/fetch-item. Anthropic's
// Batch API can't search the web itself, so before a batch run's items can
// be submitted, each one needs its search results fetched and assembled
// into source text ahead of time. Unlike the coach-info prep route, this
// never fetches a page's actual content -- there's no known URL yet to
// fetch, since finding that URL is the whole point. It only runs ONE
// Serper search per school (same query the single-school "Find athletics
// page" button uses) and hands the raw candidate list to the model to pick
// from at submit time.
//
// Runs one item at a time; the review page (/admin/batch-athletics) drives
// it across a whole run's items with a few requests in flight at once, same
// pattern as every other bulk discovery tool in this app.
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
      return NextResponse.json({ error: "Only verification staff or a system admin can run batch athletics discovery." }, { status: 403 });
    }

    const serperKey = process.env.SERPER_API_KEY;
    if (!serperKey) {
      return NextResponse.json(
        { error: "Batch athletics discovery isn't fully configured yet -- SERPER_API_KEY needs to be added in Vercel Project Settings -> Environment Variables." },
        { status: 500 }
      );
    }

    const body = await req.json().catch(() => ({}));
    const itemId = Number(body.itemId);
    if (!itemId) {
      return NextResponse.json({ error: "Missing itemId." }, { status: 400 });
    }

    const { data: item, error: itemErr } = await supabase.from("athletics_batch_items").select("id,batch_run_id,school_id").eq("id", itemId).maybeSingle();
    if (itemErr || !item) {
      return NextResponse.json({ error: "Batch item not found." }, { status: 404 });
    }

    const { data: school, error: schoolErr } = await supabase
      .from("schools")
      .select("id,name,city,state,athletics_url")
      .eq("id", item.school_id)
      .maybeSingle();
    if (schoolErr || !school) {
      await supabase.from("athletics_batch_items").update({ fetch_status: "error" }).eq("id", itemId);
      return NextResponse.json({ error: "School for this item no longer exists." }, { status: 404 });
    }

    // Same query shape as the single-school "Find athletics page" button
    // (app/api/schools/[id]/discover-athletics) -- no exact-phrase quoting
    // around school.name, since a school's athletics site sometimes uses a
    // different public-facing name (mascot name, district branding, etc.)
    // than the legal/CSD name on file.
    const searchQuery = `${school.name} ${school.city || ""} ${school.state || ""} athletics department football`;
    const rawResults = await searchWeb(searchQuery, serperKey);
    const searchResults = rawResults.filter((r) => !EXCLUDED_HOSTS.some((host) => r.link.includes(host)));

    if (searchResults.length === 0) {
      await supabase.from("athletics_batch_items").update({ fetch_status: "no_content" }).eq("id", itemId);
      return NextResponse.json({ fetch_status: "no_content" });
    }

    const sourceText = buildAthleticsSourceText({ school, searchResults, searchQuery });

    const { error: updateErr } = await supabase
      .from("athletics_batch_items")
      .update({ fetch_status: "ready", source_text: sourceText, source_label: "web search" })
      .eq("id", itemId);
    if (updateErr) {
      return NextResponse.json({ error: updateErr.message || "Could not save fetched search results." }, { status: 500 });
    }

    return NextResponse.json({ fetch_status: "ready" });
  } catch (err) {
    console.error("batch-athletics fetch-item error", err);
    return NextResponse.json({ error: "Could not search for this school's athletics site. Please try again." }, { status: 500 });
  }
}
