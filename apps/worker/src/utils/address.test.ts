import { describe, expect, test } from "vitest";
import { asAddrList, domainOf, firstInvalid, parseAddr } from "./address";

describe("parseAddr", () => {
  test("bare address", () => {
    expect(parseAddr("foo@example.com")).toEqual({ addr: "foo@example.com" });
  });

  test("lowercases domain part", () => {
    expect(parseAddr("Foo@ExAmpLe.COM")).toEqual({ addr: "foo@example.com" });
  });

  test("display form with name", () => {
    expect(parseAddr("Alice <alice@example.com>")).toEqual({
      name: "Alice",
      addr: "alice@example.com",
    });
  });

  test("display form with quoted name", () => {
    expect(parseAddr('"Doe, John" <john@example.com>')).toEqual({
      name: "Doe, John",
      addr: "john@example.com",
    });
  });

  test("empty display name drops name field", () => {
    expect(parseAddr("<x@y.com>")).toEqual({ addr: "x@y.com" });
  });

  test("trims surrounding whitespace", () => {
    expect(parseAddr("   spacey@host.com   ")).toEqual({ addr: "spacey@host.com" });
  });
});

describe("asAddrList", () => {
  test("undefined / null", () => {
    expect(asAddrList(undefined)).toEqual([]);
    expect(asAddrList(null)).toEqual([]);
  });

  test("single string", () => {
    expect(asAddrList("a@b.com")).toEqual([{ addr: "a@b.com" }]);
  });

  test("string array", () => {
    expect(asAddrList(["a@b.com", "Alice <alice@b.com>"])).toEqual([
      { addr: "a@b.com" },
      { name: "Alice", addr: "alice@b.com" },
    ]);
  });

  test("filters non-strings and empties", () => {
    expect(asAddrList(["a@b.com", 42, "", null])).toEqual([{ addr: "a@b.com" }]);
  });
});

describe("firstInvalid", () => {
  test("returns null for all-valid", () => {
    expect(firstInvalid([{ addr: "a@b.com" }, { addr: "c@d.io" }])).toBeNull();
  });

  test("returns first malformed", () => {
    expect(firstInvalid([{ addr: "a@b.com" }, { addr: "not-an-email" }])).toBe("not-an-email");
  });
});

describe("domainOf", () => {
  test("extracts domain", () => {
    expect(domainOf("foo@example.com")).toBe("example.com");
  });

  test("returns null for malformed", () => {
    expect(domainOf("no-at-here")).toBeNull();
    expect(domainOf("@leading")).toBeNull();
  });

  test("lowercases", () => {
    expect(domainOf("foo@Example.com")).toBe("example.com");
  });
});
