// RFC-5322-ish address parsing for the API surface. We intentionally accept
// only what we need: bare `user@host` or display-form `Name <user@host>`.
// Internally we always normalize the local-part case-preserved but the
// domain lower-cased; consumers compare on the lowercased address.

export interface Addr {
  name?: string;
  addr: string;
}

const DISPLAY_FORM = /^"?([^"<]*?)"?\s*<\s*([^>]+)\s*>$/;

export const EMAIL_RE = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;

export function parseAddr(line: string): Addr {
  const trimmed = line.trim();
  const m = trimmed.match(DISPLAY_FORM);
  if (m) {
    const name = m[1]?.trim();
    return { name: name || undefined, addr: m[2]!.trim().toLowerCase() };
  }
  return { addr: trimmed.toLowerCase() };
}

export function asAddrList(v: unknown): Addr[] {
  if (v == null) return [];
  const arr = Array.isArray(v) ? v : [v];
  const out: Addr[] = [];
  for (const item of arr) {
    if (typeof item === "string" && item.length > 0) out.push(parseAddr(item));
  }
  return out;
}

/** Returns the first invalid address, or null when all are well-formed. */
export function firstInvalid(addrs: Addr[]): string | null {
  for (const a of addrs) {
    if (!EMAIL_RE.test(a.addr)) return a.addr;
  }
  return null;
}

export function domainOf(addr: string): string | null {
  const at = addr.lastIndexOf("@");
  if (at <= 0) return null;
  return addr.slice(at + 1).toLowerCase();
}
