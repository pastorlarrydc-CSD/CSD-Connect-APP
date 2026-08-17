// Server-only Stripe client. Never import this from a "use client" file --
// it reads the secret key from process.env, which is only populated in
// Vercel's serverless runtime, not shipped to the browser bundle.
import Stripe from "stripe";

let stripeClient;

export function getStripe() {
  if (!stripeClient) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) {
      throw new Error("STRIPE_SECRET_KEY is not set. Add it in Vercel Project Settings -> Environment Variables.");
    }
    stripeClient = new Stripe(key);
  }
  return stripeClient;
}
