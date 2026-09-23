"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export interface ImportSummaryView {
  count: number;
  newest: string | null;
  oldest: string | null;
}

function fmtDay(value: string | null): string {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
  } catch {
    return "";
  }
}

/**
 * Upload a Hevy CSV export, the alternative to an API key. Hevy's API needs
 * Hevy Pro; the export does not. The file is read in the browser and sent to
 * /api/import-hevy-csv, which stores the workouts. Nothing uploads to Garmin
 * until a sync runs.
 */
export function ImportHevyCsv({
  summary,
  savedTimeZone,
}: {
  summary: ImportSummaryView;
  /** user_profile.timezone, used when set; otherwise the browser's zone. */
  savedTimeZone: string | null;
}) {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [timeZone, setTimeZone] = useState(() => savedTimeZone ?? browserTimeZone());
  const [since, setSince] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setOkMsg(null);
    if (!file) {
      setError("Choose the CSV file you exported from Hevy.");
      return;
    }
    setBusy(true);
    try {
      const csv = await file.text();
      const res = await fetch("/api/import-hevy-csv", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ csv, timeZone: timeZone.trim(), since: since || undefined }),
      });
      const d = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        imported?: number;
        added?: number;
        updated?: number;
        skippedBeforeSince?: number;
      };
      if (!res.ok || !d.ok) {
        setError(
          d.error ?? (res.status === 413 ? "The file is too large to upload in one go." : `Request failed (${res.status}).`),
        );
        return;
      }
      const parts = [`${d.added ?? 0} new`, `${d.updated ?? 0} already imported`];
      if (d.skippedBeforeSince) parts.push(`${d.skippedBeforeSince} before the start date skipped`);
      setOkMsg(`Imported ${d.imported ?? 0} workout${d.imported === 1 ? "" : "s"} (${parts.join(", ")}).`);
      setFile(null);
      (e.target as HTMLFormElement).reset();
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function clearAll() {
    if (!window.confirm("Remove all imported workouts? Workouts already synced stay on Garmin and stay marked as synced.")) {
      return;
    }
    setError(null);
    setOkMsg(null);
    setBusy(true);
    try {
      const res = await fetch("/api/import-hevy-csv", { method: "DELETE" });
      const d = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !d.ok) {
        setError(d.error ?? `Request failed (${res.status}).`);
        return;
      }
      setOkMsg("Imported workouts removed.");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const inputCls =
    "w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text focus:border-teal focus:outline-none";

  return (
    <form onSubmit={submit} className="space-y-3" data-testid="import-hevy-csv">
      <p className="text-xs text-text-muted">
        No Hevy Pro? Export your workouts in the Hevy app under Profile → Settings → Export &amp; Import
        Data → Export Workouts, and upload the CSV here. Upload a new export whenever you want to sync
        newer workouts; workouts already imported or synced are not duplicated. Imported workouts sync
        from the dashboard and the Vercel cron, not from the GitHub Actions auto-sync.
      </p>
      {summary.count > 0 && (
        <p className="text-xs text-text-secondary" data-testid="import-summary">
          {summary.count} workout{summary.count === 1 ? "" : "s"} imported
          {summary.oldest && summary.newest ? ` (${fmtDay(summary.oldest)} – ${fmtDay(summary.newest)})` : ""}.
        </p>
      )}
      <input
        type="file"
        accept=".csv,text/csv"
        onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        className="block w-full text-sm text-text-secondary file:mr-3 file:rounded-lg file:border-0 file:bg-surface file:px-3 file:py-2 file:text-sm file:text-text"
      />
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-xs text-text-muted">
          Timezone of the workouts
          <input
            type="text"
            value={timeZone}
            onChange={(e) => setTimeZone(e.target.value)}
            placeholder="Europe/Amsterdam"
            className={`mt-1 ${inputCls}`}
          />
        </label>
        <label className="block text-xs text-text-muted">
          Only workouts from (optional)
          <input type="date" value={since} onChange={(e) => setSince(e.target.value)} className={`mt-1 ${inputCls}`} />
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={busy}
          className="rounded-lg bg-teal/20 px-4 py-2 text-sm font-medium text-teal transition-colors hover:bg-teal/30 disabled:opacity-50"
        >
          {busy ? "Importing…" : "Import CSV"}
        </button>
        {summary.count > 0 && (
          <button
            type="button"
            onClick={clearAll}
            disabled={busy}
            className="rounded-lg px-3 py-2 text-xs text-text-muted transition-colors hover:text-danger disabled:opacity-50"
          >
            Remove imported workouts
          </button>
        )}
        {okMsg && <span className="text-xs text-success">{okMsg}</span>}
        {error && (
          <span className="text-xs text-danger" role="alert">
            {error}
          </span>
        )}
      </div>
    </form>
  );
}
