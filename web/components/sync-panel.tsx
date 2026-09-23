"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import {
  initialLoopState,
  stepLoop,
  loopPercent,
  errorHint,
  type LoopState,
  type SyncOneLike,
} from "@/lib/sync-loop";

/** Mirrors the SyncOneResult shape returned by /api/sync-one. */
interface SyncResult {
  status: "synced" | "skipped" | "deferred" | "dry_run" | "none" | "error";
  dryRun: boolean;
  wouldUpload: boolean;
  dedupDecision: string;
  workout: { hevy_id: string; title: string | null; start_time: string | null } | null;
  fitStats: {
    exercises: number;
    totalSets: number;
    calories: number;
    avgHr: number | null;
    durationS: number;
  } | null;
  existingGarminActivityId: number | null;
  garminActivityId: number | null;
  remaining: number;
  syncMethod: "upload" | "match" | null;
  error: string | null;
}

const DECISION_LABEL: Record<string, string> = {
  would_upload: "A new Garmin activity would be uploaded",
  already_synced: "Already synced — skipped",
  existing_garmin_activity: "Garmin already has this — it will be matched, not re-uploaded",
  claim_lost: "Another sync is already handling this workout",
  no_candidates: "Nothing to sync — every workout is already handled",
  no_start_time: "The next workout has no start time, so it can't be matched safely",
};

const STATUS_STYLE: Record<string, string> = {
  synced: "bg-success/15 text-success",
  dry_run: "bg-teal/15 text-teal",
  skipped: "bg-surface-active text-text-muted",
  deferred: "bg-warm/15 text-warm",
  none: "bg-surface-active text-text-muted",
  error: "bg-danger/15 text-danger",
};

function fmtDuration(s: number): string {
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/**
 * Append a "Sync all" pass to the dashboard's Sync log.
 *
 * Best-effort on purpose: the sync itself already happened, and failing to
 * write a log row must not be reported to the user as a failed sync. The loop
 * has no `failed` counter of its own, because it stops on the first error
 * rather than counting them, so an error ends the run with whatever it had
 * plus one failure.
 */
async function recordRun(state: LoopState): Promise<void> {
  try {
    await fetch("/api/sync-run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        synced: state.synced,
        skipped: state.skipped,
        failed: state.errorKind ? 1 : 0,
      }),
    });
  } catch {
    // The log is diagnostic. Losing a row is the lesser loss.
  }
}

const BTN_SECONDARY =
  "whitespace-nowrap rounded-lg border border-border px-2 py-2 text-sm font-medium text-text-secondary transition-colors hover:bg-surface-active disabled:opacity-50 sm:px-3";
const BTN_PRIMARY =
  "whitespace-nowrap rounded-lg bg-teal/20 px-2 py-2 text-sm font-medium text-teal transition-colors hover:bg-teal/30 disabled:opacity-50 sm:px-3";

/**
 * The dashboard's one sync card. It used to be three ("Run a sync", "Sync all"
 * and "Sync everything") that overlapped: two of them uploaded every pending
 * workout by different routes. What is left:
 *
 * - "Preview" runs /api/sync-one in its default DRY-RUN mode: it shows what the
 *   next sync WOULD do without writing anything to Garmin or the DB.
 * - "Sync next" uploads that one workout (?live=1).
 * - "Sync all" drives /api/sync-one?live=1 in a loop (lib/sync-loop) with a
 *   live progress bar until nothing is left, an error, or Stop. It runs in the
 *   browser, so it sees CSV-imported workouts too, which the GitHub Action
 *   route behind /api/sync does not.
 *
 * A bad upload creates a duplicate Garmin/Strava activity, so both live buttons
 * are behind an inline confirmation, and the server independently requires
 * authorization before it will run live.
 */
export function SyncPanel({
  ready,
  blockedReason,
}: {
  ready: boolean;
  /** Why the live buttons are disabled, shown to the user. Defaults to the connect hint. */
  blockedReason?: string | null;
}) {
  const blockedHint = blockedReason ?? "Connect Hevy and Garmin first";
  const router = useRouter();
  const [result, setResult] = useState<SyncResult | null>(null);
  const [busy, setBusy] = useState<null | "preview" | "live">(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<null | "one" | "all">(null);
  const [loop, setLoop] = useState<LoopState>(initialLoopState);
  const [running, setRunning] = useState(false);
  const stopRef = useRef(false);

  async function runOne(live: boolean) {
    setBusy(live ? "live" : "preview");
    setError(null);
    setLoop(initialLoopState);
    try {
      const res = await fetch(`/api/sync-one${live ? "?live=1" : ""}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(live ? { live: 1 } : {}),
      });
      const d = (await res.json().catch(() => ({}))) as SyncResult & { error?: string };
      if (!res.ok) {
        setError(d.error ?? `Request failed (${res.status}).`);
        return;
      }
      setResult(d);
      setConfirm(null);
      if (live && d.status === "synced") router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function runAll() {
    setConfirm(null);
    setResult(null);
    setError(null);
    setRunning(true);
    stopRef.current = false;
    let cur: LoopState = { ...initialLoopState };
    setLoop(cur);
    try {
      // Cap iterations defensively so a misbehaving server can't spin forever.
      for (let i = 0; i < 500; i++) {
        if (stopRef.current) {
          cur = { ...cur, done: true, message: `Paused after ${cur.synced + cur.skipped} workout(s).` };
          setLoop(cur);
          break;
        }
        let httpStatus = 0;
        let res: SyncOneLike = {};
        try {
          // batch=1: this loop posts ONE aggregate row to /api/sync-run when it
          // finishes, so the route must not also write a row per workout.
          const r = await fetch("/api/sync-one?live=1&batch=1", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ live: 1 }),
          });
          httpStatus = r.status;
          res = (await r.json().catch(() => ({}))) as SyncOneLike;
        } catch (err) {
          cur = { ...cur, done: true, errorKind: "generic", message: err instanceof Error ? err.message : "Network error." };
          setLoop(cur);
          break;
        }
        const { state: next, cont } = stepLoop(cur, { httpStatus, result: res });
        cur = next;
        setLoop(cur);
        if (!cont) break;
      }
    } finally {
      setRunning(false);
      // Record the whole pass as ONE row in the Sync log. A row per workout
      // would fill the panel with dozens of one-line entries (#611).
      await recordRun(cur);
      if (cur.synced > 0) router.refresh();
    }
  }

  const disabled = busy !== null || running;
  const pct = loopPercent(loop);
  const onGarmin = loop.total > 0 ? loop.total - loop.remaining : loop.synced;

  return (
    <section className="mb-6 rounded-xl border border-border bg-surface-elevated p-4 md:mb-8 md:p-5">
      <h2 className="text-lg font-semibold text-text">Sync to Garmin</h2>
      <p className="mt-0.5 text-sm text-text-secondary">
        Preview shows what the next sync would do. Sync next uploads that one
        workout; Sync all uploads every pending workout with live progress.
      </p>

      {running ? (
        <div className="mt-3">
          <button
            type="button"
            onClick={() => { stopRef.current = true; }}
            className="w-full rounded-lg border border-warm/50 px-3 py-2 text-sm font-medium text-warm transition-colors hover:bg-warm/15 sm:w-auto"
          >
            Stop
          </button>
        </div>
      ) : confirm ? (
        <div className="mt-3 rounded-lg border border-warm/40 bg-warm/10 p-3">
          <p className="text-xs text-warm">
            {confirm === "one"
              ? "This uploads the next workout to Garmin Connect. It runs the same duplicate-safety checks as the automatic sync, but it is a real upload."
              : "This uploads every pending workout to Garmin Connect, one at a time. Each upload runs the same duplicate-safety checks as the automatic sync."}
          </p>
          <div className="mt-3 grid grid-cols-2 gap-2 sm:flex">
            <button
              type="button"
              onClick={() => (confirm === "one" ? runOne(true) : runAll())}
              disabled={disabled}
              className="rounded-lg bg-teal px-3 py-2 text-sm font-medium text-black disabled:opacity-50"
            >
              {busy === "live" ? "Syncing…" : confirm === "one" ? "Confirm upload" : "Start"}
            </button>
            <button type="button" onClick={() => setConfirm(null)} disabled={disabled} className={BTN_SECONDARY}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-3 grid grid-cols-3 gap-2 sm:flex">
          <button type="button" onClick={() => runOne(false)} disabled={disabled} className={BTN_SECONDARY}>
            {busy === "preview" ? "Checking…" : "Preview"}
          </button>
          <button
            type="button"
            onClick={() => setConfirm("one")}
            disabled={disabled || !ready}
            title={ready ? undefined : blockedHint}
            className={BTN_PRIMARY}
          >
            Sync next
          </button>
          <button
            type="button"
            onClick={() => setConfirm("all")}
            disabled={disabled || !ready}
            title={ready ? undefined : blockedHint}
            className={BTN_PRIMARY}
          >
            Sync all
          </button>
        </div>
      )}

      {error && (
        <p className="mt-3 rounded-lg border border-danger/40 bg-danger/10 p-3 text-sm text-danger" role="alert">
          {error}
        </p>
      )}

      {(running || loop.started || loop.done) && (
        <div className="mt-4" aria-live="polite">
          <div className="h-2 w-full overflow-hidden rounded-full bg-surface-active">
            <div
              className="h-full rounded-full bg-teal transition-all duration-300"
              style={{ width: `${pct}%` }}
              role="progressbar"
              aria-valuenow={pct}
              aria-valuemin={0}
              aria-valuemax={100}
            />
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs tabular-nums text-text-secondary">
            <span>On Garmin: <span className="font-semibold text-text">{onGarmin}</span></span>
            <span>Pending: <span className="font-semibold text-text">{loop.remaining}</span></span>
            <span>Synced: <span className="font-semibold text-success">{loop.synced}</span></span>
            {loop.skipped > 0 && <span>Skipped: <span className="font-semibold text-text-muted">{loop.skipped}</span></span>}
            {running && loop.currentTitle && <span className="min-w-0 truncate text-text-muted">· {loop.currentTitle}…</span>}
          </div>
          {loop.done && loop.message && (
            <p className={`mt-2 text-xs ${loop.errorKind ? "text-danger" : "text-text-secondary"}`} role={loop.errorKind ? "alert" : undefined}>
              {loop.errorKind ? errorHint(loop.errorKind) : loop.message}
            </p>
          )}
          {/* The hint alone ("Something went wrong") gave nothing to act on; the
              server's own message says which workout and what Garmin answered. */}
          {loop.done && loop.errorKind && loop.message && loop.message !== errorHint(loop.errorKind) && (
            <p className="mt-1 break-words text-xs text-text-muted" data-testid="sync-error-detail">
              {loop.message}
            </p>
          )}
        </div>
      )}

      {result && (
        <div className="mt-4 rounded-lg border border-border bg-surface p-4">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${
                STATUS_STYLE[result.status] ?? "bg-surface-active text-text-secondary"
              }`}
            >
              {result.dryRun ? "Preview" : result.status}
            </span>
            <span className="text-sm text-text">
              {DECISION_LABEL[result.dedupDecision] ?? result.dedupDecision}
            </span>
          </div>

          {result.workout && (
            <div className="mt-3 text-sm">
              <div className="font-medium text-text">
                {result.workout.title || "Untitled workout"}
              </div>
              {result.fitStats && (
                <div className="mt-1 text-xs text-text-muted tabular-nums">
                  {result.fitStats.exercises} exercises · {result.fitStats.totalSets} sets ·{" "}
                  {result.fitStats.calories} kcal
                  {result.fitStats.avgHr != null && <> · {result.fitStats.avgHr} bpm avg</>} ·{" "}
                  {fmtDuration(result.fitStats.durationS)}
                </div>
              )}
            </div>
          )}

          {(result.garminActivityId || result.existingGarminActivityId) && (
            <div className="mt-2 text-xs text-text-muted">
              Garmin activity {result.garminActivityId ?? result.existingGarminActivityId}
              {result.syncMethod === "match" && " (matched existing)"}
            </div>
          )}

          <div className="mt-2 text-xs text-text-muted">
            {result.remaining} workout{result.remaining === 1 ? "" : "s"} left to consider
          </div>
        </div>
      )}
    </section>
  );
}
