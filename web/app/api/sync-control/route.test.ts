import { describe, it, expect, vi, beforeEach } from "vitest";

/** POST /api/sync-control: stopping sets the switch AND turns auto-sync off everywhere. */

const h = vi.hoisted(() => ({
  cache: new Map<string, unknown>(),
  pat: null as string | null,
  cancel: vi.fn(async () => 2),
  disable: vi.fn(async () => true),
}));

vi.mock("@/lib/auth", () => ({ authEnabled: () => false, verifySession: async () => true, SESSION_COOKIE: "s" }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock("@/lib/github", () => ({
  getGithubPat: async () => h.pat,
  getGithubRepo: () => (h.pat ? "me/hevy2garmin" : null),
  cancelSyncWorkflowRuns: h.cancel,
  disableGithubActions: h.disable,
}));
vi.mock("@/lib/db", () => ({
  getDb: () => {
    const tag = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join("?");
      if (text.includes("SELECT value FROM app_cache")) {
        const key = text.includes("'auto_sync'") ? "auto_sync" : String(values[0]);
        return Promise.resolve(h.cache.has(key) ? [{ value: h.cache.get(key) }] : []);
      }
      if (text.includes("INSERT INTO app_cache")) {
        if (text.includes("'auto_sync'")) h.cache.set("auto_sync", values[0]);
        else h.cache.set(String(values[0]), values[1]);
      }
      return Promise.resolve([]);
    }) as never;
    (tag as unknown as { json: (v: unknown) => unknown }).json = (v: unknown) => v;
    return tag;
  },
}));

import { GET, POST } from "./route";

const post = (body: unknown) =>
  POST(new Request("http://h/api/sync-control", { method: "POST", body: JSON.stringify(body) }));

beforeEach(() => {
  h.cache.clear();
  h.pat = null;
  h.cancel.mockClear();
  h.disable.mockClear();
});

describe("/api/sync-control", () => {
  it("stops syncing and turns auto-sync off, keeping its interval", async () => {
    h.cache.set("auto_sync", { enabled: true, interval_minutes: 60 });
    const d = await (await post({ stopped: true })).json();
    expect(d).toMatchObject({ ok: true, stopped: true, autoSyncDisabled: true });
    expect(h.cache.get("sync_control")).toMatchObject({ stopped: true });
    expect(h.cache.get("auto_sync")).toEqual({ enabled: false, interval_minutes: 60 });
    expect((await (await GET()).json()).stopped).toBe(true);
  });

  it("cancels GitHub Actions runs and removes the workflow when auto-sync runs there", async () => {
    h.pat = "ghp_x";
    const d = await (await post({ stopped: true })).json();
    expect(d.cancelledRuns).toBe(2);
    expect(h.cancel).toHaveBeenCalledWith({ pat: "ghp_x", repo: "me/hevy2garmin" });
    expect(h.disable).toHaveBeenCalledOnce();
  });

  it("resuming clears the switch and leaves auto-sync alone", async () => {
    h.cache.set("auto_sync", { enabled: false });
    await post({ stopped: true });
    const d = await (await post({ stopped: false })).json();
    expect(d).toMatchObject({ ok: true, stopped: false });
    expect(h.cache.get("auto_sync")).toEqual({ enabled: false });
    expect(h.cancel).not.toHaveBeenCalled();
  });

  it("rejects a body without a boolean", async () => {
    expect((await post({ stopped: "yes" })).status).toBe(400);
  });
});
