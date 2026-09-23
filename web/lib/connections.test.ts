import { describe, it, expect } from "vitest";
import { hevySource, loadGarminConnection, loadHevyConnection, type HevyConnection } from "./connections";

type Sql = Parameters<typeof loadGarminConnection>[0];

/** A fake `sql` tag that records the query text and returns a canned result set. */
function fakeSql(rows: unknown[], sink?: string[]): Sql {
  const tag = (async (strings: TemplateStringsArray) => {
    sink?.push(strings.join("?").replace(/\s+/g, " ").trim());
    return rows;
  }) as unknown as Sql;
  return tag;
}

function throwingSql(): Sql {
  return (async () => {
    throw new Error("relation \"platform_credentials\" does not exist");
  }) as unknown as Sql;
}

describe("loadGarminConnection (#495)", () => {
  it("reads the garmin_tokens row, not the garmin email/password row", async () => {
    const queries: string[] = [];
    await loadGarminConnection(fakeSql([], queries));
    expect(queries[0]).toContain("WHERE platform = 'garmin_tokens'");
    expect(queries[0]).not.toContain("'garmin'");
  });

  it("is connected when a nested DI token is stored, ignoring the status column", async () => {
    // has_token is what the SQL computes; status is deliberately absent from the projection
    // because DBTokenStore's DO UPDATE never refreshes it.
    const r = await loadGarminConnection(
      fakeSql([{ connected_at: "2026-09-01T00:00:00Z", has_token: true }]),
    );
    expect(r).toEqual({ connected: true, connectedAt: "2026-09-01T00:00:00Z" });
  });

  it("accepts a token with no connected_at, which the token-store upsert never sets", async () => {
    const r = await loadGarminConnection(fakeSql([{ connected_at: null, has_token: true }]));
    expect(r).toEqual({ connected: true, connectedAt: null });
  });

  it("tests both the nested and the flat token shape", async () => {
    const queries: string[] = [];
    await loadGarminConnection(fakeSql([], queries));
    expect(queries[0]).toContain("jsonb_exists(credentials -> 'garmin_tokens', 'di_token')");
    expect(queries[0]).toContain("jsonb_exists(credentials, 'di_token')");
  });

  it("is disconnected when the row exists but holds no token", async () => {
    const r = await loadGarminConnection(
      fakeSql([{ connected_at: "2026-09-01T00:00:00Z", has_token: false }]),
    );
    expect(r).toEqual({ connected: false, connectedAt: null });
  });

  it("is disconnected when no row exists at all", async () => {
    expect(await loadGarminConnection(fakeSql([]))).toEqual({
      connected: false,
      connectedAt: null,
    });
  });

  it("degrades to disconnected when the table is missing", async () => {
    expect(await loadGarminConnection(throwingSql())).toEqual({
      connected: false,
      connectedAt: null,
    });
  });
});

describe("loadHevyConnection", () => {
  it("treats the status the setup form actually writes as connected", async () => {
    const r = await loadHevyConnection(
      fakeSql([{ status: "active", connected_at: "2026-09-01T00:00:00Z" }]),
    );
    expect(r).toEqual({ connected: true, connectedAt: "2026-09-01T00:00:00Z", disconnected: false });
  });

  it("treats an explicit disconnected status as disconnected", async () => {
    const r = await loadHevyConnection(fakeSql([{ status: "disconnected", connected_at: null }]));
    expect(r.connected).toBe(false);
    expect(r.disconnected).toBe(true);
  });

  it("is disconnected when no row exists", async () => {
    expect((await loadHevyConnection(fakeSql([]))).connected).toBe(false);
  });

  it("degrades to disconnected when the table is missing", async () => {
    expect((await loadHevyConnection(throwingSql())).connected).toBe(false);
  });
});

describe("hevySource (the dashboard badge)", () => {
  const none: HevyConnection = { connected: false, connectedAt: null, disconnected: false };
  const disconnected: HevyConnection = { ...none, disconnected: true };
  const active: HevyConnection = { connected: true, connectedAt: null, disconnected: false };
  const base = { envKey: false, importCount: 0, hasSynced: false };

  it("is api with a saved key or an environment key", () => {
    expect(hevySource({ ...base, connection: active })).toBe("api");
    expect(hevySource({ ...base, connection: disconnected, envKey: true })).toBe("api");
  });

  it("is csv with only imported workouts", () => {
    expect(hevySource({ ...base, connection: disconnected, importCount: 3 })).toBe("csv");
  });

  it("keeps the old-database fallback only when no row was ever written", () => {
    expect(hevySource({ ...base, connection: none, hasSynced: true })).toBe("history");
  });

  it("is none after Disconnect Hevy, synced workouts or not", () => {
    expect(hevySource({ ...base, connection: disconnected, hasSynced: true })).toBe("none");
    expect(hevySource({ ...base, connection: none })).toBe("none");
  });
});
