import { Search, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useInboxView } from "@/lib/inbox-view";

/**
 * Debounced search input. Writes into the shared inbox view state on a small
 * delay so we don't fire one HTTP request per keystroke.
 */
export function SearchBar() {
  const { state, setQuery } = useInboxView();
  const [draft, setDraft] = useState(state.query);

  useEffect(() => {
    setDraft(state.query);
  }, [state.query]);

  useEffect(() => {
    const handle = setTimeout(() => {
      if (draft !== state.query) setQuery(draft);
    }, 200);
    return () => clearTimeout(handle);
  }, [draft, state.query, setQuery]);

  return (
    <div className="relative flex-1 max-w-xl">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
      <input
        type="search"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="Search subject / snippet / from"
        className="block w-full rounded-md border border-zinc-200 bg-white py-1.5 pl-8 pr-8 text-sm placeholder:text-zinc-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:placeholder:text-zinc-500"
      />
      {draft && (
        <button
          type="button"
          onClick={() => setDraft("")}
          className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800 dark:hover:text-zinc-300"
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}
