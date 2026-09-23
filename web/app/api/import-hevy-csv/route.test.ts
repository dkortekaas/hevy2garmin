import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * POST /api/import-hevy-csv stores workouts and uploads nothing. It refuses to
 * guess a timezone, and refuses a file that is not a Hevy export.
 */

const h = vi.hoisted(() => ({
  saved: [] as Array<{ id: string; start_time: string }>,
  cleared: 0,
  profileTz: null as string | null,
}));

vi.mock("@/lib/auth", () => ({ authEnabled: () => false, verifySession: async () => true, SESSION_COOKIE: "s" }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock("@/lib/imported-workouts", () => ({
  saveImportedWorkouts: vi.fn(async (_sql: unknown, ws: Array<{ id: string; start_time: string }>) => {
    h.saved = ws;
    return ws.length;
  }),
  clearImportedWorkouts: vi.fn(async () => {
    h.cleared++;
  }),
}));
vi.mock("@/lib/db", () => ({
  getDb: () => {
    const tag = ((strings: TemplateStringsArray) =>
      Promise.resolve(
        strings.join("?").includes("user_profile") && h.profileTz ? [{ value: { timezone: h.profileTz } }] : [],
      )) as never;
    (tag as unknown as { json: (v: unknown) => unknown }).json = (v: unknown) => v;
    return tag;
  },
}));

import { POST, DELETE } from "./route";

const CSV = [
  '"title","start_time","end_time","exercise_title","set_index","set_type","weight_kg","reps"',
  '"Upper","15 Jan 2024, 18:30","15 Jan 2024, 19:30","Bench Press (Barbell)",0,"normal",80,8',
  '"Legs","10 Jan 2024, 18:00","10 Jan 2024, 19:00","Squat (Barbell)",0,"normal",100,5',
].join("\n");

function req(body: unknown): Request {
  return new Request("http://h/api/import-hevy-csv", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  h.saved = [];
  h.cleared = 0;
  h.profileTz = null;
});

describe("POST /api/import-hevy-csv", () => {
  it("imports the workouts in the given timezone", async () => {
    const res = await POST(req({ csv: CSV, timeZone: "Europe/Amsterdam" }));
    const d = await res.json();
    expect(res.status).toBe(200);
    expect(d).toMatchObject({ ok: true, found: 2, imported: 2, added: 2, timeZone: "Europe/Amsterdam" });
    expect(h.saved.map((w) => w.id)).toEqual(["csv-20240115T1830", "csv-20240110T1800"]);
    expect(h.saved[0].start_time).toBe("2024-01-15T17:30:00+00:00");
  });

  it("falls back to the saved timezone", async () => {
    h.profileTz = "America/New_York";
    const d = await (await POST(req({ csv: CSV }))).json();
    expect(d.timeZone).toBe("America/New_York");
    expect(h.saved[0].start_time).toBe("2024-01-15T23:30:00+00:00");
  });

  it("refuses to guess when no timezone is known", async () => {
    const res = await POST(req({ csv: CSV }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/timezone/i);
    expect(h.saved).toEqual([]);
  });

  it("rejects a timezone that is not one", async () => {
    const res = await POST(req({ csv: CSV, timeZone: "Mars/Olympus" }));
    expect(res.status).toBe(400);
  });

  it("skips workouts before the start date", async () => {
    const d = await (await POST(req({ csv: CSV, timeZone: "UTC", since: "2024-01-12" }))).json();
    expect(d).toMatchObject({ found: 2, imported: 1, skippedBeforeSince: 1 });
    expect(h.saved.map((w) => w.id)).toEqual(["csv-20240115T1830"]);
  });

  it("rejects a file that is not a Hevy export, and an empty upload", async () => {
    const bad = await POST(req({ csv: "name,date\nfoo,bar", timeZone: "UTC" }));
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatch(/Hevy workout export/);
    expect((await POST(req({ csv: "", timeZone: "UTC" }))).status).toBe(400);
    expect(h.saved).toEqual([]);
  });
});

describe("DELETE /api/import-hevy-csv", () => {
  it("clears the imported workouts", async () => {
    const res = await DELETE();
    expect(res.status).toBe(200);
    expect(h.cleared).toBe(1);
  });
});
