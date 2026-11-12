// Does the email sitting next to a coach actually belong to THAT coach?
//
// lib/coachEmailFit.js already answers "does the address contain the coach's
// last name" and catches an address that contains the PREVIOUS coach's full
// last name. It is used by Batch Coach-Info, the Review Queue, Needs Review
// and the nightly recheck. Two kinds of leftover address got past it, and both
// showed up in the November 2026 Coach-Change Radar sweep:
//
//   1. An address that only PARTLY spells the old coach's name
//      (mickuc1@gpsk12.org left on Greenfield HS after Mike Kuchieski was
//      replaced by Jeff Bengston -- "kuc" is in it, "kuchieski" is not).
//   2. An address that carries no name at all (kmm7270@slp.k12.la.us left on
//      Port Barre HS after Mac Mistric was replaced). The only tell is that the
//      coach changed and the email did not.
//
// This adds those two checks on top of emailFit without touching it, so the
// five screens that already use emailFit behave exactly as before.
//
// Pure functions, no React / Supabase, so Import & Reconcile, the school
// profile page and the tests can all share it.

import { emailFit } from "./coachEmailFit";

function clean(v) {
  return String(v == null ? "" : v).trim();
}

function lettersOnly(s) {
  return String(s || "").toLowerCase().replace(/[^a-z]/g, "");
}

// Same suffix handling as coachEmailFit.lastKey ("Mireles III" -> "mireles").
const NAME_SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv", "v"]);
function surnameKey(name) {
  const tokens = String(name || "")
    .toLowerCase()
    .split(/[\s,]+/)
    .map((t) => t.replace(/[^a-z]/g, ""))
    .filter(Boolean);
  while (tokens.length > 1 && NAME_SUFFIXES.has(tokens[tokens.length - 1])) tokens.pop();
  return tokens.join("");
}

function localLetters(email) {
  const e = clean(email).toLowerCase();
  const at = e.indexOf("@");
  return at > 0 ? lettersOnly(e.slice(0, at)) : "";
}

function fullName(c) {
  return [clean(c && c.first), clean(c && c.last)].filter(Boolean).join(" ");
}

// level:
//   "ok"    nothing to say (no email, a role address, the new coach's own
//           address, or a personal-looking address and no sign it was carried over)
//   "warn"  the coach changed, the email did not, and it doesn't carry the new
//           coach's name -- probably the previous coach's, can't prove it
//   "stale" the address spells the previous coach's name (fully or mostly)
//
// input:
//   email        the address that will be on the record
//   coach        { first, last } -- the coach it will sit next to
//   priorCoach   { first, last } or null -- the coach it sat next to before
//   carriedOver  true when the coach changed but the email did not (null/false otherwise)
export function assessEmailOwnership({ email, coach, priorCoach, carriedOver }) {
  const addr = clean(email);
  if (!addr) return { level: "ok", code: "no_email", fit: "none", message: "" };

  const fit = emailFit(addr, coach || {}, priorCoach || null);
  if (fit === "match") return { level: "ok", code: "matches_coach", fit, message: "" };
  if (fit === "generic") return { level: "ok", code: "role_address", fit, message: "" };

  const coachName = fullName(coach) || "the new coach";
  const priorName = fullName(priorCoach);

  if (fit === "stale") {
    return {
      level: "stale",
      code: "previous_coach",
      fit,
      message: `The email ${addr} matches the previous coach${priorName ? ` (${priorName})` : ""}, not ${coachName}.`,
    };
  }

  // Partial spelling of the previous coach's surname. Only for surnames of 5+
  // letters (a 3-letter slice of "Lee" or "Hill" would match too much), and
  // only when the address does not contain the new coach's surname.
  const priorLast = surnameKey(priorCoach && priorCoach.last);
  const newLast = surnameKey(coach && coach.last);
  const local = localLetters(addr);
  if (priorLast.length >= 5 && priorLast !== newLast) {
    const slice = priorLast.slice(0, 3);
    const newHasSlice = newLast.length >= 3 && newLast.includes(slice);
    if (local.includes(slice) && !newHasSlice && !(newLast.length >= 3 && local.includes(newLast))) {
      return {
        level: "stale",
        code: "looks_like_previous_coach",
        fit,
        message: `The email ${addr} looks like it may belong to the previous coach${priorName ? ` (${priorName})` : ""} — it doesn't contain ${coachName}'s name.`,
      };
    }
  }

  if (carriedOver === true) {
    return {
      level: "warn",
      code: "carried_over",
      fit,
      message: `The email ${addr} was not changed when the coach changed${priorName ? ` from ${priorName}` : ""} and doesn't contain ${coachName}'s name — it probably still belongs to the previous coach.`,
    };
  }

  return { level: "ok", code: "unknown", fit, message: "" };
}

// For the school profile page, which has no "proposed change" -- it has the
// school's change history. Given the school_change_log rows for
// hc_first_name / hc_last_name / hc_email (any order), work out who the
// previous coach was and whether the email has been touched since the name
// last changed. No-op rows (old value == new value) are ignored, so a
// "verified, nothing changed" log line does not count as an email update.
//
// Returns { priorCoach: {first,last} | null, nameChangedAt: ms | null, carriedOver: boolean | null }
// (carriedOver is null when the name has never been changed on record).
export function carryOverFromHistory(rows) {
  const real = (rows || [])
    .filter((r) => clean(r.old_value) !== clean(r.new_value))
    .map((r) => ({ ...r, t: new Date(r.changed_at).getTime() }))
    .filter((r) => Number.isFinite(r.t))
    .sort((a, b) => b.t - a.t);

  const lastNameChange = real.find((r) => r.field_name === "hc_last_name" && clean(r.old_value));
  if (!lastNameChange) return { priorCoach: null, nameChangedAt: null, carriedOver: null };

  const T = lastNameChange.t;
  const firstNameChange = real.find((r) => r.field_name === "hc_first_name" && clean(r.old_value) && Math.abs(r.t - T) <= 24 * 3600 * 1000);
  const priorCoach = { first: clean(firstNameChange && firstNameChange.old_value), last: clean(lastNameChange.old_value) };

  const emailChange = real.find((r) => r.field_name === "hc_email");
  // An email edit made in the same sitting as the name change (or after it)
  // counts as "updated" -- allow a few minutes of slack for the two log rows.
  const updated = Boolean(emailChange && emailChange.t >= T - 5 * 60 * 1000);
  return { priorCoach, nameChangedAt: T, carriedOver: !updated };
}
