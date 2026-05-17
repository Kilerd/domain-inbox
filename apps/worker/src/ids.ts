// Typed id prefixes used across the codebase. Centralized so a `grep "k_"` is
// enough to find every API-key id construction, and so new entity kinds get a
// single place to add their prefix.

const PREFIX = {
  user: "u_",
  domain: "d_",
  alias: "al_",
  message: "m_",
  thread: "t_",
  attachment: "a_",
  apiKey: "k_",
  outbound: "o_",
  event: "e_",
  webhookEndpoint: "whe_",
  webhookDelivery: "whd_",
  webhookMessage: "msg_",
  suppression: "sup_",
  template: "tpl_",
} as const;

type IdKind = keyof typeof PREFIX;

function gen(kind: IdKind): string {
  return PREFIX[kind] + crypto.randomUUID();
}

export const newId = {
  user: () => gen("user"),
  domain: () => gen("domain"),
  alias: () => gen("alias"),
  message: () => gen("message"),
  thread: () => gen("thread"),
  attachment: () => gen("attachment"),
  apiKey: () => gen("apiKey"),
  outbound: () => gen("outbound"),
  event: () => gen("event"),
  webhookEndpoint: () => gen("webhookEndpoint"),
  webhookDelivery: () => gen("webhookDelivery"),
  webhookMessage: () => gen("webhookMessage"),
  suppression: () => gen("suppression"),
  template: () => gen("template"),
};
