// Dry-run "what will this click actually do?" summary for Import & Reconcile.
//
// "Apply all 140 safe rows" used to be a leap of faith: the button said how
// many ROWS, not what would happen to the DATABASE. Applying a trusted sheet
// does more than write the visible fields -- it also stamps each school
// Verified, resolves its pending Data Quality flags and clears its Needs
// Review flag; an unchecked sheet does the opposite (marks schools Not
// Verified and puts them on Needs Review, which can DOWNGRADE a school that
// was verified). None of that was visible before the click.
//
// Pure function, no React / Supabase: the page gathers the facts (the rows it
// is about to apply, each affected school's current status, how many pending
// flags each has) and this turns them into numbers and a short list of things
// worth a second look. It mirrors what applyRowFields in
// app/(app)/admin/import-reconcile/page.js does -- keep the two in step.

function clean(v) {
  return String(v == null ? "" : v).trim();
}

// items:         [{ schoolId, name, state, fields: [{ field, label, old, new, kind }] }]
// trusted:       true for a sheet marked checked (own research / coach-submitted)
// statusById:    { [schoolId]: { verification_status, needs_review } }  (missing = unknown)
// pendingFlags:  { [schoolId]: number of pending school_flags }
// newSchools:    number of brand-new schools about to be created (no existing record touched)
export function summarizeImpact({ items, trusted, statusById, pendingFlags, newSchools }) {
  const status = statusById || {};
  const flagsBy = pendingFlags || {};
  const list = items || [];

  const out = {
    rows: list.length,
    newSchools: newSchools || 0,
    trusted: Boolean(trusted),
    fieldWrites: 0,
    byField: {}, // label -> { fill, overwrite, clear }
    nameChanges: [], // { schoolId, name, state, from, to }
    emailsReplaced: 0,
    emailsCleared: 0,
    emailsFilled: 0,
    cellsCleared: 0,
    flagsClosing: 0,
    schoolsWithFlags: 0,
    becomeVerified: 0,
    alreadyVerified: 0,
    verifiedDowngraded: [], // untrusted sheet over a verified school: { schoolId, name, state }
    needsReviewCleared: 0,
    needsReviewSet: 0,
    statusUnknown: 0,
    watch: [], // plain-language things worth a second look
  };

  list.forEach((it) => {
    const fields = it.fields || [];
    const st = status[it.schoolId] || status[String(it.schoolId)] || null;

    fields.forEach((f) => {
      out.fieldWrites += 1;
      const label = f.label || f.field;
      const bucket = out.byField[label] || (out.byField[label] = { fill: 0, overwrite: 0, clear: 0 });
      if (f.kind === "clear") bucket.clear += 1;
      else if (f.kind === "overwrite") bucket.overwrite += 1;
      else bucket.fill += 1;

      if (f.field === "hc_email") {
        if (f.kind === "clear") out.emailsCleared += 1;
        else if (f.kind === "overwrite") out.emailsReplaced += 1;
        else out.emailsFilled += 1;
      }
      if (f.field === "hc_cell" && f.kind === "clear") out.cellsCleared += 1;
    });

    // A coach change = an overwrite of the first or last name.
    const first = fields.find((f) => f.field === "hc_first_name" && f.kind === "overwrite");
    const last = fields.find((f) => f.field === "hc_last_name" && f.kind === "overwrite");
    if (first || last) {
      const from = [clean(first && first.old), clean(last && last.old)].filter(Boolean).join(" ");
      const to = [clean(first && first.new), clean(last && last.new)].filter(Boolean).join(" ");
      out.nameChanges.push({ schoolId: it.schoolId, name: it.name || "", state: it.state || "", from, to });
    }

    // Side effects of the apply itself (not the visible fields).
    if (!st) {
      out.statusUnknown += 1;
    }
    const verified = st && st.verification_status === "verified";
    const needsReview = st && st.needs_review === true;

    if (trusted) {
      if (verified) out.alreadyVerified += 1;
      else out.becomeVerified += 1;
      if (needsReview) out.needsReviewCleared += 1;
      const nFlags = Number(flagsBy[it.schoolId] || flagsBy[String(it.schoolId)] || 0);
      if (nFlags > 0) {
        out.flagsClosing += nFlags;
        out.schoolsWithFlags += 1;
      }
    } else {
      out.needsReviewSet += 1;
      if (verified) out.verifiedDowngraded.push({ schoolId: it.schoolId, name: it.name || "", state: it.state || "" });
    }
  });

  // ---- Things worth a second look ------------------------------------
  if (out.nameChanges.length) {
    out.watch.push(`${out.nameChanges.length} school${out.nameChanges.length === 1 ? "" : "s"} will get a different head coach.`);
  }
  if (out.emailsReplaced) {
    out.watch.push(`${out.emailsReplaced} head-coach email${out.emailsReplaced === 1 ? "" : "s"} will be replaced with a different address.`);
  }
  if (out.emailsCleared) {
    out.watch.push(`${out.emailsCleared} head-coach email${out.emailsCleared === 1 ? "" : "s"} will be cleared (it spelled the departed coach's name).`);
  }
  if (out.cellsCleared) {
    out.watch.push(`${out.cellsCleared} head-coach cell number${out.cellsCleared === 1 ? "" : "s"} will be cleared.`);
  }
  if (trusted && out.flagsClosing) {
    out.watch.push(
      `${out.flagsClosing} pending Data Quality flag${out.flagsClosing === 1 ? "" : "s"} on ${out.schoolsWithFlags} school${out.schoolsWithFlags === 1 ? "" : "s"} will be closed as resolved — make sure the sheet really answers them.`
    );
  }
  if (!trusted && out.verifiedDowngraded.length) {
    out.watch.push(
      `${out.verifiedDowngraded.length} school${out.verifiedDowngraded.length === 1 ? " that is" : "s that are"} currently Verified will drop to Not Verified because this sheet is marked unchecked.`
    );
  }
  if (out.statusUnknown) {
    out.watch.push(`Couldn't read the current status of ${out.statusUnknown} school${out.statusUnknown === 1 ? "" : "s"}, so the verified / flag counts above leave ${out.statusUnknown === 1 ? "it" : "them"} out.`);
  }

  return out;
}

// One plain-English line per side effect, in the order Larry would want to
// read them. Kept here (not in the page) so it is tested with the numbers.
export function impactLines(s) {
  const lines = [];
  if (s.rows) lines.push(`${s.rows} existing school${s.rows === 1 ? "" : "s"} updated (${s.fieldWrites} field change${s.fieldWrites === 1 ? "" : "s"}).`);
  if (s.newSchools) lines.push(`${s.newSchools} new school${s.newSchools === 1 ? "" : "s"} added.`);
  if (s.rows && s.trusted) {
    lines.push(`${s.becomeVerified} will be marked Verified${s.alreadyVerified ? ` (${s.alreadyVerified} already are)` : ""}.`);
    if (s.needsReviewCleared) lines.push(`${s.needsReviewCleared} will come off the Needs Review list.`);
    lines.push(`${s.flagsClosing} pending Data Quality flag${s.flagsClosing === 1 ? "" : "s"} will be closed.`);
  } else if (s.rows) {
    lines.push(`${s.rows} will be left Not Verified and put on the Needs Review list (unchecked sheet).`);
  }
  return lines;
}
