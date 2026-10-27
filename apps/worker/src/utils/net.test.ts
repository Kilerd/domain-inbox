import { describe, expect, it } from "vitest";
import { isBlockedHost, validatePublicHttpUrl } from "./net";

describe("isBlockedHost", () => {
  it.each([
    "localhost",
    "foo.localhost",
    "metadata.google.internal",
    "printer.local",
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.0.1",
    "169.254.169.254",
    "100.64.0.1",
    "[::1]",
    "[fe80::1]",
    "[fd00::1]",
  ])("blocks %s", (host) => {
    expect(isBlockedHost(host)).toBe(true);
  });

  it.each(["example.com", "1.1.1.1", "172.32.0.1", "100.128.0.1", "[2001:db8::1]"])(
    "allows %s",
    (host) => {
      expect(isBlockedHost(host)).toBe(false);
    },
  );
});

describe("validatePublicHttpUrl", () => {
  it("accepts a public https URL", () => {
    expect(validatePublicHttpUrl("https://hooks.example.com/inbox")?.hostname).toBe(
      "hooks.example.com",
    );
  });

  it("rejects credentials, non-http schemes and private hosts", () => {
    expect(validatePublicHttpUrl("https://user:pass@example.com")).toBeNull();
    expect(validatePublicHttpUrl("ftp://example.com")).toBeNull();
    expect(validatePublicHttpUrl("http://127.0.0.1:8787/hook")).toBeNull();
    expect(validatePublicHttpUrl("https://[::1]/hook")).toBeNull();
  });

  it("can allow a non-default port for webhooks", () => {
    expect(validatePublicHttpUrl("https://hooks.example.com:8443/x", { defaultPortOnly: true })).toBeNull();
    expect(
      validatePublicHttpUrl("https://hooks.example.com:8443/x", { defaultPortOnly: false })?.port,
    ).toBe("8443");
  });

  it("caps the URL length", () => {
    expect(
      validatePublicHttpUrl(`https://example.com/${"a".repeat(3000)}`, { maxLength: 2048 }),
    ).toBeNull();
  });
});
