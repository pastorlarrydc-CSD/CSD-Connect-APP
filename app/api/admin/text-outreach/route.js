// app/api/admin/text-outreach/route.js
//
// The Text Outreach worklist: every coach phone number worth texting to learn who the
// NEW head coach is and what their cell is.
//
// GET  /api/admin/text-outreach
//   -> one card per phone number, built from two sources:
//        1. DUPLICATES -- the same number is the live cell at 2+ open schools (a coach moved
//           and one school's record was never updated). Reads EVERY school with a cell, in
//           pages of 1,000 (a single unpaged read stops at 1,000 of ~3,800 and used to hide
//           most duplicates).
//        2. DEPARTED COACHES -- the view text_outreach_departed: each school's most recent
//           real coach turnover and the cell that belonged to the old coach. When that same
//           number is live at a different school the card is "moved" (the coach probably
//           landed there).
//      plus the progress saved in cell_text_outreach (texted / replied / saved).
//
// POST /api/admin/text-outreach
//   { action: "status", phone, school_ids, status, note }  -- texted | replied | no_answer |
//        wrong_number | skip | reset
//   { action: "save", phone, school_id, first_name, last_name, cell, confirm_only }  -- writes
//        the coach's reply to the school (one change-log row per field) and marks it saved.
//
// Reviewer-only (verifier / sysadmin), admin client for the reads and writes, same bearer-token
// pattern as /api/admin/finish-line.
import { NextResponse } from "next/server";
import { getSupabaseRouteClient } from "@/lib/supabase/routeClient";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";

const REVIEWER_ROLES = ["verifier", "sysadmin"];
const PRIORITY_STATES = ["TX", "FL", "GA", "CA", "OH", "IN"];
const SCHOOL_COLS = "id,name,city,state,hc_first_name,hc_last_name,hc_cell,hc_office,phone,verification_status";
const STATUSES = ["texted", "replied", "no_answer", "wrong_number", "skip"];
const PAGE = 1000;
const IN_CHUNK = 150;

const last10 = (v) => String(v || "").replace(/\D/g, "").slice(-10);
const clean = (v) => String(v || "").trim();

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

// Reads every row of a query in pages of 1,000 -- build(from, to) returns the ranged query.
async function fetchAll(build) {
  const out = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build(from, from + PAGE - 1);
    if (error) throw error;
    out.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  return out;
}

async function authorize(req) {
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return { error: NextResponse.json({ error: "Not signed in." }, { status: 401 }) };
  const supabase = getSupabaseRouteClient(token);
  const { data: userData, error: userErr } = await supabase.auth.getUser();
  if (userErr || !userData?.user) return { error: NextResponse.json({ error: "Not signed in." }, { status: 401 }) };
  const { data: profile } = await supabase.from("profiles").select("role").eq("id", userData.user.id).maybeSingle();
  if (!profile || !REVIEWER_ROLES.includes(profile.role)) {
    return { error: NextResponse.json({ error: "Only verification staff or a system admin can use Text Outreach." }, { status: 403 }) };
  }
  return { user: userData.user };
}

export async function GET(req) {
  try {
    const auth = await authorize(req);
    if (auth.error) return auth.error;
    const admin = getSupabaseAdminClient();

    // 1. Every open school with a cell on file.
    const withCell = await fetchAll((a, b) =>
      admin.from("schools").select(SCHOOL_COLS).eq("is_closed", false).not("hc_cell", "is", null).neq("hc_cell", "").order("id").range(a, b)
    );
    const byId = new Map();
    withCell.forEach((s) => byId.set(s.id, s));

    // 2. Departed coaches (old cell retained), and the schools they belong to.
    const departed = await fetchAll((a, b) => admin.from("text_outreach_departed").select("*").order("school_id").range(a, b));
    const missing = Array.from(new Set(departed.map((d) => d.school_id))).filter((id) => !byId.has(id));
    for (const part of chunk(missing, IN_CHUNK)) {
      const { data, error } = await admin.from("schools").select(SCHOOL_COLS).in("id", part);
      if (error) throw error;
      (data || []).forEach((s) => byId.set(s.id, s));
    }

    // 3. Progress so far.
    const progress = await fetchAll((a, b) => admin.from("cell_text_outreach").select("*").order("phone").order("school_id").range(a, b));
    const progressByPhone = new Map(); // phone -> [rows]
    progress.forEach((r) => {
      if (!progressByPhone.has(r.phone)) progressByPhone.set(r.phone, []);
      progressByPhone.get(r.phone).push(r);
    });

    // Group by 10-digit number.
    const groups = new Map();
    const group = (p) => {
      if (!groups.has(p)) groups.set(p, { phone: p, cur: new Map(), dep: new Map() });
      return groups.get(p);
    };
    withCell.forEach((s) => {
      const p = last10(s.hc_cell);
      if (p.length !== 10) return;
      if (p === last10(s.hc_office) || p === last10(s.phone)) return; // the school's own line, not a coach's cell
      group(p).cur.set(s.id, s);
    });
    departed.forEach((d) => {
      if (byId.has(d.school_id)) group(d.dep_cell).dep.set(d.school_id, d);
    });

    const items = [];
    for (const g of groups.values()) {
      const curIds = Array.from(g.cur.keys());
      const depIds = Array.from(g.dep.keys());
      let type = null;
      if (curIds.length >= 2) type = "duplicate";
      else if (depIds.length >= 1 && curIds.some((c) => depIds.some((d) => d !== c))) type = "moved";
      else if (depIds.length >= 1) type = "departed";
      if (!type) continue;

      const targetIds = type === "moved" ? depIds : Array.from(new Set([...curIds, ...depIds]));
      const rows = progressByPhone.get(g.phone) || [];
      const savedAt = new Map(rows.filter((r) => r.saved_at).map((r) => [r.school_id, r.saved_at]));
      const withStatus = rows.filter((r) => r.status).sort((x, y) => new Date(y.updated_at) - new Date(x.updated_at))[0] || null;

      const mk = (id, role) => {
        const s = byId.get(id);
        const d = g.dep.get(id);
        return {
          id,
          role,
          name: s.name,
          city: s.city,
          state: s.state,
          first: s.hc_first_name || "",
          last: s.hc_last_name || "",
          cell_on_file: s.hc_cell || "",
          departed_name: d ? [d.dep_first, d.dep_last].filter(Boolean).join(" ").trim() : "",
          departed_last: d ? d.dep_last || "" : "",
          cell_never_changed: d ? Boolean(d.cell_never_changed) : false,
          saved_at: savedAt.get(id) || null,
        };
      };
      const targets = targetIds.filter((id) => byId.has(id)).map((id) => mk(id, "target"));
      const context = type === "moved" ? curIds.filter((id) => !targetIds.includes(id)).map((id) => mk(id, "context")) : [];
      if (targets.length === 0) continue;

      items.push({
        key: g.phone,
        phone: g.phone,
        type,
        status: withStatus ? withStatus.status : null,
        texted_at: withStatus ? withStatus.texted_at : null,
        note: withStatus ? withStatus.note || "" : "",
        all_saved: targets.every((t) => t.saved_at),
        never_changed: targets.some((t) => t.cell_never_changed),
        targets,
        context,
      });
    }

    const typeRank = { duplicate: 0, moved: 1, departed: 2 };
    const prio = (it) => (it.targets.some((t) => PRIORITY_STATES.includes(t.state)) ? 0 : 1);
    items.sort(
      (a, b) =>
        typeRank[a.type] - typeRank[b.type] ||
        prio(a) - prio(b) ||
        Number(b.never_changed) - Number(a.never_changed) ||
        String(a.targets[0].state).localeCompare(String(b.targets[0].state)) ||
        String(a.targets[0].name).localeCompare(String(b.targets[0].name))
    );

    return NextResponse.json({ items });
  } catch (err) {
    console.error("text-outreach GET error", err);
    return NextResponse.json({ error: "Could not load the Text Outreach list. Please try again." }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const auth = await authorize(req);
    if (auth.error) return auth.error;
    const admin = getSupabaseAdminClient();
    const body = await req.json().catch(() => ({}));
    const phone = last10(body.phone);
    if (phone.length !== 10) return NextResponse.json({ error: "Missing phone number." }, { status: 400 });
    const nowIso = new Date().toISOString();

    if (body.action === "status") {
      const ids = (Array.isArray(body.school_ids) ? body.school_ids : []).map(Number).filter((n) => Number.isFinite(n) && n > 0);
      if (ids.length === 0) return NextResponse.json({ error: "No schools given." }, { status: 400 });
      const status = body.status === "reset" ? null : body.status;
      if (status !== null && !STATUSES.includes(status)) return NextResponse.json({ error: "Unknown status." }, { status: 400 });
      const rows = ids.map((school_id) => {
        const r = { phone, school_id, status, updated_at: nowIso };
        if (status === "texted") {
          r.texted_at = nowIso;
          r.texted_by = auth.user.id;
        }
        if (typeof body.note === "string") r.note = body.note.slice(0, 500);
        return r;
      });
      const { error } = await admin.from("cell_text_outreach").upsert(rows, { onConflict: "phone,school_id" });
      if (error) throw error;
      return NextResponse.json({ ok: true, status, texted_at: status === "texted" ? nowIso : null });
    }

    if (body.action === "save") {
      const schoolId = Number(body.school_id);
      if (!Number.isFinite(schoolId) || schoolId <= 0) return NextResponse.json({ error: "Unknown school." }, { status: 400 });
      const { data: school, error: sErr } = await admin
        .from("schools")
        .select("id,name,hc_first_name,hc_last_name,hc_cell,hc_office,phone,is_closed")
        .eq("id", schoolId)
        .maybeSingle();
      if (sErr) throw sErr;
      if (!school || school.is_closed) return NextResponse.json({ error: "That school is closed or not found." }, { status: 404 });

      const updates = {};
      const logs = [];
      const queue = (field, oldVal, newVal) => {
        updates[field] = newVal;
        logs.push({ school_id: schoolId, field_name: field, old_value: oldVal ?? null, new_value: newVal, source: "Text outreach (coach replied by text)", changed_by: auth.user.id, changed_at: nowIso });
      };

      let nameChanged = false;
      if (!body.confirm_only) {
        const first = clean(body.first_name);
        const last = clean(body.last_name);
        if (first && first !== clean(school.hc_first_name)) {
          queue("hc_first_name", school.hc_first_name, first);
          nameChanged = true;
        }
        if (last && last !== clean(school.hc_last_name)) {
          queue("hc_last_name", school.hc_last_name, last);
          nameChanged = true;
        }
        const cellRaw = clean(body.cell);
        if (cellRaw) {
          const c = last10(cellRaw);
          if (c.length !== 10) return NextResponse.json({ error: "Enter the cell as a 10-digit number." }, { status: 400 });
          if (c === last10(school.hc_office) || c === last10(school.phone)) {
            return NextResponse.json({ error: "That is the school's own phone line, not a cell. Enter the coach's cell." }, { status: 400 });
          }
          if (c !== last10(school.hc_cell)) queue("hc_cell", school.hc_cell, c);
        }
        if (Object.keys(updates).length === 0) {
          return NextResponse.json({ error: "Nothing new to save. Enter the new coach's cell or name, or use \"Number is right\"." }, { status: 400 });
        }
        // A new head coach's name means the email on file may still be the OLD coach's, so flag the
        // school for review instead of leaving a verified-looking record that can't be trusted.
        if (nameChanged) {
          updates.needs_review = true;
          updates.needs_review_note = "Text outreach: a new head coach name was entered from a text reply. Confirm the email belongs to the new coach before the next send.";
          updates.needs_review_marked_at = nowIso;
          logs.push({ school_id: schoolId, field_name: "needs_review", old_value: null, new_value: "true", source: "Text outreach (coach replied by text)", changed_by: auth.user.id, changed_at: nowIso });
        }
        const { error: uErr } = await admin.from("schools").update(updates).eq("id", schoolId);
        if (uErr) throw uErr;
        const { error: lErr } = await admin.from("school_change_log").insert(logs);
        if (lErr) throw lErr;
      }

      const { error: pErr } = await admin
        .from("cell_text_outreach")
        .upsert([{ phone, school_id: schoolId, status: "replied", saved_at: nowIso, saved_by: auth.user.id, updated_at: nowIso }], { onConflict: "phone,school_id" });
      if (pErr) throw pErr;
      return NextResponse.json({ ok: true, saved_at: nowIso, changed: Object.keys(updates), flagged_for_review: nameChanged });
    }

    return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  } catch (err) {
    console.error("text-outreach POST error", err);
    return NextResponse.json({ error: "Could not save. Please try again." }, { status: 500 });
  }
}
