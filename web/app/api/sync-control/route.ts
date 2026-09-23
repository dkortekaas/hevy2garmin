import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getDb } from "@/lib/db";
import { loadSyncControl, setSyncStopped } from "@/lib/sync-control";
import { cancelSyncWorkflowRuns, disableGithubActions, getGithubPat, getGithubRepo } from "@/lib/github";
import { verifySession, SESSION_COOKIE, authEnabled } from "@/lib/auth";

// Reads/writes app_cache at request time — never at build.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET  /api/sync-control → { stopped, stoppedAt }
 * POST /api/sync-control   body { stopped: boolean }
 *
 * "Stop all syncing" (lib/sync-control). Stopping:
 *   1. sets the switch, which every upload path checks, so a batch or loop
 *      already running ends at its next workout;
 *   2. turns auto-sync off (app_cache 'auto_sync'.enabled = false) and, where
 *      it runs on GitHub Actions, deletes the workflow and cancels queued and
 *      running runs.
 *
 * Resuming only clears the switch. Auto-sync stays off until the user turns it
 * back on: re-enabling a schedule is a decision, not a side effect.
 */

async function authorized(): Promise<boolean> {
  if (!authEnabled()) return true;
  const store = await cookies();
  return verifySession(store.get(SESSION_COOKIE)?.value ?? null);
}

export async function GET() {
  try {
    return NextResponse.json(await loadSyncControl(getDb()));
  } catch {
    return NextResponse.json({ stopped: false, stoppedAt: null });
  }
}

export async function POST(request: Request) {
  if (!(await authorized())) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  let body: { stopped?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body." }, { status: 400 });
  }
  if (typeof body.stopped !== "boolean") {
    return NextResponse.json({ ok: false, error: "Body must be { stopped: true | false }." }, { status: 400 });
  }

  let sql: ReturnType<typeof getDb>;
  try {
    sql = getDb();
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: `DB unavailable: ${error}` }, { status: 503 });
  }

  let control;
  try {
    control = await setSyncStopped(sql, body.stopped);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: `Could not save: ${error}` }, { status: 500 });
  }
  if (!body.stopped) return NextResponse.json({ ok: true, ...control });

  // The switch is what stops uploads; the rest is housekeeping, best effort.
  let autoSyncDisabled = false;
  let cancelledRuns = 0;
  try {
    const rows = (await sql`SELECT value FROM app_cache WHERE key = 'auto_sync' LIMIT 1`) as Array<{ value: unknown }>;
    const current = rows[0]?.value && typeof rows[0].value === "object" ? (rows[0].value as Record<string, unknown>) : {};
    await sql`
      INSERT INTO app_cache (key, value, updated_at)
      VALUES ('auto_sync', ${sql.json({ ...current, enabled: false })}, NOW())
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
    `;
    autoSyncDisabled = true;
  } catch {
    // The switch is already set, and every scheduled path checks it.
  }
  try {
    const pat = await getGithubPat(sql);
    const repo = getGithubRepo();
    if (pat && repo) {
      cancelledRuns = await cancelSyncWorkflowRuns({ pat, repo });
      await disableGithubActions({ pat, repo });
    }
  } catch {
    // Same: a run that escapes the cancel still stops at its next workout.
  }
  return NextResponse.json({ ok: true, ...control, autoSyncDisabled, cancelledRuns });
}
