// Server-only Stripe client. Never import this from a "use client" file --
// it reads the secret key from process.env, which is only populated in
// Vercel's serverless runtime, not shipped to the browser bundle.
import Stripe from "stripe";

let stripeClient;

export function getStripe() {
  if (!stripeClient) {
    const rawKey = process.env.STRIPE_SECRET_KEY;
    if (!rawKey) {
      throw new Error("STRIPE_SECRET_KEY is not set. Add it in Vercel Project Settings -> Environment Variables.");
    }
    // Trim defensively -- a stray trailing newline or space pasted into
    // Vercel's env var field is a common mistake, and an untrimmed key
    // produces a confusing low-level error ("Invalid character in header
    // content") deep inside Stripe's HTTP client rather than a clear one.
    const key = rawKey.trim();
    if (key !== rawKey) {
      console.warn("STRIPE_SECRET_KEY had leading/trailing whitespace; trimmed automatically. Consider re-saving it clean in Vercel.");
    }
    stripeClient = new Stripe(key);
  }
  return stripeClient;
}
