// Shared outbound-URL safety: the image proxy and webhook endpoints both
// fetch user-supplied URLs from inside the Worker, so they must not become
// SSRF pivots into loopback, private, link-local or cloud-metadata hosts.

const BLOCKED_HOSTNAMES = new Set(["localhost", "metadata.google.internal"]);

export function isBlockedHost(hostname: string): boolean {
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
      v6.startsWith("fc") || // unique-local fc00::/7
      v6.startsWith("fd") ||
      v6.startsWith("::ffff:") // v4-mapped — treat conservatively
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

export interface PublicUrlOptions {
  /** Only allow the scheme's default port (img proxy). Default true. */
  defaultPortOnly?: boolean;
  /** Maximum accepted URL length. Default 2048. */
  maxLength?: number;
}

/** A user-supplied URL that is safe to fetch from the Worker, or null. */
export function validatePublicHttpUrl(
  raw: string,
  { defaultPortOnly = true, maxLength = 2048 }: PublicUrlOptions = {},
): URL | null {
  if (raw.length > maxLength) return null;
  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    return null;
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") return null;
  if (defaultPortOnly && target.port !== "") return null;
  if (target.username || target.password) return null;
  if (isBlockedHost(target.hostname)) return null;
  return target;
}
