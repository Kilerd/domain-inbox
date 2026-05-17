import { describe, expect, test } from "vitest";
import { normalizeSubject } from "./thread";

describe("normalizeSubject", () => {
  test("returns empty for nullish", () => {
    expect(normalizeSubject(null)).toBe("");
    expect(normalizeSubject(undefined)).toBe("");
    expect(normalizeSubject("")).toBe("");
  });

  test("strips single Re:", () => {
    expect(normalizeSubject("Re: Project plan")).toBe("project plan");
  });

  test("strips nested reply prefixes", () => {
    expect(normalizeSubject("Re: Re: Re: hi")).toBe("hi");
  });

  test("strips Fwd / Fw / forwarded forms", () => {
    expect(normalizeSubject("Fwd: status update")).toBe("status update");
    expect(normalizeSubject("Fw: status update")).toBe("status update");
  });

  test("strips mixed reply/forward prefixes", () => {
    expect(normalizeSubject("Re: Fwd: Re: deadline")).toBe("deadline");
  });

  test("strips locale forms (sv / aw / antwort)", () => {
    expect(normalizeSubject("Sv: ärende")).toBe("ärende");
    expect(normalizeSubject("AW: bitte")).toBe("bitte");
  });

  test("collapses whitespace", () => {
    expect(normalizeSubject("Re:   hello   world  ")).toBe("hello world");
  });

  test("lowercases", () => {
    expect(normalizeSubject("PROJECT PLAN")).toBe("project plan");
  });

  test("leaves non-prefix-looking text alone", () => {
    expect(normalizeSubject("Recipe ideas")).toBe("recipe ideas");
  });
});
