import { NextResponse } from "next/server";
import { getSupabaseRouteClient } from "@/lib/supabase/routeClient";
import crypto from "crypto";

// Generic outbound webhook configuration for a college's account -- lets a
// program wire CoachConnect activity (contacts logged, schools watchlisted,
// recruiting status changes) into HubSpot, Zapier, Make, or anything else
// that can receive a signed JSON POST. Actual delivery happens entirely in
// Postgres -- see the add_film_notes_and_webhook_integration migration
// (dispatch_webhook() + per-table triggers, fired fire-and-forget via
// pg_net) -- this route only manages the subscription record itself.
//
// RLS on webhook_subscriptions only enforces tenant isolation (same
// convention as every other college-scoped table here). Who's allowed to
// change the URL/secret is enforced at this layer, same pattern as the
// Stripe billing routes.
const INTEGRATIONS_ADMIN_ROLES = ["sysadmin", "athletic_director"];

async function authenticate(req) {
  const authHeader = req.headers.get("authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) {
    return { error: NextResponse.json({ error: "Not signed in." }, { status: 401 }) };
  }
  const supabase = getSupabaseRouteClient(token);
  const { data: userData, error: userErr } = await supabase.auth.getUser();
  if (userErr || !userData?.user) {
    return { error: NextResponse.json({ error: "Not signed in." }, { status: 401 }) };
  }
  const { data: profile } = await supabase
    .from("profiles")
    .select("role, college_id")
    .eq("id", userData.user.id)
    .maybeSingle();
  if (!profile?.college_id) {
    return { error: NextResponse.json({ error: "No college on your account yet." }, { status: 400 }) };
  }
  return { supabase, user: userData.user, profile };
}

export async function GET(req) {
  const auth = await authenticate(req);
  if (auth.error) return auth.error;
  const { supabase, profile } = auth;

  const { data, error } = await supabase
    .from("webhook_subscriptions")
    .select("url,secret,is_active,last_triggered_at,last_event,created_at,updated_at")
    .eq("college_id", profile.college_id)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ subscription: data || null, canManage: INTEGRATIONS_ADMIN_ROLES.includes(profile.role) });
}

export async function PUT(req) {
  const auth = await authenticate(req);
  if (auth.error) return auth.error;
  const { supabase, user, profile } = auth;

  if (!INTEGRATIONS_ADMIN_ROLES.includes(profile.role)) {
    return NextResponse.json(
      { error: "Only a System Admin or Athletic Director can manage integrations for your program." },
      { status: 403 }
    );
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const url = (body?.url || "").trim();
  if (!url || !/^https:\/\/.+/i.test(url)) {
    return NextResponse.json({ error: "Please provide a valid https:// webhook URL." }, { status: 400 });
  }

  const { data: existing } = await supabase
    .from("webhook_subscriptions")
    .select("id,secret")
    .eq("college_id", profile.college_id)
    .maybeSingle();

  const secret = body?.regenerate_secret || !existing ? crypto.randomBytes(24).toString("hex") : existing.secret;
  const isActive = body?.is_active !== false;

  const { error } = await supabase.from("webhook_subscriptions").upsert(
    {
      college_id: profile.college_id,
      url,
      secret,
      is_active: isActive,
      created_by: user.id,
    },
    { onConflict: "college_id" }
  );
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, secret });
}

export async function DELETE(req) {
  const auth = await authenticate(req);
  if (auth.error) return auth.error;
  const { supabase, profile } = auth;

  if (!INTEGRATIONS_ADMIN_ROLES.includes(profile.role)) {
    return NextResponse.json(
      { error: "Only a System Admin or Athletic Director can manage integrations for your program." },
      { status: 403 }
    );
  }

  const { error } = await supabase.from("webhook_subscriptions").delete().eq("college_id", profile.college_id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
