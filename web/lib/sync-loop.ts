/**
 * Pure reducer for the dashboard live sync loop — ports the Python syncNow()
 * client loop over /api/sync-one. Kept free of fetch/DOM so it can be unit
 * tested exhaustively; the SyncLoop component drives it.
 *
 * Each step feeds the HTTP status + the SyncOneResult of one /api/sync-one call
 * and returns the next state plus whether the loop should continue. The loop
 * terminates on: nothing-left (status "none"), unauthorized (401), a busy claim
 * (dedupDecision "claim_lost"), any error, or a caught network failure.
 */

export interface SyncOneLike {
  status?: "synced" | "skipped" | "deferred" | "dry_run" | "none" | "error";
  remaining?: number;
  dedupDecision?: string;
  workout?: { title?: string | null } | null;
  garminActivityId?: number | null;
  error?: string | null;
}

export type ErrorKind = "consent" | "hevy_key" | "garmin_auth" | "generic" | "unauthorized";

export interface LoopState {
  started: boolean;
  total: number;
  synced: number;
  skipped: number;
  remaining: number;
  currentTitle: string | null;
  done: boolean;
  message: string | null;
  errorKind: ErrorKind | null;
}

export const initialLoopState: LoopState = {
  started: false,
  total: 0,
  synced: 0,
  skipped: 0,
  remaining: 0,
  currentTitle: null,
  done: false,
  message: null,
  errorKind: null,
};

/** Classify an /api/sync-one error string into an actionable branch. */
export function classifyError(error: string): ErrorKind {
  if (/consent|upload consent/i.test(error)) return "consent";
  if (/Hevy API key/i.test(error)) return "hevy_key";
  if (/login failed|\bauth\b|oauth|\btoken\b/i.test(error)) return "garmin_auth";
  return "generic";
}

/** Percent complete (0–100) for the progress bar. */
export function loopPercent(s: LoopState): number {
  if (!s.total) return 0;
  return Math.min(100, Math.round(((s.synced + s.skipped) / s.total) * 100));
}

export interface StepInput {
  httpStatus: number;
  result: SyncOneLike;
}

export interface StepOutput {
  state: LoopState;
  cont: boolean;
}

/** Advance the loop one iteration. */
export function stepLoop(prev: LoopState, input: StepInput): StepOutput {
  const { httpStatus, result } = input;
  const s = { ...prev };

  // Unauthorized live sync → stop and prompt to sign in.
  if (httpStatus === 401) {
    return { state: { ...s, done: true, errorKind: "unauthorized", message: "Sign in to sync." }, cont: false };
  }
  // Which workout failed, when the server said: "which one" is the first thing to know.
  const failing = result.workout?.title ? `${result.workout.title}: ` : "";

  // Any non-OK HTTP → stop with the server message. A body that is not JSON (a
  // platform timeout page, say) leaves only the status, so name the common one.
  if (httpStatus >= 400) {
    const fallback =
      httpStatus === 504
        ? "The server timed out (504) on this workout. Try Sync all again; it continues where it stopped."
        : `Sync failed (${httpStatus}).`;
    return {
      state: { ...s, done: true, errorKind: "generic", message: failing + (result.error ?? fallback) },
      cont: false,
    };
  }

  const status = result.status;
  const remaining = typeof result.remaining === "number" ? result.remaining : s.remaining;

  if (status === "error") {
    const kind = classifyError(result.error ?? "");
    return { state: { ...s, done: true, errorKind: kind, message: failing + (result.error ?? "Sync error.") }, cont: false };
  }
  if (result.dedupDecision === "claim_lost") {
    return { state: { ...s, done: true, message: "Another sync is already running." }, cont: false };
  }
  if (status === "none") {
    return { state: { ...s, remaining: 0, done: true, message: "All caught up." }, cont: false };
  }

  if (status === "synced") {
    s.synced += 1;
    s.currentTitle = result.workout?.title ?? s.currentTitle;
  } else if (status === "skipped" || status === "deferred") {
    s.skipped += 1;
    s.currentTitle = result.workout?.title ?? s.currentTitle;
  }
  // Seed the total from the first productive iteration (done + remaining).
  if (!s.started && (status === "synced" || status === "skipped" || status === "deferred")) {
    s.started = true;
    s.total = s.synced + s.skipped + remaining;
  }
  s.remaining = remaining;

  // Keep going while work remains; otherwise finish.
  if (remaining > 0) return { state: s, cont: true };
  return { state: { ...s, done: true, message: "All caught up." }, cont: false };
}

/** Human message for an error kind (with an actionable hint). */
export function errorHint(kind: ErrorKind): string {
  switch (kind) {
    case "consent":
      return "Garmin needs upload consent. Enable third-party uploads in your Garmin Connect settings, then retry.";
    case "hevy_key":
      return "Your Hevy API key looks expired. Update it on Setup, then retry.";
    case "garmin_auth":
      return "Garmin sign-in expired. Reconnect Garmin on Setup, then retry.";
    case "unauthorized":
      return "Sign in to run a sync.";
    default:
      return "Something went wrong during the sync.";
  }
}

/**
 * Waits before retrying one /api/sync-one call that never got a usable answer.
 *
 * The run used to end at the first such failure. On a phone that is most runs:
 * Safari reports a dropped request as "Load failed" when the screen locks, the
 * app goes to the background or the connection blips, and a long backlog gives
 * all of those time to happen (the report was 14 of 79 workouts, then stop).
 *
 * Retrying is safe because the server never uploads a workout twice: a synced
 * workout is in the ledger, and one whose upload was mid-flight when the answer
 * got lost is claimed in pending_uploads, so the next call moves on to another
 * workout or finishes the claimed one through recovery.
 */
export const NETWORK_RETRY_DELAYS_MS = [2_000, 5_000, 10_000, 20_000] as const;

/**
 * A gateway error the platform returns without a JSON body: the function timed
 * out or was restarted. Same reasoning as a dropped request, same retry.
 */
export function isRetryableStatus(httpStatus: number): boolean {
  return httpStatus === 502 || httpStatus === 503 || httpStatus === 504;
}

/** The message for a run that gave up on the network, with the browser's own words. */
export function networkGiveUpMessage(err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err ?? "");
  return `Lost the connection to the server${detail ? ` (${detail})` : ""} and ${NETWORK_RETRY_DELAYS_MS.length} retries did not help. Keep this page open and in front, then click Sync all again: it continues where it stopped.`;
}
