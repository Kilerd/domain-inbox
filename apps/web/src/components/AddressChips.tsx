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

// Accepts a bare address or an RFC-style `Name <addr@host>` form and returns
// the lowercased address, or null when nothing parseable is found.
function extractEmail(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const angle = trimmed.match(/<([^<>]+)>/);
  const candidate = (angle ? angle[1]! : trimmed).trim().toLowerCase();
  return EMAIL_RE.test(candidate) ? candidate : null;
}

export function AddressChips({ label, values, onChange, placeholder, autoFocus }: Props) {
  const [draft, setDraft] = useState("");
  const [invalidParts, setInvalidParts] = useState<string[]>([]);

  function commit(raw: string) {
    const cleaned = raw.trim().replace(/^,|,$/, "").trim();
    if (!cleaned) return;
    // Split on commas/semicolons only — spaces are significant inside
    // `Name <a@b.com>` forms. Pieces without angle brackets may still hold
    // several whitespace-separated bare addresses.
    const pieces = cleaned
      .split(/[,;]+/)
      .flatMap((p) => (p.includes("<") ? [p] : p.split(/\s+/)))
      .map((p) => p.trim())
      .filter(Boolean);
    const next = [...values];
    const bad: string[] = [];
    for (const piece of pieces) {
      const email = extractEmail(piece);
      if (!email) {
        bad.push(piece);
        continue;
      }
      if (!next.includes(email)) next.push(email);
    }
    onChange(next);
    // Keep anything unparseable in the input, visibly flagged, instead of
    // silently dropping it.
    setDraft(bad.join(", "));
    setInvalidParts(bad);
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
          "mt-1 flex min-h-[34px] flex-wrap items-center gap-1 rounded-md border bg-white px-2 py-1.5",
          "dark:bg-zinc-900",
          invalidParts.length > 0
            ? "border-red-400 focus-within:border-red-500 focus-within:ring-1 focus-within:ring-red-500 dark:border-red-700"
            : "border-zinc-200 focus-within:border-blue-500 focus-within:ring-1 focus-within:ring-blue-500 dark:border-zinc-700",
        )}
      >
        {values.map((v, i) => (
          <span
            key={v + i}
            className="inline-flex max-w-full items-center gap-1 rounded bg-zinc-100 px-1.5 py-0.5 text-xs dark:bg-zinc-800"
          >
            <span className="truncate font-mono" title={v}>{v}</span>
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
          type="text"
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            if (invalidParts.length) setInvalidParts([]);
          }}
          onKeyDown={onKey}
          onBlur={() => draft && commit(draft)}
          placeholder={values.length === 0 ? placeholder : ""}
          className={cn(
            "min-w-[120px] flex-1 bg-transparent text-sm placeholder:text-zinc-400 focus:outline-none",
            invalidParts.length > 0 && "text-red-600 dark:text-red-400",
          )}
        />
      </div>
      {invalidParts.length > 0 && (
        <p className="mt-1 text-xs text-red-600 dark:text-red-400">
          Not a valid address: {invalidParts.join(", ")} — fix it or clear the
          input.
        </p>
      )}
    </label>
  );
}
