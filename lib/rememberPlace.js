// lib/rememberPlace.js
//
// "Where was I?" for the long review screens (Batch Social, and later the other
// batch tools). Leaving a review page and coming back used to reset it: the run
// list opened on the newest run, the confidence / search filters cleared and the
// page jumped to the top, so Larry had to dig back to the row he was working on.
//
// This remembers three things per screen, in this browser:
//   1. which run was open and which filters / switches were set,
//   2. which row was keyboard-focused, and
//   3. how far down the page he was -- recorded as "row #4312 was sitting 180px
//      from the top", not just a pixel count, so if rows above him were applied
//      or skipped in the meantime he still lands on the same school.
//
// Stored in localStorage (so it also survives closing the tab) and thrown away
// after three days so a long-forgotten place never surprises him. Every call is
// wrapped in try/catch: private windows or blocked storage just mean the screen
// opens the normal way.

const PREFIX = "csdPlace:";
const MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;

export function readPlace(name) {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(PREFIX + name);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object") return null;
    if (!data.savedAt || Date.now() - data.savedAt > MAX_AGE_MS) return null;
    return data;
  } catch (_) {
    return null;
  }
}

export function writePlace(name, data) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(PREFIX + name, JSON.stringify({ ...data, savedAt: Date.now() }));
  } catch (_) {}
}

export function clearPlace(name) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(PREFIX + name);
  } catch (_) {}
}

// Rows carry data-place-row="<id>". The anchor is the first row sitting below
// the sticky site header (headerPx from the top of the window).
export function captureScrollAnchor(headerPx = 110) {
  if (typeof document === "undefined" || typeof window === "undefined") return { scrollY: 0, anchorId: null, anchorTop: 0 };
  const scrollY = Math.round(window.scrollY || 0);
  try {
    const rows = document.querySelectorAll("[data-place-row]");
    for (let n = 0; n < rows.length; n++) {
      const top = rows[n].getBoundingClientRect().top;
      if (top >= headerPx) return { scrollY, anchorId: rows[n].getAttribute("data-place-row"), anchorTop: Math.round(top) };
    }
  } catch (_) {}
  return { scrollY, anchorId: null, anchorTop: 0 };
}

// Scrolls back to the remembered row (same distance from the top as before). If
// that row is gone -- applied or skipped elsewhere meanwhile -- falls back to the
// plain pixel position. Returns true if it scrolled anywhere.
export function restoreScrollAnchor(place) {
  if (typeof document === "undefined" || typeof window === "undefined" || !place) return false;
  try {
    if (place.anchorId !== null && place.anchorId !== undefined) {
      const id = String(place.anchorId).replace(/["\\]/g, "");
      const el = document.querySelector(`[data-place-row="${id}"]`);
      if (el) {
        window.scrollBy(0, el.getBoundingClientRect().top - (Number(place.anchorTop) || 0));
        return true;
      }
    }
    if (Number(place.scrollY) > 0) {
      window.scrollTo(0, Number(place.scrollY));
      return true;
    }
  } catch (_) {}
  return false;
}
