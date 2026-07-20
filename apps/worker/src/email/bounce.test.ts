import { describe, expect, it } from "vitest";
import { parseDsn } from "./bounce";

function dsnEml(contentType: string, fields: string): string {
  return [
    "From: MAILER-DAEMON@relay.example.com",
    "To: bounce@sender.example.com",
    "Message-ID: <dsn-1@relay.example.com>",
    `Content-Type: ${contentType}`,
    "",
    "--b1",
    "Content-Type: message/delivery-status",
    "",
    fields,
    "",
    "--b1",
    "Content-Type: text/rfc822-headers",
    "",
    "Message-ID: <original-42@sender.example.com>",
    "--b1--",
  ].join("\r\n");
}

describe("parseDsn", () => {
  it("detects a DSN with report-type first", () => {
    const dsn = parseDsn(
      dsnEml(
        'multipart/report; report-type=delivery-status; boundary="b1"',
        "Status: 5.1.1\r\nAction: failed\r\nFinal-Recipient: rfc822; gone@example.com",
      ),
    );
    expect(dsn.kind).toBe("dsn");
    expect(dsn.bounceType).toBe("hard");
    expect(dsn.originalMessageId).toBe("original-42@sender.example.com");
    expect(dsn.finalRecipient).toBe("gone@example.com");
  });

  it("detects a DSN when boundary precedes report-type", () => {
    const dsn = parseDsn(
      dsnEml(
        'multipart/report; boundary="b1"; report-type=delivery-status',
        "Status: 5.1.1\r\nAction: failed",
      ),
    );
    expect(dsn.kind).toBe("dsn");
    expect(dsn.bounceType).toBe("hard");
  });

  it("detects a quoted report-type value", () => {
    const dsn = parseDsn(
      dsnEml(
        'multipart/report; boundary="b1"; report-type="delivery-status"',
        "Status: 4.4.1\r\nAction: delayed",
      ),
    );
    expect(dsn.kind).toBe("dsn");
    expect(dsn.bounceType).toBe("soft");
  });

  it("classifies success DSNs as delivered, not failed", () => {
    const dsn = parseDsn(
      dsnEml(
        'multipart/report; report-type=delivery-status; boundary="b1"',
        "Status: 2.0.0\r\nAction: delivered\r\nFinal-Recipient: rfc822; ok@example.com",
      ),
    );
    expect(dsn.kind).toBe("dsn");
    expect(dsn.bounceType).toBe("delivered");
  });

  it("classifies ARF reports as complaints", () => {
    const dsn = parseDsn(
      dsnEml(
        'multipart/report; boundary="b1"; report-type=feedback-report',
        "Feedback-Type: abuse",
      ),
    );
    expect(dsn.kind).toBe("arf");
    expect(dsn.bounceType).toBe("complaint");
  });

  it("returns kind null for ordinary mail", () => {
    const dsn = parseDsn("From: a@b.com\r\nContent-Type: text/plain\r\n\r\nhello");
    expect(dsn.kind).toBeNull();
  });
});
