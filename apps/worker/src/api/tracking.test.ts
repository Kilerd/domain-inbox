import { beforeEach, describe, expect, test, vi } from "vitest";
import type { Env } from "../env";
import { rewriteHtmlForTracking } from "./tracking";

const BASE = "https://mail.example.test";
const CLICKS_ONLY = { opens: false, clicks: true };

// Minimal KV fake: each put settles on a later macrotask, so a caller that
// doesn't await the returned promise would observe it still pending.
function fakeEnv() {
  const store = new Map<string, string>();
  const settled: string[] = [];
  const put = vi.fn(
    (key: string, value: string, _opts?: unknown) =>
      new Promise<void>((resolve) => {
        setTimeout(() => {
          store.set(key, value);
          settled.push(key);
          resolve();
        }, 5);
      }),
  );
  const env = { APP_BASE_URL: BASE, KV: { put } } as unknown as Env;
  return { env, put, store, settled };
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("rewriteHtmlForTracking — clicks", () => {
  test("rewrites a plain http(s) link and awaits its KV write", async () => {
    const { env, put, store, settled } = fakeEnv();
    const html = `<p><a class="btn" href="https://example.com/pricing?a=1">Pricing</a></p>`;

    const out = await rewriteHtmlForTracking(html, env, "usr_1", "ob_1", CLICKS_ONLY);

    const m = out.match(/href="([^"]+)"/);
    expect(m).not.toBeNull();
    const tracked = m![1]!;
    expect(tracked.startsWith(`${BASE}/t/c/`)).toBe(true);
    const token = tracked.slice(`${BASE}/t/c/`.length);
    expect(out).toBe(`<p><a class="btn" href="${tracked}">Pricing</a></p>`);

    expect(put).toHaveBeenCalledTimes(1);
    // Write has *settled* by the time the function returns.
    expect(settled).toEqual([`tok:c:${token}`]);
    expect(JSON.parse(store.get(`tok:c:${token}`)!)).toEqual({
      outbound_id: "ob_1",
      owner_id: "usr_1",
      url: "https://example.com/pricing?a=1",
    });
    expect(put.mock.calls[0]![2]).toEqual({ expirationTtl: 60 * 60 * 24 * 90 });
  });

  test("awaits every KV write when several links are rewritten", async () => {
    const { env, put, settled } = fakeEnv();
    const html =
      `<a href="https://a.example/1">1</a>` +
      `<a href='https://b.example/2'>2</a>` +
      `<A HREF="http://c.example/3">3</A>`;

    const out = await rewriteHtmlForTracking(html, env, "usr_1", "ob_1", CLICKS_ONLY);

    expect(put).toHaveBeenCalledTimes(3);
    expect(settled).toHaveLength(3);
    expect(out.match(/\/t\/c\//g)).toHaveLength(3);
    // Original quoting is preserved.
    expect(out).toContain(`href='${BASE}/t/c/`);
    expect(out).toContain(`HREF="${BASE}/t/c/`);
  });

  test("leaves links with a fragment untouched", async () => {
    const { env, put } = fakeEnv();
    const html =
      `<a href="https://app.example/verify#t=s3cr3t-token">Verify</a>` +
      `<a href="https://app.example/reset?u=1#k=abc">Reset</a>` +
      `<a href="https://app.example/login&num;magic=xyz">Magic</a>` +
      `<a href="https://app.example/login&#35;magic=xyz">Magic 2</a>`;

    const out = await rewriteHtmlForTracking(html, env, "usr_1", "ob_1", CLICKS_ONLY);

    expect(out).toBe(html);
    expect(put).not.toHaveBeenCalled();
  });

  test("leaves data-no-track / data-pm-no-track links untouched (attribute kept)", async () => {
    const { env, put } = fakeEnv();
    const optOuts = [
      `<a data-no-track href="https://app.example/magic?token=1">a</a>`,
      `<a href="https://app.example/magic?token=2" data-no-track>b</a>`,
      `<a href="https://app.example/magic?token=3" data-no-track="">c</a>`,
      `<a href="https://app.example/magic?token=4" data-no-track='true'>d</a>`,
      `<a href="https://app.example/magic?token=5" DATA-NO-TRACK=1>e</a>`,
      `<a data-pm-no-track href="https://app.example/magic?token=6">f</a>`,
      `<a href="https://app.example/magic?token=7" data-pm-no-track="yes" />`,
    ];
    const tracked = `<a href="https://example.com/blog">blog</a>`;
    const html = optOuts.join("\n") + "\n" + tracked;

    const out = await rewriteHtmlForTracking(html, env, "usr_1", "ob_1", CLICKS_ONLY);

    for (const link of optOuts) expect(out).toContain(link);
    expect(out).not.toContain(tracked);
    expect(put).toHaveBeenCalledTimes(1);
    expect(JSON.parse(put.mock.calls[0]![1]).url).toBe("https://example.com/blog");
  });

  test("an attribute value merely mentioning data-no-track does not opt out", async () => {
    const { env, put } = fakeEnv();
    const html = `<a title="see data-no-track docs" href="https://example.com/docs">docs</a>`;

    const out = await rewriteHtmlForTracking(html, env, "usr_1", "ob_1", CLICKS_ONLY);

    expect(out).toMatch(new RegExp(`^<a title="see data-no-track docs" href="${BASE}/t/c/[^"]+">docs</a>$`));
    expect(put).toHaveBeenCalledTimes(1);
  });

  test("leaves mailto:, tel:, relative, anchor and already-tracked links untouched", async () => {
    const { env, put } = fakeEnv();
    const html =
      `<a href="mailto:help@example.com">mail</a>` +
      `<a href="tel:+15551234">call</a>` +
      `<a href="/relative/path">rel</a>` +
      `<a href="#section">anchor</a>` +
      `<a href="${BASE}/t/c/existing-token">already</a>` +
      `<a name="no-href">x</a>` +
      `<abbr title="https://example.com">abbr</abbr>`;

    const out = await rewriteHtmlForTracking(html, env, "usr_1", "ob_1", CLICKS_ONLY);

    expect(out).toBe(html);
    expect(put).not.toHaveBeenCalled();
  });

  test("does not rewrite when clicks are off", async () => {
    const { env, put } = fakeEnv();
    const html = `<a href="https://example.com/x">x</a>`;

    const out = await rewriteHtmlForTracking(html, env, "usr_1", "ob_1", {
      opens: false,
      clicks: false,
    });

    expect(out).toBe(html);
    expect(put).not.toHaveBeenCalled();
  });
});
