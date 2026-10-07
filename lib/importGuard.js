// Cross-school safety checks for the Import & Reconcile tool
// (/admin/import-reconcile).
//
// The failure this exists to catch: a spreadsheet row (or a paste-and-parse
// result) puts school A's coach email or cell number onto school B -- a
// copy/paste slip in the sheet, a district template, or a same-name-school
// mix-up. The row-level diff alone can't see that, because it only compares
// one row to ONE school. This compares what's about to be written against
// EVERY school already on file (and against the other rows in the same
// sheet), so a value that already belongs to somebody else lights up before
// it is applied, not after.
//
// Pure functions only (no React, no Supabase) so the page can use them and
// they can be tested on their own.
//
// Severity:
//   red    -- the same email/cell is already on another school under a
//             DIFFERENT coach last name (or the same value appears on another
//             row of this sheet for a different coach). Almost always a
//             mix-up. Not included in "Apply all safe rows".
//   yellow -- worth a look but often legitimate: same coach name at another
//             school in the state, same value on another school where the
//             coach surname matches (a coach who really does cover two
//             schools), a "cell" identical to the school's own office line,
//             or the surname is unknown so we can't compare. Also held out
//             of "Apply all safe rows".

export function trim(v) {
  return v == null ? "" : String(v).trim();
}

export function normEmailKey(v) {
  return trim(v).toLowerCase();
}

// Last 10 digits of a phone number, or "" when there aren't 10.
export function digits10(v) {
  let d = trim(v).replace(/\D+/g, "");
  if (d.length === 11 && d.startsWith("1")) d = d.slice(1);
  if (d.length > 10) d = d.slice(-10);
  return d.length === 10 ? d : "";
}

function nameKeyPart(v) {
  return trim(v).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function coachNameKey(first, last, state) {
  const f = nameKeyPart(first);
  const l = nameKeyPart(last);
  const st = trim(state).toUpperCase();
  return f && l && st ? `${f}|${l}|${st}` : "";
}

function pushSet(map, key, id) {
  if (!key) return;
  let set = map.get(key);
  if (!set) {
    set = new Set();
    map.set(key, set);
  }
  set.add(id);
}

function dropFromSet(map, key, id) {
  if (!key) return;
  const set = map.get(key);
  if (!set) return;
  set.delete(id);
  if (!set.size) map.delete(key);
}

// ---- Index of every school on file ------------------------------------

export function createSchoolIndex() {
  return { byId: new Map(), byEmail: new Map(), byCell: new Map(), byName: new Map() };
}

function slim(s) {
  return {
    id: String(s.id),
    name: s.name || "",
    state: s.state || "",
    city: s.city || "",
    hc_first_name: s.hc_first_name || "",
    hc_last_name: s.hc_last_name || "",
    hc_email: s.hc_email || "",
    hc_cell: s.hc_cell || "",
    hc_office: s.hc_office || "",
  };
}

function addKeys(index, e) {
  pushSet(index.byEmail, normEmailKey(e.hc_email), e.id);
  pushSet(index.byCell, digits10(e.hc_cell), e.id);
  pushSet(index.byName, coachNameKey(e.hc_first_name, e.hc_last_name, e.state), e.id);
}

function removeKeys(index, e) {
  dropFromSet(index.byEmail, normEmailKey(e.hc_email), e.id);
  dropFromSet(index.byCell, digits10(e.hc_cell), e.id);
  dropFromSet(index.byName, coachNameKey(e.hc_first_name, e.hc_last_name, e.state), e.id);
}

export function buildSchoolIndex(schools) {
  const index = createSchoolIndex();
  (schools || []).forEach((s) => indexAddSchool(index, s));
  return index;
}

export function indexAddSchool(index, school) {
  const e = slim(school);
  const existing = index.byId.get(e.id);
  if (existing) removeKeys(index, existing);
  index.byId.set(e.id, e);
  addKeys(index, e);
}

// Call after a school's coach fields change so the NEXT row sees the new
// owner of an email/cell -- this is what catches a sheet that repeats one
// coach's contact on two schools.
export function indexUpdateSchool(index, schoolId, patch) {
  const id = String(schoolId);
  const existing = index.byId.get(id);
  if (!existing) return;
  removeKeys(index, existing);
  const next = { ...existing };
  ["name", "state", "city", "hc_first_name", "hc_last_name", "hc_email", "hc_cell", "hc_office"].forEach((f) => {
    if (patch && Object.prototype.hasOwnProperty.call(patch, f)) next[f] = patch[f] || "";
  });
  index.byId.set(id, next);
  addKeys(index, next);
}

// ---- Index of the other rows in the same sheet --------------------------

export function rowKeyFor(row) {
  if (row.match_school_id != null) return `id:${row.match_school_id}`;
  const m = row.mapped_data || {};
  return `new:${nameKeyPart(m.name)}|${trim(m.state).toUpperCase()}`;
}

export function buildSheetIndex(rows) {
  const byEmail = new Map();
  const byCell = new Map();
  const push = (map, key, entry) => {
    if (!key) return;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(entry);
  };
  (rows || []).forEach((r) => {
    if (r.resolution !== "pending") return;
    if (r.bucket !== "new_info" && r.bucket !== "conflict" && r.bucket !== "new_school") return;
    const m = r.mapped_data || {};
    const entry = { rowKey: rowKeyFor(r), label: r.label || m.name || `Row ${r.row_index}`, last: m.hc_last_name || "" };
    push(byEmail, normEmailKey(m.hc_email), entry);
    push(byCell, digits10(m.hc_cell), entry);
  });
  return { byEmail, byCell };
}

// ---- The check itself -----------------------------------------------------

function surnamesDiffer(a, b) {
  const x = nameKeyPart(a);
  const y = nameKeyPart(b);
  return !!x && !!y && x !== y;
}

function where(e) {
  return `${e.name}${e.city ? ` (${e.city}, ${e.state})` : e.state ? ` (${e.state})` : ""}`;
}

// index/sheet: from buildSchoolIndex / buildSheetIndex (either may be null
// while the school list is still loading -- then nothing is flagged, but the
// caller also treats "not ready" as "can't call this safe").
//
// target: {
//   schoolId   -- the school this row writes to, or null for a new school
//   rowKey     -- rowKeyFor(row)
//   state      -- state of the school (matched or new)
//   base       -- the school's CURRENT values for the hc_* fields ({} for new)
//   fields     -- [{ field, new, kind }] about to be written (kind "clear" blanks it)
// }
//
// Returns { level: "none" | "yellow" | "red", items: [{ level, text }] }.
export function evaluateGuard(index, sheet, target) {
  const items = [];
  if (!index) return { level: "none", items };

  const base = target.base || {};
  const eff = {
    hc_first_name: trim(base.hc_first_name),
    hc_last_name: trim(base.hc_last_name),
    hc_email: trim(base.hc_email),
    hc_cell: trim(base.hc_cell),
    hc_office: trim(base.hc_office),
  };
  const touched = new Set();
  (target.fields || []).forEach((f) => {
    if (!(f.field in eff)) return;
    touched.add(f.field);
    eff[f.field] = f.kind === "clear" ? "" : trim(f.new);
  });
  const selfId = target.schoolId != null ? String(target.schoolId) : null;
  const lastName = eff.hc_last_name;
  const coachLabel = [eff.hc_first_name, eff.hc_last_name].filter(Boolean).join(" ") || "this coach";

  const othersFor = (map, key) => {
    const set = key ? map.get(key) : null;
    if (!set) return [];
    const out = [];
    set.forEach((id) => {
      if (id === selfId) return;
      const e = index.byId.get(id);
      if (e) out.push(e);
    });
    return out;
  };

  // 1. Email already on another school.
  if (touched.has("hc_email") && eff.hc_email) {
    const others = othersFor(index.byEmail, normEmailKey(eff.hc_email));
    others.slice(0, 3).forEach((o) => {
      const otherCoach = [o.hc_first_name, o.hc_last_name].filter(Boolean).join(" ") || "no coach name";
      if (surnamesDiffer(lastName, o.hc_last_name)) {
        items.push({ level: "red", text: `Email ${eff.hc_email} is already on ${where(o)} for ${otherCoach} — a different coach than ${coachLabel}. Possible copy/paste mix-up.` });
      } else {
        items.push({ level: "yellow", text: `Email ${eff.hc_email} is also on ${where(o)} (${otherCoach}). Fine if one coach really covers both schools or it's a district address; otherwise double-check.` });
      }
    });
    if (others.length > 3) items.push({ level: "yellow", text: `…and ${others.length - 3} more schools already use that email.` });
  }

  // 2. Cell already on another school (a cell is one person's -- identical
  //    cells on two schools means one coach or a mix-up).
  const cellKey = digits10(eff.hc_cell);
  if (touched.has("hc_cell") && cellKey) {
    const others = othersFor(index.byCell, cellKey);
    others.slice(0, 3).forEach((o) => {
      const otherCoach = [o.hc_first_name, o.hc_last_name].filter(Boolean).join(" ") || "no coach name";
      if (surnamesDiffer(lastName, o.hc_last_name)) {
        items.push({ level: "red", text: `Cell ${eff.hc_cell} is already on ${where(o)} for ${otherCoach} — a different coach than ${coachLabel}. Possible copy/paste mix-up.` });
      } else {
        items.push({ level: "yellow", text: `Cell ${eff.hc_cell} is also on ${where(o)} (${otherCoach}). Fine if it's the same coach; otherwise double-check.` });
      }
    });
  }

  // 3. "Cell" identical to this school's own office line.
  if ((touched.has("hc_cell") || touched.has("hc_office")) && cellKey && cellKey === digits10(eff.hc_office)) {
    items.push({ level: "yellow", text: `The cell number is the same as the office number (${eff.hc_cell}) — probably the school's main line, not a personal cell.` });
  }

  // 4. Same coach name already at another school in this state.
  if ((touched.has("hc_first_name") || touched.has("hc_last_name")) && eff.hc_first_name && eff.hc_last_name) {
    const others = othersFor(index.byName, coachNameKey(eff.hc_first_name, eff.hc_last_name, target.state));
    others.slice(0, 2).forEach((o) => {
      items.push({ level: "yellow", text: `${coachLabel} is already listed as head coach at ${where(o)}. Fine if he moved or coaches two programs; otherwise this may be the wrong school.` });
    });
  }

  // 5. Same email / cell on another row of this same sheet.
  if (sheet) {
    const sameSheet = (map, key, what, shown) => {
      if (!key) return;
      const hits = (map.get(key) || []).filter((o) => o.rowKey !== target.rowKey);
      hits.slice(0, 3).forEach((o) => {
        const differ = surnamesDiffer(lastName, o.last);
        items.push({
          level: differ ? "red" : "yellow",
          text: `This sheet also puts ${what} ${shown} on "${o.label}"${o.last ? ` (coach ${o.last})` : ""} — ${differ ? "a different coach. Likely a copy-down error in the sheet." : "check that both rows should have it."}`,
        });
      });
    };
    if (touched.has("hc_email")) sameSheet(sheet.byEmail, normEmailKey(eff.hc_email), "email", eff.hc_email);
    if (touched.has("hc_cell")) sameSheet(sheet.byCell, cellKey, "cell", eff.hc_cell);
  }

  const level = items.some((i) => i.level === "red") ? "red" : items.length ? "yellow" : "none";
  return { level, items };
}
