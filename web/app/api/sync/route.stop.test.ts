import { describe, it, expect, vi, beforeEach } from "vitest";

/** POST /api/sync with "Stop all syncing": refused up front, or ended mid-batch. */

const h = vi.hoisted(() => ({ stopped: false, syncOneWorkout: vi.fn() }));

vi.mock("@/lib/sync-one", () => ({ syncOneWorkout: (...a: unknown[]) => h.syncOneWorkout(...a) }));
vi.mock("@/lib/sync-control", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  isSyncStopped: async () => h.stopped,
}));
vi.mock("@/lib/db", () => ({ getDb: () => ({}) }));
vi.mock("@/lib/sync-lock-store", () => ({ postgresLockBackend: () => ({}) }));
vi.mock("hevy2garmin", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  acquireSyncLock: async () => ({ key: "sync", token: "t", release: async () => {} }),
  recordSyncRun: async () => {},
}));
vi.mock("@/lib/garmin-activities", () => ({ detectDuplicates: async () => [], garminClient: async () => ({}) }));
vi.mock("@/lib/hevy-sync", () => ({ fetchAllWorkouts: async () => [] }));
vi.mock("@/lib/github", () => ({ getGithubPat: async () => null, getGithubRepo: () => null, triggerViaActions: vi.fn() }));
vi.mock("@/lib/auth", () => ({ authEnabled: () => false, verifySession: async () => true, SESSION_COOKIE: "s" }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));

import { POST } from "./route";
import { SyncStoppedError } from "@/lib/sync-control";

const live = () => POST(new Request("http://h/api/sync?live=1", { method: "POST" }));

beforeEach(() => {
  h.stopped = false;
  h.syncOneWorkout.mockReset();
});

describe("POST /api/sync while stopped", () => {
  it("refuses a live batch before doing anything", async () => {
    h.stopped = true;
    const res = await live();
    expect(res.status).toBe(423);
    expect((await res.json()).stopped).toBe(true);
    expect(h.syncOneWorkout).not.toHaveBeenCalled();
  });

  it("ends a running batch at the next workout and reports what it did", async () => {
    h.syncOneWorkout
      .mockResolvedValueOnce({ status: "synced" })
      .mockRejectedValueOnce(new SyncStoppedError());
    const res = await live();
    const d = await res.json();
    expect(res.status).toBe(200);
    expect(d).toMatchObject({ stopped: true, ran: 1, totalSynced: 1 });
    expect(h.syncOneWorkout).toHaveBeenCalledTimes(2);
  });
});
