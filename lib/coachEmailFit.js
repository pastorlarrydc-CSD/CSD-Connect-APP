// Does a coach's email actually fit the coach it is sitting next to?
//
// Why this exists: Batch Coach-Info can be 100% right that a school has a NEW
// head coach (Hemet High: Dennis Gregovich -> Jeff Galloway, confidence "high")
// and still find NO email for him. Applying that suggestion used to write the
// new name, leave the previous coach's address (dgregovich@hemetusd.org) in
// place, and stamp the whole record "verified" -- a verified record with the
// wrong person's email on it. "High confidence" speaks to who the coach is, not
// to whether the email belongs to them.
//
// Pure functions, no imports, so the review page and the server-side
// auto-apply can share them.

const GENERIC_LOCAL = /^(info|athletics?|athleticdirector|football|fb|coach|coaches|admin|office|contact|ad|sports?|hs|school|principal|registrar|attendance|webmaster|frontoffice|mail|help|support|team|varsity)/;

function lettersOnly(s) {
  return String(s || "").toLowerCase().replace(/[^a-z]/g, "");
}

function emailLocal(email) {
  const e = String(email || "").trim().toLowerCase();
  const at = e.indexOf("@");
  return at > 0 ? lettersOnly(e.slice(0, at)) : "";
}

// "none"    no email at all
// "match"   the address contains the coach's last name (jgalloway@...)
// "stale"   the address contains the PREVIOUS coach's last name and not the new one
// "generic" a role address (athletics@, info@) -- fits any coach
// "unknown" a personal-looking address we can't tie to either name
export function emailFit(email, coach, priorCoach) {
  const local = emailLocal(email);
  if (!String(email || "").trim()) return "none";
  const last = lettersOnly(coach && coach.last);
  const priorLast = lettersOnly(priorCoach && priorCoach.last);
  if (last.length >= 3 && local.includes(last)) return "match";
  if (priorLast.length >= 3 && priorLast !== last && local.includes(priorLast)) return "stale";
  if (GENERIC_LOCAL.test(local)) return "generic";
  return "unknown";
}

function clean(v) {
  return String(v == null ? "" : v).trim();
}

function fullName(first, last) {
  return `${clean(first)} ${clean(last)}`.trim();
}

// school   -- the schools row as it is on file right now
// proposed -- ONLY the fields about to be written ({hc_first_name, hc_email, ...});
//             a null/"" hc_email means "being cleared"
// opts.emailEstimated -- the proposed email is a pattern guess, never seen anywhere
//
// Returns what the review page needs to decide whether a write is safe to
// bulk-apply, safe to stamp "verified", and what to tell the reviewer.
export function assessCoachChange(school, proposed, opts) {
  const s = school || {};
  const p = proposed || {};
  const estimated = Boolean(opts && opts.emailEstimated);

  const priorFirst = clean(s.hc_first_name);
  const priorLast = clean(s.hc_last_name);
  const hadPriorName = Boolean(priorFirst || priorLast);

  const has = (k) => Object.prototype.hasOwnProperty.call(p, k);
  const nextFirst = has("hc_first_name") && clean(p.hc_first_name) ? clean(p.hc_first_name) : priorFirst;
  const nextLast = has("hc_last_name") && clean(p.hc_last_name) ? clean(p.hc_last_name) : priorLast;

  const nameChanged = hadPriorName && (nextFirst !== priorFirst || nextLast !== priorLast);

  const proposedEmail = has("hc_email") ? clean(p.hc_email) : "";
  const onFileEmail = clean(s.hc_email);
  const emailChanged = Boolean(proposedEmail) && proposedEmail !== onFileEmail;
  const emailCleared = has("hc_email") && !proposedEmail;
  const finalEmail = emailCleared ? "" : emailChanged ? proposedEmail : onFileEmail;

  const fit = emailFit(finalEmail, { first: nextFirst, last: nextLast }, { first: priorFirst, last: priorLast });

  // The email is only "confirmed for this coach" when a coach change arrives
  // WITH a real (non-estimated) new address that doesn't belong to the old coach.
  const emailUnconfirmed = nameChanged && (!emailChanged || estimated || fit === "stale");
  const staleEmail = fit === "stale";

  // Left out of "Apply All High-Confidence": any coach change, and any row that
  // would leave a previous coach's address on the record.
  const risky = nameChanged || staleEmail;

  const oldName = fullName(priorFirst, priorLast);
  const newName = fullName(nextFirst, nextLast);

  function reviewNote(runId) {
    const run = runId ? ` (Batch AI run #${runId})` : "";
    let tail;
    if (!finalEmail) tail = "No email on file for the new coach -- find one.";
    else if (staleEmail) tail = `Email on file (${finalEmail}) matches the previous coach -- find the new coach's email.`;
    else tail = `Email on file (${finalEmail}) was not confirmed for the new coach -- verify it.`;
    return `Coach changed from ${oldName || "(blank)"} to ${newName}${run}. ${tail}`;
  }

  return { hadPriorName, nameChanged, emailChanged, emailCleared, finalEmail, fit, staleEmail, emailUnconfirmed, risky, oldName, newName, reviewNote };
}
