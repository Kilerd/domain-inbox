// Open / click tracking.
//
// Outbound HTML bodies are rewritten before send:
//  * opens — a 1×1 transparent PNG <img> is appended before </body>;
//    when the recipient renders the mail, their MUA fetches /t/o/<tok> and
//    we bump the outbound's open_count + write an email.opened event.
//  * clicks — every absolute http(s) link gets its href swapped for
//    /t/c/<tok>; following the link writes email.clicked and 302s back
//    to the original target.
//
// Tokens are random UUIDs that point at a KV record (no shared secret to
// rotate, easy revoke). Machine-open detection follows the user-agent
// heuristics used by Postmark and SendGrid: Google ImageProxy / MS Outlook
// safe-link prefetchers shouldn't count as a real human eyeball.

import type { Env } from "../env";
import { newId } from "../ids";
import { log } from "../utils/log";
import { fanoutEvent } from "../webhooks/dispatch";

const PIXEL_BYTES = Uint8Array.from(
  // 1x1 transparent PNG (67 bytes — the smallest standard-compliant
  // single-pixel image).
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP8" +
      "//8/AwAI/AL+AnzZagAAAABJRU5ErkJggg==",
  ),
  (c) => c.charCodeAt(0),
);

const MACHINE_OPEN_UA = [
  /GoogleImageProxy/i,
  /YahooMailProxy/i,
  /MicrosoftPreview/i,
  /SafeLinks/i,
  /Microsoft Office\/.*?Outlook/i,
  /BarracudaCentral/i,
  /Symantec/i,
  /Proofpoint/i,
];

function isMachineOpen(ua: string | null): boolean {
  if (!ua) return false;
  return MACHINE_OPEN_UA.some((re) => re.test(ua));
}

interface OpenTokenPayload {
  outbound_id: string;
  owner_id: string;
}

interface ClickTokenPayload {
  outbound_id: string;
  owner_id: string;
  url: string;
}

export interface TrackingPlan {
  opens: boolean;
  clicks: boolean;
}

/**
 * Rewrite an HTML body to inject the open pixel + click-tracking links.
 * Returns the new HTML; also writes the per-link KV records via env.KV.
 * Pure URL strings (mailto:, tel:, anchor) and links that already point at
 * APP_BASE_URL are skipped to avoid double-wrapping.
 */
export async function rewriteHtmlForTracking(
  html: string,
  env: Env,
  ownerId: string,
  outboundId: string,
  plan: TrackingPlan,
): Promise<string> {
  if (!plan.opens && !plan.clicks) return html;
  const baseUrl = env.APP_BASE_URL ?? "";
  if (!baseUrl) return html;
  let out = html;

  if (plan.clicks) {
    // 90-day TTL: same window we keep open tokens for. After this the link
    // 404s rather than redirecting — which is the correct behavior for
    // expired tracking, and matches what Resend / Postmark do.
    const ttl = 60 * 60 * 24 * 90;
    const links: string[] = [];
    const linkRE = /<a\b([^>]*?)\bhref\s*=\s*(["'])([^"']+)\2/gi;
    out = out.replace(linkRE, (full, attrs: string, q: string, url: string) => {
      if (!/^https?:\/\//i.test(url)) return full;
      if (url.startsWith(baseUrl)) return full;
      const token = crypto.randomUUID();
      links.push(token);
      // The KV writes are kicked off below in parallel — we mutate the
      // attribute synchronously here to keep the rewrite single-pass.
      env.KV.put(
        `tok:c:${token}`,
        JSON.stringify({ outbound_id: outboundId, owner_id: ownerId, url }),
        { expirationTtl: ttl },
      );
      const tracked = `${baseUrl}/t/c/${token}`;
      return `<a${attrs}href=${q}${tracked}${q}`;
    });
    log.info("tracking.clicks_wrapped", { outbound_id: outboundId, count: links.length });
  }

  if (plan.opens) {
    const ttl = 60 * 60 * 24 * 90;
    const token = crypto.randomUUID();
    await env.KV.put(
      `tok:o:${token}`,
      JSON.stringify({ outbound_id: outboundId, owner_id: ownerId }),
      { expirationTtl: ttl },
    );
    const pixel = `<img src="${baseUrl}/t/o/${token}" width="1" height="1" border="0" alt="" style="display:block;border:0;outline:none;text-decoration:none;height:1px;width:1px;">`;
    // Prefer to land *just before* </body>, fall back to appending.
    if (/<\/body>/i.test(out)) {
      out = out.replace(/<\/body>/i, `${pixel}</body>`);
    } else {
      out = out + pixel;
    }
  }

  return out;
}

export async function handleOpenPixel(
  url: URL,
  req: Request,
  env: Env,
  ctx?: ExecutionContext,
): Promise<Response> {
  const token = url.pathname.slice("/t/o/".length);
  const raw = await env.KV.get(`tok:o:${token}`, "text");
  if (!raw) {
    return new Response(PIXEL_BYTES, {
      headers: { "content-type": "image/png", "cache-control": "no-store" },
    });
  }
  const payload = JSON.parse(raw) as OpenTokenPayload;
  const ua = req.headers.get("user-agent");
  const machine = isMachineOpen(ua);

  // Always log the hit, but only the human-attributed ones bump the visible
  // open_count. Machine fetches still write an event with machine=true so
  // they can be surfaced in the activity log if useful.
  if (!machine) {
    await env.DB
      .prepare(
        `UPDATE outbound_messages
         SET open_count = open_count + 1,
             first_opened_at = COALESCE(first_opened_at, ?2),
             last_opened_at = ?2
         WHERE id = ?1`,
      )
      .bind(payload.outbound_id, Date.now())
      .run();
  }
  const openEventId = newId.event();
  await env.DB
    .prepare(
      `INSERT INTO events (id, owner_id, type, outbound_id, email_id, payload_json, created_at)
       VALUES (?1, ?2, 'email.opened', ?3, ?3, ?4, ?5)`,
    )
    .bind(
      openEventId,
      payload.owner_id,
      payload.outbound_id,
      JSON.stringify({ ua, ip: req.headers.get("cf-connecting-ip"), machine }),
      Date.now(),
    )
    .run();
  if (!machine) {
    const dispatch = fanoutEvent(env, payload.owner_id, "email.opened", {
      email_id: payload.outbound_id,
      ua,
    }, openEventId);
    if (ctx) ctx.waitUntil(dispatch);
  }
  return new Response(PIXEL_BYTES, {
    headers: { "content-type": "image/png", "cache-control": "no-store" },
  });
}

export async function handleClickRedirect(
  url: URL,
  req: Request,
  env: Env,
  ctx?: ExecutionContext,
): Promise<Response> {
  const token = url.pathname.slice("/t/c/".length);
  const raw = await env.KV.get(`tok:c:${token}`, "text");
  if (!raw) {
    return new Response("tracking link expired", { status: 404 });
  }
  const payload = JSON.parse(raw) as ClickTokenPayload;
  await env.DB
    .prepare(
      `UPDATE outbound_messages
       SET click_count = click_count + 1,
           first_clicked_at = COALESCE(first_clicked_at, ?2),
           last_clicked_at = ?2
       WHERE id = ?1`,
    )
    .bind(payload.outbound_id, Date.now())
    .run();
  const clickEventId = newId.event();
  await env.DB
    .prepare(
      `INSERT INTO events (id, owner_id, type, outbound_id, email_id, payload_json, created_at)
       VALUES (?1, ?2, 'email.clicked', ?3, ?3, ?4, ?5)`,
    )
    .bind(
      clickEventId,
      payload.owner_id,
      payload.outbound_id,
      JSON.stringify({
        url: payload.url,
        ua: req.headers.get("user-agent"),
        ip: req.headers.get("cf-connecting-ip"),
      }),
      Date.now(),
    )
    .run();
  const dispatch = fanoutEvent(env, payload.owner_id, "email.clicked", {
    email_id: payload.outbound_id,
    url: payload.url,
  }, clickEventId);
  if (ctx) ctx.waitUntil(dispatch);
  return new Response(null, {
    status: 302,
    headers: { location: payload.url, "cache-control": "no-store" },
  });
}
