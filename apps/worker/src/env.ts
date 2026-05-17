// `cloudflare:email` runtime binding type. SendEmail accepts an EmailMessage.
export interface SendEmail {
  send(message: { from: string; to: string; raw: string | ReadableStream }): Promise<void>;
}

export interface Env {
  // Bindings
  DB: D1Database;
  R2: R2Bucket;
  KV: KVNamespace;
  ASSETS: Fetcher;
  EMAIL?: SendEmail; // available once send_email binding is configured

  // Vars (plain text, set in wrangler.toml [env.<name>.vars])
  ENV: "dev" | "staging" | "prod";
  WORKER_NAME?: string;
  PRIMARY_DOMAIN?: string; // verified domain used as from-address for magic-link emails
  APP_BASE_URL?: string;   // absolute base URL for magic-link callback (e.g. https://...workers.dev)
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  DEV_USER_EMAIL?: string;
  DEV_USER_NAME?: string;
  DEV_USER_TOKEN?: string; // when set + matching `X-Dev-Auth` header → dev backdoor active

  // Secrets (set via `wrangler secret put`)
  CLOUDFLARE_API_TOKEN?: string;
}
