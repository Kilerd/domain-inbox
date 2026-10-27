import { useQuery } from "@tanstack/react-query";
import { BarChart3, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { api, type DmarcSummary, type TlsSummary } from "@/api";
import { Badge, EmptyState, ErrorText, Panel, Select } from "@/components/ui";
import { cn } from "@/lib/utils";

type Tab = "dmarc" | "tls";
const DAY_OPTIONS = [30, 90, 365];

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString();
}

function pct(part: number, total: number): string {
  return total > 0 ? `${Math.round((part / total) * 100)}%` : "—";
}

export function ReportsScreen() {
  const [tab, setTab] = useState<Tab>("dmarc");
  const [days, setDays] = useState(30);
  const domains = useQuery({ queryKey: ["domains"], queryFn: api.listDomains });

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-6xl px-4 py-4 sm:px-6 sm:py-6">
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <h1 className="text-lg font-medium">Deliverability</h1>
          <div className="flex overflow-x-auto border-b border-zinc-200 dark:border-zinc-800">
            {(
              [
                { id: "dmarc", label: "DMARC" },
                { id: "tls", label: "TLS-RPT" },
              ] as const
            ).map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                className={cn(
                  "shrink-0 whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition-colors sm:px-4",
                  tab === t.id
                    ? "border-blue-600 text-blue-700 dark:border-blue-500 dark:text-blue-300"
                    : "border-transparent text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200",
                )}
              >
                {t.label}
              </button>
            ))}
          </div>
          <Select
            className="ml-auto"
            value={String(days)}
            onChange={(e) => setDays(parseInt(e.target.value, 10))}
          >
            {DAY_OPTIONS.map((d) => (
              <option key={d} value={d}>
                Last {d} days
              </option>
            ))}
          </Select>
        </div>

        {tab === "dmarc" ? (
          <DmarcPanel days={days} domainHint={domains.data?.[0]?.name} />
        ) : (
          <TlsPanel days={days} domainHint={domains.data?.[0]?.name} />
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="text-xs text-zinc-500">{label}</div>
      <div className="mt-1 text-xl font-semibold tabular-nums">{value}</div>
      {hint && <div className="mt-0.5 text-[11px] text-zinc-500">{hint}</div>}
    </div>
  );
}

function DmarcPanel({ days, domainHint }: { days: number; domainHint?: string }) {
  const q = useQuery({
    queryKey: ["reports", "dmarc", days],
    queryFn: () => api.getDmarcSummary({ days }),
  });
  if (q.isLoading) return <p className="text-sm text-zinc-500">Loading…</p>;
  if (q.error) return <ErrorText>{String(q.error)}</ErrorText>;
  const data = q.data as DmarcSummary;

  const totals = (data.data ?? []).reduce(
    (acc, d) => ({
      reports: acc.reports + d.reports,
      messages: acc.messages + d.messages,
      passed: acc.passed + d.passed,
      failed: acc.failed + d.failed,
      quarantined: acc.quarantined + d.quarantined,
      rejected: acc.rejected + d.rejected,
    }),
    { reports: 0, messages: 0, passed: 0, failed: 0, quarantined: 0, rejected: 0 },
  );

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Reports" value={String(totals.reports)} />
        <Stat label="Messages" value={String(totals.messages)} />
        <Stat label="DMARC pass" value={pct(totals.passed, totals.messages)} />
        <Stat
          label="Failed"
          value={String(totals.failed)}
          hint={`${totals.quarantined} quarantined · ${totals.rejected} rejected`}
        />
      </div>

      {(data.data ?? []).length === 0 ? (
        <Panel title="No DMARC reports yet">
          <EmptyState icon={ShieldCheck} className="py-6">
            Add an aggregate address to your DMARC record and reports will be
            parsed automatically.
          </EmptyState>
          <pre className="mt-2 overflow-x-auto rounded bg-zinc-100 p-3 text-xs dark:bg-zinc-800">
{`_dmarc.${domainHint ?? "your-domain"} TXT "v=DMARC1; p=none; rua=mailto:dmarc@${domainHint ?? "your-domain"}"`}
          </pre>
        </Panel>
      ) : (
        <>
          <Panel title="By domain">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-sm">
                <thead className="text-xs uppercase text-zinc-500">
                  <tr>
                    <th className="px-2 py-2 text-left font-medium">Domain</th>
                    <th className="px-2 py-2 text-right font-medium">Reports</th>
                    <th className="px-2 py-2 text-right font-medium">Messages</th>
                    <th className="px-2 py-2 text-right font-medium">Pass</th>
                    <th className="px-2 py-2 text-right font-medium">Failed</th>
                    <th className="px-2 py-2 text-right font-medium">Quarantined</th>
                    <th className="px-2 py-2 text-right font-medium">Rejected</th>
                    <th className="px-2 py-2 text-right font-medium">Last</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                  {data.data.map((d) => (
                    <tr key={d.domain}>
                      <td className="px-2 py-2 font-mono text-xs">{d.domain}</td>
                      <td className="px-2 py-2 text-right">{d.reports}</td>
                      <td className="px-2 py-2 text-right">{d.messages}</td>
                      <td className="px-2 py-2 text-right text-emerald-600 dark:text-emerald-400">
                        {pct(d.passed, d.messages)}
                      </td>
                      <td className="px-2 py-2 text-right text-red-600 dark:text-red-400">
                        {d.failed}
                      </td>
                      <td className="px-2 py-2 text-right">{d.quarantined}</td>
                      <td className="px-2 py-2 text-right">{d.rejected}</td>
                      <td className="px-2 py-2 text-right text-xs text-zinc-500">
                        {fmtDate(d.last_report_at)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>

          <Panel title="Daily volume">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[480px] text-sm">
                <thead className="text-xs uppercase text-zinc-500">
                  <tr>
                    <th className="px-2 py-2 text-left font-medium">Day</th>
                    <th className="px-2 py-2 text-right font-medium">Messages</th>
                    <th className="px-2 py-2 text-right font-medium">Failed</th>
                    <th className="px-2 py-2 text-right font-medium">Quarantined</th>
                    <th className="px-2 py-2 text-right font-medium">Rejected</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                  {data.timeseries.slice(-14).map((p) => (
                    <tr key={p.day}>
                      <td className="px-2 py-1.5 text-xs">{p.day}</td>
                      <td className="px-2 py-1.5 text-right">{p.messages}</td>
                      <td className="px-2 py-1.5 text-right text-red-600 dark:text-red-400">
                        {p.failed}
                      </td>
                      <td className="px-2 py-1.5 text-right">{p.quarantined}</td>
                      <td className="px-2 py-1.5 text-right">{p.rejected}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>

          <Panel title="Recent reports">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-sm">
                <thead className="text-xs uppercase text-zinc-500">
                  <tr>
                    <th className="px-2 py-2 text-left font-medium">Period</th>
                    <th className="px-2 py-2 text-left font-medium">Domain</th>
                    <th className="px-2 py-2 text-left font-medium">Reporter</th>
                    <th className="px-2 py-2 text-right font-medium">Messages</th>
                    <th className="px-2 py-2 text-right font-medium">Failed</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                  {data.reports.map((r) => (
                    <tr key={r.id}>
                      <td className="px-2 py-2 text-xs">
                        {fmtDate(r.date_begin)} – {fmtDate(r.date_end)}
                      </td>
                      <td className="px-2 py-2 font-mono text-xs">{r.domain}</td>
                      <td className="px-2 py-2 text-xs">{r.org_name}</td>
                      <td className="px-2 py-2 text-right">{r.messages}</td>
                      <td className="px-2 py-2 text-right">
                        {r.failed > 0 ? (
                          <Badge tone="danger">{r.failed}</Badge>
                        ) : (
                          <Badge tone="success">0</Badge>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        </>
      )}
    </div>
  );
}

function TlsPanel({ days, domainHint }: { days: number; domainHint?: string }) {
  const q = useQuery({
    queryKey: ["reports", "tls", days],
    queryFn: () => api.getTlsRptSummary({ days }),
  });
  if (q.isLoading) return <p className="text-sm text-zinc-500">Loading…</p>;
  if (q.error) return <ErrorText>{String(q.error)}</ErrorText>;
  const data = q.data as TlsSummary;

  const totals = (data.data ?? []).reduce(
    (acc, d) => ({
      reports: acc.reports + d.reports,
      success: acc.success + d.success,
      failures: acc.failures + d.failures,
    }),
    { reports: 0, success: 0, failures: 0 },
  );

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Stat label="Reports" value={String(totals.reports)} />
        <Stat label="Successful sessions" value={String(totals.success)} />
        <Stat label="Failed sessions" value={String(totals.failures)} />
      </div>

      {(data.data ?? []).length === 0 ? (
        <Panel title="No TLS-RPT reports yet">
          <EmptyState icon={BarChart3} className="py-6">
            Publish a TLS reporting address and reports will be parsed
            automatically.
          </EmptyState>
          <pre className="mt-2 overflow-x-auto rounded bg-zinc-100 p-3 text-xs dark:bg-zinc-800">
{`_smtp._tls.${domainHint ?? "your-domain"} TXT "v=TLSRPTv1; rua=mailto:tlsrpt@${domainHint ?? "your-domain"}"`}
          </pre>
        </Panel>
      ) : (
        <>
          <Panel title="By domain">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[480px] text-sm">
                <thead className="text-xs uppercase text-zinc-500">
                  <tr>
                    <th className="px-2 py-2 text-left font-medium">Domain</th>
                    <th className="px-2 py-2 text-right font-medium">Reports</th>
                    <th className="px-2 py-2 text-right font-medium">Success</th>
                    <th className="px-2 py-2 text-right font-medium">Failures</th>
                    <th className="px-2 py-2 text-right font-medium">Last</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                  {data.data.map((d) => (
                    <tr key={d.domain}>
                      <td className="px-2 py-2 font-mono text-xs">{d.domain}</td>
                      <td className="px-2 py-2 text-right">{d.reports}</td>
                      <td className="px-2 py-2 text-right">{d.success}</td>
                      <td className="px-2 py-2 text-right text-red-600 dark:text-red-400">
                        {d.failures}
                      </td>
                      <td className="px-2 py-2 text-right text-xs text-zinc-500">
                        {fmtDate(d.last_report_at)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>

          <Panel title="Recent reports">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-sm">
                <thead className="text-xs uppercase text-zinc-500">
                  <tr>
                    <th className="px-2 py-2 text-left font-medium">Period</th>
                    <th className="px-2 py-2 text-left font-medium">Domain</th>
                    <th className="px-2 py-2 text-left font-medium">Reporter</th>
                    <th className="px-2 py-2 text-right font-medium">Success</th>
                    <th className="px-2 py-2 text-right font-medium">Failures</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                  {data.reports.map((r) => (
                    <tr key={r.id}>
                      <td className="px-2 py-2 text-xs">
                        {fmtDate(r.date_begin)} – {fmtDate(r.date_end)}
                      </td>
                      <td className="px-2 py-2 font-mono text-xs">{r.domain}</td>
                      <td className="px-2 py-2 text-xs">{r.org_name}</td>
                      <td className="px-2 py-2 text-right">{r.success}</td>
                      <td className="px-2 py-2 text-right">
                        {r.failures > 0 ? (
                          <Badge tone="danger">{r.failures}</Badge>
                        ) : (
                          <Badge tone="success">0</Badge>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        </>
      )}
    </div>
  );
}
