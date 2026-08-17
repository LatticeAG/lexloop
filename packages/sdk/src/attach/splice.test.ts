import { describe, expect, it } from "vitest";
import { spliceMessages } from "./splice.ts";

describe("spliceMessages", () => {
  it("does not mutate input and appends a copy with role and text", () => {
    const input = [{ role: "user", content: "hi" }];
    const snapshot = structuredClone(input);
    const out = spliceMessages(input, "nudge text", "system");
    expect(input).toEqual(snapshot);
    expect(out).not.toBe(input);
    expect(out).toHaveLength(2);
    expect(out[0]).toBe(input[0]);
    expect(out[1]).toEqual({ role: "system", content: "nudge text" });
  });
});
