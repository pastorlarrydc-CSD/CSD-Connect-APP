import { NextResponse } from "next/server";
import { getSupabaseRouteClient } from "@/lib/supabase/routeClient";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { getStripe } from "@/lib/stripe/server";
import { STRIPE_PRICE_ID } from "@/lib/stripe/config";

// Sysadmin-only, not verifier -- this rolls up revenue and per-college
// activity across every customer at once, which is a different sensitivity
// level than the data-quality/claims review tooling verifiers already see.
// This is Larry's own business dashboard: "nothing rolls up your whole
// business... you need to see this at a glance rather than piecing it
// together from Stripe and Supabase by hand."
const OWNER_ROLES = ["sysadmin"];

const DORMANT_DAYS = 30;
const ACTIVITY_WINDOW_DAYS = 30;

// Every user in the project, once, with just the field we need (last
// sign-in) -- cheaper than the coach-alert-digest route's per-user
// admin.getUserById() calls, since here we need essentially all of them at
// once rather than a handful tied to specific notification rows. Paginated
// defensively even though this project has a small user count today.
async function loadLastSignInByUserId(admin) {
  const byId = {};
  let page = 1;
  const perPage = 200;
  for (let i = 0; i < 10; i++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage });
    if (error) throw error;
    const users = data?.users || [];
    users.forEach((u) => {
      byId[u.id] = u.last_sign_in_at || null;
    });
    if (users.length < perPage) break;
    page += 1;
  }
  return byId;
}

export async function GET(req) {
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

    const { data: profile } = await supabase.from("profiles").select("role").eq("id", userData.user.id).maybeSingle();
    if (!profile || !OWNER_ROLES.includes(profile.role)) {
      return NextResponse.json({ error: "The business dashboard is limited to System Admins." }, { status: 403 });
    }

    const admin = getSupabaseAdminClient();

    const [{ data: colleges, error: collegesErr }, { data: profiles, error: profilesErr }, { data: leads, error: leadsErr }] = await Promise.all([
      admin
        .from("colleges")
        .select("id,name,division,state,subscription_status,stripe_customer_id,trial_ends_at,current_period_end,created_at")
        .order("created_at", { ascending: true }),
      admin.from("profiles").select("id,college_id,full_name,role"),
      admin.from("college_leads").select("status"),
    ]);
    if (collegesErr) throw collegesErr;
    if (profilesErr) throw profilesErr;
    if (leadsErr) throw leadsErr;

    const since30 = new Date(Date.now() - ACTIVITY_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const { count: recentContactCount, error: contactErr } = await admin
      .from("contact_logs")
      .select("id", { count: "exact", head: true })
      .gte("created_at", since30);
    if (contactErr) throw contactErr;

    let lastSignInById = {};
    try {
      lastSignInById = await loadLastSignInByUserId(admin);
    } catch (err) {
      // Non-fatal -- the dashboard still works without last-activity data,
      // it just can't flag dormant accounts. Surface it in logs, not to
      // the page, so a transient auth-admin hiccup doesn't take down the
      // whole dashboard.
      console.error("business-dashboard: could not load last sign-in data", err);
    }

    // Current price straight from Stripe rather than hardcoding a dollar
    // figure here -- if Larry ever changes the price in the Stripe
    // dashboard, this stays correct with zero code changes.
    let unitAmountCents = null;
    try {
      const stripe = getStripe();
      const price = await stripe.prices.retrieve(STRIPE_PRICE_ID);
      unitAmountCents = typeof price.unit_amount === "number" ? price.unit_amount : null;
    } catch (err) {
      console.error("business-dashboard: could not load Stripe price", err);
    }

    const staffByCollege = {};
    (profiles || []).forEach((p) => {
      if (!p.college_id) return;
      if (!staffByCollege[p.college_id]) staffByCollege[p.college_id] = [];
      staffByCollege[p.college_id].push(p);
    });

    const now = Date.now();
    let activeCount = 0;
    let trialingCount = 0;
    let pastDueCount = 0;
    let canceledCount = 0;
    let dormantCount = 0;

    const collegeRows = (colleges || []).map((c) => {
      const staff = staffByCollege[c.id] || [];
      let lastActiveAt = null;
      staff.forEach((p) => {
        const t = lastSignInById[p.id];
        if (t && (!lastActiveAt || new Date(t) > new Date(lastActiveAt))) lastActiveAt = t;
      });
      const daysSinceActive = lastActiveAt ? Math.floor((now - new Date(lastActiveAt).getTime()) / (24 * 60 * 60 * 1000)) : null;

      const status = c.subscription_status;
      if (status === "active") activeCount += 1;
      else if (status === "trialing") trialingCount += 1;
      else if (status === "past_due" || status === "unpaid") pastDueCount += 1;
      else if (status === "canceled") canceledCount += 1;

      const isPaying = status === "active" || status === "trialing";
      const isDormant = isPaying && (daysSinceActive === null || daysSinceActive > DORMANT_DAYS);
      if (isDormant) dormantCount += 1;

      return {
        id: c.id,
        name: c.name,
        division: c.division,
        state: c.state,
        subscription_status: status,
        trial_ends_at: c.trial_ends_at,
        current_period_end: c.current_period_end,
        created_at: c.created_at,
        staffCount: staff.length,
        lastActiveAt,
        daysSinceActive,
        isDormant,
      };
    });

    const pipelineCounts = { not_contacted: 0, contacted: 0, interested: 0, trial: 0, customer: 0, not_interested: 0 };
    (leads || []).forEach((l) => {
      if (pipelineCounts[l.status] !== undefined) pipelineCounts[l.status] += 1;
    });

    const mrrCents = unitAmountCents !== null ? unitAmountCents * activeCount : null;

    return NextResponse.json({
      mrrCents,
      totalColleges: collegeRows.length,
      activeCount,
      trialingCount,
      pastDueCount,
      canceledCount,
      dormantCount,
      recentContactCount: recentContactCount || 0,
      pipelineCounts,
      totalLeads: (leads || []).length,
      colleges: collegeRows,
    });
  } catch (err) {
    console.error("business dashboard error", err);
    return NextResponse.json({ error: "Could not load the business dashboard right now." }, { status: 500 });
  }
}
