import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * fetchAllWorkouts with a Hevy CSV import: either source alone is enough, and
 * having both never yields the same session twice.
 */

const h = vi.hoisted(() => ({
  apiKey: null as string | null,
  imported: [] as unknown[],
  getAllWorkouts: vi.fn(async () => [] as unknown[]),
}));

vi.mock("hevy2garmin", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    HevyClient: class {
      getAllWorkouts = h.getAllWorkouts;
    },
  };
});
vi.mock("./db", () => ({
  getDb: () => {
    const tag = ((strings: TemplateStringsArray) => {
      const text = strings.join("?");
      if (text.includes("SELECT credentials")) {
        return Promise.resolve(h.apiKey ? [{ credentials: { api_key: h.apiKey } }] : []);
      }
      if (text.includes("FROM imported_workouts")) return Promise.resolve(h.imported.map((data) => ({ data })));
      return Promise.resolve([]);
    }) as never;
    (tag as unknown as { json: (v: unknown) => unknown }).json = (v: unknown) => v;
    return tag;
  },
}));

import { fetchAllWorkouts } from "./hevy-sync";

const ids = (ws: unknown[]) => ws.map((w) => (w as { id: string }).id);

beforeEach(() => {
  delete process.env.HEVY_API_KEY;
  h.apiKey = null;
  h.imported = [];
  h.getAllWorkouts.mockReset();
  h.getAllWorkouts.mockResolvedValue([]);
});

describe("fetchAllWorkouts with a CSV import", () => {
  it("syncs from the import alone when there is no API key", async () => {
    h.imported = [{ id: "csv-20240115T1830", start_time: "2024-01-15T17:30:00+00:00" }];
    expect(ids(await fetchAllWorkouts())).toEqual(["csv-20240115T1830"]);
    expect(h.getAllWorkouts).not.toHaveBeenCalled();
  });

  it("still says what is missing when there is neither", async () => {
    await expect(fetchAllWorkouts()).rejects.toThrow(/No Hevy API key.*no Hevy CSV/);
  });

  it("combines both, dropping an imported copy of an API workout", async () => {
    h.apiKey = "k";
    h.getAllWorkouts.mockResolvedValue([{ id: "api-1", start_time: "2024-01-15T17:30:22+00:00" }]);
    h.imported = [
      { id: "csv-20240120T1800", start_time: "2024-01-20T17:00:00+00:00" },
      { id: "csv-20240115T1830", start_time: "2024-01-15T17:30:00+00:00" },
    ];
    expect(ids(await fetchAllWorkouts())).toEqual(["csv-20240120T1800", "api-1"]);
  });

  it("does not hide an API failure behind the imported workouts", async () => {
    h.apiKey = "k";
    h.imported = [{ id: "csv-20240115T1830", start_time: "2024-01-15T17:30:00+00:00" }];
    h.getAllWorkouts.mockRejectedValue(new Error("socket hang up"));
    await expect(fetchAllWorkouts()).rejects.toThrow("socket hang up");
  });
});
