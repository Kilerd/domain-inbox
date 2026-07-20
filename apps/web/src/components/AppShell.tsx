import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation } from "@tanstack/react-router";
import {
  Activity,
  FileText,
  Inbox,
  LogOut,
  Monitor,
  Moon,
  Settings,
  ShieldOff,
  Sun,
} from "lucide-react";
import type { ReactNode } from "react";
import { api } from "@/api";
import { FOCUS_RING } from "@/components/ui";
import { useTheme, type Theme } from "@/lib/theme";
import { cn } from "@/lib/utils";

const NAV = [
  { to: "/inbox", label: "Inbox", icon: Inbox },
  { to: "/activity", label: "Activity", icon: Activity },
  { to: "/templates", label: "Templates", icon: FileText },
  { to: "/suppressions", label: "Suppressions", icon: ShieldOff },
  { to: "/settings", label: "Settings", icon: Settings },
] as const;

const THEME_ORDER: Theme[] = ["light", "dark", "system"];
const THEME_META: Record<Theme, { icon: typeof Sun; label: string }> = {
  light: { icon: Sun, label: "Light" },
  dark: { icon: Moon, label: "Dark" },
  system: { icon: Monitor, label: "System" },
};

/** Cycles light → dark → system; tooltip names the current mode. */
function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const { icon: Icon, label } = THEME_META[theme];
  const next =
    THEME_ORDER[(THEME_ORDER.indexOf(theme) + 1) % THEME_ORDER.length]!;
  return (
    <button
      type="button"
      onClick={() => setTheme(next)}
      title={`Theme: ${label} — click for ${THEME_META[next].label.toLowerCase()}`}
      className={cn(
        "inline-flex items-center gap-1 rounded p-1 hover:bg-zinc-200 dark:hover:bg-zinc-800",
        FOCUS_RING,
      )}
    >
      <Icon className="h-3.5 w-3.5" />
    </button>
  );
}

/**
 * Top-level chrome shared by every authed route: header with nav buttons,
 * the matched route's content below.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const me = useQuery({ queryKey: ["me"], queryFn: api.me });
  const qc = useQueryClient();
  const location = useLocation();
  const path = location.pathname;

  const logoutMut = useMutation({
    mutationFn: () => api.logout(),
    onSuccess: () => {
      // Locally-saved drafts belong to the signed-in session; drop them so
      // the next user on this browser can't read them.
      try {
        for (const key of Object.keys(localStorage)) {
          if (key.startsWith("compose:draft:")) localStorage.removeItem(key);
        }
      } catch {
        /* localStorage unavailable — nothing to clear */
      }
      qc.invalidateQueries();
    },
  });

  return (
    <div className="flex h-screen flex-col bg-zinc-50 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      <header className="flex shrink-0 items-center gap-1 border-b border-zinc-200 px-4 py-2 dark:border-zinc-800">
        {NAV.map((n) => {
          const Icon = n.icon;
          const active = path === n.to || path.startsWith(n.to + "/");
          return (
            <Link
              key={n.to}
              to={n.to}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm font-medium transition-colors",
                FOCUS_RING,
                active
                  ? "bg-zinc-200 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100"
                  : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-900",
              )}
            >
              <Icon className="h-4 w-4" />
              {n.label}
            </Link>
          );
        })}
        <div className="ml-auto flex items-center gap-2 text-xs text-zinc-500">
          <span>{me.data?.email}</span>
          <ThemeToggle />
          <button
            type="button"
            onClick={() => logoutMut.mutate()}
            title="Sign out"
            className={cn(
              "inline-flex items-center gap-1 rounded p-1 hover:bg-zinc-200 dark:hover:bg-zinc-800",
              FOCUS_RING,
            )}
          >
            <LogOut className="h-3.5 w-3.5" />
          </button>
        </div>
      </header>
      {children}
    </div>
  );
}
