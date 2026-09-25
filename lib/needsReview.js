// Shared shape for clearing the schools.needs_review bookmark (needs_review,
// needs_review_note, needs_review_marked_at, needs_review_marked_by) -- the
// exact same four-field reset app/(app)/admin/data-quality/page.js's
// unmarkForReview already writes by hand when a reviewer clicks "unmark".
//
// Before this file existed, unmarkForReview was the ONLY place in the whole
// app that ever cleared this flag -- not Quick Fix save, not any batch
// tool's Apply/auto-apply, not Import & Reconcile. That meant a school could
// have its coach info actually corrected through any of those paths and
// still sit in the Needs Review queue forever, wearing the amber badge,
// until someone separately found it and clicked unmark as a whole extra
// step. Confirmed while investigating Run #34's 110 bounce-recovery schools
// (see claude/batch-exclusion-row-cap-bug-fix.md, Part 5 and Part 6).
//
// Spread this into an update object anywhere a real, human-endorsed fix is
// landing on a school (a Quick Fix save, a manual batch-tool Apply, an
// Import & Reconcile apply, or Coach-Info's own unattended high-confidence
// auto-apply) -- it's harmless to include even when the school didn't have
// needs_review set, since writing false/null over already-false/null values
// is a no-op.
export const NEEDS_REVIEW_CLEAR_FIELDS = {
  needs_review: false,
  needs_review_note: null,
  needs_review_marked_at: null,
  needs_review_marked_by: null,
};
