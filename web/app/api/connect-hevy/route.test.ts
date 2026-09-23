import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Tests for POST /api/connect-hevy — it must validate the key BEFORE writing,
 * and never persist a rejected key.
 */

const fetchWorkoutCount = vi.fn();
vi.mock("@/lib/hevy-sync", () => ({
  fetchWorkoutCount: (...a: unknown[]) => fetchWorkoutCount(...a),
}));

// A tagged-template SQL spy with a .json() helper, matching lib/db's surface.
const sqlTag = vi.fn((..._a: unknown[]) => Promise.resolve([] as unknown[]));
const sqlObj = Object.assign(sqlTag, { json: (o: unknown) => o });
vi.mock("@/lib/db", () => ({ getDb: () => sqlObj }));

vi.mock("@/lib/auth", () => ({ authEnabled: () => false, verifySession: async () => true, SESSION_COOKIE: "s" }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));

import { POST, DELETE } from "./route";

function req(body: unknown): Request {
  return new Request("http://h/api/connect-hevy", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchWorkoutCount.mockResolvedValue(42);
});

describe("POST /api/connect-hevy", () => {
  it("missing key → 400, no probe, no write", async () => {
    const res = await POST(req({}));
    expect(res.status).toBe(400);
    expect(fetchWorkoutCount).not.toHaveBeenCalled();
    expect(sqlTag).not.toHaveBeenCalled();
  });

  it("rejected key → valid:false and NOTHING is written", async () => {
    fetchWorkoutCount.mockRejectedValue(new Error("401 Unauthorized"));
    const res = await POST(req({ key: "bogus" }));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.ok).toBe(false);
    expect(json.valid).toBe(false);
    expect(sqlTag).not.toHaveBeenCalled(); // never persisted a bad key
  });

  it("valid key → persists + returns the workout count", async () => {
    const res = await POST(req({ key: "good-key" }));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.valid).toBe(true);
    expect(json.workout_count).toBe(42);
    expect(fetchWorkoutCount).toHaveBeenCalledWith("good-key");
    expect(sqlTag).toHaveBeenCalledTimes(1); // the upsert ran
  });

  it("invalid JSON → 400", async () => {
    const bad = new Request("http://h/api/connect-hevy", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{nope",
    });
    const res = await POST(bad);
    expect(res.status).toBe(400);
    expect(fetchWorkoutCount).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/connect-hevy (disconnect)", () => {
  it("removes the saved Hevy key and nothing else", async () => {
    delete process.env.HEVY_API_KEY;
    const res = await DELETE();
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json).toMatchObject({ ok: true, envKeyStillSet: false });
    expect(sqlTag).toHaveBeenCalledTimes(1);
    const text = (sqlTag.mock.calls[0][0] as unknown as TemplateStringsArray).join("?");
    expect(text).toContain("INSERT INTO platform_credentials");
    expect(text).toContain("status = 'disconnected'");
    // The key is gone: the credentials written are empty.
    expect(sqlTag.mock.calls[0][1]).toEqual({});
  });

  it("warns when HEVY_API_KEY in the environment keeps Hevy connected", async () => {
    process.env.HEVY_API_KEY = "from-env";
    try {
      const json = await (await DELETE()).json();
      expect(json.envKeyStillSet).toBe(true);
      expect(json.warning).toMatch(/HEVY_API_KEY/);
    } finally {
      delete process.env.HEVY_API_KEY;
    }
  });
});
