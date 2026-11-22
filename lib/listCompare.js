// lib/listCompare.js
//
// Compare a state's published head-coach list (school + coach, e.g. from a state association
// or MaxPreps) against the schools we have on file for that state. Pure functions only, so the
// same code runs in the API route (where the fixes are re-checked before anything is written)
// and can be tested on its own.
//
// What it decides for each row on the list:
//   agree       -- same coach as ours
//   spelling    -- same person, spelled differently. If the email on file carries the LIST's
//                  spelling (and not ours) it is marked fixable: the email is a second,
//                  independent source, so the typo is almost certainly ours.
//   first_name  -- same last name, different first name (could be a family member or a typo)
//   differ      -- a different coach
//   ours_blank  -- the list has a coach, we have none
//   list_blank  -- the list has no coach for this school
//   unmatched   -- no school of ours matches this row (often a co-op team listed under its own
//                  name, or a school we are missing). `alsoAt` shows where that coach already
//                  sits in our data, which tells a co-op from a gap.
//   shared      -- another row on the list already claimed the same school of ours (two co-op
//                  teams, or two schools in one building). Not counted as a difference.

const STOP = new Set(["and", "of", "the", "school", "district", "dist", "area", "community", "public", "union"]);
const SUFFIX = new Set(["jr", "sr", "ii", "iii", "iv"]);

export function norm(s) {
  let t = String(s == null ? "" : s).toLowerCase().replace(/&/g, " and ").replace(/['’.]/g, "");
  t = t.replace(/\b(high school|senior high|hs|h s)\b/g, " ");
  t = t.replace(/\b(saint|st)\b/g, "st");
  return t.replace(/[^a-z0-9]+/g, " ").trim();
}

function tokens(s) {
  return new Set(norm(s).split(" ").filter((t) => t && !STOP.has(t)));
}

const flat = (s) => String(s == null ? "" : s).toLowerCase().replace(/[^a-z0-9]/g, "");

// Ratcliff/Obershelp similarity (the same measure Python's difflib uses): 2*matches/(len a + len b).
function matchingChars(a, b) {
  if (!a.length || !b.length) return 0;
  let best = 0;
  let ai = 0;
  let bi = 0;
  const prev = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let diag = 0;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      if (a[i - 1] === b[j - 1]) {
        prev[j] = diag + 1;
        if (prev[j] > best) {
          best = prev[j];
          ai = i - best;
          bi = j - best;
        }
      } else prev[j] = 0;
      diag = tmp;
    }
  }
  if (best === 0) return 0;
  return best + matchingChars(a.slice(0, ai), b.slice(0, bi)) + matchingChars(a.slice(ai + best), b.slice(bi + best));
}

export function ratio(a, b) {
  const x = String(a || "");
  const y = String(b || "");
  if (!x.length && !y.length) return 1;
  return (2 * matchingChars(x, y)) / (x.length + y.length);
}

// "Joe Poehls & Tim Simon (interim)" -> [{first:"Joe", last:"Poehls"}, {first:"Tim", last:"Simon"}]
// first/last keep the list's own spelling; fFirst/fLast are the lower-case letters-only forms.
export function coachParts(coach) {
  const cleaned = String(coach == null ? "" : coach).replace(/\(.*?\)/g, " ");
  const out = [];
  for (const piece of cleaned.split(/&|\/|\band\b/i)) {
    const words = piece.trim().split(/\s+/).filter(Boolean).filter((w) => !SUFFIX.has(w.toLowerCase().replace(/\./g, "")));
    if (words.length === 0) continue;
    const first = words[0];
    const last = words.length > 1 ? words.slice(1).join(" ") : "";
    out.push({ first, last, fFirst: flat(first), fLast: flat(last) });
  }
  return out;
}

// How the list's coach compares with the coach on file.
export function compareCoach(listCoach, dbFirst, dbLast) {
  const parts = coachParts(listCoach);
  if (parts.length === 0) return "list_blank";
  const ol = flat(dbLast);
  const of = flat(dbFirst);
  if (!ol) return "ours_blank";
  let best = "differ";
  for (const p of parts) {
    const firstOk = !p.fFirst || !of || p.fFirst[0] === of[0] || ratio(p.fFirst, of) >= 0.7;
    if (p.fLast && p.fLast === ol) {
      if (firstOk) return "agree";
      best = "first_name";
    } else if (p.fLast && ratio(p.fLast, ol) >= 0.8 && p.fFirst[0] === of[0]) {
      if (best !== "first_name") best = "spelling";
    }
  }
  return best;
}

// Which part of the list entry is the same person as ours (closest last name).
export function closestPart(listCoach, dbLast) {
  const ol = flat(dbLast);
  let best = null;
  let bestScore = -1;
  for (const p of coachParts(listCoach)) {
    const s = ratio(p.fLast, ol);
    if (s > bestScore) {
      best = p;
      bestScore = s;
    }
  }
  return best;
}

// Does the email on file carry the list's spelling, ours, both or neither? (District emails are
// usually last name + first initial, so the last name shows up in the part before the @.)
export function emailHint(listCoach, dbLast, email) {
  const local = flat(String(email || "").split("@")[0]);
  if (!local) return "none";
  const listLasts = coachParts(listCoach).map((p) => p.fLast).filter((l) => l.length >= 3);
  const ours = flat(dbLast);
  const listHit = listLasts.some((l) => local.includes(l));
  const oursHit = ours.length >= 3 && local.includes(ours);
  if (listHit && !oursHit) return "list";
  if (oursHit && !listHit) return "ours";
  if (listHit && oursHit) return "both";
  return "neither";
}

// The fix we would make for a "spelling" row, or null when the evidence is not strong enough.
// Fixable only when the email on file matches the LIST's spelling and not ours.
export function spellingFix(listCoach, db) {
  if (compareCoach(listCoach, db.hc_first_name, db.hc_last_name) !== "spelling") return null;
  if (emailHint(listCoach, db.hc_last_name, db.hc_email) !== "list") return null;
  const p = closestPart(listCoach, db.hc_last_name);
  if (!p || !p.last) return null;
  return { first: p.first, last: p.last };
}

// A fix is safe to write only if it is a pure spelling change of the same person and the email
// agrees. Re-checked on the server; the browser is never trusted.
export function fixIsSafe(oldFirst, oldLast, email, newFirst, newLast) {
  const ol = flat(oldLast);
  const nl = flat(newLast);
  const of = flat(oldFirst);
  const nf = flat(newFirst);
  if (!ol || !nl || !of || !nf) return false;
  if (ol === nl && of === nf) return false;
  if (ratio(ol, nl) < 0.8) return false;
  if (!(of === nf || (of[0] === nf[0] && ratio(of, nf) >= 0.7))) return false;
  const local = flat(String(email || "").split("@")[0]);
  if (!local || local.length < 3) return false;
  return local.includes(nl) && !(ol !== nl && local.includes(ol));
}

function prepareSchools(schools) {
  return schools.map((s) => ({
    ...s,
    _k: norm(s.name),
    _N: tokens(s.name),
    _C: tokens(s.city),
    _ck: norm(s.city),
  }));
}

function nameScore(listName, s) {
  const k = norm(listName);
  const T = tokens(listName);
  if (k && k === s._k) return 1;
  let sc = Math.max(ratio(k, s._k), ratio(k, `${s._ck} ${s._k}`), ratio(k, `${s._k} ${s._ck}`));
  if (T.size > 0) {
    let subset = true;
    let inName = false;
    for (const t of T) {
      if (!s._N.has(t) && !s._C.has(t)) subset = false;
      if (s._N.has(t)) inName = true;
    }
    if (subset && inName) sc = Math.max(sc, 0.9);
  }
  return sc;
}

// Where a list coach already sits in our data (same last name, same first initial).
function whereCoach(listCoach, schools, excludeId) {
  const found = [];
  for (const p of coachParts(listCoach)) {
    if (!p.fLast) continue;
    for (const s of schools) {
      if (s.id === excludeId) continue;
      if (flat(s.hc_last_name) === p.fLast && flat(s.hc_first_name)[0] === p.fFirst[0]) found.push(`${s.name} (${s.city})`);
    }
  }
  return Array.from(new Set(found));
}

// listRows: [{ school, coach }]; schools: open schools of one state with at least
// id, name, city, hc_first_name, hc_last_name, hc_email, verification_status, needs_review.
export function compareList(listRows, schoolsIn) {
  const schools = prepareSchools(schoolsIn);
  const rows = [];
  const claims = new Map(); // school id -> [row index]
  listRows.forEach((r, idx) => {
    const school = String(r.school || "").trim();
    const coach = String(r.coach || "").trim();
    let best = null;
    for (const s of schools) {
      const sc = nameScore(school, s);
      const cat = compareCoach(coach, s.hc_first_name, s.hc_last_name);
      const bonus = cat === "agree" || cat === "spelling" ? 0.25 : 0;
      if (!best || sc + bonus > best.total) best = { s, sc, cat, total: sc + bonus };
    }
    const row = { idx, listName: school, listCoach: coach, matched: false, score: 0, schoolId: null };
    if (best && (best.sc >= 0.8 || ((best.cat === "agree" || best.cat === "spelling") && best.sc >= 0.4))) {
      row.matched = true;
      row.score = Math.round(best.sc * 100) / 100;
      row.schoolId = best.s.id;
      row._best = best;
      if (!claims.has(best.s.id)) claims.set(best.s.id, []);
      claims.get(best.s.id).push(idx);
    }
    rows.push(row);
  });

  // Two list rows claiming one school of ours: the row whose coach matches (or the better name
  // match) keeps it; the others are "shared".
  for (const [, idxs] of claims) {
    if (idxs.length < 2) continue;
    const order = [...idxs].sort((a, b) => {
      const ra = rows[a]._best;
      const rb = rows[b]._best;
      const aOk = ra.cat === "agree" || ra.cat === "spelling" ? 0 : 1;
      const bOk = rb.cat === "agree" || rb.cat === "spelling" ? 0 : 1;
      return aOk - bOk || rb.sc - ra.sc;
    });
    const keep = order[0];
    for (const i of order.slice(1)) {
      rows[i].shared = true;
      rows[i].sharedWith = rows[keep].listName;
    }
  }

  return rows.map((r) => {
    const out = {
      idx: r.idx,
      listName: r.listName,
      listCoach: r.listCoach,
      schoolId: null,
      schoolName: "",
      city: "",
      ourFirst: "",
      ourLast: "",
      ourEmail: "",
      status: "",
      needsReview: false,
      score: r.score,
      category: "unmatched",
      emailHint: "none",
      fix: null,
      alsoAt: [],
      note: "",
    };
    if (!r.matched) {
      out.alsoAt = whereCoach(r.listCoach, schools, null);
      if (!r.listCoach) out.category = "list_blank";
      out.note = out.alsoAt.length ? "Coach is already on file at another of our schools (likely a co-op team)" : "No school of ours matches this name";
      return out;
    }
    const s = r._best.s;
    Object.assign(out, {
      schoolId: s.id,
      schoolName: s.name,
      city: s.city || "",
      ourFirst: s.hc_first_name || "",
      ourLast: s.hc_last_name || "",
      ourEmail: s.hc_email || "",
      status: s.verification_status || "",
      needsReview: Boolean(s.needs_review),
    });
    if (r.shared) {
      out.category = "shared";
      out.note = `Same school of ours as "${r.sharedWith}" on the list`;
      return out;
    }
    const cat = r._best.cat;
    out.emailHint = emailHint(r.listCoach, s.hc_last_name, s.hc_email);
    if (cat === "agree") out.category = "agree";
    else if (cat === "spelling") {
      out.category = "spelling";
      out.fix = spellingFix(r.listCoach, s);
      out.note = out.fix ? "Email on file carries the list's spelling" : "Email does not settle which spelling is right";
    } else if (cat === "first_name") {
      out.category = "first_name";
      out.alsoAt = [];
    } else if (cat === "ours_blank") out.category = "ours_blank";
    else if (cat === "list_blank") out.category = "list_blank";
    else {
      out.category = "differ";
      out.alsoAt = whereCoach(r.listCoach, schools, s.id);
      out.note =
        out.emailHint === "list"
          ? "Email on file belongs to the list's coach, so our name is likely out of date"
          : out.status === "verified" && out.emailHint === "ours"
          ? "Ours is verified and the email matches our coach, so the list may be old"
          : out.status === "verified"
          ? "Ours is verified, confirm which is current"
          : "Not verified yet";
    }
    return out;
  });
}
