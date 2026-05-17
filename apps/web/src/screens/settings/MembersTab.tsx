import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Trash2, UserPlus, UserRound } from "lucide-react";
import { useState } from "react";
import { api, ApiError } from "@/api";
import { Badge, Button, ErrorText, Input, Panel } from "@/components/ui";

export function MembersTab() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["members"], queryFn: api.listMembers });
  const [email, setEmail] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const inviteMut = useMutation({
    mutationFn: (e: string) => api.inviteMember(e),
    onSuccess: () => {
      setEmail("");
      setErr(null);
      qc.invalidateQueries({ queryKey: ["members"] });
    },
    onError: (e: unknown) =>
      setErr(e instanceof ApiError ? e.message : String(e)),
  });

  const removeMut = useMutation({
    mutationFn: (e: string) => api.removeMember(e),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["members"] }),
  });

  return (
    <div className="space-y-4">
      <Panel
        title="Invite a member"
        description="Invitees get a magic-link sign-in once they request login with the invited email."
      >
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (email.trim()) inviteMut.mutate(email.trim().toLowerCase());
          }}
        >
          <Input
            type="email"
            placeholder="someone@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={inviteMut.isPending}
          />
          <Button
            variant="primary"
            type="submit"
            disabled={!email.trim() || inviteMut.isPending}
          >
            <UserPlus className="h-3 w-3" />
            Invite
          </Button>
        </form>
        {err && <ErrorText>{err}</ErrorText>}
      </Panel>

      <Panel title="Members">
        {q.isLoading && <p className="text-sm text-zinc-500">loading…</p>}
        <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {q.data?.members.map((m) => (
            <li key={m.email} className="flex items-center gap-3 py-2.5">
              <UserRound className="h-4 w-4 text-zinc-500" />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="truncate text-sm font-medium">{m.email}</span>
                  <Badge tone={m.role === "owner" ? "info" : "neutral"}>{m.role}</Badge>
                </div>
                <div className="mt-0.5 text-xs text-zinc-500">
                  Joined {new Date(m.created_at).toLocaleDateString()}
                  {m.last_seen_at && (
                    <> · last seen {new Date(m.last_seen_at).toLocaleString()}</>
                  )}
                </div>
              </div>
              {m.role !== "owner" && (
                <Button
                  variant="danger"
                  onClick={() => {
                    if (confirm(`Remove ${m.email}?`)) removeMut.mutate(m.email);
                  }}
                  disabled={removeMut.isPending}
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
              )}
            </li>
          ))}
          {q.data?.pending_invites.map((m) => (
            <li key={m.email} className="flex items-center gap-3 py-2.5">
              <UserRound className="h-4 w-4 text-zinc-400" />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="truncate text-sm text-zinc-500">{m.email}</span>
                  <Badge tone="warn">pending</Badge>
                </div>
                <div className="mt-0.5 text-xs text-zinc-500">
                  Invited {new Date(m.created_at).toLocaleDateString()}
                </div>
              </div>
              <Button
                variant="danger"
                onClick={() => {
                  if (confirm(`Revoke invite for ${m.email}?`))
                    removeMut.mutate(m.email);
                }}
                disabled={removeMut.isPending}
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
