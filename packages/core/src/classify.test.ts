import { describe, expect, it } from "vitest";
import {
  assertBeliefsMvp,
  classify,
  ruleR08,
  ruleR08b,
} from "./classify.ts";
import { emptyDetection } from "./detect.ts";
import { clusterId, newInterventionId } from "./ids.ts";
import { RunState, recordN } from "./run.ts";
import { progress_signal } from "./signals.ts";
import type { ClassifyConfig, Detection } from "./types.ts";
import { defaultClassifyConfig } from "./types.ts";

function expectNotInMvp(fn: () => unknown): void {
  try {
    fn();
    expect.fail("expected not_in_mvp throw");
  } catch (e) {
    expect(e).toBeInstanceOf(Error);
    expect((e as Error).message).toContain("not_in_mvp");
    expect((e as { code?: string }).code).toBe("LL3004");
  }
}

function syntheticDetection(partial: Partial<Detection>): Detection {
  const signatures = partial.signatures ?? [];
  return {
    candidate: false,
    pattern: "none",
    cluster_id: clusterId(signatures),
    signatures,
    run_length: 0,
    cycle_length: 0,
    poll: false,
    window_used: 0,
    detect_ms: 0,
    ...partial,
  };
}

describe("classify R01", () => {
  it("R01: two identical fails, candidate false, productive", async () => {
    const state = new RunState({ detect: { budget_ms: 20 } });
    await recordN(state, 2, "lookup", { q: "trace" }, "invalid");
    const detection = state.detect();
    expect(detection.candidate).toBe(false);
    const c = classify({ detection, state });
    expect(c.rule_id).toBe("R01");
    expect(c.class).toBe("productive");
    expect(c.belief_source).toBe("none");
  });
});

describe("classify R02", () => {
  it("R02: latest step has intervention_id, productive even if candidate true", async () => {
    const state = new RunState({ detect: { budget_ms: 20 } });
    await recordN(state, 4, "lookup", { q: 1 }, "invalid");
    await state.recordToolResult({
      tool_name: "lookup",
      args: { q: 1 },
      error: "invalid",
      intervention_id: newInterventionId(),
    });
    const detection = state.detect();
    expect(detection.candidate).toBe(true);
    const c = classify({ detection, state });
    expect(c.rule_id).toBe("R02");
    expect(c.class).toBe("productive");
  });
});

describe("classify R03", () => {
  it("R03: get_status x8 ok is poll exact_repeat classified productive", async () => {
    const state = new RunState({ detect: { budget_ms: 20 } });
    await recordN(state, 8, "get_status", { n: 1 });
    const detection = state.detect();
    expect(detection.candidate).toBe(true);
    expect(detection.poll).toBe(true);
    expect(detection.pattern).toBe("exact_repeat");
    const c = classify({ detection, state });
    expect(c.rule_id).toBe("R03");
    expect(c.class).toBe("productive");
  });
});

describe("classify R04", () => {
  it("R04: poll exact_repeat run_length 5 below poll.min_run is productive", async () => {
    const state = new RunState({ detect: { budget_ms: 20 } });
    await recordN(state, 5, "get_status", { n: 1 }, "invalid");
    const detection = syntheticDetection({
      candidate: true,
      poll: true,
      pattern: "exact_repeat",
      run_length: 5,
      signatures: [state.steps[state.steps.length - 1]!.signature],
      cycle_length: 1,
      window_used: 5,
    });
    const c = classify({ detection, state });
    expect(c.rule_id).toBe("R04");
    expect(c.class).toBe("productive");
  });
});

describe("classify R05", () => {
  it("R05: edit_file hash changes err_invalid to ok, progress true, productive", async () => {
    const state = new RunState({ detect: { budget_ms: 20 } });
    await state.recordToolResult({
      tool_name: "edit_file",
      args: { path: "P", content: "a" },
      error: "invalid",
    });
    await state.recordToolResult({
      tool_name: "edit_file",
      args: { path: "P", content: "b" },
      error: "invalid",
    });
    await state.recordToolResult({
      tool_name: "edit_file",
      args: { path: "P", content: "c" },
      result: { ok: true },
    });
    expect(progress_signal(state)).toBe(true);
    const detection = syntheticDetection({
      candidate: true,
      pattern: "exact_repeat",
      run_length: 3,
      poll: false,
      signatures: [state.steps[state.steps.length - 1]!.signature],
      cycle_length: 1,
      window_used: 3,
    });
    const c = classify({ detection, state });
    expect(c.progress_signal).toBe(true);
    expect(c.rule_id).toBe("R05");
    expect(c.class).toBe("productive");
  });
});

describe("classify R06", () => {
  it("R06: ping-pong edit A/B with fails, progress false, thrashing", async () => {
    const state = new RunState({ detect: { budget_ms: 20 } });
    for (let i = 0; i < 3; i++) {
      await state.recordToolResult({
        tool_name: "edit_file",
        args: { path: "P", content: "A" },
        error: "invalid",
      });
      await state.recordToolResult({
        tool_name: "edit_file",
        args: { path: "P", content: "B" },
        error: "invalid",
      });
    }
    const detection = state.detect();
    expect(detection.candidate).toBe(true);
    expect(detection.pattern).toBe("ping_pong");
    expect(progress_signal(state)).toBe(false);
    const c = classify({ detection, state });
    expect(c.progress_signal).toBe(false);
    expect(c.rule_id).toBe("R06");
    expect(c.class).toBe("thrashing");
  });
});

describe("classify R07", () => {
  it("R07: period-3 cycle of failing tools, progress false, thrashing", async () => {
    const state = new RunState({ detect: { budget_ms: 20 } });
    for (let i = 0; i < 3; i++) {
      await state.recordToolResult({ tool_name: "t1", args: {}, error: "invalid" });
      await state.recordToolResult({ tool_name: "t2", args: {}, error: "invalid" });
      await state.recordToolResult({ tool_name: "t3", args: {}, error: "invalid" });
    }
    const detection = state.detect();
    expect(detection.candidate).toBe(true);
    expect(detection.pattern).toBe("cycle");
    expect(progress_signal(state)).toBe(false);
    const c = classify({ detection, state });
    expect(c.rule_id).toBe("R07");
    expect(c.class).toBe("thrashing");
  });
});

describe("classify R09", () => {
  it("R09: bash cat /tmp/x five times ENOENT, no Axion, stuck", async () => {
    const state = new RunState({ detect: { budget_ms: 20 } });
    await recordN(state, 5, "bash", { cmd: "cat /tmp/x" }, "ENOENT");
    const detection = state.detect();
    expect(detection.candidate).toBe(true);
    expect(detection.pattern).toBe("exact_repeat");
    expect(detection.run_length).toBe(5);
    expect(detection.poll).toBe(false);
    expect(progress_signal(state)).toBe(false);
    const c = classify({ detection, state });
    expect(c.rule_id).toBe("R09");
    expect(c.class).toBe("stuck");
    expect(c.belief_source).toBe("none");
    expect(c.progress_signal).toBe(false);
  });

  it("four identical fails without Axion is stuck R09", async () => {
    const state = new RunState({ detect: { budget_ms: 20 } });
    await recordN(state, 4, "lookup", { q: 1 }, "invalid");
    const detection = state.detect();
    expect(detection.candidate).toBe(true);
    expect(detection.pattern).toBe("exact_repeat");
    expect(detection.run_length).toBe(4);
    const c = classify({ detection, state });
    expect(c.rule_id).toBe("R09");
    expect(c.class).toBe("stuck");
  });
});

describe("classify R11", () => {
  it("R11: write_file same args x4 all ok, non-poll, productive", async () => {
    const state = new RunState({ detect: { budget_ms: 20 } });
    await recordN(state, 4, "write_file", { path: "out.txt", body: "x" });
    const detection = state.detect();
    expect(detection.candidate).toBe(true);
    expect(detection.pattern).toBe("exact_repeat");
    expect(detection.poll).toBe(false);
    expect(detection.run_length).toBe(4);
    const c = classify({ detection, state });
    expect(c.rule_id).toBe("R11");
    expect(c.class).toBe("productive");
    expect(c.progress_signal).toBe(false);
  });
});

describe("classify R12", () => {
  it("R12 / P10: three identical fails without Axion is productive not R09", async () => {
    const state = new RunState({ detect: { budget_ms: 20 } });
    await recordN(state, 3, "lookup", { q: 1 }, "invalid");
    const detection = state.detect();
    expect(detection.candidate).toBe(true);
    expect(detection.pattern).toBe("exact_repeat");
    expect(detection.run_length).toBe(3);
    const c = classify({ detection, state });
    expect(c.rule_id).toBe("R12");
    expect(c.rule_id).not.toBe("R09");
    expect(c.class).toBe("productive");
  });
});

describe("classify beliefs MVP gate", () => {
  it("ruleR08 throws not_in_mvp LL3004", () => {
    expectNotInMvp(() => ruleR08());
  });

  it("ruleR08b throws not_in_mvp LL3004", () => {
    expectNotInMvp(() => ruleR08b());
  });

  it("assertBeliefsMvp throws when beliefs_enabled", () => {
    const cfg: ClassifyConfig = { ...defaultClassifyConfig(), beliefs_enabled: true };
    expectNotInMvp(() => assertBeliefsMvp(cfg));
  });

  it("classify with beliefs_enabled true throws not_in_mvp", () => {
    expectNotInMvp(() =>
      classify({
        detection: emptyDetection(0),
        state: { steps: [] },
        cfg: { ...defaultClassifyConfig(), beliefs_enabled: true },
      }),
    );
  });

  it("classify with default cfg does not throw and skips R08", async () => {
    const state = new RunState({ detect: { budget_ms: 20 } });
    await recordN(state, 3, "lookup", { q: 1 }, "invalid");
    const c = classify({ detection: state.detect(), state });
    expect(c.rule_id).toBe("R12");
    expect(defaultClassifyConfig().beliefs_enabled).toBe(false);
  });
});
