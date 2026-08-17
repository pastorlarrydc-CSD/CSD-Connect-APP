import { NextResponse } from "next/server";
import { getStripe } from "@/lib/stripe/server";
import { STRIPE_PRICE_ID, TRIAL_PERIOD_DAYS } from "@/lib/stripe/config";
import { getSupabaseRouteClient } from "@/lib/supabase/routeClient";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";

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
      .select("id, name, stripe_customer_id, subscription_status")
      .eq("id", profile.college_id)
      .maybeSingle();
    if (collegeErr || !college) {
      return NextResponse.json({ error: "College not found." }, { status: 404 });
    }
    if (["active", "trialing"].includes(college.subscription_status)) {
      return NextResponse.json(
        { error: "This college already has a subscription. Use Manage Billing instead." },
        { status: 400 }
      );
    }

    const stripe = getStripe();
    const admin = getSupabaseAdminClient();

    let customerId = college.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        name: college.name,
        metadata: { college_id: college.id },
      });
      customerId = customer.id;
      await admin.from("colleges").update({ stripe_customer_id: customerId }).eq("id", college.id);
    }

    const origin = req.headers.get("origin") || new URL(req.url).origin;

    const checkoutSession = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: [{ price: STRIPE_PRICE_ID, quantity: 1 }],
      subscription_data: { trial_period_days: TRIAL_PERIOD_DAYS },
      allow_promotion_codes: true,
      success_url: `${origin}/billing?checkout=success`,
      cancel_url: `${origin}/billing?checkout=cancelled`,
    });

    return NextResponse.json({ url: checkoutSession.url });
  } catch (err) {
    console.error("create-checkout-session error", err);
    return NextResponse.json({ error: "Could not start checkout. Please try again." }, { status: 500 });
  }
}
