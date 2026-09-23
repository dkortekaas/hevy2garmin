"use client";

import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import { useState } from "react";

type IconName =
  | "dashboard"
  | "workouts"
  | "routines"
  | "mappings"
  | "history"
  | "settings"
  | "setup"
  | "more"
  | "logout";

interface NavItem {
  href: string;
  label: string;
  icon: IconName;
  /** Shown as its own tab in the mobile bar; the rest go under "More". */
  primary: boolean;
}

const NAV_ITEMS: NavItem[] = [
  { href: "/dashboard", label: "Dashboard", icon: "dashboard", primary: true },
  { href: "/workouts", label: "Workouts", icon: "workouts", primary: true },
  { href: "/routines", label: "Routines", icon: "routines", primary: true },
  { href: "/history", label: "History", icon: "history", primary: true },
  { href: "/mappings", label: "Mappings", icon: "mappings", primary: false },
  { href: "/settings", label: "Settings", icon: "settings", primary: false },
  { href: "/setup", label: "Setup", icon: "setup", primary: false },
];

/**
 * Stroke icons drawn as plain SVG, so every phone renders them the same size.
 * The old Unicode glyphs (◉ ≡ ⚙ …) came out at different sizes per font, and
 * iOS drew ⚙ as a colour emoji.
 */
function Icon({ name }: { name: IconName }) {
  const paths: Record<IconName, React.ReactNode> = {
    dashboard: (
      <>
        <rect x="3" y="3" width="7" height="9" rx="1.5" />
        <rect x="14" y="3" width="7" height="5" rx="1.5" />
        <rect x="14" y="12" width="7" height="9" rx="1.5" />
        <rect x="3" y="16" width="7" height="5" rx="1.5" />
      </>
    ),
    workouts: (
      <>
        <path d="M6.5 7v10M17.5 7v10M3.5 9.5v5M20.5 9.5v5M6.5 12h11" />
      </>
    ),
    routines: (
      <>
        <rect x="4" y="5" width="16" height="16" rx="2" />
        <path d="M4 10h16M9 3v4M15 3v4" />
      </>
    ),
    history: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </>
    ),
    mappings: <path d="M4 8h13l-3-3M20 16H7l3 3" />,
    settings: (
      <>
        <path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h10M18 18h2" />
        <circle cx="16" cy="6" r="2" />
        <circle cx="10" cy="12" r="2" />
        <circle cx="16" cy="18" r="2" />
      </>
    ),
    setup: (
      <>
        <path d="M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4" />
      </>
    ),
    more: (
      <>
        <circle cx="5" cy="12" r="1.25" fill="currentColor" />
        <circle cx="12" cy="12" r="1.25" fill="currentColor" />
        <circle cx="19" cy="12" r="1.25" fill="currentColor" />
      </>
    ),
    logout: (
      <>
        <path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4M10 16l-4-4 4-4M6 12h10" />
      </>
    ),
  };
  return (
    <svg
      viewBox="0 0 24 24"
      width="22"
      height="22"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {paths[name]}
    </svg>
  );
}

export function NavBar({ authEnabled = false }: { authEnabled?: boolean }) {
  const pathname = usePathname();
  const router = useRouter();
  const [loggingOut, setLoggingOut] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);

  const isActive = (href: string) =>
    pathname === href || pathname.startsWith(href + "/");

  // Hide the whole bar on the login screen.
  if (pathname === "/login") return null;

  async function logout() {
    setLoggingOut(true);
    try {
      await fetch("/api/logout", { method: "POST" });
    } catch {
      // ignore — navigate to login regardless
    }
    router.push("/login");
    router.refresh();
  }

  const primary = NAV_ITEMS.filter((i) => i.primary);
  const secondary = NAV_ITEMS.filter((i) => !i.primary);
  const moreActive = secondary.some((i) => isActive(i.href));

  return (
    <>
      {/* Desktop: top bar */}
      <nav className="hidden md:flex items-center justify-between px-6 py-3 bg-surface-elevated border-b border-border sticky top-0 z-40">
        <Link href="/dashboard" className="text-lg font-bold text-text">
          hevy2garmin
        </Link>
        <div className="flex items-center gap-1">
          {NAV_ITEMS.map(({ href, label }) => (
            <Link
              key={href}
              href={href}
              className={`px-4 py-2 text-sm rounded-lg transition-colors ${
                isActive(href)
                  ? "bg-warm/20 text-warm font-medium"
                  : "text-text-secondary hover:text-text hover:bg-surface-hover"
              }`}
            >
              {label}
            </Link>
          ))}
          {authEnabled && (
            <button
              type="button"
              onClick={logout}
              disabled={loggingOut}
              className="ml-2 rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-text-secondary transition-colors hover:bg-surface-active disabled:opacity-50"
            >
              {loggingOut ? "Logging out…" : "Log out"}
            </button>
          )}
        </div>
      </nav>

      {/* Mobile: tap outside the "More" sheet to close it */}
      {moreOpen && (
        <button
          type="button"
          aria-label="Close menu"
          onClick={() => setMoreOpen(false)}
          className="md:hidden fixed inset-0 z-40 bg-black/40"
        />
      )}

      {/* Mobile: bottom tab bar, four tabs plus "More" */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 z-50 border-t border-border bg-surface-elevated pb-[env(safe-area-inset-bottom)]">
        {moreOpen && (
          <div
            id="nav-more"
            className="absolute bottom-full left-2 right-2 mb-2 overflow-hidden rounded-xl border border-border bg-surface-elevated shadow-lg"
          >
            {secondary.map(({ href, label, icon }) => (
              <Link
                key={href}
                href={href}
                onClick={() => setMoreOpen(false)}
                className={`flex items-center gap-3 px-4 py-3 text-sm ${
                  isActive(href) ? "text-teal font-medium" : "text-text-secondary"
                }`}
              >
                <Icon name={icon} />
                {label}
              </Link>
            ))}
            {authEnabled && (
              <button
                type="button"
                onClick={logout}
                disabled={loggingOut}
                className="flex w-full items-center gap-3 border-t border-border px-4 py-3 text-left text-sm text-text-secondary disabled:opacity-50"
              >
                <Icon name="logout" />
                {loggingOut ? "Logging out…" : "Log out"}
              </button>
            )}
          </div>
        )}
        <div className="grid grid-cols-5">
          {primary.map(({ href, label, icon }) => (
            <Link
              key={href}
              href={href}
              onClick={() => setMoreOpen(false)}
              className={`flex flex-col items-center gap-0.5 py-2 ${
                isActive(href) ? "text-teal" : "text-text-muted"
              }`}
            >
              <Icon name={icon} />
              <span className="text-[10px] font-medium leading-tight">{label}</span>
            </Link>
          ))}
          <button
            type="button"
            onClick={() => setMoreOpen((o) => !o)}
            aria-expanded={moreOpen}
            aria-controls="nav-more"
            className={`flex flex-col items-center gap-0.5 py-2 ${
              moreOpen || moreActive ? "text-teal" : "text-text-muted"
            }`}
          >
            <Icon name="more" />
            <span className="text-[10px] font-medium leading-tight">More</span>
          </button>
        </div>
      </nav>
    </>
  );
}
