import { NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";

// School lookup for the public "Submit a Prospect" form
// (app/submit-prospect) -- deliberately NOT the same schools_select RLS
// policy the rest of the app uses (that policy requires an authenticated
// session), since a high school coach filling out this form has no
// account. Uses the service-role client instead, but only ever exposes
// id/name/city/state -- the same handful of fields already shown in the
// in-app school-search autocomplete on app/(app)/prospects/page.js -- and
// never anything from the head-coach contact fields or verification data.
//
// GET-only, read-only, no write path here at all. Query length is capped
// at 2 characters minimum (same as the in-app version) so this can't be
// used to page through the entire schools table one character at a time.
export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const q = (searchParams.get("q") || "").trim().slice(0, 100);
    if (q.length < 2) {
      return NextResponse.json({ schools: [] });
    }

    const supabase = getSupabaseAdminClient();
    const { data, error } = await supabase
      .from("schools")
      .select("id,name,city,state")
      .ilike("name", `%${q}%`)
      .order("name", { ascending: true })
      .limit(8);

    if (error) throw error;
    return NextResponse.json({ schools: data || [] });
  } catch (err) {
    console.error("public school search error", err);
    return NextResponse.json({ error: "Could not search schools right now." }, { status: 500 });
  }
}
