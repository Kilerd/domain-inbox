import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Globe, Inbox, RefreshCw, Send, Trash2 } from "lucide-react";
import { useState } from "react";
import { api, ApiError, type Domain } from "@/api";
import { Badge, Button, EmptyState, ErrorText, Input, Panel } from "@/components/ui";
import { useCompose } from "@/lib/compose-store";
import { cn } from "@/lib/utils";

export function DomainsTab() {
  const qc = useQueryClient();
  const domains = useQuery({ queryKey: ["domains"], queryFn: api.listDomains });
  const [name, setName] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const createMut = useMutation({
    mutationFn: (n: string) => api.createDomain(n),
    onSuccess: () => {
      setName("");
      setErr(null);
      qc.invalidateQueries({ queryKey: ["domains"] });
    },
    onError: (e: unknown) =>
      setErr(e instanceof ApiError ? e.message : String(e)),
  });

  return (
    <div className="space-y-4">
      <Panel title="Add a domain" description="Must be hosted on Cloudflare DNS.">
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) createMut.mutate(name.trim());
          }}
        >
          <Input
            value={name}
            placeholder="example.com"
            onChange={(e) => setName(e.target.value)}
            disabled={createMut.isPending}
          />
          <Button
            variant="primary"
            type="submit"
            disabled={!name.trim() || createMut.isPending}
          >
            {createMut.isPending ? "Adding…" : "Add"}
          </Button>
        </form>
        {err && <ErrorText>{err}</ErrorText>}
        {createMut.data?.auto_configured && (
          <p className="mt-2 text-xs text-emerald-600 dark:text-emerald-400">
            ✓ Email Routing auto-configured via Cloudflare API.
          </p>
        )}
        {createMut.data?.auto_config_error && (
          <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">
            Auto-config skipped: {createMut.data.auto_config_error}
          </p>
        )}
      </Panel>

      <Panel
        title="Your domains"
        description="DNS records are auto-published by Cloudflare when you enable Email Routing / Email Sending on the zone."
      >
        {domains.isLoading && <p className="text-sm text-zinc-500">Loading…</p>}
        {domains.data?.length === 0 && (
          <EmptyState icon={Globe} className="py-6">No domains yet.</EmptyState>
        )}
        <div className="space-y-2">
          {domains.data?.map((d) => <DomainRow key={d.id} domain={d} />)}
        </div>
      </Panel>
    </div>
  );
}

function DomainRow({ domain }: { domain: Domain }) {
  const qc = useQueryClient();
  const { openCompose } = useCompose();
  const me = useQuery({ queryKey: ["me"], queryFn: api.me });

  const verifyMut = useMutation({
    mutationFn: () => api.verifyDomain(domain.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["domains"] }),
  });
  const deleteMut = useMutation({
    mutationFn: () => api.deleteDomain(domain.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["domains"] }),
  });

  function sendTest() {
    const target = me.data?.email ?? "";
    openCompose({
      mode: "test",
      testDomain: domain.name,
      from: `test@${domain.name}`,
      to: target ? [target] : [],
      subject: `Test from ${domain.name}`,
      text: `This is a deliverability test sent from ${domain.name} at ${new Date().toISOString()}.\n\nIf this message arrives in your inbox with valid DKIM/SPF, outbound sending is correctly configured for this domain.`,
      bodyMode: "text",
    });
  }

  const showHint =
    domain.receive_status !== "verified" || domain.send_status !== "verified";

  return (
    <article className="rounded border border-zinc-200 dark:border-zinc-800">
      <header className="flex flex-wrap items-center gap-3 px-3 py-2">
        <Globe className="h-4 w-4 text-zinc-500" />
        <span className="font-mono text-sm">{domain.name}</span>
        <div className="flex items-center gap-1.5">
          <Badge
            tone={domain.receive_status === "verified" ? "success" : "warn"}
            className="gap-1"
          >
            <Inbox className="h-3 w-3" />
            receive {domain.receive_status}
          </Badge>
          <Badge
            tone={domain.send_status === "verified" ? "success" : "warn"}
            className="gap-1"
          >
            <Send className="h-3 w-3" />
            send {domain.send_status}
          </Badge>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Button
            variant="secondary"
            onClick={sendTest}
            disabled={domain.send_status !== "verified"}
            title={
              domain.send_status === "verified"
                ? "Send a deliverability test to yourself"
                : "Sending must be configured for this domain first"
            }
          >
            <Send className="h-3 w-3" />
            Test
          </Button>
          <Button
            variant="secondary"
            onClick={() => verifyMut.mutate()}
            disabled={verifyMut.isPending}
            title="Re-query DNS"
          >
            <RefreshCw className={cn("h-3 w-3", verifyMut.isPending && "animate-spin")} />
            Verify
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              if (confirm(`Remove ${domain.name}?`)) deleteMut.mutate();
            }}
            disabled={deleteMut.isPending}
            title="Remove from this service"
          >
            <Trash2 className="h-3 w-3" />
          </Button>
        </div>
      </header>
      {showHint && <DomainHint domain={domain} />}
    </article>
  );
}

function DomainHint({ domain }: { domain: Domain }) {
  const needReceive = domain.receive_status !== "verified";
  const needSend = domain.send_status !== "verified";
  return (
    <div className="space-y-1.5 border-t border-zinc-100 px-3 py-2 text-xs text-zinc-600 dark:border-zinc-800 dark:text-zinc-400">
      {needReceive && (
        <a
          href="https://dash.cloudflare.com/?to=/:account/email"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-blue-600 hover:underline dark:text-blue-400"
        >
          <Inbox className="h-3 w-3" />
          Enable Email Routing on {domain.name} in the Cloudflare dashboard
          <ExternalLink className="h-3 w-3" />
        </a>
      )}
      {needSend && (
        <a
          href="https://dash.cloudflare.com/?to=/:account/email"
          target="_blank"
          rel="noopener noreferrer"
          className="block inline-flex items-center gap-1 text-blue-600 hover:underline dark:text-blue-400"
        >
          <Send className="h-3 w-3" />
          Enable Email Sending on {domain.name} in the Cloudflare dashboard
          <ExternalLink className="h-3 w-3" />
        </a>
      )}
    </div>
  );
}
