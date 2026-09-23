"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * Connect-Hevy form for the setup page. Sends the entered API key to
 * /api/connect-hevy, which validates it against Hevy (read-only) and, only if
 * valid, stores it. The key is never echoed back — on success the field clears.
 */
export function ConnectHevy({ connected }: { connected: boolean }) {
  const router = useRouter();
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);

  async function disconnect() {
    if (
      !window.confirm(
        "Disconnect Hevy? The saved API key is removed. Your sync history and imported CSV workouts are kept.",
      )
    ) {
      return;
    }
    setError(null);
    setOkMsg(null);
    setBusy(true);
    try {
      const res = await fetch("/api/connect-hevy", { method: "DELETE" });
      const d = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; warning?: string };
      if (!res.ok || !d.ok) {
        setError(d.error ?? `Request failed (${res.status}).`);
        return;
      }
      if (d.warning) setError(d.warning);
      else setOkMsg("Hevy disconnected.");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setOkMsg(null);
    const trimmed = key.trim();
    if (!trimmed) {
      setError("Enter your Hevy API key.");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/connect-hevy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: trimmed }),
      });
      const d = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        valid?: boolean;
        workout_count?: number;
        error?: string;
      };
      if (!res.ok || !d.ok) {
        setError(d.error ?? `Request failed (${res.status}).`);
        return;
      }
      setKey("");
      setOkMsg(
        `Connected — Hevy reports ${d.workout_count ?? 0} workout${d.workout_count === 1 ? "" : "s"}.`,
      );
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <p className="text-xs text-text-muted">
        {connected
          ? "Hevy is connected. Enter a new key to replace it."
          : "Paste your Hevy API key. Find it in the Hevy app under Settings → API."}
      </p>
      <input
        type="password"
        autoComplete="off"
        value={key}
        onChange={(e) => setKey(e.target.value)}
        placeholder="Hevy API key"
        className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text focus:border-teal focus:outline-none"
      />
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={busy}
          className="rounded-lg bg-teal/20 px-4 py-2 text-sm font-medium text-teal transition-colors hover:bg-teal/30 disabled:opacity-50"
        >
          {busy ? "Working…" : "Validate & save"}
        </button>
        {connected && (
          <button
            type="button"
            onClick={disconnect}
            disabled={busy}
            data-testid="disconnect-hevy"
            className="rounded-lg border border-danger/40 px-3 py-2 text-sm text-danger transition-colors hover:bg-danger/10 disabled:opacity-50"
          >
            Disconnect Hevy
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
