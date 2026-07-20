import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ShieldOff, Trash2 } from "lucide-react";
import { useState } from "react";
import { api, type Suppression } from "@/api";
import { Badge, Button, EmptyState, ErrorText, Input, Panel } from "@/components/ui";

const REASON_FILTERS = [
  { id: "", label: "All" },
  { id: "hard_bounce", label: "Hard bounces" },
  { id: "complaint", label: "Complaints" },
  { id: "manual", label: "Manual" },
];

const REASON_TONE: Record<string, "danger" | "warn" | "neutral" | "info"> = {
  hard_bounce: "danger",
  complaint: "warn",
  manual: "neutral",
};

export function SuppressionsTab() {
  const qc = useQueryClient();
  const [reason, setReason] = useState<string>("");
  const [q, setQ] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const list = useQuery({
    queryKey: ["suppressions", { reason, q }],
    queryFn: () => api.listSuppressions({ reason: reason || undefined, q: q || undefined }),
  });

  const addMut = useMutation({
    mutationFn: (email: string) => api.addSuppression(email),
    onSuccess: () => {
      setNewEmail("");
      setErr(null);
      qc.invalidateQueries({ queryKey: ["suppressions"] });
    },
    onError: (e: unknown) => setErr(String(e)),
  });

  const delMut = useMutation({
    mutationFn: (id: string) => api.removeSuppression(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["suppressions"] }),
  });

  return (
    <div className="space-y-4">
      <Panel
        title="Add suppression"
        description="Sends to this address will fail fast with `validation_error` until you remove the entry."
      >
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const v = newEmail.trim();
            if (v) addMut.mutate(v);
          }}
        >
          <Input
            value={newEmail}
            placeholder="user@example.com"
            onChange={(e) => setNewEmail(e.target.value)}
            disabled={addMut.isPending}
          />
          <Button
            variant="primary"
            type="submit"
            disabled={!newEmail.trim() || addMut.isPending}
          >
            {addMut.isPending ? "Adding…" : "Add"}
          </Button>
        </form>
        {err && <ErrorText>{err}</ErrorText>}
      </Panel>

      <Panel title="Suppression list">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          {REASON_FILTERS.map((r) => (
            <button
              key={r.id || "all"}
              type="button"
              onClick={() => setReason(r.id)}
              className={
                "rounded-md border px-2.5 py-1 text-xs transition-colors " +
                (reason === r.id
                  ? "border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300"
                  : "border-zinc-200 text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800")
              }
            >
              {r.label}
            </button>
          ))}
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="search email…"
            className="ml-auto max-w-xs"
          />
        </div>

        {list.isLoading && <p className="text-sm text-zinc-500">Loading…</p>}
        {list.data?.length === 0 && (
          <EmptyState icon={ShieldOff} className="py-6">
            No suppressions match this filter.
          </EmptyState>
        )}
        <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {list.data?.map((s: Suppression) => (
            <li key={s.id} className="flex items-start gap-3 py-2.5">
              <ShieldOff className="mt-0.5 h-4 w-4 text-zinc-500" />
              <div className="min-w-0 flex-1">
                <code className="block truncate font-mono text-sm">{s.email}</code>
                <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-zinc-500">
                  <Badge tone={REASON_TONE[s.reason] ?? "neutral"}>{s.reason}</Badge>
                  <span>added {new Date(s.created_at).toLocaleString()}</span>
                  {s.source_outbound_id && (
                    <code className="font-mono text-[10px]">
                      ← {s.source_outbound_id.slice(0, 10)}…
                    </code>
                  )}
                </div>
              </div>
              <Button
                variant="danger"
                onClick={() => {
                  if (confirm(`Remove suppression for ${s.email}?`)) delMut.mutate(s.id);
                }}
                disabled={delMut.isPending}
              >
                <Trash2 className="h-3 w-3" />
              </Button>
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}
