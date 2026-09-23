/**
 * The "stop all syncing" switch.
 *
 * One flag, app_cache 'sync_control'.stopped, that every path which writes to
 * Garmin checks before it does: the dashboard buttons, the batch and cron
 * loops, the webhook, routine sync and scheduling, and the Python CLI that the
 * GitHub Actions auto-sync runs (sync.py reads the same row).
 *
 * The check sits in syncOneWorkout, the single call every workout upload goes
 * through, so a loop that is already running stops at its next workout rather
 * than finishing its backlog. The workout in flight at that moment is allowed
 * to complete: cutting an upload off halfway is what leaves the half-finished
 * state the recovery path exists for.
 *
 * Dry runs are not blocked. They never touch Garmin, and previewing what would
 * sync is how a user decides whether to resume.
 */
import type { getDb } from "./db";

type Sql = ReturnType<typeof getDb>;

export const SYNC_CONTROL_KEY = "sync_control";

export const SYNC_STOPPED_MESSAGE =
  "Syncing is stopped. Resume it on the dashboard to upload workouts to Garmin again.";

export class SyncStoppedError extends Error {
  constructor() {
    super(SYNC_STOPPED_MESSAGE);
    this.name = "SyncStoppedError";
  }
}

export interface SyncControl {
  stopped: boolean;
  stoppedAt: string | null;
}

export const RUNNING: SyncControl = { stopped: false, stoppedAt: null };

/**
 * Read the switch. A missing row, table or database reads as running: the
 * switch is opt-in, and a read failure must not silently halt every sync.
 */
export async function loadSyncControl(sql: Sql): Promise<SyncControl> {
  try {
    const rows = (await sql`
      SELECT value FROM app_cache WHERE key = ${SYNC_CONTROL_KEY} LIMIT 1
    `) as Array<{ value: unknown }>;
    const raw = rows[0]?.value;
    const v = (typeof raw === "string" ? JSON.parse(raw) : raw) as Record<string, unknown> | undefined;
    if (!v || v.stopped !== true) return RUNNING;
    return { stopped: true, stoppedAt: typeof v.stopped_at === "string" ? v.stopped_at : null };
  } catch {
    return RUNNING;
  }
}

export async function isSyncStopped(sql: Sql): Promise<boolean> {
  return (await loadSyncControl(sql)).stopped;
}

/** Throw SyncStoppedError when the switch is on. */
export async function assertSyncAllowed(sql: Sql): Promise<void> {
  if (await isSyncStopped(sql)) throw new SyncStoppedError();
}

/** Flip the switch. Unlike the read, a failed write throws: the user must know. */
export async function setSyncStopped(sql: Sql, stopped: boolean): Promise<SyncControl> {
  const value = { stopped, stopped_at: stopped ? new Date().toISOString() : null };
  await sql`
    INSERT INTO app_cache (key, value, updated_at)
    VALUES (${SYNC_CONTROL_KEY}, ${sql.json(value)}, NOW())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
  `;
  return { stopped, stoppedAt: value.stopped_at };
}
