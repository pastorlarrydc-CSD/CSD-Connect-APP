// Server-only Supabase client using the service_role key. This bypasses
// Row Level Security entirely, so it must ONLY be used inside trusted
// server code (API routes) that has already authenticated the caller and
// checked their role -- never import this from a "use client" file, and
// never let a route pass raw client input straight through to a table
// write with this client without checking permissions first.
import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL } from "./config";

let adminClient;

export function getSupabaseAdminClient() {
  if (!adminClient) {
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!key) {
      throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set. Add it in Vercel Project Settings -> Environment Variables.");
    }
    adminClient = createClient(SUPABASE_URL, key, { auth: { persistSession: false, autoRefreshToken: false } });
  }
  return adminClient;
}
