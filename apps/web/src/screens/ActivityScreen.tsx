import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { format, formatDistanceToNow, subDays } from "date-fns";
import {
  AlertTriangle,
  ArrowLeft,
  Ban,
  Code2,
  Inbox,
  Mail,
  MailCheck,
  MailOpen,
  MailWarning,
  MailX,
  MousePointerClick,
  Send,
  Search,
  ShieldOff,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  api,
  type ActivityEvent,
  type ApiKey,
  type InboundMessage,
  type OutboundStats,
  type OutboundTimeseries,
} from "@/api";
import { Badge, EmptyState, Panel, Select } from "@/components/ui";
import { cn } from "@/lib/utils";

// ── Helpers ────────────────────────────────────────────────────────────────

type SubTab = "sending" | "receiving" | "metrics";

interface DateRange {
  label: string;
  days: number | null; // null = all time
}

const DATE_RANGES: DateRange[] = [
  { label: "Last 7 days", days: 7 },
  { label: "Last 15 days", days: 15 },
  { label: "Last 30 days", days: 30 },
  { label: "Last 90 days", days: 90 },
  { label: "All time", days: null },
];

const STATUS_OPTIONS = [
  { id: "", label: "All statuses" },
  { id: "delivered", label: "Delivered" },
  { id: "opened", label: "Opened" },
  { id: "clicked", label: "Clicked" },
  { id: "bounced", label: "Bounced" },
  { id: "complained", label: "Complained" },
  { id: "delivery_delayed", label: "Delivery delayed" },
  { id: "failed", label: "Failed" },
  { id: "canceled", label: "Canceled" },
  { id: "scheduled", label: "Scheduled" },
  { id: "queued", label: "Queued" },
];

const STATUS_TONE: Record<string, "success" | "danger" | "warn" | "neutral" | "info"> = {
  delivered: "success",
  sent: "success",
  opened: "info",
  clicked: "info",
  bounced: "danger",
  complained: "warn",
  delivery_delayed: "warn",
  failed: "danger",
  canceled: "neutral",
  scheduled: "info",
  queued: "info",
};

const STATUS_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  delivered: MailCheck,
  sent: MailCheck,
  opened: MailOpen,
  clicked: MousePointerClick,
  bounced: MailWarning,
  complained: ShieldOff,
  delivery_delayed: AlertTriangle,
  failed: MailX,
  canceled: Ban,
  scheduled: Mail,
  queued: Mail,
};

const STATUS_ICON_BG: Record<string, string> = {
  delivered: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  sent: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  opened: "bg-indigo-100 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300",
  clicked: "bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300",
  bounced: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300",
  complained: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  delivery_delayed: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  failed: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300",
  canceled: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
  scheduled: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
  queued: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
};

const EVENT_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  "email.sent": Send,
  "email.failed": MailX,
  "email.bounced": MailWarning,
  "email.complained": ShieldOff,
  "email.delivery_delayed": AlertTriangle,
  "email.received": MailCheck,
  "email.opened": MailOpen,
  "email.clicked": MousePointerClick,
  "email.canceled": Ban,
  "email.scheduled": Mail,
};

function rcptList(value: string[] | string | null): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  return value.join(", ");
}

function fmtAgo(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `about ${Math.floor(diff / 3_600_000)} hours ago`;
  if (diff < 7 * 86_400_000) {
    const days = Math.floor(diff / 86_400_000);
    return `${days} day${days === 1 ? "" : "s"} ago`;
  }
  return formatDistanceToNow(d, { addSuffix: true });
}

function pct(rate: number): string {
  return `${(rate * 100).toFixed(rate === 1 || rate === 0 ? 0 : 1)}%`;
}

/**
 * Trailing-debounced value — same idea as components/SearchBar.tsx, so we
 * don't fire one HTTP request per keystroke from the filter inputs.
 */
function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const handle = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(handle);
  }, [value, ms]);
  return debounced;
}

function LoadMoreRow({
  colSpan,
  hasNextPage,
  isFetchingNextPage,
  onLoadMore,
}: {
  colSpan: number;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  onLoadMore: () => void;
}) {
  if (!hasNextPage) return null;
  return (
    <tr>
      <td colSpan={colSpan} className="px-3 py-2 text-center">
        <button
          type="button"
          onClick={onLoadMore}
          disabled={isFetchingNextPage}
          className="rounded-md px-3 py-1 text-sm font-medium text-zinc-600 hover:bg-zinc-100 disabled:opacity-60 dark:text-zinc-300 dark:hover:bg-zinc-800"
        >
          {isFetchingNextPage ? "Loading…" : "Load more"}
        </button>
      </td>
    </tr>
  );
}

// ── Main screen ────────────────────────────────────────────────────────────

const VALID_TABS: SubTab[] = ["sending", "receiving", "metrics"];

export function ActivityScreen() {
  const params = useParams({ from: "/activity/$tab" });
  const tab = (VALID_TABS as string[]).includes(params.tab)
    ? (params.tab as SubTab)
    : "sending";

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-6xl px-6 py-6">
        <h1 className="mb-3 text-lg font-medium">Emails</h1>
        <div className="mb-6 flex border-b border-zinc-200 dark:border-zinc-800">
          {(
            [
              { id: "sending", label: "Sending" },
              { id: "receiving", label: "Receiving" },
              { id: "metrics", label: "Metrics" },
            ] as { id: SubTab; label: string }[]
          ).map((t) => (
            <Link
              key={t.id}
              to="/activity/$tab"
              params={{ tab: t.id }}
              className={cn(
                "border-b-2 px-4 py-2 text-sm font-medium transition-colors",
                tab === t.id
                  ? "border-blue-600 text-blue-700 dark:border-blue-500 dark:text-blue-300"
                  : "border-transparent text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200",
              )}
            >
              {t.label}
            </Link>
          ))}
        </div>
        {tab === "sending" && <SendingPane />}
        {tab === "receiving" && <ReceivingPane />}
        {tab === "metrics" && <MetricsPane />}
      </div>
    </div>
  );
}

// ── Filter helpers ─────────────────────────────────────────────────────────

function rangeToParams(range: DateRange) {
  if (range.days == null) return {};
  return {
    created_after: subDays(new Date(), range.days).toISOString(),
  };
}

// ── Sending pane ───────────────────────────────────────────────────────────

function SendingPane() {
  const [rangeIdx, setRangeIdx] = useState(1); // default Last 15 days
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [apiKey, setApiKey] = useState<string>("");
  const [q, setQ] = useState("");
  // Selected outbound lives in the URL as ?email=o_…, so refresh + back/
  // forward preserve the drawer state.
  const search = useSearch({ from: "/activity/$tab" });
  const navigate = useNavigate();
  const selected = search.email ?? null;
  const setSelected = (id: string | null) => {
    navigate({
      to: "/activity/$tab",
      params: { tab: "sending" },
      search: id ? { email: id } : {},
      replace: false,
    });
  };

  const range = DATE_RANGES[rangeIdx]!;
  const dq = useDebounced(q, 300);
  const params = {
    ...rangeToParams(range),
    api_key: apiKey || undefined,
    display: statusFilter || undefined,
    q: dq || undefined,
  };

  const stats = useQuery({
    queryKey: ["outbound-stats", rangeIdx, apiKey],
    queryFn: () => api.outboundStats({
      ...rangeToParams(range),
      api_key: apiKey || undefined,
    }),
  });

  const list = useInfiniteQuery({
    queryKey: ["outbound-list", rangeIdx, statusFilter, apiKey, dq],
    queryFn: ({ pageParam }) => api.listOutbound({ ...params, cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => (last.has_more ? last.next_cursor : null),
  });
  const rows = list.data?.pages.flatMap((p) => p.data) ?? [];

  const apiKeys = useQuery({ queryKey: ["api-keys"], queryFn: api.listApiKeys });

  return (
    <div>
      {stats.data && <StatsRow stats={stats.data} />}
      {stats.error != null && (
        <p className="mb-4 text-sm text-red-600 dark:text-red-400">
          Failed to load stats: {String(stats.error)}
        </p>
      )}

      <FilterBar
        q={q}
        onQ={setQ}
        rangeIdx={rangeIdx}
        onRangeIdx={setRangeIdx}
        status={statusFilter}
        onStatus={setStatusFilter}
        apiKey={apiKey}
        onApiKey={setApiKey}
        apiKeys={apiKeys.data ?? []}
      />

      <div className="mt-4 overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-800">
        <table className="w-full text-sm">
          <thead className="bg-zinc-50 text-xs uppercase text-zinc-500 dark:bg-zinc-900/50">
            <tr>
              <th className="w-12 px-3 py-2"></th>
              <th className="px-3 py-2 text-left font-medium">To</th>
              <th className="w-28 px-3 py-2 text-left font-medium">Status</th>
              <th className="px-3 py-2 text-left font-medium">Subject</th>
              <th className="w-40 px-3 py-2 text-right font-medium">Sent</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {list.isLoading && (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-center text-zinc-500">
                  Loading…
                </td>
              </tr>
            )}
            {list.error != null && (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-center text-red-600 dark:text-red-400">
                  Failed to load emails: {String(list.error)}
                </td>
              </tr>
            )}
            {list.data && rows.length === 0 && (
              <tr>
                <td colSpan={5}>
                  <EmptyState icon={Send}>No emails match these filters.</EmptyState>
                </td>
              </tr>
            )}
            {rows.map((m) => (
              <tr
                key={m.id}
                onClick={() => setSelected(m.id)}
                className="cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-900"
              >
                <td className="px-3 py-2.5">
                  <StatusIcon status={m.display_status} />
                </td>
                <td className="truncate px-3 py-2.5 font-mono text-xs">
                  {rcptList(m.to)}
                </td>
                <td className="px-3 py-2.5">
                  <Badge tone={STATUS_TONE[m.display_status] ?? "neutral"}>
                    {labelForStatus(m.display_status)}
                  </Badge>
                </td>
                <td className="truncate px-3 py-2.5">
                  {m.subject || <em className="italic text-zinc-400">(no subject)</em>}
                </td>
                <td className="px-3 py-2.5 text-right text-xs text-zinc-500">
                  {fmtAgo(m.created_at)}
                </td>
              </tr>
            ))}
            <LoadMoreRow
              colSpan={5}
              hasNextPage={list.hasNextPage}
              isFetchingNextPage={list.isFetchingNextPage}
              onLoadMore={() => list.fetchNextPage()}
            />
          </tbody>
        </table>
      </div>

      {selected && (
        <DetailDrawer id={selected} onClose={() => setSelected(null)} />
      )}
    </div>
  );
}

function labelForStatus(s: string): string {
  // delivery_delayed → "Delivery delayed"
  return s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, " ");
}

function StatusIcon({ status }: { status: string }) {
  const Icon = STATUS_ICON[status] ?? Mail;
  const bg = STATUS_ICON_BG[status] ?? "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400";
  return (
    <div className={cn("flex h-7 w-7 items-center justify-center rounded-md", bg)}>
      <Icon className="h-3.5 w-3.5" />
    </div>
  );
}

function StatsRow({ stats }: { stats: OutboundStats }) {
  return (
    <div className="mb-4 grid grid-cols-4 gap-3">
      <StatCard label="Emails" value={String(stats.total)} />
      <StatCard
        label="Deliverability"
        value={pct(stats.deliverability_rate)}
        tone={stats.deliverability_rate >= 0.95 ? "success" : "warn"}
      />
      <StatCard
        label="Bounce rate"
        value={pct(stats.bounce_rate)}
        tone={stats.bounce_rate > 0.05 ? "danger" : "neutral"}
      />
      <StatCard
        label="Complain rate"
        value={pct(stats.complain_rate)}
        tone={stats.complain_rate > 0.001 ? "danger" : "neutral"}
      />
    </div>
  );
}

function StatCard({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: string;
  tone?: "neutral" | "success" | "warn" | "danger";
}) {
  const accent: Record<typeof tone & string, string> = {
    neutral: "text-zinc-900 dark:text-zinc-100",
    success: "text-emerald-700 dark:text-emerald-300",
    warn: "text-amber-700 dark:text-amber-300",
    danger: "text-red-700 dark:text-red-300",
  };
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="text-[10px] font-medium uppercase tracking-wide text-zinc-500">
        {label}
      </div>
      <div className={cn("mt-1 text-2xl font-semibold tabular-nums", accent[tone])}>
        {value}
      </div>
    </div>
  );
}

function FilterBar({
  q,
  onQ,
  rangeIdx,
  onRangeIdx,
  status,
  onStatus,
  apiKey,
  onApiKey,
  apiKeys,
}: {
  q: string;
  onQ: (v: string) => void;
  rangeIdx: number;
  onRangeIdx: (i: number) => void;
  status: string;
  onStatus: (v: string) => void;
  apiKey: string;
  onApiKey: (v: string) => void;
  apiKeys: ApiKey[];
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative min-w-[200px] flex-1">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
        <input
          value={q}
          onChange={(e) => onQ(e.target.value)}
          placeholder="Search subject, from, to…"
          className="w-full rounded-md border border-zinc-200 bg-white px-8 py-1.5 text-sm placeholder:text-zinc-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-zinc-700 dark:bg-zinc-900 dark:placeholder:text-zinc-500"
        />
      </div>
      <Select
        value={String(rangeIdx)}
        onChange={(e) => onRangeIdx(parseInt(e.target.value, 10))}
      >
        {DATE_RANGES.map((r, i) => (
          <option key={r.label} value={String(i)}>
            {r.label}
          </option>
        ))}
      </Select>
      <Select value={status} onChange={(e) => onStatus(e.target.value)}>
        {STATUS_OPTIONS.map((o) => (
          <option key={o.id || "all"} value={o.id}>
            {o.label}
          </option>
        ))}
      </Select>
      <Select value={apiKey} onChange={(e) => onApiKey(e.target.value)}>
        <option value="">All API keys</option>
        {apiKeys.map((k) => (
          <option key={k.id} value={k.id}>
            {k.name ?? k.prefix}
          </option>
        ))}
      </Select>
    </div>
  );
}

// ── Receiving pane ─────────────────────────────────────────────────────────

function ReceivingPane() {
  const [rangeIdx, setRangeIdx] = useState(1);
  const [q, setQ] = useState("");
  const range = DATE_RANGES[rangeIdx]!;
  const dq = useDebounced(q, 300);

  const list = useInfiniteQuery({
    queryKey: ["inbound-list", rangeIdx, dq],
    queryFn: ({ pageParam }) =>
      api.listInbound({
        ...rangeToParams(range),
        q: dq || undefined,
        cursor: pageParam,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => (last.has_more ? last.next_cursor : null),
  });
  const rows = list.data?.pages.flatMap((p) => p.data) ?? [];

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[200px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search subject, from…"
            className="w-full rounded-md border border-zinc-200 bg-white px-8 py-1.5 text-sm placeholder:text-zinc-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-zinc-700 dark:bg-zinc-900 dark:placeholder:text-zinc-500"
          />
        </div>
        <Select
          value={String(rangeIdx)}
          onChange={(e) => setRangeIdx(parseInt(e.target.value, 10))}
        >
          {DATE_RANGES.map((r, i) => (
            <option key={r.label} value={String(i)}>
              {r.label}
            </option>
          ))}
        </Select>
      </div>

      <div className="mt-4 overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-800">
        <table className="w-full text-sm">
          <thead className="bg-zinc-50 text-xs uppercase text-zinc-500 dark:bg-zinc-900/50">
            <tr>
              <th className="w-12 px-3 py-2"></th>
              <th className="px-3 py-2 text-left font-medium">From</th>
              <th className="px-3 py-2 text-left font-medium">Subject</th>
              <th className="w-40 px-3 py-2 text-right font-medium">Received</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {list.isLoading && (
              <tr>
                <td colSpan={4} className="px-3 py-6 text-center text-zinc-500">
                  Loading…
                </td>
              </tr>
            )}
            {list.error != null && (
              <tr>
                <td colSpan={4} className="px-3 py-6 text-center text-red-600 dark:text-red-400">
                  Failed to load inbound mail: {String(list.error)}
                </td>
              </tr>
            )}
            {list.data && rows.length === 0 && (
              <tr>
                <td colSpan={4}>
                  <EmptyState icon={Inbox}>No inbound mail in this window.</EmptyState>
                </td>
              </tr>
            )}
            {rows.map((m: InboundMessage) => (
              <tr key={m.id} className="hover:bg-zinc-50 dark:hover:bg-zinc-900">
                <td className="px-3 py-2.5">
                  <div className="flex h-7 w-7 items-center justify-center rounded-md bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
                    <Inbox className="h-3.5 w-3.5" />
                  </div>
                </td>
                <td className="truncate px-3 py-2.5 font-mono text-xs">
                  {m.from?.address ?? "—"}
                </td>
                <td className="truncate px-3 py-2.5">
                  {m.subject || <em className="italic text-zinc-400">(no subject)</em>}
                </td>
                <td className="px-3 py-2.5 text-right text-xs text-zinc-500">
                  {fmtAgo(m.received_at)}
                </td>
              </tr>
            ))}
            <LoadMoreRow
              colSpan={4}
              hasNextPage={list.hasNextPage}
              isFetchingNextPage={list.isFetchingNextPage}
              onLoadMore={() => list.fetchNextPage()}
            />
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Metrics pane ───────────────────────────────────────────────────────────

function MetricsPane() {
  const [rangeIdx, setRangeIdx] = useState(1);
  const [apiKey, setApiKey] = useState<string>("");
  const range = DATE_RANGES[rangeIdx]!;

  const apiKeys = useQuery({ queryKey: ["api-keys"], queryFn: api.listApiKeys });
  const stats = useQuery({
    queryKey: ["outbound-stats", rangeIdx, apiKey],
    queryFn: () => api.outboundStats({
      ...rangeToParams(range),
      api_key: apiKey || undefined,
    }),
  });
  const series = useQuery({
    queryKey: ["outbound-timeseries", rangeIdx, apiKey],
    queryFn: () => api.outboundTimeseries({
      ...rangeToParams(range),
      api_key: apiKey || undefined,
    }),
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Select
          value={String(rangeIdx)}
          onChange={(e) => setRangeIdx(parseInt(e.target.value, 10))}
        >
          {DATE_RANGES.map((r, i) => (
            <option key={r.label} value={String(i)}>
              {r.label}
            </option>
          ))}
        </Select>
        <Select value={apiKey} onChange={(e) => setApiKey(e.target.value)}>
          <option value="">All API keys</option>
          {apiKeys.data?.map((k) => (
            <option key={k.id} value={k.id}>
              {k.name ?? k.prefix}
            </option>
          ))}
        </Select>
      </div>

      {(stats.error != null || series.error != null) && (
        <p className="text-sm text-red-600 dark:text-red-400">
          Failed to load metrics: {String(stats.error ?? series.error)}
        </p>
      )}

      {stats.data && (
        <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
          <div className="mb-4 grid grid-cols-2 gap-6">
            <div>
              <div className="text-[10px] font-medium uppercase tracking-wide text-zinc-500">
                Emails
              </div>
              <div className="mt-1 text-3xl font-semibold tabular-nums">
                {stats.data.total}
              </div>
            </div>
            <div>
              <div className="text-[10px] font-medium uppercase tracking-wide text-zinc-500">
                Deliverability rate
              </div>
              <div className="mt-1 text-3xl font-semibold tabular-nums text-emerald-700 dark:text-emerald-300">
                {pct(stats.data.deliverability_rate)}
              </div>
            </div>
          </div>
          {series.data && <LineChart data={series.data} />}
        </div>
      )}

      {stats.data && (
        <div className="grid grid-cols-2 gap-3">
          <StatCard
            label="Bounce rate"
            value={pct(stats.data.bounce_rate)}
            tone={stats.data.bounce_rate > 0.05 ? "danger" : "neutral"}
          />
          <StatCard
            label="Complain rate"
            value={pct(stats.data.complain_rate)}
            tone={stats.data.complain_rate > 0.001 ? "danger" : "neutral"}
          />
          <StatCard label="Open rate" value={pct(stats.data.open_rate)} />
          <StatCard label="Click rate" value={pct(stats.data.click_rate)} />
        </div>
      )}
    </div>
  );
}

// ── Hand-rolled SVG line chart ─────────────────────────────────────────────
//
// Two series: delivered (green) + opened (violet). One area each. Y-axis is
// the larger of the two daily maxes. X-axis is the days in the window with a
// label every ~5 days.

function LineChart({ data }: { data: OutboundTimeseries }) {
  const W = 800;
  const H = 280;
  const PAD = { top: 16, right: 32, bottom: 28, left: 24 };
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const points = data.series;
  const n = points.length;

  const maxY = useMemo(() => {
    let m = 1;
    for (const p of points) {
      m = Math.max(m, p.delivered, p.opened);
    }
    // round up to next nice number
    if (m <= 5) return 5;
    if (m <= 10) return 10;
    return Math.ceil(m / 5) * 5;
  }, [points]);

  function xAt(i: number) {
    return PAD.left + (n <= 1 ? innerW / 2 : (i / (n - 1)) * innerW);
  }
  function yAt(v: number) {
    return PAD.top + innerH - (v / maxY) * innerH;
  }

  function linePath(values: number[]): string {
    return values
      .map((v, i) => `${i === 0 ? "M" : "L"}${xAt(i).toFixed(1)},${yAt(v).toFixed(1)}`)
      .join(" ");
  }
  function areaPath(values: number[]): string {
    const top = linePath(values);
    return `${top} L${xAt(n - 1).toFixed(1)},${(PAD.top + innerH).toFixed(1)} L${xAt(0).toFixed(1)},${(PAD.top + innerH).toFixed(1)} Z`;
  }

  const delivered = points.map((p) => p.delivered);
  const opened = points.map((p) => p.opened);

  // Y gridlines at quartiles.
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((t) => Math.round(maxY * t));
  // X labels: first, last, and ~3 evenly-spaced in between.
  const xLabelIndices = n <= 6
    ? points.map((_, i) => i)
    : [0, Math.floor(n / 4), Math.floor(n / 2), Math.floor((3 * n) / 4), n - 1];

  return (
    <div className="w-full overflow-x-auto">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="block min-w-[600px] text-zinc-400"
        preserveAspectRatio="none"
      >
        {/* Gridlines + Y labels */}
        {yTicks.map((v) => (
          <g key={v}>
            <line
              x1={PAD.left}
              x2={W - PAD.right}
              y1={yAt(v)}
              y2={yAt(v)}
              stroke="currentColor"
              strokeWidth={0.5}
              strokeDasharray="2,3"
              opacity={0.4}
            />
            <text
              x={W - PAD.right + 4}
              y={yAt(v) + 3}
              fontSize={9}
              fill="currentColor"
              opacity={0.6}
            >
              {v}
            </text>
          </g>
        ))}

        {/* Area under each series */}
        <path d={areaPath(delivered)} fill="rgb(16 185 129 / 0.18)" />
        <path d={areaPath(opened)} fill="rgb(139 92 246 / 0.18)" />

        {/* Line strokes */}
        <path
          d={linePath(delivered)}
          stroke="rgb(16 185 129)"
          strokeWidth={1.5}
          fill="none"
        />
        <path
          d={linePath(opened)}
          stroke="rgb(139 92 246)"
          strokeWidth={1.5}
          fill="none"
        />

        {/* X labels */}
        {xLabelIndices.map((i) => {
          const day = points[i]?.day;
          if (!day) return null;
          const date = new Date(day);
          return (
            <text
              key={i}
              x={xAt(i)}
              y={H - 8}
              fontSize={9}
              fill="currentColor"
              textAnchor="middle"
              opacity={0.7}
            >
              {format(date, "MMM d")}
            </text>
          );
        })}
      </svg>
      <div className="mt-2 flex items-center justify-end gap-4 text-xs text-zinc-500">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-emerald-500" />
          Delivered
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-violet-500" />
          Opened
        </span>
      </div>
    </div>
  );
}

// ── Detail drawer (slide-over from the right) ──────────────────────────────

function DetailDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const detail = useQuery({
    queryKey: ["outbound", id],
    queryFn: () => api.getOutbound(id),
  });
  const events = useQuery({
    queryKey: ["outbound", id, "events"],
    queryFn: () => api.getOutboundEvents(id),
  });
  const m = detail.data;

  return (
    <div className="fixed inset-0 z-40 flex">
      <div
        className="flex-1 bg-black/30 backdrop-blur-sm"
        onClick={onClose}
        aria-label="close"
      />
      <div className="w-full max-w-xl overflow-y-auto bg-white shadow-xl dark:bg-zinc-950">
        <div className="border-b border-zinc-200 p-4 dark:border-zinc-800">
          <button
            type="button"
            onClick={onClose}
            className="mb-3 inline-flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
          >
            <ArrowLeft className="h-3 w-3" />
            Close
          </button>
          {detail.isLoading && <p className="text-sm text-zinc-500">Loading…</p>}
          {m && (
            <>
              <div className="flex items-center justify-between gap-3">
                <h2 className="truncate text-base font-medium">
                  {m.subject || <em className="italic text-zinc-400">(no subject)</em>}
                </h2>
                <Badge tone={STATUS_TONE[m.display_status] ?? "neutral"}>
                  {labelForStatus(m.display_status)}
                </Badge>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1.5 text-xs">
                <Field label="ID" value={m.id} mono />
                <Field label="From" value={m.from ?? "—"} />
                <Field label="To" value={rcptList(m.to) || "—"} />
                {m.cc && <Field label="Cc" value={rcptList(m.cc)} />}
                <Field label="Created" value={fmtAgo(m.created_at)} />
                <Field label="Sent" value={m.sent_at ? fmtAgo(m.sent_at) : "—"} />
                {m.bounce_type && (
                  <Field
                    label="Bounce"
                    value={`${m.bounce_type}${m.bounce_diag ? ` — ${m.bounce_diag}` : ""}`}
                  />
                )}
                {m.last_error && <Field label="Error" value={m.last_error} />}
                {m.template_id && <Field label="Template" value={m.template_id} mono />}
              </div>

              {m.tracking.enabled && (
                <div className="mt-3 flex gap-4 rounded-md bg-zinc-50 p-3 text-xs dark:bg-zinc-900/50">
                  <span className="inline-flex items-center gap-1">
                    <MailOpen className="h-3 w-3" />
                    {m.tracking.open_count} opens
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <MousePointerClick className="h-3 w-3" />
                    {m.tracking.click_count} clicks
                  </span>
                </div>
              )}
            </>
          )}
        </div>
        <div className="p-4">
          <Panel title="Timeline">
            {events.isLoading && <p className="text-sm text-zinc-500">Loading…</p>}
            {events.data?.data.length === 0 && (
              <p className="text-sm text-zinc-500">No events yet.</p>
            )}
            <ul className="space-y-2">
              {events.data?.data.map((e) => <EventRow key={e.id} ev={e} />)}
            </ul>
          </Panel>
        </div>
      </div>
    </div>
  );
}

function EventRow({ ev }: { ev: ActivityEvent }) {
  const Icon = EVENT_ICON[ev.type] ?? Code2;
  return (
    <li className="flex items-start gap-2.5 rounded-md border border-zinc-100 p-2.5 dark:border-zinc-800">
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-zinc-500" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <code className="font-mono text-xs">{ev.type}</code>
          <span className="text-[10px] text-zinc-400">{fmtAgo(ev.created_at)}</span>
        </div>
        {Object.keys(ev.data).length > 0 && (
          <pre className="mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap break-words font-mono text-[10px] text-zinc-500">
            {JSON.stringify(ev.data, null, 2)}
          </pre>
        )}
      </div>
    </li>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <div className="text-zinc-500">{label}</div>
      <div className={cn("truncate", mono && "font-mono text-[10px]")}>{value}</div>
    </div>
  );
}
