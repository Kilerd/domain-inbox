import { describe, expect, it } from "vitest";
import { refsToArrayJson } from "./parse";

describe("refsToArrayJson", () => {
  it("strips angle brackets so refs match bare-stored rfc822_message_id", () => {
    const json = refsToArrayJson("<a@x.com> <b@y.com>");
    expect(JSON.parse(json!)).toEqual(["a@x.com", "b@y.com"]);
  });

  it("handles array input from postal-mime", () => {
    const json = refsToArrayJson(["<a@x.com>", "b@y.com"]);
    expect(JSON.parse(json!)).toEqual(["a@x.com", "b@y.com"]);
  });

  it("returns null for empty input", () => {
    expect(refsToArrayJson(undefined)).toBeNull();
    expect(refsToArrayJson("")).toBeNull();
    expect(refsToArrayJson("   ")).toBeNull();
  });
});
