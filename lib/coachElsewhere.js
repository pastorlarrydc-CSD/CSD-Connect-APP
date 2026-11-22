// lib/coachElsewhere.js
//
// "Neighbor coach" guard for AI coach lookups.
//
// A common AI mistake is to answer with a coach who really belongs to the school next door or to
// a co-op partner -- for example a school's lookup coming back with the Ripon coach's name when
// that coach is already on file at Ripon. In Wisconsin run #110, 12 of 100 results were this kind
// of mistake, and each one sat in the review list waiting for someone to look at it.
//
// The rule: if the coach the AI found is NOT the coach already on file for THIS school, but the
// same person (same last name, same first initial) is on file as head coach at ANOTHER open
// school, the result is almost certainly a mix-up. It is forced to "low" confidence and the notes
// say who and where. Low confidence is never auto-applied and never flags a good school for
// review (see lib/backlogVerify.js), so these results stop costing anyone time.
//
// It only ever LOWERS confidence, like the other checks in lib/coachInfoLookup.js and
// lib/aiSecondPass.js. Any failure is silent: the suggestion goes through unchanged.

const flat = (s) => String(s == null ? "" : s).toLowerCase().replace(/[^a-z0-9]/g, "");
const escapeLike = (s) => String(s).replace(/[\\%_]/g, (m) => `\\${m}`);

// Pure part: given the suggested coach, this school's own coach, and the rows found with that
// last name elsewhere, return the schools where the same person is already on file.
export function matchesElsewhere({ first, last, ownFirst, ownLast, schoolId, rows }) {
  const f = flat(first);
  const l = flat(last);
  if (!f || !l) return [];
  // Same person as the coach already on file here: nothing to check.
  if (flat(ownLast) === l && flat(ownFirst)[0] === f[0]) return [];
  return (rows || []).filter((r) => r.id !== schoolId && flat(r.hc_last_name) === l && flat(r.hc_first_name)[0] === f[0]);
}

export function lowerForCoachElsewhere(suggestion, matches) {
  const where = matches.slice(0, 3).map((m) => `${m.name} (${m.city}, ${m.state})`).join("; ");
  const note = `⚠️ ${suggestion.hc_first_name} ${suggestion.hc_last_name} is already on file as head coach at ${where}. The AI may have picked up a neighboring or co-op school's coach. Check that this coach really leads THIS school before applying. `;
  const evidence = suggestion.evidence && typeof suggestion.evidence === "object" ? { ...suggestion.evidence } : {};
  const problems = Array.isArray(evidence.problems) ? [...evidence.problems] : [];
  problems.push(`coach already on file at ${where}`);
  evidence.problems = problems;
  return {
    ...suggestion,
    confidence: "low",
    notes: `${note}${suggestion.notes || ""}`.trim(),
    evidence,
    coach_elsewhere: matches.slice(0, 3).map((m) => ({ id: m.id, name: m.name, city: m.city, state: m.state })),
  };
}

export async function applyCoachElsewhereGuard({ supabase, schoolId, school, suggestion }) {
  try {
    if (!suggestion || !suggestion.hc_first_name || !suggestion.hc_last_name) return suggestion;
    const { data, error } = await supabase
      .from("schools")
      .select("id,name,city,state,hc_first_name,hc_last_name")
      .eq("is_closed", false)
      .ilike("hc_last_name", escapeLike(suggestion.hc_last_name))
      .limit(25);
    if (error || !data) return suggestion;
    const matches = matchesElsewhere({
      first: suggestion.hc_first_name,
      last: suggestion.hc_last_name,
      ownFirst: school?.hc_first_name,
      ownLast: school?.hc_last_name,
      schoolId,
      rows: data,
    });
    return matches.length ? lowerForCoachElsewhere(suggestion, matches) : suggestion;
  } catch (_) {
    return suggestion;
  }
}
