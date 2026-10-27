import { describe, expect, it } from "vitest";
import {
  buildOutboundFilters,
  deriveDisplayStatus,
  shapeOutbound,
  type OutboundRow,
} from "./outbound";

const row: OutboundRow = {
  id: "o_1",
  status: "sent",
  created_at: 1_800_000_000_000,
  sent_at: 1_800_000_001_000,
  scheduled_at: null,
  bounced_at: null,
  bounce_type: null,
  bounce_diag: null,
  last_error: null,
  template_id: null,
  tracking_enabled: 0,
  open_count: 2,
  click_count: 1,
  first_opened_at: 1_800_000_002_000,
  last_opened_at: 1_800_000_002_000,
  first_clicked_at: 1_800_000_003_000,
  last_clicked_at: 1_800_000_003_000,
  api_key_id: null,
  idempotency_key: "idem-1",
  request_json: JSON.stringify({
    from: "hello@example.test",
    to: ["a@b.test"],
    subject: "Hi",
  }),
};

describe("deriveDisplayStatus", () => {
  it("prefers terminal delivery failures over engagement", () => {
    expect(deriveDisplayStatus({ ...row, status: "bounced" })).toBe("bounced");
    expect(deriveDisplayStatus({ ...row, bounce_type: "hard" })).toBe("bounced");
    expect(deriveDisplayStatus({ ...row, bounce_type: "complaint" })).toBe("complained");
    expect(deriveDisplayStatus({ ...row, status: "failed" })).toBe("failed");
  });

  it("reports the latest engagement for a delivered mail", () => {
    expect(deriveDisplayStatus({ ...row, click_count: 0, open_count: 1 })).toBe("opened");
    expect(deriveDisplayStatus({ ...row, click_count: 0, open_count: 0 })).toBe("delivered");
  });

  it("maps in-flight states to queued", () => {
    expect(deriveDisplayStatus({ ...row, status: "sending" })).toBe("queued");
    expect(deriveDisplayStatus({ ...row, status: "scheduled" })).toBe("scheduled");
  });
});

describe("shapeOutbound", () => {
  it("keeps the Resend shape on the API surface", () => {
    const shaped = shapeOutbound(row, "api");
    expect(shaped).toMatchObject({ object: "email", id: "o_1", idempotency_key: "idem-1" });
    expect(shaped).not.toHaveProperty("display_status");
    expect(shaped.from).toBe("hello@example.test");
  });

  it("adds display_status and hides idempotency_key on the SPA surface", () => {
    const shaped = shapeOutbound(row, "inbox");
    expect(shaped.display_status).toBe("clicked");
    expect(shaped).not.toHaveProperty("idempotency_key");
    expect(shaped.tracking).toMatchObject({ open_count: 2, click_count: 1 });
  });
});

describe("buildOutboundFilters", () => {
  it("builds every supported dimension with aligned binds", () => {
    const url = new URL(
      "https://x/?status=sent&domain=example.test&api_key=k_1&q=hi" +
        "&created_after=2026-01-01T00:00:00Z&created_before=2026-02-01T00:00:00Z",
    );
    const built = buildOutboundFilters(url, "u_1");
    expect(built).not.toBeInstanceOf(Response);
    const { sql, binds } = built as { sql: string; binds: Array<string | number> };
    expect(sql).toContain("om.owner_id = ?1");
    expect(sql).toContain("om.status = ?2");
    expect(sql).toContain("om.api_key_id = ?3");
    expect(sql).toContain("json_extract(om.request_json, '$.subject')");
    expect(binds).toEqual([
      "u_1",
      "sent",
      "k_1",
      "%@example.test%",
      "%hi%",
      Date.parse("2026-01-01T00:00:00Z"),
      Date.parse("2026-02-01T00:00:00Z"),
    ]);
  });

  it("rejects an unparseable date", () => {
    const built = buildOutboundFilters(new URL("https://x/?created_after=nope"), "u_1");
    expect(built).toBeInstanceOf(Response);
    expect((built as Response).status).toBe(422);
  });
});
