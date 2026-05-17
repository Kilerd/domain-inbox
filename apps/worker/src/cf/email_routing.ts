// Cloudflare REST API wrappers for Email Routing.
//
// These are used only when CLOUDFLARE_API_TOKEN is configured as a wrangler
// secret. The token needs:
//   - Zone:Read  (to look up zone IDs by hostname)
//   - Email Routing Write
//
// When the secret is absent we degrade silently — domain CRUD still works,
// the user just has to enable Routing manually in the dashboard.

const CF_API = "https://api.cloudflare.com/client/v4";

interface CfResponse<T> {
  success: boolean;
  errors?: { code: number; message: string }[];
  result: T;
}

async function cf<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${CF_API}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(init?.headers as Record<string, string> | undefined),
    },
  });
  let body: CfResponse<T>;
  try {
    body = (await res.json()) as CfResponse<T>;
  } catch {
    throw new Error(`CF API ${path}: non-JSON ${res.status}`);
  }
  if (!body.success) {
    const msg = body.errors?.map((e) => `${e.code}:${e.message}`).join(", ") ?? res.statusText;
    throw new Error(`CF API ${path} (${res.status}): ${msg}`);
  }
  return body.result;
}

export async function getZoneId(token: string, domain: string): Promise<string> {
  const list = await cf<Array<{ id: string; name: string; status: string }>>(
    token,
    `/zones?name=${encodeURIComponent(domain)}&per_page=1`,
  );
  if (!list.length) throw new Error(`zone ${domain} not found on Cloudflare`);
  return list[0]!.id;
}

export async function enableRouting(token: string, zoneId: string): Promise<void> {
  await cf<unknown>(token, `/zones/${zoneId}/email/routing/enable`, {
    method: "POST",
    body: "{}",
  });
}

/**
 * Sets the zone's catch-all rule to forward all unmatched addresses to the
 * given Worker. Idempotent: re-running just overwrites the rule.
 */
export async function setCatchAllToWorker(
  token: string,
  zoneId: string,
  workerName: string,
): Promise<void> {
  await cf<unknown>(token, `/zones/${zoneId}/email/routing/rules/catch_all`, {
    method: "PUT",
    body: JSON.stringify({
      enabled: true,
      matchers: [{ type: "all" }],
      actions: [{ type: "worker", value: [workerName] }],
    }),
  });
}
