// app/api/admin/needs-review/find-email/route.js
//
// POST { school_id }
//
// "Find email on staff pages" for the Needs Review queue. When the AI check
// says "same coach -- email not confirmed" (Bertrand High, for example), this
// goes and READS the school's own pages -- athletics site, website, staff
// directory, and a couple of searches aimed at the coach's name on the
// school's own domain -- scans the text for email addresses, and reports any
// address that is literally printed next to the coach's name, with the line it
// was found on and the page it came from.
//
// No AI and no guessing: see lib/staffEmailFinder.js. Read-only -- it NEVER
// writes to the database. The reviewer clicks "Use this" and saves through
// Quick Fix like any other edit.
import { NextResponse } from "next/server";
import { getSupabaseRouteClient } from "@/lib/supabase/routeClient";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { withProtocol } from "@/lib/schoolRecheck";
import { fetchPageText, searchWeb, findDirectoryPage, isLowValueDirectoryDomain, serperLocationForState } from "@/lib/coachInfoLookup";
import { findCoachEmailCandidates, inferEmailPattern, extractEmails } from "@/lib/staffEmailFinder";

export const maxDuration = 45;

const REVIEWER_ROLES = ["verifier", "sysadmin"];
const MAX_EXTRA_PAGES = 4;

function hostOf(url) {
  try {
    return new URL(withProtocol(url)).hostname.replace(/^www\./, "").toLowerCase();
  } catch (_) {
    return "";
  }
}

function rootOf(host) {
  const parts = String(host || "").split(".");
  return parts.length <= 2 ? parts.join(".") : parts.slice(-2).join(".");
}

export async function POST(req) {
  try {
    const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    if (!token) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
    const supabase = getSupabaseRouteClient(token);
    const { data: userData, error: userErr } = await supabase.auth.getUser();
    if (userErr || !userData?.user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
    const { data: profile } = await supabase.from("profiles").select("role").eq("id", userData.user.id).maybeSingle();
    if (!profile || !REVIEWER_ROLES.includes(profile.role)) {
      return NextResponse.json({ error: "Only verification staff or a system admin can use this." }, { status: 403 });
    }

    const body = await req.json().catch(() => ({}));
    const schoolId = Number(body.school_id);
    if (!schoolId) return NextResponse.json({ error: "school_id is required." }, { status: 400 });

    const admin = getSupabaseAdminClient();
    const { data: school, error: schoolErr } = await admin
      .from("schools")
      .select("id,name,city,state,athletics_url,website,hc_first_name,hc_last_name,hc_email")
      .eq("id", schoolId)
      .maybeSingle();
    if (schoolErr || !school) return NextResponse.json({ error: "School not found." }, { status: 404 });

    const first = String(school.hc_first_name || "").trim();
    const last = String(school.hc_last_name || "").trim();
    if (!last) {
      return NextResponse.json({ error: "This school has no head coach name on file to look for." }, { status: 400 });
    }

    const athleticsUrl = withProtocol(school.athletics_url);
    const websiteUrl = withProtocol(school.website);
    const onFileEmailHost = String(school.hc_email || "").includes("@") ? String(school.hc_email).split("@").pop().toLowerCase() : "";
    const domainHints = [hostOf(athleticsUrl), hostOf(websiteUrl), onFileEmailHost].filter(Boolean);
    const serperKey = process.env.SERPER_API_KEY;
    const location = serperLocationForState(school.state);
    const coachName = `${first} ${last}`.trim();

    // Page text collected so far: { label, url, text }
    const pages = [];
    const checked = [];
    const addPage = (label, url, fetched) => {
      checked.push({ label, url, ok: Boolean(fetched && fetched.ok !== false && fetched.text) });
      if (fetched && fetched.text) pages.push({ label, url, text: fetched.text });
    };

    // 1) The school's own pages, plus the directory search, in parallel.
    const [athFetch, webFetch, directory] = await Promise.all([
      athleticsUrl ? fetchPageText(athleticsUrl) : Promise.resolve(null),
      websiteUrl ? fetchPageText(websiteUrl) : Promise.resolve(null),
      serperKey ? findDirectoryPage({ school, serperKey }) : Promise.resolve({ results: [], page: null }),
    ]);
    if (athFetch) addPage("athletics site", athleticsUrl, athFetch);
    if (webFetch) addPage("school website", websiteUrl, webFetch);
    if (directory.page) addPage("staff directory", directory.page.url, { ok: true, text: directory.page.text });
    // Search snippets can carry an address too.
    (directory.results || []).forEach((r) => addPage("search snippet", r.link, { ok: true, text: `${r.title} ${r.snippet}` }));

    // 2) Searches aimed at THIS coach on the school's own domain.
    if (serperKey) {
      const siteRoot = rootOf(hostOf(websiteUrl) || hostOf(athleticsUrl) || onFileEmailHost);
      const queries = [`"${coachName}" ${school.name} ${school.city || ""} ${school.state || ""} football coach email`];
      if (siteRoot) queries.push(`"${last}" football coach email site:${siteRoot}`);
      const resultSets = await Promise.all(queries.map((q) => searchWeb(q, serperKey, location)));
      const seen = new Set(pages.map((p) => p.url));
      const toFetch = [];
      for (const results of resultSets) {
        for (const r of results || []) {
          addPage("search snippet", r.link, { ok: true, text: `${r.title} ${r.snippet}` });
          if (seen.has(r.link) || isLowValueDirectoryDomain(r.link)) continue;
          // Prefer the school's own domain for full-page reads.
          const onDomain = domainHints.some((h) => rootOf(h) === rootOf(hostOf(r.link)));
          if (onDomain || toFetch.length < 1) {
            seen.add(r.link);
            toFetch.push(r.link);
          }
          if (toFetch.length >= MAX_EXTRA_PAGES) break;
        }
        if (toFetch.length >= MAX_EXTRA_PAGES) break;
      }
      const fetched = await Promise.all(toFetch.map((u) => fetchPageText(u)));
      fetched.forEach((f, i) => addPage("page from search", toFetch[i], f));
    }

    // 3) Scan every page for an address printed next to the coach.
    const merged = new Map();
    for (const p of pages) {
      for (const c of findCoachEmailCandidates({ text: p.text, url: p.url, first, last, domainHints })) {
        const k = c.email.toLowerCase();
        const prev = merged.get(k);
        if (!prev || c.score > prev.score) merged.set(k, { ...c, source_label: p.label });
      }
    }
    const onFile = String(school.hc_email || "").trim().toLowerCase();
    const candidates = [...merged.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .map((c) => ({ ...c, same_as_on_file: Boolean(onFile) && c.email.toLowerCase() === onFile }));

    // 4) A pattern hint (never a candidate) when nothing was found.
    const allText = pages.map((p) => p.text).join("\n");
    const hint = candidates.some((c) => c.strength === "strong") ? null : inferEmailPattern(allText, domainHints);

    return NextResponse.json({
      coach: coachName,
      candidates,
      pages_checked: checked.filter((c) => c.label !== "search snippet").slice(0, 10),
      emails_seen_on_pages: new Set(pages.flatMap((p) => extractEmails(p.text).map((e) => e.email.toLowerCase()))).size,
      pattern_hint: hint
        ? { ...hint, note: "Other staff addresses follow this pattern. This is only a hint about what to look for -- it is NOT this coach's email and is never applied." }
        : null,
    });
  } catch (err) {
    console.error("needs-review find-email error", err);
    return NextResponse.json({ error: "Could not search the staff pages right now. Please try again." }, { status: 500 });
  }
}
