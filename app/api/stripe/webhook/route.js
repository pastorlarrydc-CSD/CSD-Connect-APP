import { NextResponse } from "next/server";
import { getStripe } from "@/lib/stripe/server";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";

// Stripe requires the raw, unparsed request body to verify the webhook
// signature -- Next.js App Router route handlers don't auto-parse the
// body, so req.text() below already gives us that raw string.
export async function POST(req) {
  const stripe = getStripe();
  const signature = req.headers.get("stripe-signature");
  const rawBody = await req.text();

  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("Stripe webhook signature verification failed", err.message);
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  const admin = getSupabaseAdminClient();

  try {
    switch (event.type) {
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        const sub = event.data.object;
        const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer?.id;
        if (!customerId) break;

        const status = event.type === "customer.subscription.deleted" ? "canceled" : sub.status;
        const currentPeriodEnd = sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null;
        const trialEndsAt = sub.trial_end ? new Date(sub.trial_end * 1000).toISOString() : null;

        const { error } = await admin
          .from("colleges")
          .update({
            stripe_subscription_id: sub.id,
            subscription_status: status,
            trial_ends_at: trialEndsAt,
            current_period_end: currentPeriodEnd,
            billing_updated_at: new Date().toISOString(),
          })
          .eq("stripe_customer_id", customerId);

        if (error) console.error("Failed to sync subscription to colleges table", error);
        break;
      }
      default:
        // Ignore other event types -- we only care about subscription lifecycle.
        break;
    }
  } catch (err) {
    // Log but still return 200: Stripe retries on non-2xx, and a bug in
    // our own DB sync shouldn't cause Stripe to keep hammering the
    // endpoint indefinitely. We'd rather investigate from logs.
    console.error("Error processing Stripe webhook event", event.type, err);
  }

  return NextResponse.json({ received: true });
}
