// Server-side HTML sanitization using Cloudflare's HTMLRewriter.
//
// Strategy: defense-in-depth.
//   1. Strip dangerous tags entirely (script, style, iframe, object, ...)
//   2. Strip all on* event-handler attributes from any element
//   3. Normalize <a>: force target=_blank rel=noopener noreferrer, drop non-http schemes
//   4. Rewrite <img src> to /api/img-proxy (privacy-preserving fetch, no Referer leakage)
//   5. Strip inline styles containing url(...) and media tags with remote
//      sources — those would bypass the img-proxy privacy layer
//   6. The SPA's CSP meta (script-src 'self') is the second layer client-side

const TAGS_TO_REMOVE = [
  "script",
  "style",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "form",
  "input",
  "button",
  "textarea",
  "select",
  "option",
  "meta",
  "base",
  "link",
  // Media elements load remote resources via src/poster without going
  // through the img proxy; rare in email, so drop rather than proxy.
  "video",
  "audio",
  "source",
  "track",
];

function isSafeHref(href: string): boolean {
  return /^(https?:|mailto:|cid:|#)/i.test(href.trim());
}

export async function sanitizeEmailHtml(rawHtml: string, proxyPrefix: string): Promise<string> {
  const rewriter = new HTMLRewriter()
    .on("*", {
      element(el) {
        // Collect names first; HTMLRewriter invalidates the iterator if we
        // mutate during iteration.
        const toDrop: string[] = [];
        for (const [name, value] of el.attributes) {
          if (!name) continue;
          const lc = name.toLowerCase();
          if (lc.startsWith("on") || lc === "srcset" || lc === "background") {
            toDrop.push(name);
          }
          // Inline styles can smuggle remote loads (background:url(...))
          // around the img proxy; drop the whole attribute in that case.
          if (lc === "style" && /url\s*\(/i.test(value ?? "")) {
            toDrop.push(name);
          }
        }
        for (const name of toDrop) {
          el.removeAttribute(name);
        }
      },
    })
    .on(TAGS_TO_REMOVE.join(", "), {
      element(el) {
        el.remove();
      },
    })
    .on("a", {
      element(el) {
        const href = el.getAttribute("href");
        if (href && !isSafeHref(href)) {
          el.removeAttribute("href");
        }
        el.setAttribute("target", "_blank");
        el.setAttribute("rel", "noopener noreferrer");
      },
    })
    .on("img", {
      element(el) {
        const src = el.getAttribute("src");
        if (!src) return;
        if (src.startsWith("cid:")) return; // inline reference; client handles
        if (!/^https?:/i.test(src)) {
          el.removeAttribute("src");
          return;
        }
        el.setAttribute("src", `${proxyPrefix}?u=${encodeURIComponent(src)}`);
        el.removeAttribute("loading");
        el.setAttribute("loading", "lazy");
      },
    });

  const transformed = rewriter.transform(
    new Response(rawHtml, { headers: { "content-type": "text/html; charset=utf-8" } }),
  );
  return await transformed.text();
}
