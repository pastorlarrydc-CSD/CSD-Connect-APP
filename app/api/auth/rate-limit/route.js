import { NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";

// Basic, dependency-free abuse protection for the three public auth entry
// points (login, signup, forgot-password) -- none of them had anything
// beyond Supabase Auth's own built-in limits before this. No captcha
// service is configured in this app, so this is a plain sliding-window
// counter backed by one small table (auth_attempt_log) instead.
//
// Deliberately does NOT touch the Stripe webhook or the cron routes:
// the Stripe webhook is already protected by cryptographic signature
// verification (stripe.webhooks.constructEvent), which is strictly
// stronger than a request-count limit, and the cron routes are already
// gated by a long random CRON_SECRET that Vercel Cron itself calls with --
// adding rate-limiting there risks accidentally throttling Vercel's own
// scheduled calls for close to zero real security benefit.
const WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const MAX_PER_IP = 8;
const MAX_PER_IDENTIFIER = 6;
const KINDS = ["login", "signup", "forgot_password"];

function getClientIp(req) {
  // Vercel sets x-forwarded-for on every request; the first entry is the
  // original client. Falls back to a constant bucket if it's ever
  // missing (e.g. local dev) rather than throwing.
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return req.headers.get("x-real-ip") || "unknown";
}

export async function POST(req) {
  try {
    const body = await req.json().catch(() => ({}));
    const kind = KINDS.includes(body.kind) ? body.kind : null;
    if (!kind) {
      return NextResponse.json({ error: "Invalid kind." }, { status: 400 });
    }

    const identifier = typeof body.identifier === "string" ? body.identifier.trim().toLowerCase().slice(0, 200) : "";
    const ip = getClientIp(req);
    const admin = getSupabaseAdminClient();
    const since = new Date(Date.now() - WINDOW_MS).toISOString();

    // Two buckets: always by IP (catches one attacker hammering many
    // accounts), and by email/identifier when the caller has one to give
    // us (catches many IPs hammering one account). Note this second
    // bucket means someone COULD slow down a specific real user's login
    // attempts for a few minutes by deliberately failing their email from
    // several IPs -- an accepted trade-off for "basic" protection with no
    // captcha in place; it never locks an account out entirely, just
    // throttles it for the 10-minute window.
    const checks = [{ key: `ip:${ip}`, max: MAX_PER_IP }];
    if (identifier) checks.push({ key: `id:${identifier}`, max: MAX_PER_IDENTIFIER });

    for (const check of checks) {
      const { count, error } = await admin
        .from("auth_attempt_log")
        .select("id", { count: "exact", head: true })
        .eq("kind", kind)
        .eq("bucket_key", check.key)
        .gte("created_at", since);
      if (error) throw error;
      if ((count || 0) >= check.max) {
        return NextResponse.json({ allowed: false, retryAfterSeconds: Math.round(WINDOW_MS / 1000) });
      }
    }

    const rows = checks.map((c) => ({ kind, bucket_key: c.key }));
    const { error: insertErr } = await admin.from("auth_attempt_log").insert(rows);
    if (insertErr) console.error("rate-limit: could not record attempt", insertErr);

    // Best-effort housekeeping so this table doesn't grow forever. Cheap
    // enough to run inline given how infrequently this route is called
    // relative to, say, the schools table.
    try {
      await admin.from("auth_attempt_log").delete().lt("created_at", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
    } catch (cleanupErr) {
      console.error("rate-limit: cleanup failed (non-fatal)", cleanupErr);
    }

    return NextResponse.json({ allowed: true, retryAfterSeconds: null });
  } catch (err) {
    console.error("rate-limit check error", err);
    // Fail OPEN. A rate limiter that can lock every real user out of the
    // app the moment it breaks is worse than having no rate limiter at
    // all -- the pages calling this treat a broken check the same way,
    // as "allowed", and proceed straight to the real Supabase Auth call.
    return NextResponse.json({ allowed: true, retryAfterSeconds: null });
  }
}
