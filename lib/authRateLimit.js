// Thin client-side wrapper around POST /api/auth/rate-limit, shared by
// login/signup/forgot-password so the same check-before-you-call-Supabase
// pattern isn't copy-pasted three times. See that route for the actual
// limits and the reasoning behind them.
//
// Always resolves to { allowed, retryAfterSeconds } and never throws --
// a network hiccup on this check is treated as "allowed" so a bug or
// outage in the rate limiter itself can never block a real sign-in,
// account creation, or password reset.
export async function checkAuthRateLimit(kind, identifier) {
  try {
    const res = await fetch("/api/auth/rate-limit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind, identifier }),
    });
    const body = await res.json().catch(() => ({}));
    if (body.allowed === false) {
      return { allowed: false, retryAfterSeconds: body.retryAfterSeconds || 600 };
    }
    return { allowed: true, retryAfterSeconds: null };
  } catch {
    return { allowed: true, retryAfterSeconds: null };
  }
}

export function rateLimitMessage(retryAfterSeconds, action) {
  const minutes = Math.max(1, Math.ceil((retryAfterSeconds || 600) / 60));
  return `Too many ${action} attempts. Please wait about ${minutes} minute${minutes === 1 ? "" : "s"} and try again.`;
}
