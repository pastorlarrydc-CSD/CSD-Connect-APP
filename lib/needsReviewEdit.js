// lib/needsReviewEdit.js
//
// Shared by the Needs Review page and its save endpoint
// (app/api/admin/needs-review/save/route.js): which fields Quick Fix on that
// page can edit, how to spot an email that still belongs to the PREVIOUS coach,
// and how to turn a stored athletics/website value into a safe link.
//
// Pure functions, no imports beyond lib/coachEmailFit.js.
import { emailFit } from "./coachEmailFit";

export const EDIT_FIELDS = ["hc_first_name", "hc_last_name", "hc_email", "hc_office", "hc_cell"];
export const EDIT_LABELS = {
  hc_first_name: "First name",
  hc_last_name: "Last name",
  hc_email: "Email",
  hc_office: "Office phone",
  hc_cell: "Cell",
};

export function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
}

// The coach-change flags written on Oct 7, 2026 say "...from last name Brose
// to Ryan Patterson, but the email on file (...) still contains the previous
// coach's surname...". Pull that previous surname back out of the note.
export function priorLastFromNote(note) {
  const m = /from last name (.+?) to /i.exec(String(note || ""));
  return m ? m[1].trim() : "";
}

// Non-null when the school's email on file still looks like the previous
// coach's (it contains their surname and not the current coach's).
export function staleEmailInfo(school) {
  const priorLast = priorLastFromNote(school && school.needs_review_note);
  if (!priorLast) return null;
  const fit = emailFit(school.hc_email, { last: school.hc_last_name }, { last: priorLast });
  return fit === "stale" ? { priorLast } : null;
}

// A school's athletics/website value as a safe, clickable http(s) URL. Stored
// values are sometimes bare ("hemetusd.org/athletics"); anything that can't be
// parsed as a web address is refused rather than linked.
export function linkableUrl(value) {
  const v = String(value || "").trim();
  if (!v) return null;
  const withProto = /^https?:\/\//i.test(v) ? v : `https://${v}`;
  try {
    const u = new URL(withProto);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch (_) {
    return null;
  }
}
