import type { getDb } from "./db";

type Sql = ReturnType<typeof getDb>;

export interface Connection {
  connected: boolean;
  connectedAt: string | null;
}

const DISCONNECTED: Connection = { connected: false, connectedAt: null };

/**
 * Which platform_credentials row means what:
 *
 *   platform='hevy'          the API key, written by the setup form
 *   platform='garmin'        the Garmin email/password pair, written by the Python setup form only
 *   platform='garmin_tokens' the DI tokens, written by every Garmin login (Python and web)
 *
 * Garmin connectivity has to come from `garmin_tokens`. A web login writes only that row, so
 * pages that looked at `garmin` reported a working login as "Not connected" and stayed that way
 * until the user hand-copied the row (hevy2garmin#495).
 *
 * It also has to come from the stored token rather than the `status` column. DBTokenStore's
 * upsert sets status='active' on INSERT but not in its DO UPDATE branch, so a row first created
 * by anything else keeps the schema default 'disconnected' through every later login. Reading the
 * token itself is true whenever a sync would actually work, which is what the badge claims.
 *
 * Both token shapes count: 0.3+ nests the DI payload under `garmin_tokens`, older Python logins
 * wrote it flat. healGarminTokenRow migrates a flat row, but only during a sync.
 */
export async function loadGarminConnection(sql: Sql): Promise<Connection> {
  const rows = await sql`
    SELECT connected_at,
           (jsonb_exists(credentials -> 'garmin_tokens', 'di_token')
            OR jsonb_exists(credentials, 'di_token')) AS has_token
    FROM platform_credentials
    WHERE platform = 'garmin_tokens'
  `.catch(() => [] as Array<{ connected_at: string | null; has_token: boolean | null }>);
  const row = rows[0];
  if (!row?.has_token) return DISCONNECTED;
  return { connected: true, connectedAt: row.connected_at ?? null };
}

export interface HevyConnection extends Connection {
  /**
   * The row exists and says 'disconnected': the user pressed Disconnect Hevy, or Hevy rejected
   * the key (#605). Unlike a missing row, this is a statement that Hevy is NOT connected, so no
   * fallback may paint it green.
   */
  disconnected: boolean;
}

/**
 * Hevy is connected when its credential row exists and is not explicitly disconnected. The
 * setup form writes status='active', so testing for the literal 'connected' never matches.
 */
export async function loadHevyConnection(sql: Sql): Promise<HevyConnection> {
  const rows = await sql`
    SELECT status, connected_at
    FROM platform_credentials
    WHERE platform = 'hevy'
  `.catch(() => [] as Array<{ status: string | null; connected_at: string | null }>);
  const row = rows[0];
  if (!row) return { ...DISCONNECTED, disconnected: false };
  if (row.status === "disconnected") return { ...DISCONNECTED, disconnected: true };
  return { connected: true, connectedAt: row.connected_at ?? null, disconnected: false };
}

/**
 * Where the dashboard's Hevy badge gets its workouts from.
 *
 *   api      a saved key, or HEVY_API_KEY in the environment (which the sync uses too)
 *   csv      no key, but workouts imported from a Hevy CSV export
 *   history  no credential row at all, but synced workouts: a database from an older build
 *            that never wrote the row. Never after an explicit disconnect.
 *   none     not connected
 *
 * `history` used to be unconditional, so a user who pressed Disconnect Hevy still saw
 * "Connected" for as long as they had any synced workout.
 */
export type HevySource = "api" | "csv" | "history" | "none";

export function hevySource(o: {
  connection: HevyConnection;
  envKey: boolean;
  importCount: number;
  hasSynced: boolean;
}): HevySource {
  if (o.connection.connected || o.envKey) return "api";
  if (o.importCount > 0) return "csv";
  if (o.hasSynced && !o.connection.disconnected) return "history";
  return "none";
}
