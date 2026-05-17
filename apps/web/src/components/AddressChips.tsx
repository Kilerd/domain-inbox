import { X } from "lucide-react";
import { useState, type KeyboardEvent } from "react";
import { cn } from "@/lib/utils";

const EMAIL_RE = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;

interface Props {
  label: string;
  values: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  autoFocus?: boolean;
}

export function AddressChips({ label, values, onChange, placeholder, autoFocus }: Props) {
  const [draft, setDraft] = useState("");

  function commit(raw: string) {
    const cleaned = raw.trim().replace(/^,|,$/, "").trim().toLowerCase();
    if (!cleaned) return;
    // Allow splitting on comma + commit each piece.
    const parts = cleaned.split(/[,\s]+/).map((p) => p.trim()).filter(Boolean);
    const next = [...values];
    for (const p of parts) {
      if (!EMAIL_RE.test(p)) continue;
      if (next.includes(p)) continue;
      next.push(p);
    }
    onChange(next);
    setDraft("");
  }

  function onKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" || e.key === "," || e.key === "Tab") {
      if (draft.trim()) {
        e.preventDefault();
        commit(draft);
      }
    } else if (e.key === "Backspace" && !draft && values.length > 0) {
      e.preventDefault();
      onChange(values.slice(0, -1));
    }
  }

  function remove(idx: number) {
    onChange(values.filter((_, i) => i !== idx));
  }

  return (
    <label className="block">
      <span className="block text-[11px] font-medium uppercase tracking-wide text-zinc-500">
        {label}
      </span>
      <div
        className={cn(
          "mt-1 flex min-h-[34px] flex-wrap items-center gap-1 rounded-md border border-zinc-200 bg-white px-2 py-1.5",
          "focus-within:border-blue-500 focus-within:ring-1 focus-within:ring-blue-500",
          "dark:border-zinc-700 dark:bg-zinc-900",
        )}
      >
        {values.map((v, i) => (
          <span
            key={v + i}
            className="inline-flex items-center gap-1 rounded bg-zinc-100 px-1.5 py-0.5 text-xs dark:bg-zinc-800"
          >
            <span className="font-mono">{v}</span>
            <button
              type="button"
              onClick={() => remove(i)}
              className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
        <input
          autoFocus={autoFocus}
          type="email"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKey}
          onBlur={() => draft && commit(draft)}
          placeholder={values.length === 0 ? placeholder : ""}
          className="min-w-[120px] flex-1 bg-transparent text-sm placeholder:text-zinc-400 focus:outline-none"
        />
      </div>
    </label>
  );
}
