import { Menu, Pencil } from "lucide-react";
import { useEffect, useState } from "react";
import type { InboxView, Thread, ThreadFlagsPatch } from "@/api";
import { Navigator } from "@/components/Navigator";
import { SearchBar } from "@/components/SearchBar";
import { ThreadDetail } from "@/components/ThreadDetail";
import { ThreadList } from "@/components/ThreadList";
import { Button, FOCUS_RING } from "@/components/ui";
import { useCompose } from "@/lib/compose-store";
import { InboxViewProvider, useInboxView } from "@/lib/inbox-view";
import { cn } from "@/lib/utils";

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
      aria-label="Compose new message"
    >
      <Pencil className="h-3 w-3" />
      <span className="hidden sm:inline">Compose</span>
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
  const [navOpen, setNavOpen] = useState(false);
  const { state } = useInboxView();

  // Clear selected thread when the view filter changes (so we don't show a
  // thread from a now-hidden domain/view).
  useEffect(() => {
    setSelected(null);
    setNavOpen(false);
  }, [state.view, state.domainId, state.aliasId]);

  // Close the mobile folder drawer on Escape.
  useEffect(() => {
    if (!navOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setNavOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navOpen]);

  return (
    // Mobile (<md): one pane at a time — thread list, or the open thread.
    // Tablet (md): list + detail. Desktop (lg+): folders + list + detail.
    <div className="relative flex flex-1 overflow-hidden">
      {navOpen && (
        <div
          className="absolute inset-0 z-30 bg-black/30 lg:hidden"
          onClick={() => setNavOpen(false)}
          aria-hidden="true"
        />
      )}
      <aside
        className={cn(
          "absolute inset-y-0 left-0 z-40 w-[280px] max-w-[85vw] shrink-0 border-r border-zinc-200 bg-white px-2 transition-transform duration-200 dark:border-zinc-800 dark:bg-zinc-900",
          "lg:static lg:z-auto lg:w-[240px] lg:translate-x-0 lg:shadow-none lg:transition-none",
          navOpen ? "translate-x-0 shadow-xl" : "-translate-x-full",
        )}
      >
        <Navigator onNavigate={() => setNavOpen(false)} />
      </aside>
      <div className="flex w-full shrink-0 flex-col border-r border-zinc-200 dark:border-zinc-800 md:w-[380px]">
        <div className="flex shrink-0 items-center gap-2 border-b border-zinc-200 px-3 py-2 dark:border-zinc-800">
          <button
            type="button"
            onClick={() => setNavOpen(true)}
            className={cn(
              "inline-flex shrink-0 items-center rounded-md p-1.5 text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800 lg:hidden",
              FOCUS_RING,
            )}
            title="Folders"
            aria-label="Open folders"
          >
            <Menu className="h-4 w-4" />
          </button>
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
      <main
        className={cn(
          "absolute inset-0 z-20 overflow-hidden bg-zinc-50 dark:bg-zinc-950",
          "md:static md:z-auto md:min-w-0 md:flex-1",
          !selected && "hidden md:block",
        )}
      >
        {selected ? (
          <ThreadDetail
            threadId={selected.id}
            onBack={() => setSelected(null)}
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
