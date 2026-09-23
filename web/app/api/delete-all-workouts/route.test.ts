import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * POST /api/delete-all-workouts: app-only wipe of API and CSV workouts. It must
 * stop syncing BEFORE deleting anything, and must never reach Garmin.
 */

const h = vi.hoisted(() => ({ texts: [] as string[], demo: false }));

vi.mock("@/lib/demo", () => ({ demoMode: () => h.demo }));
vi.mock("@/lib/auth", () => ({ authEnabled: () => false, verifySession: async () => true, SESSION_COOKIE: "s" }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock("@/lib/garmin-upload", () => ({
  getGarminClient: () => {
    throw new Error("must not touch Garmin");
  },
}));
vi.mock("@/lib/db", () => ({
  getDb: () => {
    const tag = ((strings: TemplateStringsArray) => {
      const text = strings.join("?");
      h.texts.push(text);
      if (text.includes("DELETE FROM synced_workouts")) return Promise.resolve([{ hevy_id: "a" }, { hevy_id: "csv-1" }]);
      if (text.includes("DELETE FROM imported_workouts")) return Promise.resolve([{ hevy_id: "csv-1" }]);
      return Promise.resolve([]);
    }) as never;
    (tag as unknown as { json: (v: unknown) => unknown }).json = (v: unknown) => v;
    return tag;
  },
}));

import { POST } from "./route";

const post = (body: unknown) =>
  POST(new Request("http://h/api/delete-all-workouts", { method: "POST", body: JSON.stringify(body) }));

beforeEach(() => {
  h.texts = [];
  h.demo = false;
});

describe("POST /api/delete-all-workouts", () => {
  it("requires confirm=DELETE and deletes nothing without it", async () => {
    expect((await post({})).status).toBe(400);
    expect((await post({ confirm: "RESET" })).status).toBe(400);
    expect(h.texts).toEqual([]);
  });

  it("refuses in demo mode", async () => {
    h.demo = true;
    expect((await post({ confirm: "DELETE" })).status).toBe(403);
    expect(h.texts).toEqual([]);
  });

  it("stops syncing first, then clears API and CSV workouts", async () => {
    const res = await post({ confirm: "DELETE" });
    const d = await res.json();
    expect(res.status).toBe(200);
    expect(d).toMatchObject({ ok: true, syncStopped: true, deleted: { synced: 2, imported: 1, pending: 0 } });

    const stopAt = h.texts.findIndex((t) => t.includes("INSERT INTO app_cache"));
    const firstDelete = h.texts.findIndex((t) => t.includes("DELETE FROM"));
    expect(stopAt).toBeGreaterThanOrEqual(0);
    expect(stopAt).toBeLessThan(firstDelete);
    for (const table of ["pending_uploads", "synced_workouts", "imported_workouts", "hr_cache"]) {
      expect(h.texts.some((t) => t.includes(`DELETE FROM ${table}`))).toBe(true);
    }
    // Run history, settings and credentials stay.
    expect(h.texts.some((t) => t.includes("DELETE FROM sync_log"))).toBe(false);
    expect(h.texts.some((t) => t.includes("platform_credentials"))).toBe(false);
  });
});
