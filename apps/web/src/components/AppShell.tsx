import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation } from "@tanstack/react-router";
import {
  Activity,
  FileText,
  Inbox,
  LogOut,
  Settings,
  ShieldOff,
} from "lucide-react";
import type { ReactNode } from "react";
import { api } from "@/api";
import { cn } from "@/lib/utils";

const NAV = [
  { to: "/inbox", label: "Inbox", icon: Inbox },
  { to: "/activity", label: "Activity", icon: Activity },
  { to: "/templates", label: "Templates", icon: FileText },
  { to: "/suppressions", label: "Suppressions", icon: ShieldOff },
  { to: "/settings", label: "Settings", icon: Settings },
] as const;

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
    onSuccess: () => qc.invalidateQueries(),
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
          <button
            type="button"
            onClick={() => logoutMut.mutate()}
            title="Sign out"
            className="inline-flex items-center gap-1 rounded p-1 hover:bg-zinc-200 dark:hover:bg-zinc-800"
          >
            <LogOut className="h-3.5 w-3.5" />
          </button>
        </div>
      </header>
      {children}
    </div>
  );
}
