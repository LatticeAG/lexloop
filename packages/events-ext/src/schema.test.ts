import { describe, expect, it } from "vitest";
import { latticeExtensionEnvelopeSchema, lexLoopEventSchema } from "./schema.ts";
import { toLatticeExtension } from "./toLattice.ts";
import type { LexLoopEvent } from "./types.ts";

const sample: LexLoopEvent = {
  v: "lexloop/v1",
  id: "01M0872B3V4MKNCTN13B283Q0X",
  ts: "2026-08-17T15:00:00.123Z",
  run_id: "run_01M0872B3TQBTD4MD5FSFA5PMG",
  session_id: "ses_01M0872B3TPV6Z6EQJGP9B05V2",
  seq: 1,
  name: "budget_skipped",
  payload: {
    v: "lexloop/v1",
    reason: "detect_budget",
    budget_ms: 2,
  },
};

describe("lexLoopEventSchema", () => {
  it("rejects timestamps that do not end in Z", () => {
    const result = lexLoopEventSchema.safeParse({
      ...sample,
      ts: "2026-08-17T15:00:00.123+00:00",
    });
    expect(result.success).toBe(false);
  });

  it("rejects additional payload properties", () => {
    const result = lexLoopEventSchema.safeParse({
      ...sample,
      payload: { ...sample.payload, leftover: true },
    });
    expect(result.success).toBe(false);
  });

  it("accepts a valid native event", () => {
    expect(lexLoopEventSchema.parse(sample).name).toBe("budget_skipped");
  });
});

describe("latticeExtensionEnvelopeSchema", () => {
  it("accepts toLatticeExtension output", () => {
    const envelope = toLatticeExtension(sample, { causation_id: sample.id });
    expect(latticeExtensionEnvelopeSchema.parse(envelope).causation_id).toBe(sample.id);
  });
});
