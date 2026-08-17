// Builds a Supabase client scoped to whichever user's access token is
// passed in -- used inside API routes to identify "who is calling this
// route" and read their data under normal Row Level Security (i.e. the
// route sees exactly what that user would see, nothing more). This is
// deliberately NOT the admin client: reads/writes through this client are
// still fully subject to RLS.
import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config";

export function getSupabaseRouteClient(accessToken) {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}
