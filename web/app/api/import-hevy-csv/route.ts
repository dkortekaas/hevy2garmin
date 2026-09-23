import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getDb } from "@/lib/db";
import { normaliseTimeZone } from "@/lib/timezone";
import { HevyCsvError, parseHevyCsv, parseWallTime, wallTimeToUtc } from "@/lib/hevy-csv";
import { clearImportedWorkouts, saveImportedWorkouts } from "@/lib/imported-workouts";
import { verifySession, SESSION_COOKIE, authEnabled } from "@/lib/auth";

// Writes imported_workouts in the live Postgres at request time.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/import-hevy-csv
 * Body: { csv: "<file contents>", timeZone?: "Europe/Amsterdam", since?: "2024-01-31" }
 *
 * Imports a Hevy workout export as an alternative (or addition) to the API key.
 * The workouts are stored, nothing is uploaded: they show up in the To sync
 * list and go through the normal sync, which is dry-run by default.
 *
 * The export's times have no offset, so a timezone is needed. The request's
 * wins, then the one saved on the Setup page. With neither, the import is
 * refused rather than guessed, because a wrong zone shifts every workout.
 *
 * `since` skips older workouts, for anyone whose history already reached Garmin
 * some other way.
 *
 * DELETE /api/import-hevy-csv removes every imported workout. Synced ones stay
 * recorded as synced.
 */

async function authorized(): Promise<boolean> {
  // Same gate as /api/settings: only when a password is configured.
  if (!authEnabled()) return true;
  const store = await cookies();
  return verifySession(store.get(SESSION_COOKIE)?.value ?? null);
}

async function savedTimeZone(sql: ReturnType<typeof getDb>): Promise<string | null> {
  const rows = await sql`SELECT value FROM app_cache WHERE key = 'user_profile' LIMIT 1`.catch(
    () => [] as Array<{ value: unknown }>,
  );
  const tz = (rows[0]?.value as { timezone?: unknown } | undefined)?.timezone;
  return typeof tz === "string" ? normaliseTimeZone(tz) : null;
}

export async function POST(request: Request) {
  if (!(await authorized())) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  let body: { csv?: unknown; timeZone?: unknown; since?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body." }, { status: 400 });
  }
  const csv = typeof body.csv === "string" ? body.csv : "";
  if (!csv.trim()) {
    return NextResponse.json({ ok: false, error: "Choose a Hevy CSV export to upload." }, { status: 400 });
  }

  let sql: ReturnType<typeof getDb>;
  try {
    sql = getDb();
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: `DB unavailable: ${error}` }, { status: 503 });
  }

  const requestedTz = typeof body.timeZone === "string" && body.timeZone.trim() ? body.timeZone : null;
  const timeZone = requestedTz ? normaliseTimeZone(requestedTz) : await savedTimeZone(sql);
  if (!timeZone) {
    return NextResponse.json(
      {
        ok: false,
        error: requestedTz
          ? `"${requestedTz}" is not a timezone. Use a name like Europe/Amsterdam.`
          : "Set your timezone first: the export's times have no offset.",
      },
      { status: 400 },
    );
  }

  let sinceMs: number | null = null;
  if (typeof body.since === "string" && body.since.trim()) {
    const wall = parseWallTime(`${body.since.trim()} 00:00`);
    if (!wall) {
      return NextResponse.json({ ok: false, error: "The start date must look like 2024-01-31." }, { status: 400 });
    }
    sinceMs = wallTimeToUtc(wall, timeZone).getTime();
  }

  let parsed: ReturnType<typeof parseHevyCsv>;
  try {
    parsed = parseHevyCsv(csv, { timeZone });
  } catch (err) {
    if (err instanceof HevyCsvError) return NextResponse.json({ ok: false, error: err.message }, { status: 400 });
    throw err;
  }
  if (!parsed.workouts.length) {
    return NextResponse.json(
      { ok: false, error: "No workouts found in the file. Is it the workout export from Hevy?" },
      { status: 400 },
    );
  }

  const workouts =
    sinceMs == null ? parsed.workouts : parsed.workouts.filter((w) => Date.parse(w.start_time) >= sinceMs);

  let added: number;
  try {
    added = await saveImportedWorkouts(sql, workouts);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: `Could not save the workouts: ${error}` }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    timeZone,
    found: parsed.workouts.length,
    imported: workouts.length,
    added,
    updated: workouts.length - added,
    skippedBeforeSince: parsed.workouts.length - workouts.length,
    unreadableRows: parsed.skippedRows,
  });
}

export async function DELETE() {
  if (!(await authorized())) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  try {
    await clearImportedWorkouts(getDb());
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
