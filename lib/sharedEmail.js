// lib/sharedEmail.js
//
// Helpers for the Shared Email review (app/(app)/admin/shared-email and
// app/api/admin/shared-email). A "shared email" is one head-coach email that
// sits on two or more OPEN schools with a city. The Postgres view
// shared_email_schools lists them (see the migration
// shared_email_review_view_and_dismissals); combined-team entries with no city
// are left out because they legitimately repeat their member school's email.
//
// Why this exists: the original coach import copied one coach's email onto
// same-named or same-district schools. That left ~150 emails on more than one
// school. The same email on two schools almost always means one of them is
// wrong, and a wrong email is the one thing the newsletter must never send to.

// Notes written by the 10/21-10/26 shared-email audit start with this, so a
// school the audit flagged can be recognized (and un-flagged once resolved).
export const SHARED_NOTE_PREFIX = "Shared-email audit";

export function emailKey(email) {
  return String(email == null ? "" : email).trim().toLowerCase();
}

export function isSharedAuditNote(note) {
  return String(note || "").startsWith(SHARED_NOTE_PREFIX);
}

// Other open schools (with a city) that already use this email. Used by the
// Needs Review save route to warn, right after a save, that the email just
// entered is already on another school. excludeId = the school being saved.
export async function findOtherSchoolsWithEmail(admin, email, excludeId) {
  const key = emailKey(email);
  if (!key) return [];
  // ilike treats _ and % as wildcards, so the match is re-checked exactly below.
  const { data, error } = await admin
    .from("schools")
    .select("id,name,city,state,hc_email,is_closed")
    .ilike("hc_email", key.replace(/[%_\\]/g, (c) => "\\" + c))
    .eq("is_closed", false)
    .neq("id", excludeId)
    .limit(20);
  if (error || !data) return [];
  return data.filter((r) => emailKey(r.hc_email) === key).map((r) => ({ id: r.id, name: r.name, city: r.city, state: r.state }));
}

// Group flat rows from shared_email_schools into one object per email.
export function groupSharedRows(rows) {
  const byKey = new Map();
  for (const r of rows) {
    if (!byKey.has(r.email_key)) {
      byKey.set(r.email_key, {
        email_key: r.email_key,
        email: r.hc_email,
        group_size: r.group_size,
        same_city: r.group_cities === 1,
        same_coach: r.group_last_names === 1,
        multi_state: r.group_states > 1,
        schools: [],
      });
    }
    byKey.get(r.email_key).schools.push(r);
  }
  const groups = Array.from(byKey.values());
  for (const g of groups) g.schools.sort((a, b) => a.id - b.id);
  // Most suspicious first: same city, then different coaches, then the rest.
  groups.sort((a, b) => {
    const score = (g) => (g.same_city ? 0 : 2) + (g.same_coach ? 1 : 0);
    return score(a) - score(b) || a.email_key.localeCompare(b.email_key);
  });
  return groups;
}
