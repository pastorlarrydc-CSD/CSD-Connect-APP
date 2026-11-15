// lib/aiSecondPass.js
//
// A second, skeptical AI read of the SAME sources, aimed only at disproving the
// first answer. The first pass is asked "who is the head coach?" and tends to
// settle on the first name that fits; this pass is asked "what in these
// sources says that answer is wrong?" -- a different job, so it catches
// different mistakes (a newer coach named further down the page, an interim
// tag, a resignation, an email that belongs to someone else, a same-named
// school).
//
// Rules that keep it safe:
//   - It only ever LOWERS confidence (high -> medium) and attaches a note.
//     It can never raise confidence or write anything to the database.
//   - A "contradicted" verdict only counts when the objection is backed by a
//     verbatim quote that really appears in the sources (verifyQuote). An
//     objection with no findable quote is recorded as "inconclusive".
//   - Any failure (timeout, bad JSON, API error) is silent: the suggestion goes
//     through exactly as it did before this existed.
//   - It uses only the text already given to the first pass; no new searches.
import { verifyQuote, stripOnFileBlock } from "@/lib/aiEvidence";

export const SECOND_PASS_MODEL = process.env.ANTHROPIC_SECOND_PASS_MODEL || process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001";
export const SECOND_PASS_TIMEOUT_MS = 15000;
const MAX_SOURCE_CHARS = 60000;

export const SECOND_PASS_SYSTEM_PROMPT = `You are a skeptical fact-checker for a college football recruiting database. You are given (1) SOURCES -- text collected from the web about one specific high school's football program -- and (2) a CLAIM about who that school's current head football coach is. Your only job is to look for anything in the SOURCES that contradicts or undermines the claim. Do not use outside knowledge.

Look for:
- a different person named as head football coach (including "new head coach", "interim", "named", "hired", "promoted") for the current or an upcoming season;
- a statement that the claimed coach resigned, was fired, retired, moved to another job or school, or is only an assistant, coordinator or non-football coach;
- an email address in the claim that sits next to a different person's name in the sources, or whose name part matches someone else;
- sources that describe a different school with the same or a similar name (different city or state);
- the only evidence for the claimed coach being older than evidence for someone else.

Reply with ONLY one JSON object, no other text:
{"verdict": "contradicted" | "supported" | "inconclusive", "conflict_type": "", "conflicting_name": "", "conflicting_quote": "", "reason": ""}
- "contradicted": you found something in the SOURCES that undermines the claim. conflicting_quote MUST be copied word for word from the SOURCES.
- "supported": you looked for all of the above and found nothing that undermines the claim.
- "inconclusive": the SOURCES are too thin to say either way.
conflict_type is one of: different_coach, left_job, email_mismatch, different_school, older_evidence, other. reason is one or two plain sentences.`;

function clean(v) {
  return String(v == null ? "" : v).trim();
}

export function buildSecondPassMessage({ school, suggestion, sourceText }) {
  const name = [suggestion.hc_first_name, suggestion.hc_last_name].filter(Boolean).join(" ");
  const claim = [
    `School: ${clean(school?.name)}, ${clean(school?.city)}, ${clean(school?.state)}`,
    `Claimed head football coach: ${name || "(none)"}`,
    suggestion.hc_email ? `Claimed coach email: ${suggestion.hc_email}${suggestion.hc_email_estimated ? " (pattern-estimated)" : ""}` : null,
    suggestion.evidence?.name_quote ? `Quote the first reader relied on: "${suggestion.evidence.name_quote}"` : null,
  ]
    .filter(Boolean)
    .join("\n");
  return `CLAIM\n${claim}\n\nSOURCES\n${String(sourceText || "").slice(0, MAX_SOURCE_CHARS)}`;
}

// Which suggestions are worth a second look. High confidence is the only tier
// that is ever auto-applied or auto-confirmed, so it always gets one. A
// medium suggestion that names a DIFFERENT coach than the one on file is the
// other costly mistake (a good coach replaced by a wrong one), so it gets one
// too. Everything else is skipped to keep the cost down.
export function needsSecondPass({ suggestion, school }) {
  if (!suggestion || !(suggestion.hc_first_name || suggestion.hc_last_name)) return false;
  if (suggestion.confidence === "high") return true;
  if (suggestion.confidence === "medium" && school) {
    const same = (a, b) => clean(a).toLowerCase().replace(/[^a-z]/g, "") === clean(b).toLowerCase().replace(/[^a-z]/g, "");
    const onFile = clean(school.hc_first_name) || clean(school.hc_last_name);
    const differs = !same(suggestion.hc_last_name, school.hc_last_name) || !same(suggestion.hc_first_name, school.hc_first_name);
    return Boolean(onFile) && differs;
  }
  return false;
}

// Parses the model's JSON the same forgiving way the first pass does.
function parseJson(text) {
  const t = clean(text);
  if (!t) return null;
  try {
    return JSON.parse(t);
  } catch (_) {
    const m = t.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      return JSON.parse(m[0]);
    } catch (_) {
      return null;
    }
  }
}

// Folds a raw second-pass reply into the shape stored on the suggestion.
// Exported separately so it can be tested without a network call.
export function interpretSecondPass(raw, sourceText) {
  const verdictRaw = ["contradicted", "supported", "inconclusive"].includes(raw?.verdict) ? raw.verdict : "inconclusive";
  const quote = clean(raw?.conflicting_quote).slice(0, 400);
  const out = {
    verdict: verdictRaw,
    conflict_type: clean(raw?.conflict_type).slice(0, 40),
    conflicting_name: clean(raw?.conflicting_name).slice(0, 80),
    conflicting_quote: quote,
    reason: clean(raw?.reason).slice(0, 400),
    quote_verified: null,
  };
  if (verdictRaw === "contradicted") {
    const v = quote ? verifyQuote(quote, sourceText) : { verified: false };
    out.quote_verified = v.verified;
    // An objection nobody can find in the sources does not count.
    if (!v.verified) {
      out.verdict = "inconclusive";
      out.reason = `${out.reason} (The objection's quote could not be found in the sources, so it was not counted.)`.trim();
    }
  }
  return out;
}

// Applies a second-pass result to a normalized suggestion: returns a NEW
// suggestion (never mutates). Only lowers confidence.
export function applySecondPass(suggestion, secondPass) {
  if (!secondPass) return suggestion;
  const next = { ...suggestion, second_pass: secondPass };
  if (secondPass.verdict === "contradicted") {
    const who = secondPass.conflicting_name ? ` (${secondPass.conflicting_name})` : "";
    next.notes = `⚠️ Second look found a conflict${who}: ${secondPass.reason || secondPass.conflict_type || "see quote"}. ${suggestion.notes || ""}`.trim();
    if (next.confidence === "high") next.confidence = "medium";
  }
  return next;
}

// Network call. Returns the stored shape, or null when the call failed (the
// caller then leaves the suggestion exactly as it was).
export async function runSecondPass({ apiKey, school, suggestion, sourceText }) {
  if (!apiKey || !clean(sourceText)) return null;
  const evidenceText = stripOnFileBlock(sourceText);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SECOND_PASS_TIMEOUT_MS);
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: SECOND_PASS_MODEL,
        max_tokens: 400,
        system: SECOND_PASS_SYSTEM_PROMPT,
        messages: [{ role: "user", content: buildSecondPassMessage({ school, suggestion, sourceText: evidenceText }) }],
      }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const json = await res.json().catch(() => null);
    const raw = parseJson(json?.content?.[0]?.text);
    if (!raw) return null;
    return interpretSecondPass(raw, evidenceText);
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// One call for every collector: decides whether this suggestion deserves a
// second look, runs it, and returns the (possibly lowered) suggestion.
// `budget` is optional ({ deadline: ms timestamp }) so an unattended collector
// with a hard time limit can stop spending time on this once it runs low; a
// suggestion that skips the second pass is simply left as it was.
export async function secondPassIfNeeded({ apiKey, school, suggestion, sourceText, budget }) {
  if (!needsSecondPass({ suggestion, school })) return suggestion;
  if (budget && budget.deadline && Date.now() > budget.deadline) return suggestion;
  const result = await runSecondPass({ apiKey, school, suggestion, sourceText });
  return applySecondPass(suggestion, result);
}
