import { NextResponse } from "next/server";
import { getStripe } from "@/lib/stripe/server";
import { getSupabaseRouteClient } from "@/lib/supabase/routeClient";

const BILLING_ADMIN_ROLES = ["sysadmin", "athletic_director"];

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

    const { data: profile, error: profileErr } = await supabase
      .from("profiles")
      .select("role, college_id")
      .eq("id", userData.user.id)
      .maybeSingle();
    if (profileErr || !profile?.college_id) {
      return NextResponse.json({ error: "No college on this account yet." }, { status: 400 });
    }
    if (!BILLING_ADMIN_ROLES.includes(profile.role)) {
      return NextResponse.json(
        { error: "Only a System Admin or Athletic Director can manage billing for your program." },
        { status: 403 }
      );
    }

    const { data: college, error: collegeErr } = await supabase
      .from("colleges")
      .select("id, stripe_customer_id")
      .eq("id", profile.college_id)
      .maybeSingle();
    if (collegeErr || !college?.stripe_customer_id) {
      return NextResponse.json({ error: "No billing account on file yet." }, { status: 400 });
    }

    const stripe = getStripe();
    const origin = req.headers.get("origin") || new URL(req.url).origin;

    const portalSession = await stripe.billingPortal.sessions.create({
      customer: college.stripe_customer_id,
      return_url: `${origin}/billing`,
    });

    return NextResponse.json({ url: portalSession.url });
  } catch (err) {
    console.error("create-portal-session error", err);
    return NextResponse.json({ error: "Could not open billing portal. Please try again." }, { status: 500 });
  }
}
