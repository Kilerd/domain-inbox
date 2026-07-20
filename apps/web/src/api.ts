// Typed API client. Pointed at the same origin (Worker also serves the SPA).

export interface Me {
  id: string;
  email: string;
  name: string | null;
  is_new: boolean;
}

// ── Inbox ─────────────────────────────────────────────────────────────────

export interface Thread {
  id: string;
  subject: string;
  participants: string[];
  message_count: number;
  unread_count: number;
  first_message_at: number;
  last_message_at: number;
  flags_bitmap: number;
  snippet: string | null;
  domain_id: string | null;
}

export interface ThreadList {
  threads: Thread[];
  next_cursor: string | null;
}

export type InboxView =
  | "inbox"
  | "unread"
  | "starred"
  | "sent"
  | "archived"
  | "trash"
  | "spam"
  | "all";

export interface InboxDomainStat {
  id: string;
  domain: string;
  unread_count: number;
  thread_count: number;
}

export interface InboxAlias {
  id: string;
  domain_id: string;
  address: string;
  local_part: string;
  type: "explicit" | "auto_created";
  label: string | null;
  disabled: boolean;
  hidden: boolean;
  message_count: number;
  unread_count: number;
  last_message_at: number | null;
}

export interface FromSuggestion {
  address: string;
  used_at: number | null;
}

export interface ThreadFlagsPatch {
  star?: boolean;
  archive?: boolean;
  trash?: boolean;
  spam?: boolean;
  read?: boolean;
}

export interface MessageAttachment {
  id: string;
  filename: string | null;
  content_type: string | null;
  size_bytes: number | null;
  content_id: string | null;
  is_inline: boolean;
}

export interface Message {
  id: string;
  thread_id: string | null;
  rfc822_message_id: string | null;
  direction: "inbound" | "outbound";
  from: { address: string; name: string | null } | null;
  to: string[];
  cc: string[];
  bcc: string[];
  reply_to: string | null;
  subject: string | null;
  snippet: string | null;
  received_at: number | null;
  sent_at: number | null;
  size_bytes: number | null;
  has_attachments: boolean;
  attachment_count: number;
  is_read: boolean;
  parse_status: string;
  outbound_id: string | null;
  attachments: MessageAttachment[];
}

export interface ThreadDetail {
  thread: Thread;
  messages: Message[];
}

export interface MessageBody {
  id: string;
  text: string | null;
  html: string | null;
  headers: Record<string, string>;
}

// ── Domains ───────────────────────────────────────────────────────────────

export interface DnsRecord {
  record: "MX" | "SPF" | "DKIM";
  purpose: "receive" | "send";
  name: string;
  type: "MX" | "TXT" | "CNAME";
  value: string;
  ttl: number;
  priority: number | null;
  status: "pending" | "verified" | "failed";
}

export interface Domain {
  object: "domain";
  id: string;
  name: string;
  status: "pending" | "verified" | "failed";
  receive_status: "pending" | "verified" | "failed";
  send_status: "pending" | "verified" | "failed";
  catch_all_enabled: boolean;
  created_at: string;
  verified_at: string | null;
  records: DnsRecord[];
  auto_configured?: boolean;
  auto_config_error?: string | null;
}

// ── API Keys ──────────────────────────────────────────────────────────────

export interface ApiKey {
  object: "api_key";
  id: string;
  name: string | null;
  prefix: string;
  scopes: string[];
  domain_scope: string[] | null;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export interface ApiKeyCreated extends Omit<ApiKey, "last_used_at" | "revoked_at"> {
  token: string;
}

// ── Members ───────────────────────────────────────────────────────────────

export interface Member {
  email: string;
  name?: string | null;
  role: "owner" | "member";
  created_at: string;
  last_seen_at?: string | null;
  joined: boolean;
}

// ── Webhooks ──────────────────────────────────────────────────────────────

export interface WebhookEndpoint {
  object: "webhook_endpoint";
  id: string;
  url: string;
  events: string[];
  enabled: boolean;
  created_at: string;
}

export interface WebhookCreated extends WebhookEndpoint {
  secret: string;
}

// ── Suppressions ──────────────────────────────────────────────────────────

export interface Suppression {
  id: string;
  email: string;
  reason: string;
  source_outbound_id: string | null;
  created_at: string;
}

// ── Templates ─────────────────────────────────────────────────────────────

export interface Template {
  id: string;
  name: string;
  subject: string | null;
  html: string | null;
  text: string | null;
  variables_schema: unknown;
  created_at: string;
  updated_at: string;
}

export interface TemplateRender {
  template_id: string;
  subject: string | null;
  html: string | null;
  text: string | null;
}

// ── Outbound / events ─────────────────────────────────────────────────────

export interface OutboundTracking {
  enabled: boolean;
  open_count: number;
  click_count: number;
  first_opened_at: string | null;
  last_opened_at: string | null;
  first_clicked_at: string | null;
  last_clicked_at: string | null;
}

export interface OutboundMessage {
  id: string;
  status: string;
  display_status: string;
  created_at: string;
  sent_at: string | null;
  scheduled_at: string | null;
  bounced_at: string | null;
  bounce_type: string | null;
  bounce_diag: string | null;
  last_error: string | null;
  from: string | null;
  to: string[] | string | null;
  cc: string[] | string | null;
  bcc: string[] | string | null;
  subject: string | null;
  template_id: string | null;
  api_key_id: string | null;
  tracking: OutboundTracking;
}

export interface OutboundStats {
  total: number;
  delivered: number;
  bounced: number;
  complained: number;
  failed: number;
  opened: number;
  clicked: number;
  deliverability_rate: number;
  bounce_rate: number;
  complain_rate: number;
  open_rate: number;
  click_rate: number;
}

export interface TimeseriesPoint {
  day: string;
  delivered: number;
  bounced: number;
  complained: number;
  opened: number;
  clicked: number;
  sent: number;
}

export interface OutboundTimeseries {
  from: string;
  to: string;
  granularity: "day";
  series: TimeseriesPoint[];
}

export interface InboundMessage {
  id: string;
  rfc822_message_id: string | null;
  from: { address: string; name: string | null } | null;
  to: string[];
  subject: string | null;
  snippet: string | null;
  received_at: string | null;
  size_bytes: number | null;
  has_attachments: boolean;
  attachment_count: number;
  thread_id: string | null;
}

export interface InboundList {
  object: "list";
  has_more: boolean;
  next_cursor: string | null;
  data: InboundMessage[];
}

export interface OutboundList {
  object: "list";
  has_more: boolean;
  next_cursor: string | null;
  data: OutboundMessage[];
}

export interface ActivityEvent {
  id: string;
  type: string;
  email_id: string | null;
  created_at: string;
  data: Record<string, unknown>;
}

export interface ActivityList {
  object: "list";
  has_more: boolean;
  next_cursor: string | null;
  data: ActivityEvent[];
}

// ── HTTP layer ────────────────────────────────────────────────────────────

interface ApiErrorBody {
  name: string;
  message: string;
  statusCode: number;
}

export class ApiError extends Error {
  readonly status: number;
  readonly errorName: string;
  constructor(body: ApiErrorBody) {
    super(body.message);
    this.status = body.statusCode;
    this.errorName = body.name;
  }
}

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: "same-origin",
    ...init,
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...(init?.headers as Record<string, string> | undefined),
    },
  });
  if (!res.ok) {
    let body: ApiErrorBody;
    try {
      body = (await res.json()) as ApiErrorBody;
    } catch {
      throw new Error(`${res.status} ${path}`);
    }
    throw new ApiError(body);
  }
  return (await res.json()) as T;
}

interface ListResp<T> {
  object: "list";
  data: T[];
}

interface MembersList {
  object: "list";
  members: Member[];
  pending_invites: Member[];
}

export const api = {
  me: () => fetchJson<Me>("/api/me"),

  // Auth
  requestLogin: (email: string) =>
    fetchJson<{ ok: true }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email }),
    }),
  logout: async () => {
    const res = await fetch("/api/auth/logout", {
      method: "POST",
      credentials: "same-origin",
    });
    if (!res.ok) throw new Error(`logout failed: ${res.status}`);
    return res;
  },

  // Members
  listMembers: () => fetchJson<MembersList>("/api/v1/members"),
  inviteMember: (email: string) =>
    fetchJson<{ email: string; invited: true }>("/api/v1/members", {
      method: "POST",
      body: JSON.stringify({ email }),
    }),
  removeMember: (email: string) =>
    fetchJson<{ email: string; removed: true }>(
      `/api/v1/members/${encodeURIComponent(email)}`,
      { method: "DELETE" },
    ),

  // Inbox
  listThreads: (params?: {
    view?: InboxView;
    domain?: string | null;
    alias?: string | null;
    q?: string | null;
    cursor?: string | null;
    limit?: number;
  }) => {
    const qs = new URLSearchParams();
    if (params?.view) qs.set("view", params.view);
    if (params?.domain) qs.set("domain", params.domain);
    if (params?.alias) qs.set("alias", params.alias);
    if (params?.q) qs.set("q", params.q);
    if (params?.cursor) qs.set("cursor", params.cursor);
    if (params?.limit) qs.set("limit", String(params.limit));
    const search = qs.toString();
    return fetchJson<ThreadList>(`/api/inbox/threads${search ? `?${search}` : ""}`);
  },
  getThread: (id: string) => fetchJson<ThreadDetail>(`/api/inbox/threads/${id}/messages`),
  getBody: (id: string) => fetchJson<MessageBody>(`/api/inbox/messages/${id}/body`),
  markRead: (id: string) =>
    fetchJson<{ ok: true }>(`/api/inbox/messages/${id}/read`, { method: "POST" }),

  // Inbox structure
  listInboxDomains: () =>
    fetchJson<{ object: "list"; data: InboxDomainStat[] }>("/api/inbox/domains"),
  listInboxAliases: (domain?: string | null, includeQuiet = false) => {
    const qs = new URLSearchParams();
    if (domain) qs.set("domain", domain);
    if (includeQuiet) qs.set("include_quiet", "true");
    const search = qs.toString();
    return fetchJson<{ object: "list"; data: InboxAlias[] }>(
      `/api/inbox/aliases${search ? `?${search}` : ""}`,
    );
  },

  // Thread flags
  setThreadFlags: (id: string, patch: ThreadFlagsPatch) =>
    fetchJson<{ object: "thread"; id: string; updated: true }>(
      `/api/inbox/threads/${id}/flags`,
      { method: "POST", body: JSON.stringify(patch) },
    ),
  batchSetThreadFlags: (ids: string[], patch: ThreadFlagsPatch) =>
    fetchJson<{ object: "list"; updated: number; missed: number }>(
      "/api/inbox/threads/batch/flags",
      { method: "POST", body: JSON.stringify({ ids, ...patch }) },
    ),

  // Compose + suggestions
  fromSuggestions: () =>
    fetchJson<{ object: "list"; data: FromSuggestion[] }>(
      "/api/inbox/from-suggestions",
    ),
  composeEmail: (payload: {
    from: string;
    to: string | string[];
    cc?: string | string[];
    bcc?: string | string[];
    reply_to?: string | string[];
    subject: string;
    text?: string;
    html?: string;
    headers?: Record<string, string>;
    attachments?: Array<{
      filename: string;
      content: string; // base64-encoded
      content_type?: string;
      content_id?: string;
    }>;
  }) =>
    fetchJson<{ id: string }>("/api/inbox/compose", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  // Domains
  listDomains: () => fetchJson<ListResp<Domain>>("/api/v1/domains").then((r) => r.data),
  createDomain: (name: string) =>
    fetchJson<Domain>("/api/v1/domains", {
      method: "POST",
      body: JSON.stringify({ name }),
    }),
  verifyDomain: (idOrName: string) =>
    fetchJson<Domain>(`/api/v1/domains/${idOrName}/verify`, { method: "POST" }),
  deleteDomain: (idOrName: string) =>
    fetchJson<{ object: "domain"; id: string; deleted: true }>(
      `/api/v1/domains/${idOrName}`,
      { method: "DELETE" },
    ),

  // API Keys
  listApiKeys: () => fetchJson<ListResp<ApiKey>>("/api/v1/api-keys").then((r) => r.data),
  createApiKey: (params: { name?: string; scopes?: string[]; domain_scope?: string[] }) =>
    fetchJson<ApiKeyCreated>("/api/v1/api-keys", {
      method: "POST",
      body: JSON.stringify(params),
    }),
  revokeApiKey: (id: string) =>
    fetchJson<{ object: "api_key"; id: string; deleted: true }>(
      `/api/v1/api-keys/${id}`,
      { method: "DELETE" },
    ),

  // Webhooks
  listWebhooks: () =>
    fetchJson<ListResp<WebhookEndpoint>>("/api/v1/webhooks").then((r) => r.data),
  createWebhook: (params: { url: string; events: string[] }) =>
    fetchJson<WebhookCreated>("/api/v1/webhooks", {
      method: "POST",
      body: JSON.stringify(params),
    }),
  deleteWebhook: (id: string) =>
    fetchJson<{ object: "webhook_endpoint"; id: string; deleted: true }>(
      `/api/v1/webhooks/${id}`,
      { method: "DELETE" },
    ),

  // Suppressions
  listSuppressions: (params?: { reason?: string; q?: string }) => {
    const qs = new URLSearchParams();
    if (params?.reason) qs.set("reason", params.reason);
    if (params?.q) qs.set("q", params.q);
    const search = qs.toString();
    return fetchJson<ListResp<Suppression>>(
      `/api/v1/suppressions${search ? `?${search}` : ""}`,
    ).then((r) => r.data);
  },
  addSuppression: (email: string, reason?: string) =>
    fetchJson<Suppression>("/api/v1/suppressions", {
      method: "POST",
      body: JSON.stringify({ email, reason: reason ?? "manual" }),
    }),
  removeSuppression: (id: string) =>
    fetchJson<{ id: string; deleted: true }>(`/api/v1/suppressions/${id}`, {
      method: "DELETE",
    }),

  // Templates
  listTemplates: () =>
    fetchJson<ListResp<Template>>("/api/v1/templates").then((r) => r.data),
  getTemplate: (id: string) => fetchJson<Template>(`/api/v1/templates/${id}`),
  createTemplate: (payload: {
    name: string;
    subject?: string | null;
    html?: string | null;
    text?: string | null;
    variables_schema?: unknown;
  }) =>
    fetchJson<Template>("/api/v1/templates", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  updateTemplate: (
    id: string,
    payload: Partial<{
      name: string;
      subject: string | null;
      html: string | null;
      text: string | null;
      variables_schema: unknown;
    }>,
  ) =>
    fetchJson<Template>(`/api/v1/templates/${id}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    }),
  deleteTemplate: (id: string) =>
    fetchJson<{ object: "template"; id: string; deleted: true }>(
      `/api/v1/templates/${id}`,
      { method: "DELETE" },
    ),
  renderTemplate: (id: string, data: Record<string, unknown>) =>
    fetchJson<TemplateRender>(`/api/v1/templates/${id}/render`, {
      method: "POST",
      body: JSON.stringify({ data }),
    }),

  // Outbound listing + detail (cookie-auth surface for SPA)
  listOutbound: (params?: {
    status?: string;
    display?: string;
    domain?: string;
    api_key?: string;
    q?: string;
    created_after?: string;
    created_before?: string;
    cursor?: string | null;
    limit?: number;
  }) => {
    const qs = new URLSearchParams();
    if (params?.status) qs.set("status", params.status);
    if (params?.display) qs.set("display", params.display);
    if (params?.domain) qs.set("domain", params.domain);
    if (params?.api_key) qs.set("api_key", params.api_key);
    if (params?.q) qs.set("q", params.q);
    if (params?.created_after) qs.set("created_after", params.created_after);
    if (params?.created_before) qs.set("created_before", params.created_before);
    if (params?.cursor) qs.set("cursor", params.cursor);
    if (params?.limit) qs.set("limit", String(params.limit));
    const search = qs.toString();
    return fetchJson<OutboundList>(`/api/inbox/outbound${search ? `?${search}` : ""}`);
  },
  outboundStats: (params?: {
    domain?: string;
    api_key?: string;
    created_after?: string;
    created_before?: string;
  }) => {
    const qs = new URLSearchParams();
    if (params?.domain) qs.set("domain", params.domain);
    if (params?.api_key) qs.set("api_key", params.api_key);
    if (params?.created_after) qs.set("created_after", params.created_after);
    if (params?.created_before) qs.set("created_before", params.created_before);
    const search = qs.toString();
    return fetchJson<OutboundStats>(
      `/api/inbox/outbound/stats${search ? `?${search}` : ""}`,
    );
  },
  outboundTimeseries: (params?: {
    domain?: string;
    api_key?: string;
    created_after?: string;
    created_before?: string;
  }) => {
    const qs = new URLSearchParams();
    if (params?.domain) qs.set("domain", params.domain);
    if (params?.api_key) qs.set("api_key", params.api_key);
    if (params?.created_after) qs.set("created_after", params.created_after);
    if (params?.created_before) qs.set("created_before", params.created_before);
    const search = qs.toString();
    return fetchJson<OutboundTimeseries>(
      `/api/inbox/outbound/timeseries${search ? `?${search}` : ""}`,
    );
  },
  listInbound: (params?: {
    q?: string;
    domain?: string;
    created_after?: string;
    created_before?: string;
    cursor?: string | null;
    limit?: number;
  }) => {
    const qs = new URLSearchParams();
    if (params?.q) qs.set("q", params.q);
    if (params?.domain) qs.set("domain", params.domain);
    if (params?.created_after) qs.set("created_after", params.created_after);
    if (params?.created_before) qs.set("created_before", params.created_before);
    if (params?.cursor) qs.set("cursor", params.cursor);
    if (params?.limit) qs.set("limit", String(params.limit));
    const search = qs.toString();
    return fetchJson<InboundList>(`/api/inbox/inbound${search ? `?${search}` : ""}`);
  },
  getOutbound: (id: string) => fetchJson<OutboundMessage>(`/api/inbox/outbound/${id}`),
  getOutboundEvents: (id: string) =>
    fetchJson<{ object: "list"; email_id: string; data: ActivityEvent[] }>(
      `/api/inbox/outbound/${id}/events`,
    ),

  // Activity feed (cross-message events)
  listEvents: (params?: {
    type?: string;
    email_id?: string;
    cursor?: string | null;
    limit?: number;
  }) => {
    const qs = new URLSearchParams();
    if (params?.type) qs.set("type", params.type);
    if (params?.email_id) qs.set("email_id", params.email_id);
    if (params?.cursor) qs.set("cursor", params.cursor);
    if (params?.limit) qs.set("limit", String(params.limit));
    const search = qs.toString();
    return fetchJson<ActivityList>(`/api/inbox/events${search ? `?${search}` : ""}`);
  },
};
