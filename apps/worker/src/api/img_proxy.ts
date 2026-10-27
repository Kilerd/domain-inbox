import type { Env } from "../env";
import { httpError } from "../http";
import { validatePublicHttpUrl } from "../utils/net";

// Generic image proxy used by sanitized email HTML.
//   GET /api/img-proxy?u=<url>  → streams the image with Referer stripped.
//
// Privacy + SSRF posture:
//   - Strip Referer / Origin / cookies
//   - Limit to http/https on default ports
//   - Refuse loopback / private / link-local / metadata hosts
//   - Follow redirects manually (max 3), re-validating every hop
//   - Cap response size (10 MB) by counting streamed bytes, not just Content-Length
//   - Force image/* content-type; otherwise fail closed
//   - Upstream failures collapse to an opaque 502 so the endpoint can't be used
//     as a reachability / port-scan oracle
//
// Note: deliberately unauthenticated so the rendered email HTML (which loads
// images through this path) works without embedding tokens in proxied URLs.

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_REDIRECTS = 3;

function validateTarget(u: string): URL | null {
  return validatePublicHttpUrl(u, { defaultPortOnly: true });
}

export async function handleImgProxy(url: URL, _env: Env): Promise<Response> {
  const u = url.searchParams.get("u");
  if (!u) {
    return httpError.badRequest("missing ?u=<url>");
  }
  const initial = validateTarget(u);
  if (!initial) {
    return httpError.badRequest("invalid or disallowed url");
  }

  // Manual redirect loop so every hop goes through the same host validation.
  let target: URL = initial;
  let upstream: Response | null = null;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let res: Response;
    try {
      res = await fetch(target.toString(), {
        headers: {
          "user-agent": "domain-inbox image proxy",
          accept: "image/*",
        },
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      return httpError.internal("upstream fetch failed", 502);
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      const next: URL | null = loc
        ? validateTarget(new URL(loc, target.toString()).toString())
        : null;
      if (!next || hop === MAX_REDIRECTS) {
        return httpError.internal("upstream fetch failed", 502);
      }
      target = next;
      continue;
    }
    upstream = res;
    break;
  }
  // Opaque failure: don't echo upstream status codes back to the caller.
  if (!upstream || !upstream.ok || !upstream.body) {
    return httpError.internal("upstream fetch failed", 502);
  }

  const ct = upstream.headers.get("content-type") ?? "application/octet-stream";
  if (!ct.startsWith("image/")) {
    return httpError.internal(`non-image content-type ${ct}`, 415);
  }

  const lenHeader = upstream.headers.get("content-length");
  if (lenHeader && parseInt(lenHeader, 10) > MAX_BYTES) {
    return httpError.internal("image too large", 413);
  }

  // Enforce the size cap on the actual bytes; Content-Length can be absent
  // (chunked) or lie.
  let sent = 0;
  const capped = upstream.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        sent += chunk.byteLength;
        if (sent > MAX_BYTES) {
          controller.error(new Error("image exceeds size cap"));
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );

  const headers: Record<string, string> = {
    "content-type": ct,
    "cache-control": "public, max-age=3600",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  };
  if (lenHeader) headers["content-length"] = lenHeader;
  return new Response(capped, { headers });
}
