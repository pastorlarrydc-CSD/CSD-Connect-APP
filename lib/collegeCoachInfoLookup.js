// College-lead counterpart to lib/coachInfoLookup.js. Reuses every generic
// piece from that file (the Serper/fetch helpers, JSON parsing, the
// low-value-directory-domain filter) rather than copying them, so a fix to
// how a page gets fetched or how model JSON gets parsed automatically
// benefits both the high-school and college lookups. Only the parts that
// actually differ between "verify a high school's head football coach" and
// "find this specific person's contact info at a college program" live
// here: the prompt, the search-query shape, and the response fields
// (college_leads has no athletics_url/website/twitter/facebook columns the
// way schools does, so this stays intentionally lighter).
import { searchWeb, fetchPageText, isLowValueDirectoryDomain, MAX_CHARS_DIRECTORY_PAGE } from "./coachInfoLookup";

export const COLLEGE_SYSTEM_PROMPT = `You are helping a college-football recruiting-data sales rep find current contact information for a specific staff member at a college football program, so the rep can reach out to them. You will be given search-engine results, and -- when available -- full text read from the program's own staff-directory page, plus whatever is currently on file for this lead.

Rules:
- The goal is a SPECIFIC person's current email and phone (cell if you can tell it's a direct/mobile line, office phone otherwise) at this specific college football program -- not just "the head coach" generically, unless that is in fact the role on file or no role is known.
- If a name and/or title is already on file, treat it as a starting point, not a confirmed fact -- it may be from an old import, a placeholder, or simply wrong. Use the web evidence in front of you to confirm, correct, or fill in the name, title, email, and phone. If the evidence clearly points to a different person currently holding that role, prefer the evidence and say so in notes rather than defaulting back to the on-file name out of caution.
- If no name is on file, use the title/role on file (e.g. "Recruiting Coordinator", "Running Backs Coach") to find whoever currently holds that role at this program. If no role is on file either, the recruiting coordinator (or the most relevant recruiting contact you can find) is the most useful person to surface.
- Never invent or guess a name, phone number, or email that isn't actually present in what you were given. Return empty strings for anything not found. Email is the one exception -- see the pattern-derivation rule below.
- Email pattern-derivation (use sparingly, only for email): if this specific person's email is not directly stated anywhere, but you can see at least one OTHER staff member's real email address in what you were given (another coach, a general athletics-office contact, anyone at the same program) AND you have identified this person's name, you may derive an estimated address by applying that same visible naming pattern (e.g. lastnamefirstinitial@domain, firstinitiallastname@domain, firstname.lastname@domain) to their name. When you do this: set email_estimated to true, cap confidence at "medium" even if everything else is solid, and say exactly what you did in notes (the pattern you saw, and whose email you saw it on). If you cannot see any other real staff email to establish a pattern from, or you don't have a name to apply it to, leave email blank and email_estimated false rather than guessing.
- Only fill mobile if a number is explicitly labeled as a cell/mobile/direct line for this person. Otherwise put any phone number found in office_phone.
- Set confidence to "high" only when the name/role/contact info is clearly stated in full page text (not just a search snippet). Use "medium" for a real but ambiguous match, a match found only in a search snippet, or any suggestion where email_estimated is true. Use "low" if only partially confident.
- The "currently on file" information you're given is NOT independently verified -- it may be an old bulk import or simply wrong, which is often exactly why a human is running this lookup. Judge the evidence on its own merits rather than treating a match with what's on file as extra proof of correctness.
- Respond with ONLY a single JSON object, no other text, in exactly this shape:
{"coach_first_name": "", "coach_last_name": "", "title": "", "email": "", "email_estimated": false, "mobile": "", "office_phone": "", "confidence": "high", "source": "web search", "notes": "1-3 sentences: what was found and where (which specific source), and any conflict with what's on file worth flagging"}`;

// Defaults to an open "college + role + email contact" query even when a
// name is already on file, for the same reason buildSearchQuery in
// lib/coachInfoLookup.js does -- anchoring the search to a possibly-wrong
// on-file name can only ever turn up pages that already agree with it,
// which is exactly the confirmation-bias loop that tool's own comment
// documents happening for a real school. Once a name IS confirmed by that
// open search, a human re-running this lookup on the same lead benefits
// more from a name-anchored query aimed at finding contact details -- so
// this uses the on-file name only to make the query more specific, not to
// presuppose it's correct.
export function buildLeadSearchQuery(lead) {
  const knownCoachName = [lead.coach_first_name, lead.coach_last_name].filter(Boolean).join(" ").trim();
  const roleText = lead.title || lead.role_category || "football staff";
  if (knownCoachName) {
    return `"${knownCoachName}" ${lead.college_name} football ${roleText} email contact`;
  }
  return `${lead.college_name} football ${roleText} staff directory contact`;
}

export function buildLeadDirectorySearchQuery(lead) {
  return `${lead.college_name} football staff directory`;
}

// Same "search, then fetch whichever result isn't a low-value aggregator"
// pattern as findDirectoryPage in lib/coachInfoLookup.js -- a program's own
// staff directory page is usually the best source for an actual email
// address, and re-fetching the full page (rather than reading just the
// two-line search snippet) is what makes that worth doing.
export async function findLeadDirectoryPage({ lead, serperKey }) {
  const results = await searchWeb(buildLeadDirectorySearchQuery(lead), serperKey);
  const candidate = results.find((r) => !isLowValueDirectoryDomain(r.link));
  if (!candidate) return { results, page: null };
  const fetched = await fetchPageText(candidate.link);
  if (!fetched.ok || !fetched.text) return { results, page: null };
  return { results, page: { url: candidate.link, text: fetched.text } };
}

// Builds the combined source text (fetched directory page, if any + search
// results) and the "currently on file" summary block handed to the model,
// same shape/purpose as buildSourceBlocks in lib/coachInfoLookup.js but
// without the athletics_url/website fetches (college_leads has no such
// columns) or the recency search (identity-currency isn't the primary risk
// here the way it is for a high school's head-coach listing -- these leads
// were imported as a specific named person already).
export function buildLeadSourceBlocks({ lead, searchResults, searchQuery, directoryPage, directorySearchResults, knowledgeGraph, answerBox }) {
  const usableBlocks = [];
  if (directoryPage?.text) {
    usableBlocks.push({ label: "staff directory search result", url: directoryPage.url, text: directoryPage.text, cap: MAX_CHARS_DIRECTORY_PAGE });
  }

  const pageTextBlocks = usableBlocks.map((b) => `--- Full text from the ${b.label} (${b.url}) ---\n${b.text.slice(0, b.cap)}`);
  const searchBlock =
    searchResults && searchResults.length > 0
      ? `--- Web search results for "${searchQuery}" ---\n${searchResults.map((r, i) => `${i + 1}. ${r.title} (${r.link})\n   ${r.snippet}`).join("\n")}`
      : null;
  const directorySearchBlock =
    directorySearchResults && directorySearchResults.length > 0
      ? `--- Web search results for "${buildLeadDirectorySearchQuery(lead)}" ---\n${directorySearchResults.map((r, i) => `${i + 1}. ${r.title} (${r.link})\n   ${r.snippet}`).join("\n")}`
      : null;
  const knowledgeGraphBlock = knowledgeGraph
    ? `--- Google Knowledge Graph entry for "${searchQuery}" ---\n${[
        knowledgeGraph.title ? `Title: ${knowledgeGraph.title}` : null,
        knowledgeGraph.type ? `Type: ${knowledgeGraph.type}` : null,
        knowledgeGraph.description ? `Description: ${knowledgeGraph.description}` : null,
        knowledgeGraph.website ? `Website: ${knowledgeGraph.website}` : null,
        ...Object.entries(knowledgeGraph.attributes || {}).map(([k, v]) => `${k}: ${v}`),
      ]
        .filter(Boolean)
        .join("\n")}`
    : null;
  const answerBoxBlock = answerBox
    ? `--- Google answer box for "${searchQuery}" ---\n${[
        answerBox.title ? `Title: ${answerBox.title}` : null,
        answerBox.answer ? `Answer: ${answerBox.answer}` : null,
        answerBox.snippet ? `Snippet: ${answerBox.snippet}` : null,
        answerBox.link ? `Source: ${answerBox.link}` : null,
      ]
        .filter(Boolean)
        .join("\n")}`
    : null;
  const textBlocks = [...pageTextBlocks, searchBlock, directorySearchBlock, knowledgeGraphBlock, answerBoxBlock].filter(Boolean).join("\n\n");

  const currentlyOnFile = [
    "(Not independently verified -- see the system prompt's rule on this.)",
    lead.coach_first_name || lead.coach_last_name ? `Name on file: ${[lead.coach_first_name, lead.coach_last_name].filter(Boolean).join(" ")}` : "Name on file: none",
    lead.title ? `Title on file: ${lead.title}` : lead.role_category ? `Role on file: ${lead.role_category}` : "Title/role on file: none",
    lead.email ? `Email on file: ${lead.email}` : "Email on file: none",
    lead.mobile ? `Mobile/cell on file: ${lead.mobile}` : null,
    lead.office_phone ? `Office phone on file: ${lead.office_phone}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  const defaultSource = [...usableBlocks.map((b) => b.label), searchResults && searchResults.length > 0 ? "web search" : null].filter(Boolean).join(" + ");

  return {
    hasUsableContent:
      usableBlocks.length > 0 ||
      (searchResults && searchResults.length > 0) ||
      (directorySearchResults && directorySearchResults.length > 0) ||
      Boolean(knowledgeGraph) ||
      Boolean(answerBox),
    userMessage: `College football program: ${lead.college_name}${lead.division ? ` (${lead.division})` : ""}${lead.state ? `, ${lead.state}` : ""}\n\n${currentlyOnFile}\n\n${textBlocks}`,
    defaultSource,
  };
}

// Normalizes the raw parsed model response into the exact shape the route
// returns to the client -- trimmed strings and a validated confidence
// value, mirroring normalizeSuggestion in lib/coachInfoLookup.js.
export function normalizeCollegeSuggestion(parsed, defaultSource) {
  const email = (parsed.email || "").toString().trim();
  const email_estimated = Boolean(parsed.email_estimated) && Boolean(email);
  const rawConfidence = ["high", "medium", "low"].includes(parsed.confidence) ? parsed.confidence : "low";
  return {
    coach_first_name: (parsed.coach_first_name || "").toString().trim(),
    coach_last_name: (parsed.coach_last_name || "").toString().trim(),
    title: (parsed.title || "").toString().trim(),
    email,
    email_estimated,
    mobile: (parsed.mobile || "").toString().trim(),
    office_phone: (parsed.office_phone || "").toString().trim(),
    confidence: email_estimated && rawConfidence === "high" ? "medium" : rawConfidence,
    source: (parsed.source || defaultSource || "web search").toString(),
    notes: (parsed.notes || "").toString().trim(),
  };
}
