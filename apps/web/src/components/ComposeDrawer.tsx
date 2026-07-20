import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Send, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "@/api";
import { AddressChips } from "@/components/AddressChips";
import { AttachmentDropzone, type ComposeAttachment } from "@/components/AttachmentDropzone";
import { Button, ErrorText, FOCUS_RING, Input, Textarea } from "@/components/ui";
import { useCompose, type ComposePrefill } from "@/lib/compose-store";
import { cn } from "@/lib/utils";

// Drafts are scoped by the kind of compose: a fresh "new" draft is shared,
// while replies/forwards/test sends key off the source message id (or the
// domain for test sends) so each prompt restores its own work-in-progress.
function draftKey(prefill: ComposePrefill | null): string {
  if (!prefill) return "compose:draft:new";
  if (prefill.mode === "reply" || prefill.mode === "reply-all" || prefill.mode === "forward") {
    // Forwards carry no In-Reply-To, and some inbound messages lack an
    // rfc822 Message-ID — fall back to our own message id so drafts for
    // different source messages never share a key.
    const id = prefill.inReplyTo ?? prefill.sourceMessageId ?? "no-id";
    return `compose:draft:${prefill.mode}:${id}`;
  }
  if (prefill.mode === "test") return `compose:draft:test:${prefill.testDomain ?? ""}`;
  return "compose:draft:new";
}

interface DraftState {
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  bodyMode: "text" | "html";
  attachments: ComposeAttachment[];
}

function emptyDraft(prefill: ComposePrefill | null): DraftState {
  return {
    from: prefill?.from ?? "",
    to: prefill?.to ?? [],
    cc: prefill?.cc ?? [],
    bcc: prefill?.bcc ?? [],
    subject: prefill?.subject ?? "",
    body: prefill?.bodyMode === "html" ? prefill.html ?? "" : prefill?.text ?? "",
    bodyMode: prefill?.bodyMode ?? "text",
    attachments: [],
  };
}

// What actually hits localStorage: text fields plus attachment *names* only.
// Base64 attachment content can easily blow the ~5MB quota, and a throwing
// setItem used to drop the whole draft — so file bytes are never persisted.
interface PersistedDraft {
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  bodyMode: "text" | "html";
  attachment_names: string[];
}

interface LoadedDraft {
  state: DraftState;
  // Names of attachments that were on the draft when it was saved; their
  // content is gone, so the user must re-add the files.
  missingAttachments: string[];
}

function loadDraft(key: string): LoadedDraft | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PersistedDraft> & {
      // Legacy drafts stored full attachments; salvage the names.
      attachments?: Array<{ filename?: string }>;
    };
    const missingAttachments =
      parsed.attachment_names ??
      (parsed.attachments ?? [])
        .map((a) => a.filename ?? "")
        .filter(Boolean);
    return {
      state: {
        from: parsed.from ?? "",
        to: parsed.to ?? [],
        cc: parsed.cc ?? [],
        bcc: parsed.bcc ?? [],
        subject: parsed.subject ?? "",
        body: parsed.body ?? "",
        bodyMode: parsed.bodyMode === "html" ? "html" : "text",
        attachments: [],
      },
      missingAttachments,
    };
  } catch {
    return null;
  }
}

function persistDraft(key: string, draft: DraftState) {
  try {
    // Skip persisting if nothing useful was typed yet.
    const hasContent =
      draft.to.length || draft.cc.length || draft.bcc.length ||
      draft.subject.trim() || draft.body.trim() || draft.attachments.length;
    if (!hasContent) {
      localStorage.removeItem(key);
      return;
    }
    const persisted: PersistedDraft = {
      from: draft.from,
      to: draft.to,
      cc: draft.cc,
      bcc: draft.bcc,
      subject: draft.subject,
      body: draft.body,
      bodyMode: draft.bodyMode,
      attachment_names: draft.attachments.map((a) => a.filename),
    };
    localStorage.setItem(key, JSON.stringify(persisted));
  } catch {
    // Quota exceeded etc — silently drop; loss-tolerant.
  }
}

// A usable From needs a non-empty local part AND a non-empty domain —
// "@example.com" (as left behind by the "…@domain" picker template) is not
// sendable.
function isValidFromAddress(addr: string): boolean {
  const at = addr.indexOf("@");
  return at > 0 && at < addr.length - 1;
}

function discardDraft(key: string) {
  try {
    localStorage.removeItem(key);
  } catch {
    /* noop */
  }
}

export function ComposeDrawer() {
  const { open, prefill, close } = useCompose();
  const qc = useQueryClient();
  const [draft, setDraft] = useState<DraftState>(() => emptyDraft(null));
  const [showCcBcc, setShowCcBcc] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Attachment names from a restored draft whose content wasn't persisted.
  const [missingAttachments, setMissingAttachments] = useState<string[]>([]);
  const subjectRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  const suggestions = useQuery({
    queryKey: ["compose", "from-suggestions"],
    queryFn: api.fromSuggestions,
    enabled: open,
    staleTime: 60_000,
  });
  const domainsQ = useQuery({
    queryKey: ["domains"],
    queryFn: api.listDomains,
    enabled: open,
    staleTime: 60_000,
  });
  const me = useQuery({ queryKey: ["me"], queryFn: api.me });

  const dkey = draftKey(prefill);

  // Reset draft state when a new prefill arrives — pull from localStorage if
  // we have a saved work-in-progress for this exact compose key, else start
  // from the prefill itself.
  useEffect(() => {
    if (!open) return;
    const saved = loadDraft(dkey);
    const next = saved ? saved.state : emptyDraft(prefill);
    if (saved) {
      setDraft(saved.state);
      setShowCcBcc(saved.state.cc.length > 0 || saved.state.bcc.length > 0);
      setMissingAttachments(saved.missingAttachments);
    } else {
      setDraft(emptyDraft(prefill));
      setShowCcBcc(Boolean((prefill?.cc?.length ?? 0) + (prefill?.bcc?.length ?? 0)));
      setMissingAttachments([]);
    }
    setErr(null);
    // Focus the first empty field. An empty To autofocuses itself via
    // AddressChips; otherwise move focus on to Subject, then Body.
    if (next.to.length > 0) {
      const target = next.subject.trim() ? bodyRef.current : subjectRef.current;
      requestAnimationFrame(() => target?.focus());
    }
  }, [open, prefill, dkey]);

  // Autosave whenever draft mutates.
  useEffect(() => {
    if (!open) return;
    persistDraft(dkey, draft);
  }, [open, dkey, draft]);

  // Pick a default From when none was prefilled.
  useEffect(() => {
    if (!open || draft.from) return;
    const recent = suggestions.data?.data[0]?.address;
    const firstVerified = domainsQ.data?.find((d) => d.status === "verified")?.name;
    if (recent) {
      setDraft((d) => ({ ...d, from: recent }));
    } else if (firstVerified) {
      setDraft((d) => ({ ...d, from: `hello@${firstVerified}` }));
    }
  }, [open, draft.from, suggestions.data, domainsQ.data]);

  const sendMut = useMutation({
    mutationFn: async () => {
      const headers: Record<string, string> = {};
      if (prefill?.inReplyTo) headers["In-Reply-To"] = `<${prefill.inReplyTo}>`;
      if (prefill?.references && prefill.references.length > 0) {
        headers["References"] = prefill.references.map((r) => `<${r}>`).join(" ");
      }
      return api.composeEmail({
        from: draft.from,
        to: draft.to,
        cc: draft.cc.length ? draft.cc : undefined,
        bcc: draft.bcc.length ? draft.bcc : undefined,
        subject: draft.subject || "(no subject)",
        text: draft.bodyMode === "text" ? draft.body : undefined,
        html: draft.bodyMode === "html" ? draft.body : undefined,
        headers: Object.keys(headers).length ? headers : undefined,
        attachments: draft.attachments.length
          ? draft.attachments.map((a) => ({
              filename: a.filename,
              content: a.content,
              content_type: a.content_type,
            }))
          : undefined,
      });
    },
    onSuccess: () => {
      discardDraft(dkey);
      qc.invalidateQueries({ queryKey: ["inbox"] });
      qc.invalidateQueries({ queryKey: ["thread"] });
      close();
    },
    onError: (e) => setErr(e instanceof ApiError ? e.message : String(e)),
  });

  // Escape closes the drawer. Safe: the draft autosaves on every change.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !sendMut.isPending) close();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close, sendMut.isPending]);

  if (!open) return null;

  const canSend =
    isValidFromAddress(draft.from.trim()) &&
    draft.to.length > 0 &&
    !sendMut.isPending;

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 bg-black/30"
        onClick={() => !sendMut.isPending && close()}
      />
      {/* Drawer */}
      <aside
        className={cn(
          "fixed inset-y-0 right-0 z-50 flex w-full max-w-[640px] flex-col",
          "border-l border-zinc-200 bg-white text-zinc-900 shadow-xl",
          "dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100",
        )}
        aria-modal="true"
        role="dialog"
      >
        <header className="flex shrink-0 items-center gap-3 border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <h2 className="text-sm font-semibold">{titleFor(prefill)}</h2>
          <button
            type="button"
            onClick={() => !sendMut.isPending && close()}
            className={cn(
              "ml-auto rounded p-1 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800 dark:hover:bg-zinc-800 dark:hover:text-zinc-100",
              FOCUS_RING,
            )}
            title="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-4 py-4">
          <FromField
            value={draft.from}
            onChange={(v) => setDraft((d) => ({ ...d, from: v }))}
            suggestions={(suggestions.data?.data ?? []).map((s) => s.address)}
            domainNames={(domainsQ.data ?? [])
              .filter((d) => d.status === "verified")
              .map((d) => d.name)}
          />

          <div className="mt-3">
            <AddressChips
              label="To"
              values={draft.to}
              onChange={(to) => setDraft((d) => ({ ...d, to }))}
              placeholder="recipient@example.com"
              autoFocus={!prefill?.to?.length}
            />
          </div>

          {showCcBcc ? (
            <>
              <div className="mt-3">
                <AddressChips
                  label="Cc"
                  values={draft.cc}
                  onChange={(cc) => setDraft((d) => ({ ...d, cc }))}
                />
              </div>
              <div className="mt-3">
                <AddressChips
                  label="Bcc"
                  values={draft.bcc}
                  onChange={(bcc) => setDraft((d) => ({ ...d, bcc }))}
                />
              </div>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setShowCcBcc(true)}
              className="mt-2 text-xs text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
            >
              + Cc / Bcc
            </button>
          )}

          <label className="mt-3 block">
            <span className="block text-[11px] font-medium uppercase tracking-wide text-zinc-500">
              Subject
            </span>
            <Input
              ref={subjectRef}
              type="text"
              value={draft.subject}
              onChange={(e) => setDraft((d) => ({ ...d, subject: e.target.value }))}
              placeholder="(no subject)"
              className="mt-1"
            />
          </label>

          <div className="mt-3">
            <div className="flex items-center gap-2">
              <span className="block text-[11px] font-medium uppercase tracking-wide text-zinc-500">
                Body
              </span>
              <span className="ml-auto inline-flex overflow-hidden rounded border border-zinc-200 text-[10px] dark:border-zinc-700">
                <button
                  type="button"
                  onClick={() => setDraft((d) => ({ ...d, bodyMode: "text" }))}
                  className={cn(
                    "px-2 py-0.5",
                    draft.bodyMode === "text"
                      ? "bg-zinc-200 dark:bg-zinc-700"
                      : "hover:bg-zinc-100 dark:hover:bg-zinc-800",
                  )}
                >
                  Plain
                </button>
                <button
                  type="button"
                  onClick={() => setDraft((d) => ({ ...d, bodyMode: "html" }))}
                  className={cn(
                    "px-2 py-0.5 border-l border-zinc-200 dark:border-zinc-700",
                    draft.bodyMode === "html"
                      ? "bg-zinc-200 dark:bg-zinc-700"
                      : "hover:bg-zinc-100 dark:hover:bg-zinc-800",
                  )}
                >
                  HTML
                </button>
              </span>
            </div>
            <Textarea
              ref={bodyRef}
              value={draft.body}
              onChange={(e) => setDraft((d) => ({ ...d, body: e.target.value }))}
              placeholder={
                draft.bodyMode === "html"
                  ? "<p>Type HTML here…</p>"
                  : "Type your message…"
              }
              className="mt-1 min-h-[280px] resize-y font-mono"
            />
          </div>

          <div className="mt-4">
            <AttachmentDropzone
              attachments={draft.attachments}
              onChange={(attachments) => setDraft((d) => ({ ...d, attachments }))}
            />
            {missingAttachments.length > 0 && (
              <p className="mt-1 flex items-start gap-1 text-xs text-amber-600 dark:text-amber-400">
                <span>
                  Attachment files aren&apos;t saved with drafts — re-add:{" "}
                  {missingAttachments.join(", ")}
                </span>
                <button
                  type="button"
                  onClick={() => setMissingAttachments([])}
                  className="shrink-0 underline hover:text-amber-700 dark:hover:text-amber-300"
                >
                  dismiss
                </button>
              </p>
            )}
          </div>

          {err && <ErrorText>{err}</ErrorText>}
          {me.data && draft.from && !isValidFromAddress(draft.from.trim()) && (
            <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">
              {draft.from.includes("@")
                ? "`from` needs a local part before the @ (e.g. hello@domain)."
                : "`from` looks malformed (missing @)."}
            </p>
          )}
        </div>

        <footer className="flex shrink-0 items-center gap-2 border-t border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <Button
            variant="primary"
            onClick={() => sendMut.mutate()}
            disabled={!canSend}
          >
            <Send className="h-3 w-3" />
            {sendMut.isPending ? "Sending…" : "Send"}
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              if (confirm("Discard this draft?")) {
                discardDraft(dkey);
                close();
              }
            }}
            disabled={sendMut.isPending}
            title="Discard draft and close"
          >
            Discard
          </Button>
          <span className="ml-auto text-[10px] text-zinc-500">
            Drafts autosave locally (attachments excluded)
          </span>
        </footer>
      </aside>
    </>
  );
}

function titleFor(prefill: ComposePrefill | null): string {
  if (!prefill) return "New message";
  switch (prefill.mode) {
    case "reply":
      return "Reply";
    case "reply-all":
      return "Reply all";
    case "forward":
      return "Forward";
    case "test":
      return `Test send · ${prefill.testDomain ?? ""}`;
    case "new":
    default:
      return "New message";
  }
}

function FromField({
  value,
  onChange,
  suggestions,
  domainNames,
}: {
  value: string;
  onChange: (v: string) => void;
  suggestions: string[];
  domainNames: string[];
}) {
  const [editing, setEditing] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  // Build a unique list of candidate options.
  const seen = new Set<string>();
  const options: string[] = [];
  for (const s of suggestions) {
    if (!seen.has(s)) {
      seen.add(s);
      options.push(s);
    }
  }
  // Also offer a "<local>@<domain>" template for each verified domain so the
  // user can pick a fresh local-part on a catch-all-enabled domain.
  for (const d of domainNames) {
    const placeholder = `…@${d}`;
    if (!options.some((o) => o.endsWith(`@${d}`))) options.push(placeholder);
  }

  useEffect(() => {
    if (!editing) return;
    function handle(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setEditing(false);
    }
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [editing]);

  return (
    <label className="block">
      <span className="block text-[11px] font-medium uppercase tracking-wide text-zinc-500">
        From
      </span>
      <div ref={ref} className="relative mt-1">
        <button
          type="button"
          onClick={() => setEditing((v) => !v)}
          className={cn(
            "flex w-full items-center justify-between rounded-md border border-zinc-200 bg-white px-2.5 py-1.5 text-left text-sm dark:border-zinc-700 dark:bg-zinc-900",
            FOCUS_RING,
          )}
        >
          <span className={cn("truncate font-mono", !value && "text-zinc-400")}>
            {value || "Pick a from address"}
          </span>
          <ChevronDown className="h-3.5 w-3.5 text-zinc-400" />
        </button>
        {editing && (
          <div className="absolute left-0 right-0 top-full z-10 mt-1 overflow-hidden rounded-md border border-zinc-200 bg-white shadow-lg dark:border-zinc-800 dark:bg-zinc-900">
            {options.map((o) => (
              <button
                key={o}
                type="button"
                onClick={() => {
                  onChange(o.startsWith("…@") ? `@${o.slice(2)}` : o);
                  if (!o.startsWith("…@")) setEditing(false);
                }}
                className="block w-full px-3 py-1.5 text-left font-mono text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800"
              >
                {o}
              </button>
            ))}
            <div className="border-t border-zinc-100 px-3 py-2 dark:border-zinc-800">
              <span className="block text-[10px] font-medium uppercase tracking-wide text-zinc-500">
                Custom
              </span>
              <input
                type="email"
                value={value}
                onChange={(e) => onChange(e.target.value)}
                placeholder="local-part@verified-domain"
                className="mt-1 block w-full rounded border border-zinc-200 bg-white px-2 py-1 font-mono text-sm placeholder:text-zinc-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-zinc-700 dark:bg-zinc-900 dark:placeholder:text-zinc-500"
              />
            </div>
          </div>
        )}
      </div>
    </label>
  );
}
