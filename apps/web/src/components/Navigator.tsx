import { useQuery } from "@tanstack/react-query";
import {
  Archive,
  Check,
  ChevronsUpDown,
  Globe,
  Inbox,
  Mail,
  MailCheck,
  Send,
  ShieldAlert,
  Star,
  Trash2,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, type InboxAlias, type InboxView } from "@/api";
import { useInboxView } from "@/lib/inbox-view";
import { cn } from "@/lib/utils";

interface SystemViewDef {
  view: InboxView;
  label: string;
  icon: React.ReactNode;
}

const SYSTEM_VIEWS: SystemViewDef[] = [
  { view: "inbox", label: "Inbox", icon: <Inbox className="h-4 w-4" /> },
  { view: "unread", label: "Unread", icon: <Mail className="h-4 w-4" /> },
  { view: "starred", label: "Starred", icon: <Star className="h-4 w-4" /> },
  { view: "sent", label: "Sent", icon: <Send className="h-4 w-4" /> },
  { view: "archived", label: "Archived", icon: <Archive className="h-4 w-4" /> },
  { view: "spam", label: "Spam", icon: <ShieldAlert className="h-4 w-4" /> },
  { view: "trash", label: "Trash", icon: <Trash2 className="h-4 w-4" /> },
];

export function Navigator() {
  const { state, setView, selectAlias } = useInboxView();
  const domains = useQuery({ queryKey: ["inbox", "domains"], queryFn: api.listInboxDomains });
  const aliases = useQuery({
    queryKey: ["inbox", "aliases", state.domainId ?? "(none)"],
    queryFn: () => api.listInboxAliases(state.domainId),
    enabled: !!state.domainId,
    staleTime: 30_000,
  });

  return (
    <nav className="flex h-full flex-col overflow-y-auto py-3 text-sm">
      <div className="px-2">
        <DomainSwitcher />
      </div>

      <section className="mt-3 px-1">
        <SectionLabel>Mail</SectionLabel>
        {SYSTEM_VIEWS.map((s) => {
          const isActive = state.view === s.view && !state.aliasId;
          // Show inbox unread badge — aggregate from domains list, scoped to current selection.
          let badge: number | null = null;
          if (s.view === "inbox") {
            const ds = domains.data?.data ?? [];
            const scoped = state.domainId ? ds.filter((d) => d.id === state.domainId) : ds;
            const sum = scoped.reduce((n, d) => n + d.unread_count, 0);
            badge = sum > 0 ? sum : null;
          }
          return (
            <button
              key={s.view}
              type="button"
              onClick={() => setView(s.view)}
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left",
                isActive
                  ? "bg-zinc-200 font-medium text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100"
                  : "text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-900",
              )}
            >
              <span className="text-zinc-500 dark:text-zinc-400">{s.icon}</span>
              <span className="flex-1 truncate">{s.label}</span>
              {badge && (
                <span className="rounded bg-blue-600 px-1.5 text-[10px] font-semibold leading-5 text-white">
                  {badge}
                </span>
              )}
            </button>
          );
        })}
      </section>

      {state.domainId && (
        <section className="mt-4 px-1">
          <SectionLabel>Aliases</SectionLabel>
          {aliases.isLoading && (
            <div className="px-2 py-1 text-xs text-zinc-500">loading…</div>
          )}
          {aliases.data?.data.length === 0 && (
            <div className="px-2 py-1 text-xs italic text-zinc-500">
              No aliases yet.
            </div>
          )}
          {aliases.data?.data.map((a) => (
            <AliasRow
              key={a.id}
              alias={a}
              active={state.aliasId === a.id}
              onSelect={() => selectAlias(a.id)}
            />
          ))}
        </section>
      )}
    </nav>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-1 px-2 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
      {children}
    </div>
  );
}

function DomainSwitcher() {
  const { state, selectDomain } = useInboxView();
  const domains = useQuery({ queryKey: ["inbox", "domains"], queryFn: api.listInboxDomains });
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handle(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [open]);

  const currentDomain = state.domainId
    ? domains.data?.data.find((d) => d.id === state.domainId)
    : null;
  const label = currentDomain ? currentDomain.domain : "All domains";
  const isAll = !state.domainId;
  const totalUnread = (domains.data?.data ?? []).reduce(
    (sum, d) => sum + d.unread_count,
    0,
  );
  const currentUnread = isAll ? totalUnread : currentDomain?.unread_count ?? 0;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex w-full items-center gap-2 rounded-md border border-zinc-200 bg-white px-2.5 py-2 text-left transition-colors",
          "hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:bg-zinc-800",
        )}
      >
        {isAll ? (
          <Inbox className="h-4 w-4 text-zinc-500" />
        ) : (
          <Globe className="h-4 w-4 text-zinc-500" />
        )}
        <span className={cn("min-w-0 flex-1 truncate font-medium", !isAll && "font-mono text-[12px]")}>
          {label}
        </span>
        {currentUnread > 0 && (
          <span className="rounded bg-blue-600 px-1.5 text-[10px] font-semibold leading-5 text-white">
            {currentUnread}
          </span>
        )}
        <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
      </button>

      {open && (
        <div
          className={cn(
            "absolute left-0 right-0 top-full z-30 mt-1 overflow-hidden rounded-md border border-zinc-200 bg-white shadow-lg dark:border-zinc-800 dark:bg-zinc-900",
          )}
        >
          <DomainOption
            label="All domains"
            icon={<Inbox className="h-4 w-4 text-zinc-500" />}
            badge={totalUnread || null}
            active={isAll}
            onClick={() => {
              selectDomain(null);
              setOpen(false);
            }}
          />
          <div className="border-t border-zinc-100 dark:border-zinc-800" />
          {domains.data?.data.map((d) => (
            <DomainOption
              key={d.id}
              label={d.domain}
              icon={<Globe className="h-4 w-4 text-zinc-500" />}
              monospace
              badge={d.unread_count || null}
              active={state.domainId === d.id}
              onClick={() => {
                selectDomain(d.id);
                setOpen(false);
              }}
            />
          ))}
          {domains.data && domains.data.data.length === 0 && (
            <div className="px-3 py-2 text-xs text-zinc-500">No domains.</div>
          )}
        </div>
      )}
    </div>
  );
}

function DomainOption({
  label,
  icon,
  badge,
  active,
  monospace,
  onClick,
}: {
  label: string;
  icon: React.ReactNode;
  badge: number | null;
  active: boolean;
  monospace?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 px-3 py-2 text-left text-sm",
        active
          ? "bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100"
          : "hover:bg-zinc-50 dark:hover:bg-zinc-800",
      )}
    >
      {icon}
      <span className={cn("flex-1 truncate", monospace && "font-mono text-[12px]")}>{label}</span>
      {badge && badge > 0 && (
        <span className="rounded bg-blue-600 px-1.5 text-[10px] font-semibold leading-5 text-white">
          {badge}
        </span>
      )}
      {active && <Check className="h-3.5 w-3.5 text-blue-600" />}
    </button>
  );
}

function AliasRow({
  alias,
  active,
  onSelect,
}: {
  alias: InboxAlias;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs",
        active
          ? "bg-zinc-200 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100"
          : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-900",
      )}
      title={alias.address}
    >
      <MailCheck className="h-3 w-3 shrink-0 text-zinc-500" />
      <span className="flex-1 truncate font-mono">
        {alias.label || alias.local_part}
      </span>
      {alias.unread_count > 0 && (
        <span className="rounded bg-blue-600 px-1 text-[9px] font-semibold leading-4 text-white">
          {alias.unread_count}
        </span>
      )}
    </button>
  );
}
