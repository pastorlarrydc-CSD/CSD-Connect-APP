import { NextResponse } from "next/server";
import { getSupabaseRouteClient } from "@/lib/supabase/routeClient";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";

// Fields a claimed owner is allowed to touch on their own school record --
// deliberately narrow (no name/address/classification) even though the
// admin client below has no column-level restriction of its own.
const EDITABLE_FIELDS = ["hc_first_name", "hc_last_name", "hc_email", "hc_cell", "hc_office"];

export async function POST(req, { params }) {
  try {
    const schoolId = Number(params.id);
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

    const { data: profile } = await supabase.from("profiles").select("school_id").eq("id", userData.user.id).maybeSingle();
    if (!profile || profile.school_id !== schoolId) {
      return NextResponse.json({ error: "You can only update the school listing you've claimed." }, { status: 403 });
    }

    const admin = getSupabaseAdminClient();
    const { data: before, error: beforeErr } = await admin.from("schools").select("*").eq("id", schoolId).maybeSingle();
    if (beforeErr || !before) {
      return NextResponse.json({ error: "School not found." }, { status: 404 });
    }

    const body = await req.json().catch(() => ({}));
    const update = {};
    const changes = [];
    EDITABLE_FIELDS.forEach((field) => {
      if (!(field in body)) return;
      const newVal = (body[field] ?? "").toString().trim() || null;
      const oldVal = before[field] || null;
      if (newVal !== oldVal) {
        update[field] = newVal;
        changes.push({
          school_id: schoolId,
          field_name: field,
          old_value: oldVal,
          new_value: newVal,
          source: "Self-updated by claimed HS coach account",
          changed_by: userData.user.id,
        });
      }
    });

    if (Object.keys(update).length) {
      update.verification_status = "verified";
      update.last_verified_at = new Date().toISOString();
      const { error: updateErr } = await admin.from("schools").update(update).eq("id", schoolId);
      if (updateErr) throw updateErr;
      if (changes.length) {
        const { error: logErr } = await admin.from("school_change_log").insert(changes);
        if (logErr) throw logErr;
      }
      // A confirmed-current listing is no longer "possibly outdated" --
      // resolve any pending flags on it so they don't linger in the queue.
      await admin
        .from("school_flags")
        .update({ status: "resolved", resolved_by: userData.user.id, resolved_at: new Date().toISOString() })
        .eq("school_id", schoolId)
        .eq("status", "pending");
    }

    return NextResponse.json({ ok: true, changed: changes.length });
  } catch (err) {
    console.error("school self-update error", err);
    return NextResponse.json({ error: "Could not save your listing. Please try again." }, { status: 500 });
  }
}
