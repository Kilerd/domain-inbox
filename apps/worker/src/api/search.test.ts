import { describe, expect, it } from "vitest";
import { escapeLike, parseSearchQuery } from "./search";

describe("parseSearchQuery", () => {
  it("quotes free text and extracts operators", () => {
    const parsed = parseSearchQuery(
      'from:github subject:"quarterly report" has:attachment is:unread after:2026-01-01 hello world',
    );
    expect(parsed.fts).toBe('"hello" AND "world"');
    expect(parsed.from).toBe("github");
    expect(parsed.subject).toBe("quarterly report");
    expect(parsed.hasAttachment).toBe(true);
    expect(parsed.unreadOnly).toBe(true);
    expect(parsed.after).toBe(Date.parse("2026-01-01"));
    expect(parsed.before).toBeUndefined();
  });

  it("keeps a quoted phrase together", () => {
    expect(parseSearchQuery('"hello world"').fts).toBe('"hello world"');
  });

  it("does not turn unknown key:value tokens into operators", () => {
    expect(parseSearchQuery("foo:bar").fts).toBe('"foo:bar"');
  });

  it("ignores invalid dates instead of failing the search", () => {
    const parsed = parseSearchQuery("after:not-a-date invoice");
    expect(parsed.after).toBeUndefined();
    expect(parsed.fts).toBe('"invoice"');
  });

  it("returns only structured filters when there is no free text", () => {
    expect(parseSearchQuery("is:unread").fts).toBeNull();
  });
});

describe("escapeLike", () => {
  it("escapes LIKE metacharacters", () => {
    expect(escapeLike("100%_\\")).toBe("100\\%\\_\\\\");
  });
});
