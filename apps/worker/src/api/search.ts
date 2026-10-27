// Translate the search box into an FTS5 MATCH plus structured SQL filters.
// Free text is quoted as FTS phrases; known operators are extracted first so
// they never reach the MATCH parser.

export interface ParsedSearch {
  /** FTS5 MATCH expression, or null when only structured filters are used. */
  fts: string | null;
  from?: string;
  to?: string;
  subject?: string;
  hasAttachment?: boolean;
  unreadOnly?: boolean;
  /** Inclusive lower bound (ms). */
  after?: number;
  /** Exclusive upper bound (ms). */
  before?: number;
}

const OPERATOR = /(^|\s)(from|to|subject|has|is|after|before):("[^"]*"|\S+)/gi;

function unquote(value: string): string {
  const v = value.trim();
  return v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1) : v;
}

function parseDate(value: string): number | null {
  const ts = Date.parse(value);
  return Number.isNaN(ts) ? null : ts;
}

export function parseSearchQuery(raw: string): ParsedSearch {
  const out: ParsedSearch = { fts: null };
  let rest = raw;

  // Extract `key:value` operators, leaving the rest for full-text search.
  rest = rest.replace(OPERATOR, (whole, lead: string, key: string, value: string) => {
    const v = unquote(value);
    switch (key.toLowerCase()) {
      case "from":
        if (v) out.from = v;
        break;
      case "to":
        if (v) out.to = v;
        break;
      case "subject":
        if (v) out.subject = v;
        break;
      case "has":
        if (v.toLowerCase() === "attachment") out.hasAttachment = true;
        break;
      case "is":
        if (v.toLowerCase() === "unread") out.unreadOnly = true;
        break;
      case "after": {
        const ts = parseDate(v);
        if (ts !== null) out.after = ts;
        break;
      }
      case "before": {
        const ts = parseDate(v);
        if (ts !== null) out.before = ts;
        break;
      }
      default:
        break;
    }
    return lead + " ";
  });

  const terms: string[] = [];
  const re = /"([^"]+)"|(\S+)/g;
  for (const match of rest.matchAll(re)) {
    const term = (match[1] ?? match[2] ?? "").trim();
    if (!term) continue;
    terms.push(`"${term.replace(/"/g, '""')}"`);
  }
  if (terms.length > 0) out.fts = terms.join(" AND ");

  return out;
}

/** Escape a value for a SQL LIKE clause (used with ESCAPE '\'). */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}
