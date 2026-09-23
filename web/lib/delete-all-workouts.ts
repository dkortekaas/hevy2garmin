/**
 * "Delete all workouts": wipe every workout this app holds, whether it came
 * from the Hevy API or a CSV import. APP-ONLY: no Garmin activity is touched,
 * and nothing is deleted in Hevy.
 *
 * What goes:
 *   synced_workouts    the ledger of what was synced (API and CSV ids alike)
 *   pending_uploads    in-flight uploads
 *   imported_workouts  the CSV import
 *   hr_cache           heart rate cached per workout
 *   hevy_workouts_page_*  cached Hevy API pages
 *
 * The sync log (run history), settings and credentials stay.
 *
 * Syncing is STOPPED first (lib/sync-control), and deliberately left stopped.
 * With the ledger gone every API workout is a candidate again, while its
 * activity is still on Garmin, so the next sync would upload the whole history
 * a second time. The user resumes on purpose, once they have cleared Garmin or
 * chosen a CSV "only workouts from" date.
 */
import type { getDb } from "./db";
import { setSyncStopped } from "./sync-control";

type Sql = ReturnType<typeof getDb>;

export interface DeleteAllResult {
  synced: number;
  pending: number;
  imported: number;
  heartRate: number;
}

export async function deleteAllWorkouts(sql: Sql): Promise<DeleteAllResult> {
  await setSyncStopped(sql, true);
  const pending = await sql`DELETE FROM pending_uploads RETURNING hevy_id`;
  const synced = await sql`DELETE FROM synced_workouts RETURNING hevy_id`;
  const imported = await sql`DELETE FROM imported_workouts RETURNING hevy_id`;
  const heartRate = await sql`DELETE FROM hr_cache RETURNING hevy_id`;
  await sql`DELETE FROM app_cache WHERE key LIKE 'hevy_workouts_page_%'`;
  return {
    synced: synced.length,
    pending: pending.length,
    imported: imported.length,
    heartRate: heartRate.length,
  };
}
