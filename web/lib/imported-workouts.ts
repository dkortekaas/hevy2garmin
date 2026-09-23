/**
 * Storage for workouts imported from a Hevy CSV export (see ./hevy-csv).
 *
 * One row per workout in `imported_workouts`, holding the same JSON shape the
 * Hevy API returns. The sync reads them alongside the API's list, so an
 * imported workout goes through the exact same dedup, merge and upload path.
 *
 * Importing never uploads anything. It only makes workouts available to the
 * sync, which stays dry-run by default.
 */
import type { getDb } from "./db";
import type { CsvWorkout } from "./hevy-csv";

type Sql = ReturnType<typeof getDb>;

export interface ImportSummary {
  count: number;
  /** Start of the newest imported workout, ISO, or null when there are none. */
  newest: string | null;
  /** Start of the oldest imported workout, ISO, or null when there are none. */
  oldest: string | null;
  lastImportedAt: string | null;
}

const IMPORT_CHUNK = 200;

export const NO_IMPORT: ImportSummary = { count: 0, newest: null, oldest: null, lastImportedAt: null };

/** Every imported workout, newest first. Empty on any database failure. */
export async function loadImportedWorkouts(sql: Sql): Promise<CsvWorkout[]> {
  const rows = await sql`
    SELECT data FROM imported_workouts ORDER BY start_time DESC
  `.catch(() => [] as Array<{ data: unknown }>);
  return rows
    .map((r) => (typeof r.data === "string" ? JSON.parse(r.data) : r.data) as CsvWorkout)
    .filter((w) => w && typeof w.id === "string");
}

/** Count and date range of what is imported, for the setup page. */
export async function loadImportSummary(sql: Sql): Promise<ImportSummary> {
  const rows = await sql`
    SELECT COUNT(*)::int AS count, MAX(start_time) AS newest, MIN(start_time) AS oldest,
           MAX(imported_at) AS last_imported_at
    FROM imported_workouts
  `.catch(() => [] as Array<Record<string, unknown>>);
  const r = rows[0];
  if (!r || !Number(r.count)) return NO_IMPORT;
  const iso = (v: unknown) => (v == null ? null : v instanceof Date ? v.toISOString() : String(v));
  return {
    count: Number(r.count),
    newest: iso(r.newest),
    oldest: iso(r.oldest),
    lastImportedAt: iso(r.last_imported_at),
  };
}

/**
 * Store workouts, replacing any with the same id. Re-importing a newer export
 * therefore refreshes the workouts it repeats instead of adding second copies.
 * Returns how many were new.
 */
export async function saveImportedWorkouts(sql: Sql, workouts: readonly CsvWorkout[]): Promise<number> {
  let inserted = 0;
  // One statement per chunk rather than one per workout: a few years of history
  // is hundreds of workouts, and a round trip each is slow on a remote database.
  for (let i = 0; i < workouts.length; i += IMPORT_CHUNK) {
    const chunk = workouts.slice(i, i + IMPORT_CHUNK);
    const rows = await sql`
      INSERT INTO imported_workouts (hevy_id, start_time, data, imported_at)
      SELECT w ->> 'id', (w ->> 'start_time')::timestamptz, w, NOW()
      FROM jsonb_array_elements(${sql.json(chunk)}) AS w
      ON CONFLICT (hevy_id) DO UPDATE SET
        start_time = EXCLUDED.start_time,
        data = EXCLUDED.data,
        imported_at = NOW()
      RETURNING (xmax = 0) AS inserted
    `;
    inserted += rows.filter((r: { inserted: boolean }) => r.inserted).length;
  }
  return inserted;
}

/**
 * Remove every imported workout. What was already synced stays synced: the
 * ledger in synced_workouts is untouched, so importing the same file again
 * later does not upload those workouts a second time.
 */
export async function clearImportedWorkouts(sql: Sql): Promise<void> {
  await sql`DELETE FROM imported_workouts`;
}
