import { NextResponse } from "next/server";
import { getSupabaseRouteClient } from "@/lib/supabase/routeClient";
import crypto from "crypto";

// Sends one real, synchronous test POST to the college's configured webhook
// URL so the "Send Test Webhook" button on the Integrations page can show an
// immediate pass/fail -- unlike the real event triggers (which fire
// fire-and-forget via pg_net and don't report a result back to any UI).
const INTEGRATIONS_ADMIN_ROLES = ["sysadmin", "athletic_director"];

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

    const { data: profile } = await supabase
      .from("profiles")
      .select("role, college_id, full_name")
      .eq("id", userData.user.id)
      .maybeSingle();
    if (!profile?.college_id) {
      return NextResponse.json({ error: "No college on your account yet." }, { status: 400 });
    }
    if (!INTEGRATIONS_ADMIN_ROLES.includes(profile.role)) {
      return NextResponse.json(
        { error: "Only a System Admin or Athletic Director can manage integrations for your program." },
        { status: 403 }
      );
    }

    const { data: sub, error: subErr } = await supabase
      .from("webhook_subscriptions")
      .select("url,secret")
      .eq("college_id", profile.college_id)
      .maybeSingle();
    if (subErr || !sub) {
      return NextResponse.json({ error: "Save a webhook URL first, then send a test." }, { status: 400 });
    }

    const payload = {
      event: "test",
      college_id: profile.college_id,
      occurred_at: new Date().toISOString(),
      data: {
        message: "This is a test event from CSD CoachConnect.",
        sent_by: profile.full_name || null,
      },
    };
    const body = JSON.stringify(payload);
    const signature = crypto.createHmac("sha256", sub.secret).update(body).digest("hex");

    let status = null;
    let ok = false;
    let detail = "";
    try {
      const res = await fetch(sub.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-CoachConnect-Event": "test",
          "X-CoachConnect-Signature": `sha256=${signature}`,
        },
        body,
        signal: AbortSignal.timeout(10000),
      });
      status = res.status;
      ok = res.ok;
      const text = await res.text().catch(() => "");
      detail = text ? text.slice(0, 300) : "";
    } catch (err) {
      return NextResponse.json({ error: `Could not reach that URL: ${err.message || "request failed"}` }, { status: 502 });
    }

    return NextResponse.json({ ok, status, detail });
  } catch (err) {
    console.error("webhook test error", err);
    return NextResponse.json({ error: "Could not send the test webhook. Please try again." }, { status: 500 });
  }
}
