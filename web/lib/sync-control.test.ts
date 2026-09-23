import { describe, it, expect } from "vitest";
import { assertSyncAllowed, loadSyncControl, setSyncStopped, SyncStoppedError } from "./sync-control";

/** A tagged-template sql over an in-memory app_cache. */
function fakeSql(initial: Record<string, unknown> = {}) {
  const cache = new Map(Object.entries(initial));
  const tag = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?");
    if (text.includes("SELECT value FROM app_cache")) {
      const key = String(values[0]);
      return Promise.resolve(cache.has(key) ? [{ value: cache.get(key) }] : []);
    }
    if (text.includes("INSERT INTO app_cache")) {
      cache.set(String(values[0]), values[1]);
      return Promise.resolve([]);
    }
    return Promise.resolve([]);
  }) as never as Parameters<typeof loadSyncControl>[0];
  (tag as unknown as { json: (v: unknown) => unknown }).json = (v: unknown) => v;
  return { sql: tag, cache };
}

describe("sync control", () => {
  it("reads as running when nothing is stored, or the database fails", async () => {
    expect(await loadSyncControl(fakeSql().sql)).toEqual({ stopped: false, stoppedAt: null });
    const broken = (() => Promise.reject(new Error("down"))) as never;
    expect((await loadSyncControl(broken)).stopped).toBe(false);
  });

  it("stops and resumes", async () => {
    const { sql } = fakeSql();
    const stopped = await setSyncStopped(sql, true);
    expect(stopped.stopped).toBe(true);
    expect(stopped.stoppedAt).toMatch(/^\d{4}-/);
    expect((await loadSyncControl(sql)).stopped).toBe(true);
    await expect(assertSyncAllowed(sql)).rejects.toBeInstanceOf(SyncStoppedError);

    await setSyncStopped(sql, false);
    expect(await loadSyncControl(sql)).toEqual({ stopped: false, stoppedAt: null });
    await expect(assertSyncAllowed(sql)).resolves.toBeUndefined();
  });

  it("reads the row the Python CLI reads", async () => {
    const { sql } = fakeSql({ sync_control: { stopped: true, stopped_at: "2026-09-23T10:00:00.000Z" } });
    expect(await loadSyncControl(sql)).toEqual({ stopped: true, stoppedAt: "2026-09-23T10:00:00.000Z" });
  });
});
