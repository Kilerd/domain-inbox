import type { AuthUser } from "../auth";
import type { Env } from "../env";
import { handleEmailSend } from "./emails";

/**
 * Browser-side compose endpoint. Reuses `handleEmailSend` (the Resend-shaped
 * sender) but auth comes from the cookie-session AuthUser instead of a
 * bearer API key. Internally we synthesize an ApiKeyAuth-shaped principal so
 * scope / domain_scope checks pass uniformly.
 */
export async function composeEmail(
  req: Request,
  env: Env,
  user: AuthUser,
  ctx?: ExecutionContext,
): Promise<Response> {
  const auth = {
    user_id: user.id,
    key_id: null as unknown as string, // nullable column in outbound_messages
    scopes: ["emails.send", "emails.read"],
    domain_scope: null,
  };
  // Keep the browser path synchronous: the drawer refetches the inbox as soon
  // as this resolves, so the sent message must already be persisted.
  return handleEmailSend(req, env, auth, ctx, false);
}

/**
 * From-address suggestions for the compose UI: recent outbound senders plus
 * any explicit aliases the user has access to. Deduped by full address.
 */
export async function fromSuggestions(env: Env, user: AuthUser): Promise<Response> {
  const recent = await env.DB
    .prepare(
      `SELECT from_addr, MAX(sent_at) AS used_at
       FROM messages
       WHERE owner_id = ?1 AND direction = 'outbound' AND from_addr IS NOT NULL
       GROUP BY from_addr
       ORDER BY used_at DESC
       LIMIT 10`,
    )
    .bind(user.id)
    .all<{ from_addr: string; used_at: number }>();

  const aliases = await env.DB
    .prepare(
      `SELECT a.full_address AS addr, a.last_message_at AS used_at
       FROM aliases a JOIN domains d ON d.id = a.domain_id
       WHERE d.owner_id = ?1 AND a.type = 'explicit' AND a.disabled = 0
       ORDER BY a.last_message_at DESC NULLS LAST
       LIMIT 10`,
    )
    .bind(user.id)
    .all<{ addr: string; used_at: number | null }>();

  const seen = new Set<string>();
  const out: { address: string; used_at: number | null }[] = [];
  for (const r of recent.results ?? []) {
    if (!seen.has(r.from_addr)) {
      seen.add(r.from_addr);
      out.push({ address: r.from_addr, used_at: r.used_at });
    }
  }
  for (const a of aliases.results ?? []) {
    if (!seen.has(a.addr)) {
      seen.add(a.addr);
      out.push({ address: a.addr, used_at: a.used_at });
    }
  }
  return Response.json({ object: "list", data: out });
}

export async function openInboxStream(env: Env, user: AuthUser): Promise<Response> {
  const encoder = new TextEncoder();
  // Change signal = max(created_at) of the owner's messages, read from D1.
  // D1 is strongly consistent, so a 2s tick really means ~2s to notify; the
  // previous KV beacon was edge-cached for ≥60s, which quietly turned
  // "realtime" into minute-late. The query rides idx_messages_owner_received.
  const latest = async (): Promise<number> => {
    const r = await env.DB
      .prepare(`SELECT MAX(received_at) AS ts FROM messages WHERE owner_id = ?1`)
      .bind(user.id)
      .first<{ ts: number | null }>();
    return r?.ts ?? 0;
  };
  let lastSeen = await latest();
  let cancelled = false;

  const stream = new ReadableStream({
    async start(controller) {
      const TICK_MS = 2000;
      const MAX_LIFETIME_MS = 4 * 60 * 1000;
      const startedAt = Date.now();
      try {
        controller.enqueue(
          encoder.encode(`event: hello\ndata: ${JSON.stringify({ user_id: user.id, ts: Date.now() })}\n\n`),
        );
        while (!cancelled && Date.now() - startedAt < MAX_LIFETIME_MS) {
          const current = await latest();
          if (current > lastSeen) {
            lastSeen = current;
            controller.enqueue(
              encoder.encode(`event: new-message\ndata: ${JSON.stringify({ ts: current })}\n\n`),
            );
          } else {
            controller.enqueue(encoder.encode(`: keepalive ${Date.now()}\n\n`));
          }
          await new Promise((r) => setTimeout(r, TICK_MS));
        }
      } catch {
        // enqueue after client disconnect — expected teardown path
      } finally {
        if (!cancelled) {
          try {
            controller.close();
          } catch {
            // stream already canceled/errored
          }
        }
      }
    },
    cancel() {
      cancelled = true;
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "x-accel-buffering": "no",
    },
  });
}


