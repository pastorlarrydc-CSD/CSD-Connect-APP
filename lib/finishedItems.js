// lib/finishedItems.js
//
// Keeps schools that are ALREADY DONE out of the batch review screens.
//
// A batch run can hold AI answers for schools that were verified some other
// way (another tool, a manual edit, an earlier pass), including whole states
// that are finished. Reviewing those again is duplicated work. This remembers,
// the first time a row is seen on screen, whether it was still waiting for
// review ("pending") while its school was already marked verified and not
// flagged for review. Those rows are hidden by default; each page has a
// "Show verified schools" switch to bring them back.
//
// The decision is made ONCE per row, at first sight, and never changes
// afterwards. That matters: applying a suggestion or saving a Quick Fix marks
// the school verified, and the row you just worked on must not vanish from
// under you.
import { useRef } from "react";

// Pure rule (exported for tests).
export function isFinishedAtFirstSight(item) {
  const s = item && item.school;
  if (!s) return false;
  if (item.review_status !== "pending") return false;
  if (s.verification_status !== "verified") return false;
  if (s.needs_review) return false; // flagged schools still need a person
  return true;
}

// -> Map(item id -> true when the row should be hidden by default)
export function useFinishedAtFirstSight(items) {
  const ref = useRef(null);
  if (ref.current === null) ref.current = new Map();
  const seen = ref.current;
  for (const item of items || []) {
    if (item && item.id != null && !seen.has(item.id)) seen.set(item.id, isFinishedAtFirstSight(item));
  }
  return seen;
}
