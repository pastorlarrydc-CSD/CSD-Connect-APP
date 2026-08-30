import { NextResponse } from "next/server";
import { getSupabaseRouteClient } from "@/lib/supabase/routeClient";
import { searchWeb } from "@/lib/coachInfoLookup";
import { buildMaxPrepsSourceText } from "@/lib/maxPrepsLookup";

const REVIEWER_ROLES = ["verifier", "sysadmin"];

// Prep stage of the overnight MaxPreps-URL Batch API job -- the MaxPreps
// counterpart to app/api/admin/athletics-batch/fetch-item (see that route
// for the pattern this mirrors). Anthropic's Batch API can't search the web
// itself, so before a batch run's items can be submitted, each one needs
// its search results fetched and assembled into source text ahead of time.
// Same site:maxpreps.com-restricted query the single-school "Find MaxPreps
// page" button uses (app/api/schools/[id]/discover-maxpreps) -- one Serper
// search per school, hands the raw candidate list to the model to pick from
// at submit time.
//
// Runs one item at a time; the review page (/admin/batch-maxpreps) drives it
// across a whole run's items with a few requests in flight at once, same
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
      return NextResponse.json({ error: "Only verification staff or a system admin can run batch MaxPreps discovery." }, { status: 403 });
    }

    const serperKey = process.env.SERPER_API_KEY;
    if (!serperKey) {
      return NextResponse.json(
        { error: "Batch MaxPreps discovery isn't fully configured yet -- SERPER_API_KEY needs to be added in Vercel Project Settings -> Environment Variables." },
        { status: 500 }
      );
    }

    const body = await req.json().catch(() => ({}));
    const itemId = Number(body.itemId);
    if (!itemId) {
      return NextResponse.json({ error: "Missing itemId." }, { status: 400 });
    }

    const { data: item, error: itemErr } = await supabase.from("maxpreps_batch_items").select("id,batch_run_id,school_id").eq("id", itemId).maybeSingle();
    if (itemErr || !item) {
      return NextResponse.json({ error: "Batch item not found." }, { status: 404 });
    }

    const { data: school, error: schoolErr } = await supabase
      .from("schools")
      .select("id,name,city,state,maxpreps_url")
      .eq("id", item.school_id)
      .maybeSingle();
    if (schoolErr || !school) {
      await supabase.from("maxpreps_batch_items").update({ fetch_status: "error" }).eq("id", itemId);
      return NextResponse.json({ error: "School for this item no longer exists." }, { status: 404 });
    }

    // Same query shape as the single-school "Find MaxPreps page" button
    // (app/api/schools/[id]/discover-maxpreps) -- no exact-phrase quoting
    // around school.name, since MaxPreps sometimes lists a school under a
    // different public-facing name than the legal/CSD name on file.
    const searchQuery = `site:maxpreps.com ${school.name} ${school.city || ""} ${school.state || ""} football`;
    const rawResults = await searchWeb(searchQuery, serperKey);
    // Belt-and-suspenders on top of the site: restriction -- Serper
    // occasionally returns a stray off-site result even for a site:-scoped
    // query, so only pass the model links that actually land on maxpreps.com.
    const searchResults = rawResults.filter((r) => r.link && r.link.includes("maxpreps.com"));

    if (searchResults.length === 0) {
      await supabase.from("maxpreps_batch_items").update({ fetch_status: "no_content" }).eq("id", itemId);
      return NextResponse.json({ fetch_status: "no_content" });
    }

    const sourceText = buildMaxPrepsSourceText({ school, searchResults, searchQuery });

    const { error: updateErr } = await supabase
      .from("maxpreps_batch_items")
      .update({ fetch_status: "ready", source_text: sourceText, source_label: "web search" })
      .eq("id", itemId);
    if (updateErr) {
      return NextResponse.json({ error: updateErr.message || "Could not save fetched search results." }, { status: 500 });
    }

    return NextResponse.json({ fetch_status: "ready" });
  } catch (err) {
    console.error("batch-maxpreps fetch-item error", err);
    return NextResponse.json({ error: "Could not search for this school's MaxPreps page. Please try again." }, { status: 500 });
  }
}
