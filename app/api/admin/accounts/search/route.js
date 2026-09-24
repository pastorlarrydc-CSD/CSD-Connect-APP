import { NextResponse } from "next/server";
import { getSupabaseRouteClient } from "@/lib/supabase/routeClient";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";

export const maxDuration = 30;

// Sysadmin-only account lookup -- Larry asked for "search the database via
// email and pull up and edit any account." Deliberately scoped to LOGIN
// accounts (auth.users + profiles) per that conversation, not the
// hc_email/ad_email contact info already searchable on the Data Quality
// page's "Find & Edit a School" tool -- high school coaches don't have
// logins, so they're not "accounts" in this sense.
//
// auth.users has no server-exposed email filter via the JS admin SDK's
// listUsers() -- it only supports page/perPage -- so this paginates the
// whole user list and filters in memory. That's fine at this project's
// current scale (a couple dozen accounts at most; see business-dashboard's
// own loadLastSignInByUserId, which does the exact same thing for the same
// reason) and is the same tradeoff every other admin route here already
// makes rather than reaching for raw SQL against the auth schema.
const OWNER_ROLES = ["sysadmin"];
const MIN_QUERY_LENGTH = 3;
const MAX_RESULTS = 25;

async function listAllUsers(admin) {
  const all = [];
  let page = 1;
  const perPage = 200;
  for (let i = 0; i < 10; i++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage });
    if (error) throw error;
    const users = data?.users || [];
    all.push(...users);
    if (users.length < perPage) break;
    page += 1;
  }
  return all;
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

    const { data: callerProfile } = await supabase.from("profiles").select("role").eq("id", userData.user.id).maybeSingle();
    if (!callerProfile || !OWNER_ROLES.includes(callerProfile.role)) {
      return NextResponse.json({ error: "Account search is limited to System Admins." }, { status: 403 });
    }

    const { searchParams } = new URL(req.url);
    const q = (searchParams.get("email") || "").trim().toLowerCase();
    if (q.length < MIN_QUERY_LENGTH) {
      return NextResponse.json({ error: `Enter at least ${MIN_QUERY_LENGTH} characters to search.` }, { status: 400 });
    }

    const admin = getSupabaseAdminClient();

    const allUsers = await listAllUsers(admin);
    const matched = allUsers.filter((u) => (u.email || "").toLowerCase().includes(q)).slice(0, MAX_RESULTS);

    if (matched.length === 0) {
      return NextResponse.json({ accounts: [] });
    }

    const userIds = matched.map((u) => u.id);
    const { data: profileRows, error: profileErr } = await admin
      .from("profiles")
      .select("id,college_id,full_name,role,title,school_id,created_at")
      .in("id", userIds);
    if (profileErr) throw profileErr;
    const profileById = new Map((profileRows || []).map((p) => [p.id, p]));

    const collegeIds = Array.from(new Set((profileRows || []).map((p) => p.college_id).filter(Boolean)));
    let collegeById = new Map();
    if (collegeIds.length > 0) {
      const { data: collegeRows, error: collegeErr } = await admin
        .from("colleges")
        .select("id,name,division,state,subscription_status")
        .in("id", collegeIds);
      if (collegeErr) throw collegeErr;
      collegeById = new Map((collegeRows || []).map((c) => [c.id, c]));
    }

    const schoolIds = Array.from(new Set((profileRows || []).map((p) => p.school_id).filter((id) => id !== null && id !== undefined)));
    let schoolById = new Map();
    if (schoolIds.length > 0) {
      const { data: schoolRows, error: schoolErr } = await admin.from("schools").select("id,name,city,state").in("id", schoolIds);
      if (schoolErr) throw schoolErr;
      schoolById = new Map((schoolRows || []).map((s) => [s.id, s]));
    }

    const accounts = matched.map((u) => {
      const profile = profileById.get(u.id) || null;
      return {
        id: u.id,
        email: u.email,
        email_confirmed_at: u.email_confirmed_at || null,
        created_at: u.created_at,
        last_sign_in_at: u.last_sign_in_at || null,
        profile: profile
          ? {
              full_name: profile.full_name,
              role: profile.role,
              title: profile.title,
              college_id: profile.college_id,
              school_id: profile.school_id,
              created_at: profile.created_at,
            }
          : null,
        college: profile?.college_id ? collegeById.get(profile.college_id) || null : null,
        school: profile?.school_id !== null && profile?.school_id !== undefined ? schoolById.get(profile.school_id) || null : null,
      };
    });

    return NextResponse.json({ accounts });
  } catch (err) {
    console.error("admin/accounts/search error", err);
    return NextResponse.json({ error: err.message || "Could not search accounts." }, { status: 500 });
  }
}
