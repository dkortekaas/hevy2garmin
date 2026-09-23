import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getDb } from "@/lib/db";
import { demoMode } from "@/lib/demo";
import { deleteAllWorkouts } from "@/lib/delete-all-workouts";
import { verifySession, SESSION_COOKIE, authEnabled } from "@/lib/auth";

// Deletes from the app's own tables at request time — never at build.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/delete-all-workouts
 * Body: { confirm: "DELETE" }
 *
 * Removes every workout the app holds, from the Hevy API and from a CSV import
 * (lib/delete-all-workouts). APP-ONLY: Garmin activities and Hevy itself are
 * untouched. Stops all syncing first and leaves it stopped, because with the
 * ledger gone the next sync would upload everything to Garmin a second time.
 */
export async function POST(request: Request) {
  if (demoMode()) {
    return NextResponse.json({ ok: false, error: "Read-only in demo mode" }, { status: 403 });
  }
  if (authEnabled()) {
    const store = await cookies();
    if (!(await verifySession(store.get(SESSION_COOKIE)?.value ?? null))) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }
  }

  let confirm = "";
  try {
    confirm = String(((await request.json()) as { confirm?: unknown }).confirm ?? "");
  } catch {
    confirm = "";
  }
  if (confirm !== "DELETE") {
    return NextResponse.json({ ok: false, error: "Send confirm=DELETE to proceed" }, { status: 400 });
  }

  let sql: ReturnType<typeof getDb>;
  try {
    sql = getDb();
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: `DB unavailable: ${error}` }, { status: 503 });
  }

  try {
    const deleted = await deleteAllWorkouts(sql);
    return NextResponse.json({ ok: true, deleted, syncStopped: true });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error }, { status: 500 });
  }
}
