// lib/staffEmailFinder.js
//
// Finds a coach's email by READING the school's own staff pages -- no AI, no
// guessing. Pure functions (no imports, no network) so the route can feed them
// fetched page text and tests can feed them fixtures.
//
// Why: the AI lookup often confirms WHO the coach is but not the email
// ("Same coach -- email not confirmed", as on Bertrand High). The email is
// usually printed right on the school's staff directory next to the coach's
// name. Instead of asking a model to remember it, this scans the page text for
// every email address, looks at the words around each one, and reports only an
// address that is literally on the page next to (or clearly belonging to) the
// coach. Every candidate comes back with the line it was found on and the page
// it came from, so a reviewer can confirm in one glance.
//
// Never invents an address. A district's email pattern (first.last@domain) is
// reported only as a labelled HINT about what to look for -- it is never
// returned as a candidate and never applied.

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

// Role / office mailboxes: they fit any coach, so they never count as "the
// coach's email" (they are returned only as a labelled fallback).
const GENERIC_LOCAL = /^(info|athletics?|athleticdirector|football|fb|coach|coaches|admin|office|contact|ad|sports?|hs|school|principal|registrar|attendance|webmaster|frontoffice|mail|help|support|team|varsity|noreply|no-reply)/;

const SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv", "v"]);

function clean(v) {
  return String(v == null ? "" : v).trim();
}

function letters(s) {
  return clean(s).toLowerCase().replace(/[^a-z]/g, "");
}

function lastKey(name) {
  const t = clean(name)
    .toLowerCase()
    .split(/[\s,]+/)
    .map((x) => x.replace(/[^a-z]/g, ""))
    .filter(Boolean);
  while (t.length > 1 && SUFFIXES.has(t[t.length - 1])) t.pop();
  return t.join("");
}

export function extractEmails(text) {
  const out = [];
  const t = String(text || "");
  let m;
  EMAIL_RE.lastIndex = 0;
  while ((m = EMAIL_RE.exec(t))) {
    // Trailing punctuation that is part of the sentence, not the address.
    const email = m[0].replace(/[.,;:)]+$/, "");
    out.push({ email, index: m.index });
  }
  return out;
}

function hostOf(email) {
  const at = clean(email).lastIndexOf("@");
  return at > 0 ? clean(email).slice(at + 1).toLowerCase() : "";
}

function rootDomain(host) {
  const parts = clean(host).toLowerCase().replace(/^www\./, "").split(".");
  return parts.length <= 2 ? parts.join(".") : parts.slice(-2).join(".");
}

// domainHints: hostnames of the school/district's own sites and the domain of
// any email already on file ("bertrandvikings.org", "tangischools.org").
function onSchoolDomain(email, domainHints) {
  const root = rootDomain(hostOf(email));
  return (domainHints || []).some((h) => {
    const r = rootDomain(h);
    return r && r === root;
  });
}

// -> [{ email, score, strength, context, url, reasons[], generic, off_domain }]
// strength: "strong"  the coach's name is right beside the address AND/OR the
//                     address itself contains the coach's last name
//           "possible" only one weak signal
// Sorted best first; at most `limit`.
export function findCoachEmailCandidates({ text, url, first, last, domainHints = [], limit = 5 }) {
  const lk = lastKey(last);
  const fi = letters(first).slice(0, 1);
  if (lk.length < 2) return [];
  const body = String(text || "");
  const lower = body.toLowerCase();
  const all = extractEmails(body);
  const found = new Map();
  for (let i = 0; i < all.length; i++) {
    const { email, index } = all[i];
    const key = email.toLowerCase();
    const local = letters(key.slice(0, key.indexOf("@")));
    const generic = GENERIC_LOCAL.test(local) && !local.includes(lk);
    const ctxStart = Math.max(0, index - 140);
    const ctxEnd = Math.min(body.length, index + email.length + 140);
    const context = body.slice(ctxStart, ctxEnd).replace(/\s+/g, " ").trim();

    // "Next to it" means in the same staff-directory row: the coach's last name
    // appears just before this address (or just after it) with NO other email
    // address in between. A name that belongs to the neighbouring row does not
    // count -- otherwise the principal's address, listed right under the
    // coach, would look like the coach's.
    const prevEnd = i > 0 ? all[i - 1].index + all[i - 1].email.length : 0;
    const nextStart = i + 1 < all.length ? all[i + 1].index : body.length;
    const before = lower.slice(Math.max(prevEnd, index - 110), index).replace(/[^a-z]/g, "");
    const after = lower.slice(index + email.length, Math.min(nextStart, index + email.length + 70)).replace(/[^a-z]/g, "");
    const nameBeside = before.includes(lk) || after.includes(lk);
    const localHasName = local.includes(lk);
    if (!localHasName && !nameBeside) continue;
    const near = lower.slice(Math.max(prevEnd, index - 110), Math.min(nextStart, index + email.length + 70));

    let score = 0;
    const reasons = [];
    if (localHasName) {
      score += 4;
      reasons.push("the address contains the coach's last name");
      if (fi && (local.startsWith(fi) || local.includes(`${fi}${lk}`))) score += 1;
    }
    if (nameBeside) {
      score += 3;
      reasons.push("the coach's name is printed next to it");
    }
    if (/football/.test(near)) {
      score += 1;
      reasons.push("'football' is mentioned in the same row");
    }
    if (/head\s+(football\s+)?coach/.test(near)) {
      score += 1;
      reasons.push("'head coach' is mentioned in the same row");
    }
    if (generic) {
      score -= 4;
      reasons.push("looks like a general mailbox, not a person");
    }
    const offDomain = domainHints.length > 0 && !onSchoolDomain(key, domainHints);
    if (offDomain) {
      score -= 2;
      reasons.push("not on the school's or district's own domain");
    }
    if (score <= 0) continue;
    const prev = found.get(key);
    if (!prev || score > prev.score) {
      found.set(key, {
        email,
        score,
        strength: (localHasName && nameBeside) || score >= 7 ? "strong" : "possible",
        context,
        url: clean(url),
        reasons,
        generic,
        off_domain: offDomain,
      });
    }
  }
  return [...found.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

// A district naming pattern seen on the page, as a HINT only: what other staff
// addresses look like, so a reviewer knows what to look for. Returns null when
// there is no clear pattern. Never applied to anything.
export function inferEmailPattern(text, domainHints = []) {
  const counts = new Map();
  const examples = new Map();
  for (const { email } of extractEmails(text)) {
    if (domainHints.length && !onSchoolDomain(email, domainHints)) continue;
    const at = email.indexOf("@");
    const local = email.slice(0, at).toLowerCase();
    if (GENERIC_LOCAL.test(local.replace(/[^a-z]/g, ""))) continue;
    let pattern = null;
    if (/^[a-z]+\.[a-z]+$/.test(local)) pattern = "first.last";
    else if (/^[a-z]\.[a-z]+$/.test(local)) pattern = "f.last";
    else if (/^[a-z]+_[a-z]+$/.test(local)) pattern = "first_last";
    else if (/^[a-z]{5,}$/.test(local)) pattern = "firstlast-or-flast";
    if (!pattern) continue;
    const key = `${pattern}@${email.slice(at + 1).toLowerCase()}`;
    counts.set(key, (counts.get(key) || 0) + 1);
    if (!examples.has(key)) examples.set(key, email);
  }
  let best = null;
  for (const [key, n] of counts) if (n >= 3 && (!best || n > best.n)) best = { key, n };
  if (!best) return null;
  return { pattern: best.key, seen_on: best.n, example: examples.get(best.key) };
}
