import type { Env } from "../env";
import { httpError } from "../http";

// Generic image proxy used by sanitized email HTML.
//   GET /api/img-proxy?u=<url>  → streams the image with Referer stripped.
//
// Privacy posture:
//   - Strip Referer / Origin / cookies
//   - Limit to http/https
//   - Cap response size (10 MB)
//   - Force image/* content-type; otherwise fail closed
//
// Note: deliberately unauthenticated so the rendered <iframe srcdoc> (which
// runs in a sandboxed null origin) can still load images. Adding auth would
// require passing tokens in the proxied URLs, which is fine to add later.

const MAX_BYTES = 10 * 1024 * 1024;

export async function handleImgProxy(url: URL, _env: Env): Promise<Response> {
  const u = url.searchParams.get("u");
  if (!u) {
    return httpError.badRequest("missing ?u=<url>");
  }
  let target: URL;
  try {
    target = new URL(u);
  } catch {
    return httpError.badRequest("invalid url");
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    return httpError.badRequest("unsupported scheme");
  }

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      headers: {
        "user-agent": "domain-inbox image proxy",
        accept: "image/*",
      },
      redirect: "follow",
    });
  } catch (err) {
    return httpError.internal(`upstream fetch failed: ${err}`, 502);
  }

  if (!upstream.ok) {
    return new Response(null, { status: upstream.status });
  }

  const ct = upstream.headers.get("content-type") ?? "application/octet-stream";
  if (!ct.startsWith("image/")) {
    return httpError.internal(`non-image content-type ${ct}`, 415);
  }

  const lenHeader = upstream.headers.get("content-length");
  if (lenHeader && parseInt(lenHeader, 10) > MAX_BYTES) {
    return httpError.internal("image too large", 413);
  }

  return new Response(upstream.body, {
    headers: {
      "content-type": ct,
      "content-length": lenHeader ?? "",
      "cache-control": "public, max-age=3600",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
}
