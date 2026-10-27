import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Save, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import {
  api,
  type EmailRule,
  type RuleActions,
  type RuleMatch,
} from "@/api";
import {
  Badge,
  Button,
  EmptyState,
  ErrorText,
  Input,
  Panel,
  Textarea,
} from "@/components/ui";

const ACTION_LABELS: Array<[keyof RuleActions, string]> = [
  ["star", "Star"],
  ["archive", "Archive"],
  ["spam", "Spam"],
  ["trash", "Trash"],
  ["read", "Mark read"],
];

function matchSummary(m: RuleMatch): string {
  const parts: string[] = [];
  if (m.from) parts.push(`from ~ ${m.from}`);
  if (m.to) parts.push(`to ~ ${m.to}`);
  if (m.subject) parts.push(`subject ~ ${m.subject}`);
  if (m.hasAttachment) parts.push("has attachment");
  return parts.join(" · ");
}

function actionSummary(a: RuleActions): string {
  return ACTION_LABELS.filter(([k]) => a[k])
    .map(([, label]) => label)
    .join(", ");
}

function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60_000).toISOString().slice(0, 16);
}

function fromLocalInput(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function RulesTab() {
  const qc = useQueryClient();
  const rules = useQuery({ queryKey: ["rules"], queryFn: api.listRules });

  const [name, setName] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [subject, setSubject] = useState("");
  const [hasAttachment, setHasAttachment] = useState(false);
  const [actions, setActions] = useState<RuleActions>({});
  const [err, setErr] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: (params: {
      name?: string;
      match: RuleMatch;
      actions: RuleActions;
    }) => api.createRule(params),
    onSuccess: () => {
      setName("");
      setFrom("");
      setTo("");
      setSubject("");
      setHasAttachment(false);
      setActions({});
      setErr(null);
      qc.invalidateQueries({ queryKey: ["rules"] });
    },
    onError: (e: unknown) => setErr(String(e)),
  });
  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api.updateRule(id, { enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["rules"] }),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteRule(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["rules"] }),
  });

  function submit() {
    const match: RuleMatch = {};
    if (from.trim()) match.from = from.trim();
    if (to.trim()) match.to = to.trim();
    if (subject.trim()) match.subject = subject.trim();
    if (hasAttachment) match.hasAttachment = true;
    const enabledActions: RuleActions = {};
    for (const [k] of ACTION_LABELS) {
      if (actions[k]) enabledActions[k] = true;
    }
    if (Object.keys(match).length === 0) {
      setErr("Add at least one condition (from, to, subject or attachment).");
      return;
    }
    if (Object.keys(enabledActions).length === 0) {
      setErr("Choose at least one action.");
      return;
    }
    setErr(null);
    create.mutate({
      name: name.trim() || undefined,
      match,
      actions: enabledActions,
    });
  }

  return (
    <div className="space-y-4">
      <Panel
        title="Inbound rules"
        description="All conditions must match. Every matching rule applies its actions. Rules run before the vacation responder."
      >
        <div className="grid gap-2 sm:grid-cols-3">
          <Input
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            placeholder="From contains, e.g. @github.com"
          />
          <Input
            value={to}
            onChange={(e) => setTo(e.target.value)}
            placeholder="To contains, e.g. support@"
          />
          <Input
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="Subject contains"
          />
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-zinc-600 dark:text-zinc-300">
          <label className="inline-flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={hasAttachment}
              onChange={(e) => setHasAttachment(e.target.checked)}
              className="h-3.5 w-3.5 rounded border-zinc-300 dark:border-zinc-600"
            />
            Has attachment
          </label>
          {ACTION_LABELS.map(([key, label]) => (
            <label key={key} className="inline-flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={Boolean(actions[key])}
                onChange={(e) =>
                  setActions((a) => ({ ...a, [key]: e.target.checked }))
                }
                className="h-3.5 w-3.5 rounded border-zinc-300 dark:border-zinc-600"
              />
              {label}
            </label>
          ))}
        </div>
        <div className="mt-3 flex items-center gap-2">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="(optional) rule name"
            className="max-w-xs"
          />
          <Button
            variant="primary"
            onClick={submit}
            disabled={create.isPending}
          >
            <Plus className="h-3 w-3" />
            {create.isPending ? "Creating…" : "Add rule"}
          </Button>
        </div>
        {err && <ErrorText>{err}</ErrorText>}
      </Panel>

      <Panel title="Configured rules">
        {rules.isLoading && <p className="text-sm text-zinc-500">Loading…</p>}
        {rules.data?.length === 0 && (
          <EmptyState className="py-6">No rules yet.</EmptyState>
        )}
        <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {rules.data?.map((r: EmailRule) => (
            <li key={r.id} className="flex items-center gap-3 py-2.5">
              <input
                type="checkbox"
                checked={r.enabled}
                onChange={() => toggle.mutate({ id: r.id, enabled: !r.enabled })}
                className="h-3.5 w-3.5 rounded border-zinc-300 dark:border-zinc-600"
                title={r.enabled ? "Disable rule" : "Enable rule"}
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="truncate text-sm font-medium">{r.name}</span>
                  {!r.enabled && <Badge tone="neutral">disabled</Badge>}
                </div>
                <div className="mt-0.5 truncate text-xs text-zinc-500">
                  {matchSummary(r.match)}
                </div>
                <div className="mt-0.5 truncate text-xs text-zinc-500">
                  → {actionSummary(r.actions)}
                </div>
              </div>
              <Button
                variant="danger"
                onClick={() => {
                  if (confirm(`Delete rule "${r.name}"?`)) remove.mutate(r.id);
                }}
                disabled={remove.isPending}
                title="Delete rule"
              >
                <Trash2 className="h-3 w-3" />
              </Button>
            </li>
          ))}
        </ul>
      </Panel>

      <VacationPanel />
    </div>
  );
}

function VacationPanel() {
  const qc = useQueryClient();
  const vacation = useQuery({ queryKey: ["vacation"], queryFn: api.getVacation });
  const [enabled, setEnabled] = useState(false);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [startAt, setStartAt] = useState("");
  const [endAt, setEndAt] = useState("");
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const v = vacation.data;
    if (!v) return;
    setEnabled(v.enabled);
    setSubject(v.subject ?? "");
    setBody(v.body_text);
    setStartAt(toLocalInput(v.start_at));
    setEndAt(toLocalInput(v.end_at));
  }, [vacation.data]);

  const save = useMutation({
    mutationFn: () =>
      api.saveVacation({
        enabled,
        subject: subject.trim() || null,
        body_text: body,
        start_at: fromLocalInput(startAt),
        end_at: fromLocalInput(endAt),
      }),
    onSuccess: () => {
      setErr(null);
      qc.invalidateQueries({ queryKey: ["vacation"] });
    },
    onError: (e: unknown) => setErr(String(e)),
  });

  return (
    <Panel
      title="Vacation responder"
      description="One reply per sender every 3 days. Automated mail, your own domains, suppressed addresses and spam are skipped."
    >
      <label className="inline-flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          className="h-3.5 w-3.5 rounded border-zinc-300 dark:border-zinc-600"
        />
        Enabled
      </label>
      <div className="mt-3 space-y-2">
        <Input
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          placeholder="(optional) subject, e.g. Out of office"
        />
        <Textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="I'm away until…"
          className="min-h-[120px]"
        />
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="block text-xs text-zinc-500">
            Starts (optional)
            <Input
              type="datetime-local"
              value={startAt}
              onChange={(e) => setStartAt(e.target.value)}
              className="mt-1"
            />
          </label>
          <label className="block text-xs text-zinc-500">
            Ends (optional)
            <Input
              type="datetime-local"
              value={endAt}
              onChange={(e) => setEndAt(e.target.value)}
              className="mt-1"
            />
          </label>
        </div>
      </div>
      {err && <ErrorText>{err}</ErrorText>}
      <div className="mt-3">
        <Button
          variant="primary"
          onClick={() => save.mutate()}
          disabled={save.isPending || vacation.isLoading}
        >
          <Save className="h-3 w-3" />
          {save.isPending ? "Saving…" : "Save auto-reply"}
        </Button>
      </div>
    </Panel>
  );
}
