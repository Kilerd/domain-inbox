import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { Archive, Inbox, Mail, Star, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api, type Thread } from "@/api";
import { Button } from "@/components/ui";
import { FLAG_STARRED, has } from "@/lib/flags";
import { useInboxView } from "@/lib/inbox-view";
import { cn } from "@/lib/utils";

interface Props {
  selectedThreadId: string | null;
  onSelect: (t: Thread) => void;
}

export function ThreadList({ selectedThreadId, onSelect }: Props) {
  const { state } = useInboxView();
  const qc = useQueryClient();
  const queryKey = useMemo(
    () => [
      "inbox",
      "threads",
      state.view,
      state.domainId,
      state.aliasId,
      state.query,
    ],
    [state.view, state.domainId, state.aliasId, state.query],
  );
  const q = useQuery({
    queryKey,
    queryFn: () =>
      api.listThreads({
        view: state.view,
        domain: state.domainId,
        alias: state.aliasId,
        q: state.query || null,
        limit: 100,
      }),
    refetchInterval: 30_000,
  });

  // Live updates via SSE
  useEffect(() => {
    const es = new EventSource("/api/inbox/stream");
    es.addEventListener("new-message", () => {
      qc.invalidateQueries({ queryKey: ["inbox"] });
    });
    es.onerror = () => {};
    return () => es.close();
  }, [qc]);

  // Multi-select set
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Clear selection when the underlying list/view changes
  useEffect(() => {
    setSelected(new Set());
  }, [state.view, state.domainId, state.aliasId]);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="flex h-full flex-col">
      <Toolbar
        viewLabel={describeView(state)}
        count={q.data?.threads.length ?? 0}
        selectedIds={[...selected]}
        onComplete={() => setSelected(new Set())}
      />
      <div className="flex-1 overflow-y-auto overflow-x-hidden">
        {q.isLoading && <div className="p-4 text-sm text-zinc-500">loading…</div>}
        {q.error && <div className="p-4 text-sm text-red-600">{String(q.error)}</div>}
        {q.data && q.data.threads.length === 0 && (
          <div className="p-6 text-center text-sm text-zinc-500">
            No threads in this view.
          </div>
        )}
        {q.data?.threads.map((t) => (
          <ThreadRow
            key={t.id}
            thread={t}
            selectedForBulk={selected.has(t.id)}
            onToggle={() => toggle(t.id)}
            isOpen={selectedThreadId === t.id}
            onSelect={() => onSelect(t)}
          />
        ))}
      </div>
    </div>
  );
}

function describeView(state: ReturnType<typeof useInboxView>["state"]): string {
  if (state.aliasId) return "Alias";
  if (state.domainId) return "Domain";
  switch (state.view) {
    case "inbox":
      return "Inbox";
    case "unread":
      return "Unread";
    case "starred":
      return "Starred";
    case "sent":
      return "Sent";
    case "archived":
      return "Archived";
    case "trash":
      return "Trash";
    case "spam":
      return "Spam";
    case "all":
      return "All mail";
  }
}

function Toolbar({
  viewLabel,
  count,
  selectedIds,
  onComplete,
}: {
  viewLabel: string;
  count: number;
  selectedIds: string[];
  onComplete: () => void;
}) {
  const qc = useQueryClient();
  const mut = useMutation({
    mutationFn: (patch: Parameters<typeof api.batchSetThreadFlags>[1]) =>
      api.batchSetThreadFlags(selectedIds, patch),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["inbox"] });
      onComplete();
    },
  });

  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-zinc-200 px-3 py-2 dark:border-zinc-800">
      <Inbox className="h-3.5 w-3.5 text-zinc-500" />
      <span className="text-sm font-medium">{viewLabel}</span>
      <span className="text-xs text-zinc-500">{count}</span>
      {selectedIds.length > 0 && (
        <div className="ml-auto flex items-center gap-1">
          <span className="text-xs text-zinc-500">{selectedIds.length} selected</span>
          <Button
            variant="ghost"
            onClick={() => mut.mutate({ read: true })}
            disabled={mut.isPending}
            title="Mark read"
          >
            <Mail className="h-3 w-3" />
          </Button>
          <Button
            variant="ghost"
            onClick={() => mut.mutate({ star: true })}
            disabled={mut.isPending}
            title="Star"
          >
            <Star className="h-3 w-3" />
          </Button>
          <Button
            variant="ghost"
            onClick={() => mut.mutate({ archive: true })}
            disabled={mut.isPending}
            title="Archive"
          >
            <Archive className="h-3 w-3" />
          </Button>
          <Button
            variant="danger"
            onClick={() => mut.mutate({ trash: true })}
            disabled={mut.isPending}
            title="Trash"
          >
            <Trash2 className="h-3 w-3" />
          </Button>
        </div>
      )}
    </div>
  );
}

function ThreadRow({
  thread,
  selectedForBulk,
  onToggle,
  isOpen,
  onSelect,
}: {
  thread: Thread;
  selectedForBulk: boolean;
  onToggle: () => void;
  isOpen: boolean;
  onSelect: () => void;
}) {
  const starred = has(thread.flags_bitmap, FLAG_STARRED);

  return (
    <div
      className={cn(
        "group block w-full overflow-hidden border-b border-zinc-100 px-3 py-2.5 text-left transition-colors dark:border-zinc-800",
        isOpen
          ? "bg-zinc-100 dark:bg-zinc-800"
          : selectedForBulk
            ? "bg-blue-50 dark:bg-blue-950/30"
            : "hover:bg-zinc-50 dark:hover:bg-zinc-900",
      )}
    >
      <div className="flex min-w-0 items-baseline gap-2">
        <input
          type="checkbox"
          checked={selectedForBulk}
          onChange={(e) => {
            e.stopPropagation();
            onToggle();
          }}
          onClick={(e) => e.stopPropagation()}
          className={cn(
            "h-3 w-3 shrink-0 cursor-pointer rounded border-zinc-300",
            !selectedForBulk &&
              "opacity-0 transition-opacity group-hover:opacity-100",
          )}
        />
        {starred && (
          <Star className="h-3 w-3 shrink-0 fill-yellow-400 text-yellow-500" />
        )}
        <button
          type="button"
          onClick={onSelect}
          className="block min-w-0 flex-1 text-left"
        >
          <div className="flex min-w-0 items-baseline gap-2">
            <span className="min-w-0 flex-1 truncate text-sm font-medium">
              {thread.participants.slice(0, 2).join(", ") || "(no participants)"}
            </span>
            <span className="shrink-0 text-xs text-zinc-500">
              {formatDistanceToNow(new Date(thread.last_message_at), {
                addSuffix: true,
              })}
            </span>
          </div>
          <div className="mt-0.5 flex min-w-0 items-baseline gap-2">
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-sm",
                thread.unread_count > 0
                  ? "font-medium text-zinc-900 dark:text-zinc-100"
                  : "text-zinc-600 dark:text-zinc-400",
              )}
            >
              {thread.subject || "(no subject)"}
            </span>
            {thread.message_count > 1 && (
              <span className="shrink-0 text-xs text-zinc-500">
                {thread.message_count}
              </span>
            )}
            {thread.unread_count > 0 && (
              <span className="h-2 w-2 shrink-0 rounded-full bg-blue-500" />
            )}
          </div>
          {thread.snippet && (
            <div className="mt-1 truncate text-xs text-zinc-500">
              {thread.snippet}
            </div>
          )}
        </button>
      </div>
    </div>
  );
}
