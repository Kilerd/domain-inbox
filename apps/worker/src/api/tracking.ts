// Open / click tracking.
//
// Outbound HTML bodies are rewritten before send:
//  * opens — a 1×1 transparent PNG <img> is appended before </body>;
//    when the recipient renders the mail, their MUA fetches /t/o/<tok> and
//    we bump the outbound's open_count + write an email.opened event.
//  * clicks — absolute http(s) links get their href swapped for
//    /t/c/<tok>; following the link writes email.clicked and 302s back
//    to the original target. Links are NEVER rewritten when the href has a
//    fragment (`#…` — senders put one-time secrets there precisely so they
//    stay in the browser) or when the <a> carries `data-no-track` /
//    `data-pm-no-track`. Rewriting would copy the full URL (secret included)
//    into KV, events.payload_json and webhook payloads for 90 days.
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

// An opening <a …> tag. Quoted attribute values are consumed whole so a `>`
// inside a value doesn't end the tag early.
const A_TAG_RE = /<a(?=[\s/>])(?:[^>"']|"[^"]*"|'[^']*')*>/gi;
// One attribute inside a tag: name, optionally `= "v"` / `= 'v'` / `= v`.
const ATTR_RE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
// Per-link opt-out markers (presence is enough, any value).
const NO_TRACK_ATTRS = new Set(["data-no-track", "data-pm-no-track"]);

interface HrefSpan {
  url: string;
  /** Offsets of the href value (without quotes) inside the tag string. */
  start: number;
  end: number;
}

/**
 * Locate the quoted href of an `<a …>` tag. Returns null when the tag opts
 * out of tracking (`data-no-track` / `data-pm-no-track`) or has no quoted
 * href (unquoted hrefs were never rewritten and still aren't).
 */
function trackableHref(tag: string): HrefSpan | null {
  const body = tag.slice(2, -1); // strip "<a" and ">"
  let href: HrefSpan | null = null;
  let sawHref = false;
  for (const m of body.matchAll(ATTR_RE)) {
    const name = (m[1] ?? "").toLowerCase();
    if (NO_TRACK_ATTRS.has(name)) return null;
    if (name !== "href" || sawHref) continue;
    // Browsers honour the first href only.
    sawHref = true;
    const value = m[2] ?? m[3];
    if (value === undefined) continue;
    // A quoted value ends one char before the end of the match (the quote).
    const end = 2 + (m.index ?? 0) + m[0].length - 1;
    href = { url: value, start: end - value.length, end };
  }
  return href;
}

// Character references that realistically show up in href values. Anything
// else (`&foo;`) is left as written.
const NAMED_REFS: Record<string, string> = {
  amp: "&",
  quot: '"',
  apos: "'",
  lt: "<",
  gt: ">",
  num: "#",
};

/**
 * Decode HTML character references in an attribute value: the named ones in
 * NAMED_REFS plus decimal `&#NN;` and hex `&#xHH;`. The raw attribute text is
 * what the browser decodes before following a link, so the tracked URL must
 * be stored (and redirected to) decoded — `?a=1&amp;b=2` means `?a=1&b=2`.
 */
export function decodeHtmlEntities(value: string): string {
  return value.replace(
    /&(?:#[xX]([0-9a-fA-F]+)|#([0-9]+)|([a-zA-Z]+));/g,
    (ref, hex: string | undefined, dec: string | undefined, name: string | undefined) => {
      if (name !== undefined) return NAMED_REFS[name.toLowerCase()] ?? ref;
      const cp = hex !== undefined ? parseInt(hex, 16) : parseInt(dec ?? "", 10);
      // Same substitution browsers make for NUL, surrogates, out of range.
      if (!(cp > 0 && cp <= 0x10ffff) || (cp >= 0xd800 && cp <= 0xdfff)) return "�";
      return String.fromCodePoint(cp);
    },
  );
}

/** `url` must already be entity-decoded. */
function isTrackableUrl(url: string, baseUrl: string): boolean {
  if (!/^https?:\/\//i.test(url)) return false; // mailto:, tel:, #anchor, …
  if (url.startsWith(baseUrl)) return false; // already wrapped
  // A fragment means "this part stays in the browser" (magic links, reset
  // tokens). Checked after decoding, so `&#35;` / `&#x23;` / `&num;` count.
  if (url.includes("#")) return false;
  return true;
}

/**
 * Rewrite an HTML body to inject the open pixel + click-tracking links.
 * Returns the new HTML; also writes the per-link KV records via env.KV and
 * waits for every write, so a returned tracked link always resolves.
 * Left byte-for-byte as is: non-http(s) hrefs (mailto:, tel:, anchors),
 * links already pointing at APP_BASE_URL, hrefs with a fragment, and <a>
 * tags carrying `data-no-track` / `data-pm-no-track`.
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
    const puts: Promise<void>[] = [];
    out = out.replace(A_TAG_RE, (tag) => {
      const href = trackableHref(tag);
      if (!href) return tag;
      // Decode for the checks and for storage; the tag text outside the href
      // value is never touched, and the value itself is replaced wholesale.
      const url = decodeHtmlEntities(href.url);
      if (!isTrackableUrl(url, baseUrl)) return tag;
      const token = crypto.randomUUID();
      // Start the KV write now (single-pass rewrite) and await the batch
      // below — an un-awaited put can be dropped, leaving a 404 link.
      puts.push(
        env.KV.put(
          `tok:c:${token}`,
          JSON.stringify({ outbound_id: outboundId, owner_id: ownerId, url }),
          { expirationTtl: ttl },
        ),
      );
      return `${tag.slice(0, href.start)}${baseUrl}/t/c/${token}${tag.slice(href.end)}`;
    });
    await Promise.all(puts);
    log.info("tracking.clicks_wrapped", { outbound_id: outboundId, count: puts.length });
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
  // Serialize through URL so non-ASCII hosts/paths become punycode /
  // percent-encoding — a raw `中` in a Location header makes Response throw.
  let location: string;
  try {
    location = new URL(payload.url).href;
  } catch {
    return new Response("invalid tracking link", { status: 404 });
  }
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
    headers: { location, "cache-control": "no-store" },
  });
}
