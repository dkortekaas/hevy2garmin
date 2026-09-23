"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * "Delete all workouts" for the settings Danger zone. Wipes every workout the
 * app holds (API and CSV import) but no Garmin activity. The user types DELETE
 * to confirm, because unlike "Unsync all" this also throws away the CSV import.
 */
export function DeleteAllWorkouts({ total }: { total: number }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/delete-all-workouts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: "DELETE" }),
      });
      const d = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        deleted?: { synced: number; pending: number; imported: number };
      };
      if (!res.ok || !d.ok) {
        setError(d.error ?? `Request failed (${res.status}).`);
        return;
      }
      const x = d.deleted ?? { synced: 0, pending: 0, imported: 0 };
      setDone(
        `Deleted ${x.synced} synced, ${x.pending} in-flight and ${x.imported} imported workout record(s). Syncing is stopped; resume it on the dashboard when you are ready.`,
      );
      setConfirming(false);
      setTyped("");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 rounded-xl border border-danger/40 bg-danger/5 p-4" data-testid="delete-all-workouts">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-danger">Delete all workouts</h3>
          <p className="mt-0.5 text-xs text-text-muted">
            Removes every workout record in this app ({total}), from the Hevy API and from CSV imports: sync
            history, in-flight uploads, imported workouts and cached heart rate. Garmin activities and your
            Hevy account are not touched. Syncing is stopped, because the next sync would otherwise upload
            everything to Garmin again.
          </p>
        </div>
        {!confirming && (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            disabled={busy || total === 0}
            title={total === 0 ? "There are no workouts to delete" : undefined}
            className="rounded-lg border border-danger/50 px-3 py-1.5 text-xs font-medium text-danger transition-colors hover:bg-danger/15 disabled:opacity-50"
          >
            Delete all workouts
          </button>
        )}
      </div>
      {confirming && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <label className="text-xs text-text-secondary">
            Type <strong>DELETE</strong> to confirm
            <input
              type="text"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
              className="ml-2 w-28 rounded-lg border border-border bg-surface px-2 py-1 text-xs text-text focus:border-danger focus:outline-none"
            />
          </label>
          <button
            type="button"
            onClick={run}
            disabled={busy || typed !== "DELETE"}
            className="rounded-lg bg-danger/20 px-3 py-1.5 text-xs font-medium text-danger transition-colors hover:bg-danger/30 disabled:opacity-50"
          >
            {busy ? "Deleting…" : "Delete everything"}
          </button>
          <button
            type="button"
            onClick={() => {
              setConfirming(false);
              setTyped("");
            }}
            disabled={busy}
            className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:bg-surface-active disabled:opacity-50"
          >
            Cancel
          </button>
        </div>
      )}
      {done && <p className="mt-2 text-xs text-success">{done}</p>}
      {error && (
        <p className="mt-2 text-xs text-danger" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
