import { Pencil } from "lucide-react";
import { useEffect, useState } from "react";
import type { InboxView, Thread, ThreadFlagsPatch } from "@/api";
import { Navigator } from "@/components/Navigator";
import { SearchBar } from "@/components/SearchBar";
import { ThreadDetail } from "@/components/ThreadDetail";
import { ThreadList } from "@/components/ThreadList";
import { Button } from "@/components/ui";
import { useCompose } from "@/lib/compose-store";
import { InboxViewProvider, useInboxView } from "@/lib/inbox-view";

export function InboxScreen() {
  return (
    <InboxViewProvider>
      <Layout />
    </InboxViewProvider>
  );
}

function ComposeButton() {
  const { openCompose } = useCompose();
  return (
    <Button
      variant="primary"
      onClick={() => openCompose({ mode: "new" })}
      title="Compose new message"
    >
      <Pencil className="h-3 w-3" />
      Compose
    </Button>
  );
}

// Does applying `patch` to a thread remove it from `view`? Mirrors the
// worker's viewClause() semantics (apps/worker/src/api/inbox.ts): inbox
// excludes archived/trash/spam; unread excludes trash/spam; the flag views
// each check only their own flag. Deliberately ignores `read` so implicitly
// marking an open thread read in the "unread" view doesn't close it.
function patchHidesThreadInView(view: InboxView, patch: ThreadFlagsPatch): boolean {
  switch (view) {
    case "inbox":
      return patch.trash === true || patch.spam === true || patch.archive === true;
    case "unread":
      return patch.trash === true || patch.spam === true;
    case "starred":
      return patch.star === false;
    case "archived":
      return patch.archive === false;
    case "trash":
      return patch.trash === false;
    case "spam":
      return patch.spam === false;
    case "sent":
    case "all":
      return false;
  }
}

function Layout() {
  const [selected, setSelected] = useState<Thread | null>(null);
  const { state } = useInboxView();

  // Clear selected thread when the view filter changes (so we don't show a
  // thread from a now-hidden domain/view).
  useEffect(() => {
    setSelected(null);
  }, [state.view, state.domainId, state.aliasId]);

  return (
    <div className="flex flex-1 overflow-hidden">
      <aside className="w-[240px] shrink-0 border-r border-zinc-200 bg-white px-2 dark:border-zinc-800 dark:bg-zinc-900">
        <Navigator />
      </aside>
      <div className="flex w-[380px] shrink-0 flex-col border-r border-zinc-200 dark:border-zinc-800">
        <div className="flex shrink-0 items-center gap-2 border-b border-zinc-200 px-3 py-2 dark:border-zinc-800">
          <ComposeButton />
          <SearchBar />
        </div>
        <div className="flex-1 overflow-hidden">
          <ThreadList
            selectedThreadId={selected?.id ?? null}
            onSelect={setSelected}
            onBulkFlags={(ids, patch) => {
              // A bulk action that included the open thread and removed it
              // from this view — don't keep the dead thread rendered.
              if (
                selected &&
                ids.includes(selected.id) &&
                patchHidesThreadInView(state.view, patch)
              ) {
                setSelected(null);
              }
            }}
          />
        </div>
      </div>
      <main className="flex-1 overflow-hidden">
        {selected ? (
          <ThreadDetail
            threadId={selected.id}
            onFlagsChanged={(patch) => {
              // Trashed/archived/… out of the current view from the detail
              // header — clear the selection instead of showing a dead thread.
              if (patchHidesThreadInView(state.view, patch)) setSelected(null);
            }}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-zinc-500">
            Select a thread to view messages.
          </div>
        )}
      </main>
    </div>
  );
}
