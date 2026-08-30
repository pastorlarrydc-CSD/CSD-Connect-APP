import { NextResponse } from "next/server";
import { getSupabaseRouteClient } from "@/lib/supabase/routeClient";
import { searchWeb } from "@/lib/coachInfoLookup";
import { buildSocialSourceText } from "@/lib/socialLookup";

const REVIEWER_ROLES = ["verifier", "sysadmin"];

// Prep stage of the overnight Social Media Batch API job -- the social
// counterpart to app/api/admin/athletics-batch/fetch-item. Runs the same
// two site:-restricted Serper searches the single-school "Find Social
// Media" button uses (app/api/schools/[id]/discover-social) -- one for
// Twitter/X, one for Facebook -- and saves both result sets as one block
// of source text ahead of Batch API submission. Needs an actual coach
// name to search on (same reason the single-school button requires one):
// without a name this is just guessing at "[school] twitter", which
// mostly finds the school's own program account rather than the coach's.
// Candidates for this batch job are selected on the review page to
// already have a name on file, but this re-checks defensively in case a
// name gets cleared between when a run starts and when it's fetched.
//
// Runs one item at a time; the review page (/admin/batch-social) drives
// it across a whole run's items with a few requests in flight at once,
// same pattern as every other bulk discovery tool in this app.
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
      return NextResponse.json({ error: "Only verification staff or a system admin can run batch social discovery." }, { status: 403 });
    }

    const serperKey = process.env.SERPER_API_KEY;
    if (!serperKey) {
      return NextResponse.json(
        { error: "Batch social discovery isn't fully configured yet -- SERPER_API_KEY needs to be added in Vercel Project Settings -> Environment Variables." },
        { status: 500 }
      );
    }

    const body = await req.json().catch(() => ({}));
    const itemId = Number(body.itemId);
    if (!itemId) {
      return NextResponse.json({ error: "Missing itemId." }, { status: 400 });
    }

    const { data: item, error: itemErr } = await supabase.from("social_batch_items").select("id,batch_run_id,school_id").eq("id", itemId).maybeSingle();
    if (itemErr || !item) {
      return NextResponse.json({ error: "Batch item not found." }, { status: 404 });
    }

    const { data: school, error: schoolErr } = await supabase
      .from("schools")
      .select("id,name,city,state,hc_first_name,hc_last_name,hc_twitter,hc_facebook")
      .eq("id", item.school_id)
      .maybeSingle();
    if (schoolErr || !school) {
      await supabase.from("social_batch_items").update({ fetch_status: "error" }).eq("id", itemId);
      return NextResponse.json({ error: "School for this item no longer exists." }, { status: 404 });
    }

    const fullName = [school.hc_first_name, school.hc_last_name].filter(Boolean).join(" ");
    if (!fullName) {
      await supabase.from("social_batch_items").update({ fetch_status: "no_content" }).eq("id", itemId);
      return NextResponse.json({ fetch_status: "no_content" });
    }

    // Same query shape as the single-school "Find Social Media" button --
    // site: restricts the search to just that platform's domain.
    const twitterQuery = `(site:x.com OR site:twitter.com) "${fullName}" ${school.name} ${school.city || ""} ${school.state || ""}`;
    const facebookQuery = `site:facebook.com "${fullName}" ${school.name} ${school.city || ""} ${school.state || ""}`;

    const [twitterResults, facebookResults] = await Promise.all([searchWeb(twitterQuery, serperKey), searchWeb(facebookQuery, serperKey)]);

    if (twitterResults.length === 0 && facebookResults.length === 0) {
      await supabase.from("social_batch_items").update({ fetch_status: "no_content" }).eq("id", itemId);
      return NextResponse.json({ fetch_status: "no_content" });
    }

    const sourceText = buildSocialSourceText({ school, twitterResults, facebookResults });

    const { error: updateErr } = await supabase
      .from("social_batch_items")
      .update({ fetch_status: "ready", source_text: sourceText, source_label: "web search" })
      .eq("id", itemId);
    if (updateErr) {
      return NextResponse.json({ error: updateErr.message || "Could not save fetched search results." }, { status: 500 });
    }

    return NextResponse.json({ fetch_status: "ready" });
  } catch (err) {
    console.error("batch-social fetch-item error", err);
    return NextResponse.json({ error: "Could not search for this school's social media. Please try again." }, { status: 500 });
  }
}
