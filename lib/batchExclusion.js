// Shared "already touched" exclusion helper for every batch-discovery tool
// (Coach-Info, Athletics, Social Media, MaxPreps -- see each tool's own
// page.js). Each tool's startRun() needs to know every school_id that's
// EVER shown up in that tool's own _batch_items table before, across every
// past run, so a fresh run doesn't hand back a school someone already
// applied, skipped, or got a no-content/no-answer result for.
//
// That list used to be built with a single unpaginated
// `supabase.from(table).select("school_id")` call. That looks safe -- it's
// asking for one column, no filter -- but Supabase's hosted PostgREST caps
// ANY request at 1000 rows by default (project has no db_max_rows override
// set, confirmed via `select current_setting('pgrst.db_max_rows', true)` --
// it comes back null, so the platform default applies). Once a tool's
// _batch_items table passed 1000 rows, that select silently returned only
// part of the "already touched" list instead of erroring -- so older
// touched schools quietly stopped being excluded and could resurface in a
// later run, exactly as if they'd never been touched at all.
//
// Confirmed this was actually happening, not just theoretically possible:
// as of Sept 24 2026, 477 schools had already reappeared across more than
// one non-re_verify Coach-Info run once that table crossed 1000 rows (it's
// at ~4,800 rows now), and Social Media Discovery's own _batch_items table
// (~8,000 rows) uses the identical unpaginated pattern, so it's exposed the
// same way.
//
// Fix: page through with .range() in 1000-row chunks until a page comes
// back with fewer than 1000 rows, so the exclusion set is always complete
// no matter how large the table has grown. Every batch tool's startRun()
// should call this instead of doing its own unpaginated select.
export async function fetchAllTouchedSchoolIds(supabase, tableName) {
  const excludedIds = new Set();
  const pageSize = 1000;
  let from = 0;

  for (;;) {
    const { data, error } = await supabase
      .from(tableName)
      .select("school_id")
      .range(from, from + pageSize - 1);
    if (error) throw error;

    (data || []).forEach((row) => excludedIds.add(row.school_id));

    if (!data || data.length < pageSize) break;
    from += pageSize;
  }

  return excludedIds;
}
