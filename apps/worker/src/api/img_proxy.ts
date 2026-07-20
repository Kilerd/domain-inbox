import type { Env } from "../env";
import { httpError } from "../http";

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

const BLOCKED_HOSTNAMES = new Set(["localhost", "metadata.google.internal"]);

function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (BLOCKED_HOSTNAMES.has(host)) return true;
  if (host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) {
    return true;
  }
  // IPv6 literal (URL hostname keeps brackets).
  if (host.startsWith("[")) {
    const v6 = host.slice(1, -1);
    return (
      v6 === "::" ||
      v6 === "::1" ||
      v6.startsWith("fe80:") || // link-local
      v6.startsWith("fc") ||    // unique-local fc00::/7
      v6.startsWith("fd") ||
      v6.startsWith("::ffff:")  // v4-mapped — treat conservatively
    );
  }
  // IPv4 literal.
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true; // link-local / cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  }
  return false;
}

function validateTarget(u: string): URL | null {
  let target: URL;
  try {
    target = new URL(u);
  } catch {
    return null;
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") return null;
  if (target.port !== "") return null; // default ports only
  if (target.username || target.password) return null;
  if (isBlockedHost(target.hostname)) return null;
  return target;
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
