import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import {
  Archive,
  Eye,
  Forward,
  MousePointerClick,
  Paperclip,
  Reply,
  ReplyAll,
  ShieldAlert,
  Star,
  Trash2,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, type ActivityEvent, type Message, type ThreadDetail as TThreadDetail } from "@/api";
import { Badge, Button } from "@/components/ui";
import { FLAG_ARCHIVED, FLAG_SPAM, FLAG_STARRED, FLAG_TRASH, has } from "@/lib/flags";
import { useCompose, type ComposePrefill } from "@/lib/compose-store";
import { cn } from "@/lib/utils";

function normalizeSubjectPrefix(subject: string, prefix: "Re:" | "Fwd:"): string {
  let prev = "";
  let cur = (subject ?? "").trim();
  while (cur !== prev) {
    prev = cur;
    cur = cur.replace(/^(re|fwd?|fw):\s*/i, "");
  }
  return `${prefix} ${cur}`.trim();
}

function dedupeAddrs(arr: string[], ownEmails: Set<string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of arr) {
    const m = raw.match(/<([^>]+)>/);
    const addr = (m ? m[1]! : raw).trim().toLowerCase();
    if (ownEmails.has(addr)) continue;
    if (seen.has(addr)) continue;
    seen.add(addr);
    out.push(addr);
  }
  return out;
}

interface Props {
  threadId: string;
}

export function ThreadDetail({ threadId }: Props) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["thread", threadId],
    queryFn: () => api.getThread(threadId),
  });
  const flagsMut = useMutation({
    mutationFn: (patch: Parameters<typeof api.setThreadFlags>[1]) =>
      api.setThreadFlags(threadId, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["inbox"] }),
  });

  if (q.isLoading)
    return <div className="p-6 text-sm text-zinc-500">loading thread…</div>;
  if (q.error)
    return <div className="p-6 text-sm text-red-600">{String(q.error)}</div>;
  if (!q.data) return null;

  const t = q.data.thread;
  const isStarred = has(t.flags_bitmap, FLAG_STARRED);
  const isArchived = has(t.flags_bitmap, FLAG_ARCHIVED);
  const isTrash = has(t.flags_bitmap, FLAG_TRASH);
  const isSpam = has(t.flags_bitmap, FLAG_SPAM);

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-start justify-between gap-3 border-b border-zinc-200 px-6 py-4 dark:border-zinc-800">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-lg font-semibold">
            {q.data.thread.subject || "(no subject)"}
          </h2>
          <p className="mt-1 truncate text-xs text-zinc-500">
            {q.data.thread.participants.join(", ")}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant={isStarred ? "secondary" : "ghost"}
            onClick={() => flagsMut.mutate({ star: !isStarred })}
            disabled={flagsMut.isPending}
            title={isStarred ? "Unstar" : "Star"}
          >
            <Star className={cn("h-3 w-3", isStarred && "fill-yellow-400 text-yellow-500")} />
          </Button>
          <Button
            variant={isArchived ? "secondary" : "ghost"}
            onClick={() => flagsMut.mutate({ archive: !isArchived })}
            disabled={flagsMut.isPending}
            title={isArchived ? "Move out of archive" : "Archive"}
          >
            <Archive className="h-3 w-3" />
          </Button>
          <Button
            variant={isSpam ? "secondary" : "ghost"}
            onClick={() => flagsMut.mutate({ spam: !isSpam })}
            disabled={flagsMut.isPending}
            title={isSpam ? "Not spam" : "Mark spam"}
          >
            <ShieldAlert className="h-3 w-3" />
          </Button>
          <Button
            variant={isTrash ? "secondary" : "danger"}
            onClick={() => flagsMut.mutate({ trash: !isTrash })}
            disabled={flagsMut.isPending}
            title={isTrash ? "Restore from trash" : "Move to trash"}
          >
            <Trash2 className="h-3 w-3" />
          </Button>
        </div>
      </header>
      <div className="flex-1 space-y-4 overflow-y-auto p-6">
        {q.data.messages.map((m, i) => (
          <MessageCard
            key={m.id}
            message={m}
            defaultOpen={i === q.data.messages.length - 1}
            threadId={threadId}
            thread={q.data}
          />
        ))}
      </div>
    </div>
  );
}

function useReplyHandlers(
  message: Message,
  thread: TThreadDetail,
): {
  reply: () => void;
  replyAll: () => void;
  forward: () => void;
} {
  const { openCompose } = useCompose();
  const meQ = useQuery({ queryKey: ["me"], queryFn: api.me });
  const domainsQ = useQuery({ queryKey: ["v1", "domains"], queryFn: api.listDomains });
  const suggestionsQ = useQuery({
    queryKey: ["compose", "from-suggestions"],
    queryFn: api.fromSuggestions,
    staleTime: 60_000,
  });

  function pickOwnFromAddress(): string {
    const myDomains = (domainsQ.data ?? []).map((d) => d.name.toLowerCase());

    function ownOf(addrs: string[]): string | null {
      for (const a of addrs) {
        const lower = a.toLowerCase();
        const dom = lower.split("@")[1];
        if (dom && myDomains.includes(dom)) return lower;
      }
      return null;
    }

    // Preference order:
    //   1. The recipient address on THIS message that belongs to one of our
    //      verified domains (preserves identity for direct replies).
    //   2. The recipient address on the earliest inbound message in this
    //      thread that belongs to our domains — this is the "they reached us
    //      at" identity, so every reply in the thread stays consistent.
    //   3. If this message is one we sent ourselves, the From we used then.
    //   4. The most-recent outbound From across all our mail.
    //   5. hello@<first verified domain> as a sensible default.

    const direct = ownOf([...message.to, ...message.cc]);
    if (direct) return direct;

    // Walk the thread inbound messages in chronological order to find the
    // canonical recipient identity.
    const inboundInThread = thread.messages.filter(
      (m) => m.direction === "inbound",
    );
    for (const m of inboundInThread) {
      const candidate = ownOf([...m.to, ...m.cc]);
      if (candidate) return candidate;
    }

    if (message.direction === "outbound" && message.from?.address) {
      return message.from.address.toLowerCase();
    }

    const recent = suggestionsQ.data?.data[0]?.address;
    if (recent) return recent.toLowerCase();
    const first = domainsQ.data?.find((d) => d.status === "verified")?.name;
    return first ? `hello@${first}` : "";
  }

  function buildPrefill(mode: ComposePrefill["mode"]): ComposePrefill {
    const myEmail = meQ.data?.email?.toLowerCase() ?? "";
    const fromAddr = pickOwnFromAddress();
    const ownEmails = new Set<string>([myEmail, fromAddr].filter(Boolean));

    const replyTarget = message.reply_to ?? message.from?.address ?? "";
    const baseSubject = message.subject ?? thread.thread.subject ?? "";

    const quoteHeader =
      "\n\n--- Original message ---\nFrom: " +
      (message.from?.address ?? "(unknown)") +
      "\nDate: " +
      (message.received_at
        ? new Date(message.received_at).toLocaleString()
        : "(unknown)") +
      "\nSubject: " +
      (message.subject ?? "(no subject)") +
      "\n";

    if (mode === "reply") {
      return {
        mode: "reply",
        from: fromAddr,
        to: replyTarget ? [replyTarget.toLowerCase()] : [],
        subject: normalizeSubjectPrefix(baseSubject, "Re:"),
        text: quoteHeader,
        bodyMode: "text",
        inReplyTo: message.rfc822_message_id ?? null,
        references: message.rfc822_message_id ? [message.rfc822_message_id] : [],
      };
    }
    if (mode === "reply-all") {
      const others = dedupeAddrs(
        [
          ...(message.from?.address ? [message.from.address] : []),
          ...message.to,
          ...message.cc,
        ],
        ownEmails,
      );
      const to = others.slice(0, 1);
      const cc = others.slice(1);
      return {
        mode: "reply-all",
        from: fromAddr,
        to,
        cc: cc.length ? cc : undefined,
        subject: normalizeSubjectPrefix(baseSubject, "Re:"),
        text: quoteHeader,
        bodyMode: "text",
        inReplyTo: message.rfc822_message_id ?? null,
        references: message.rfc822_message_id ? [message.rfc822_message_id] : [],
      };
    }
    if (mode === "forward") {
      return {
        mode: "forward",
        from: fromAddr,
        to: [],
        subject: normalizeSubjectPrefix(baseSubject, "Fwd:"),
        text:
          "\n\n---------- Forwarded message ----------\nFrom: " +
          (message.from?.address ?? "(unknown)") +
          "\nDate: " +
          (message.received_at
            ? new Date(message.received_at).toLocaleString()
            : "(unknown)") +
          "\nSubject: " +
          (message.subject ?? "(no subject)") +
          "\nTo: " +
          message.to.join(", ") +
          "\n",
        bodyMode: "text",
      };
    }
    return { mode: "new" };
  }

  return {
    reply: () => openCompose(buildPrefill("reply")),
    replyAll: () => openCompose(buildPrefill("reply-all")),
    forward: () => openCompose(buildPrefill("forward")),
  };
}

/**
 * Email body renderer that uses a Shadow DOM (not a sandboxed iframe) so the
 * container's height auto-fits content with zero measurement quirks. Safe
 * because:
 *   - sanitizeEmailHtml on the worker already strips <script>/<iframe>/<form>
 *     /<style>/<meta>/<link>/<object>/<embed> and all on* event handlers,
 *     and rewrites <img src> through /api/img-proxy
 *   - the residue is plain layout HTML with no execution surface
 *   - Shadow DOM gives us per-message CSS encapsulation so emails can't
 *     override the SPA's Tailwind classes
 */
function HtmlBody({ html }: { html: string }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [showQuote, setShowQuote] = useState(false);
  const hasQuote = /gmail_quote(_container)?\b|<blockquote/i.test(html);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const shadow =
      host.shadowRoot ?? host.attachShadow({ mode: "open" });

    // Force every link to open in a new tab (mirrors what <base target> did
    // in the old iframe path).
    const linkTargetScript = "";
    shadow.innerHTML = `
      <style>
        :host { display: block; color-scheme: light dark; }
        :host, .root {
          font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
          color: #18181b;
        }
        @media (prefers-color-scheme: dark) {
          :host, .root { color: #e4e4e7; }
        }
        .root { word-break: break-word; overflow-wrap: anywhere; }
        .root img { max-width: 100%; height: auto; }
        .root a { color: #2563eb; }
        ${
          !showQuote
            ? `.root .gmail_quote_container,
               .root .gmail_quote,
               .root blockquote.gmail_quote { display: none; }`
            : ""
        }
      </style>
      <div class="root">${html}</div>
      ${linkTargetScript}
    `;
    // sanitize already added target="_blank" rel=… to every <a>, but Shadow
    // DOM doesn't honor <base target>, so links open in current tab unless
    // we force target via DOM. Belt-and-suspenders:
    shadow.querySelectorAll("a").forEach((a) => {
      if (!a.getAttribute("target")) a.setAttribute("target", "_blank");
      if (!a.getAttribute("rel")) a.setAttribute("rel", "noopener noreferrer");
    });
  }, [html, showQuote]);

  return (
    <div>
      <div ref={hostRef} />
      {hasQuote && (
        <button
          type="button"
          onClick={() => setShowQuote((v) => !v)}
          className="mt-1 inline-flex items-center gap-1 rounded border border-zinc-200 px-1.5 py-0.5 text-[10px] text-zinc-500 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
        >
          •••&nbsp;{showQuote ? "Hide quoted text" : "Show quoted text"}
        </button>
      )}
    </div>
  );
}

function MessageCard({
  message,
  defaultOpen,
  threadId,
  thread,
}: {
  message: Message;
  defaultOpen: boolean;
  threadId: string;
  thread: TThreadDetail;
}) {
  const replyHandlers = useReplyHandlers(message, thread);
  const [open, setOpen] = useState(defaultOpen);
  const qc = useQueryClient();

  const bodyQ = useQuery({
    queryKey: ["body", message.id],
    queryFn: () => api.getBody(message.id),
    enabled: open,
  });

  const markRead = useMutation({
    mutationFn: () => api.markRead(message.id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["thread", threadId] });
      qc.invalidateQueries({ queryKey: ["threads"] });
    },
  });

  useEffect(() => {
    if (open && !message.is_read) markRead.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <div
      className={cn(
        "rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900",
        !message.is_read && "border-blue-200 dark:border-blue-900",
      )}
    >
      <button
        type="button"
        className="block w-full text-left"
        onClick={() => setOpen((v) => !v)}
      >
        <div className="flex items-baseline justify-between gap-2">
          <div className="truncate text-sm">
            <span className="font-medium">
              {message.from?.name || message.from?.address || "unknown"}
            </span>
            {message.from?.name && (
              <span className="ml-1 text-zinc-500">
                &lt;{message.from.address}&gt;
              </span>
            )}
          </div>
          <span className="shrink-0 text-xs text-zinc-500">
            {message.received_at && format(new Date(message.received_at), "PP p")}
          </span>
        </div>
        <div className="mt-0.5 text-xs text-zinc-500">
          to {message.to.join(", ")}
          {message.attachment_count > 0 && (
            <span className="ml-2 inline-flex items-baseline gap-0.5">
              <Paperclip className="h-3 w-3" />
              {message.attachment_count}
            </span>
          )}
        </div>
      </button>

      {open && (
        <div className="mt-3 border-t border-zinc-100 pt-3 dark:border-zinc-800">
          {bodyQ.isLoading && <div className="text-xs text-zinc-500">loading body…</div>}
          {bodyQ.error && (
            <div className="text-xs text-red-600">{String(bodyQ.error)}</div>
          )}
          {bodyQ.data && (
            <>
              {bodyQ.data.html ? (
                <HtmlBody html={bodyQ.data.html} />
              ) : bodyQ.data.text ? (
                <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-relaxed text-zinc-800 dark:text-zinc-200">
                  {bodyQ.data.text}
                </pre>
              ) : (
                <div className="text-xs text-zinc-500 italic">(empty body)</div>
              )}
              {message.attachments.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {message.attachments.map((a) => (
                    <a
                      key={a.id}
                      href={`/api/inbox/attachments/${a.id}`}
                      className="inline-flex items-center gap-1.5 rounded border border-zinc-200 bg-zinc-50 px-2.5 py-1 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-800 dark:hover:bg-zinc-700"
                    >
                      <Paperclip className="h-3 w-3" />
                      <span>{a.filename || "attachment"}</span>
                      {a.size_bytes != null && (
                        <span className="text-zinc-500">
                          ({Math.ceil(a.size_bytes / 1024)} KB)
                        </span>
                      )}
                    </a>
                  ))}
                </div>
              )}
              <div className="mt-3 flex items-center gap-2 border-t border-zinc-100 pt-3 dark:border-zinc-800">
                <Button variant="secondary" onClick={replyHandlers.reply}>
                  <Reply className="h-3 w-3" />
                  Reply
                </Button>
                <Button variant="ghost" onClick={replyHandlers.replyAll}>
                  <ReplyAll className="h-3 w-3" />
                  Reply all
                </Button>
                <Button variant="ghost" onClick={replyHandlers.forward}>
                  <Forward className="h-3 w-3" />
                  Forward
                </Button>
              </div>
              {message.direction === "outbound" && message.outbound_id && (
                <OutboundActivityPanel outboundId={message.outbound_id} />
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

const EVENT_TONE: Record<string, "success" | "danger" | "warn" | "neutral" | "info"> = {
  "email.sent": "success",
  "email.delivered": "success",
  "email.opened": "info",
  "email.clicked": "info",
  "email.bounced": "danger",
  "email.complained": "warn",
  "email.delivery_delayed": "warn",
  "email.failed": "danger",
  "email.canceled": "neutral",
  "email.scheduled": "info",
};

function OutboundActivityPanel({ outboundId }: { outboundId: string }) {
  const detail = useQuery({
    queryKey: ["outbound", outboundId],
    queryFn: () => api.getOutbound(outboundId),
  });
  const events = useQuery({
    queryKey: ["outbound", outboundId, "events"],
    queryFn: () => api.getOutboundEvents(outboundId),
  });
  const m = detail.data;
  if (!m && !detail.isLoading) return null;

  return (
    <div className="mt-3 rounded-md border border-zinc-100 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-900/50">
      <div className="mb-2 flex items-center justify-between text-xs">
        <span className="font-medium text-zinc-600 dark:text-zinc-400">Delivery activity</span>
        {m && <Badge tone={EVENT_TONE[`email.${m.status}`] ?? "neutral"}>{m.status}</Badge>}
      </div>
      {m?.tracking.enabled && (
        <div className="mb-2 flex items-center gap-3 text-xs text-zinc-600 dark:text-zinc-400">
          <span className="inline-flex items-center gap-1">
            <Eye className="h-3 w-3" /> {m.tracking.open_count} opens
          </span>
          <span className="inline-flex items-center gap-1">
            <MousePointerClick className="h-3 w-3" /> {m.tracking.click_count} clicks
          </span>
        </div>
      )}
      {events.data && (
        <ol className="space-y-1.5 text-xs">
          {events.data.data.map((e) => <EventLine key={e.id} ev={e} />)}
        </ol>
      )}
      {(detail.isLoading || events.isLoading) && (
        <p className="text-xs text-zinc-500">loading…</p>
      )}
    </div>
  );
}

function EventLine({ ev }: { ev: ActivityEvent }) {
  return (
    <li className="flex items-baseline justify-between gap-2">
      <code className="font-mono">{ev.type}</code>
      <span className="text-[10px] text-zinc-500">
        {format(new Date(ev.created_at), "MMM d, p")}
      </span>
    </li>
  );
}
