import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Key, Trash2 } from "lucide-react";
import { useState } from "react";
import { api, type ApiKeyCreated } from "@/api";
import { Badge, Button, CopyableSecret, EmptyState, ErrorText, Input, Panel } from "@/components/ui";

export function ApiKeysTab() {
  const qc = useQueryClient();
  const keys = useQuery({ queryKey: ["api-keys"], queryFn: api.listApiKeys });
  const [name, setName] = useState("");
  const [lastCreated, setLastCreated] = useState<ApiKeyCreated | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const createMut = useMutation({
    mutationFn: () => api.createApiKey({ name: name.trim() || undefined }),
    onSuccess: (k) => {
      setLastCreated(k);
      setName("");
      setErr(null);
      qc.invalidateQueries({ queryKey: ["api-keys"] });
    },
    onError: (e: unknown) => setErr(String(e)),
  });

  const revokeMut = useMutation({
    mutationFn: (id: string) => api.revokeApiKey(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["api-keys"] }),
  });

  return (
    <div className="space-y-4">
      <Panel
        title="Create API key"
        description="Resend SDKs use these via `Authorization: Bearer re_live_…`."
      >
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            createMut.mutate();
          }}
        >
          <Input
            value={name}
            placeholder="(optional) label, e.g. ci-mailer"
            onChange={(e) => setName(e.target.value)}
            disabled={createMut.isPending}
          />
          <Button variant="primary" type="submit" disabled={createMut.isPending}>
            {createMut.isPending ? "Creating…" : "Create key"}
          </Button>
        </form>
        {err && <ErrorText>{err}</ErrorText>}

        {lastCreated && (
          <div className="mt-3 rounded-md border border-amber-300 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950/40">
            <p className="text-xs font-medium text-amber-900 dark:text-amber-200">
              Copy this token now — it will not be shown again.
            </p>
            <div className="mt-2">
              <CopyableSecret value={lastCreated.token} />
            </div>
          </div>
        )}
      </Panel>

      <Panel title="Your API keys">
        {keys.isLoading && <p className="text-sm text-zinc-500">Loading…</p>}
        {keys.data?.length === 0 && (
          <EmptyState icon={Key} className="py-6">No API keys yet.</EmptyState>
        )}
        <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {keys.data?.map((k) => (
            <li key={k.id} className="flex items-center gap-3 py-2.5">
              <Key className="h-4 w-4 text-zinc-500" />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="truncate text-sm font-medium">
                    {k.name ?? "(unnamed)"}
                  </span>
                  <code className="font-mono text-xs text-zinc-500">{k.prefix}…</code>
                  {k.revoked_at && <Badge tone="danger">revoked</Badge>}
                </div>
                <div className="mt-0.5 text-xs text-zinc-500">
                  {k.scopes.join(", ")} · created{" "}
                  {new Date(k.created_at).toLocaleString()}
                  {k.last_used_at && (
                    <> · last used {new Date(k.last_used_at).toLocaleString()}</>
                  )}
                </div>
              </div>
              {!k.revoked_at && (
                <Button
                  variant="danger"
                  onClick={() => {
                    if (confirm(`Revoke ${k.prefix}…?`)) revokeMut.mutate(k.id);
                  }}
                  disabled={revokeMut.isPending}
                >
                  <Trash2 className="h-3 w-3" />
                  Revoke
                </Button>
              )}
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}
