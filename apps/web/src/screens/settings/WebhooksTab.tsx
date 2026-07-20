import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Trash2, Webhook } from "lucide-react";
import { useState } from "react";
import { api, type WebhookCreated } from "@/api";
import { Badge, Button, CopyableSecret, EmptyState, ErrorText, Input, Panel } from "@/components/ui";

const EVENT_TYPES = [
  "email.sent",
  "email.failed",
  "email.bounced",
  "email.complained",
  "email.delivery_delayed",
  "email.received",
  "email.opened",
  "email.clicked",
  "email.canceled",
  "email.scheduled",
  "domain.created",
  "domain.verified",
  "domain.deleted",
];

export function WebhooksTab() {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["webhooks"], queryFn: api.listWebhooks });
  const [url, setUrl] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set(EVENT_TYPES.slice(0, 5)));
  const [lastCreated, setLastCreated] = useState<WebhookCreated | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const createMut = useMutation({
    mutationFn: () => api.createWebhook({ url, events: [...picked] }),
    onSuccess: (w) => {
      setLastCreated(w);
      setUrl("");
      setErr(null);
      qc.invalidateQueries({ queryKey: ["webhooks"] });
    },
    onError: (e: unknown) => setErr(String(e)),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => api.deleteWebhook(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["webhooks"] }),
  });

  function toggle(ev: string) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(ev)) next.delete(ev);
      else next.add(ev);
      return next;
    });
  }

  return (
    <div className="space-y-4">
      <Panel
        title="Add webhook endpoint"
        description="Receives Svix-signed payloads (`svix-id`, `svix-timestamp`, `svix-signature`)."
      >
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (url.trim() && picked.size > 0) createMut.mutate();
          }}
        >
          <Input
            value={url}
            placeholder="https://your-server.example.com/webhooks/inbox"
            onChange={(e) => setUrl(e.target.value)}
            disabled={createMut.isPending}
          />
          <div className="flex flex-wrap gap-2">
            {EVENT_TYPES.map((ev) => (
              <label key={ev} className="inline-flex cursor-pointer items-center gap-1.5 text-xs">
                <input
                  type="checkbox"
                  className="rounded border-zinc-300 dark:border-zinc-600"
                  checked={picked.has(ev)}
                  onChange={() => toggle(ev)}
                />
                <code className="font-mono">{ev}</code>
              </label>
            ))}
          </div>
          <Button
            variant="primary"
            type="submit"
            disabled={!url.trim() || picked.size === 0 || createMut.isPending}
          >
            {createMut.isPending ? "Adding…" : "Add endpoint"}
          </Button>
        </form>
        {err && <ErrorText>{err}</ErrorText>}

        {lastCreated && (
          <div className="mt-3 rounded-md border border-amber-300 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950/40">
            <p className="text-xs font-medium text-amber-900 dark:text-amber-200">
              Copy this signing secret now — it will not be shown again.
            </p>
            <div className="mt-2">
              <CopyableSecret value={lastCreated.secret} />
            </div>
          </div>
        )}
      </Panel>

      <Panel title="Endpoints">
        {list.isLoading && <p className="text-sm text-zinc-500">Loading…</p>}
        {list.data?.length === 0 && (
          <EmptyState icon={Webhook} className="py-6">
            No webhook endpoints yet.
          </EmptyState>
        )}
        <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {list.data?.map((w) => (
            <li key={w.id} className="flex items-start gap-3 py-2.5">
              <Webhook className="mt-0.5 h-4 w-4 text-zinc-500" />
              <div className="min-w-0 flex-1">
                <code className="block truncate font-mono text-sm">{w.url}</code>
                <div className="mt-1 flex flex-wrap items-center gap-1">
                  {w.events.map((e) => (
                    <Badge key={e} tone="info">
                      {e}
                    </Badge>
                  ))}
                  {!w.enabled && <Badge tone="danger">disabled</Badge>}
                </div>
              </div>
              <Button
                variant="danger"
                onClick={() => {
                  if (confirm(`Remove webhook to ${w.url}?`)) deleteMut.mutate(w.id);
                }}
                disabled={deleteMut.isPending}
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
