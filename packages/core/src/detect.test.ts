import { describe, expect, it } from "vitest";
import { CLUSTER_ID_RE, clusterId, newInterventionId } from "./ids.ts";
import { checkBudget, noteSkip, shouldSkipDetect } from "./budget.ts";
import { detect, defaultDetectConfig, isPollTool } from "./detect.ts";
import { RunState, recordN } from "./run.ts";
import { isSentinelText, matchSentinel, SENTINEL_RE } from "./sentinel.ts";
import type { DetectBudgetState } from "./budget.ts";

const HEX64 = /^[0-9a-f]{64}$/;

describe("detect exact_repeat", () => {
  it("fires at 3 identical failing tool_results", async () => {
    const state = new RunState({ detect: { budget_ms: 20 } });
    await recordN(state, 3, "lookup", { q: "trace" }, "invalid");
    const d = state.detect();
    expect(d.candidate).toBe(true);
    expect(d.pattern).toBe("exact_repeat");
    expect(d.run_length).toBe(3);
    expect(d.poll).toBe(false);
    expect(d.cycle_length).toBe(1);
    expect(d.signatures).toHaveLength(1);
    expect(d.signatures[0]).toMatch(HEX64);
    expect(d.cluster_id).toMatch(CLUSTER_ID_RE);
    expect(d.cluster_id).toBe(clusterId(d.signatures));
  });

  it("does not fire at 2 identical failing tool_results", async () => {
    const state = new RunState({ detect: { budget_ms: 20 } });
    await recordN(state, 2, "lookup", { q: "trace" }, "invalid");
    const d = state.detect();
    expect(d.candidate).toBe(false);
    expect(d.pattern).toBe("none");
    expect(d.run_length).toBe(0);
  });
});

describe("detect ping_pong", () => {
  it("fires at 3 cycles of A-B with two arg hashes, both errors", async () => {
    const state = new RunState({ detect: { budget_ms: 20 } });
    for (let i = 0; i < 3; i++) {
      await state.recordToolResult({
        tool_name: "lookup",
        args: { id: "a" },
        error: "invalid",
      });
      await state.recordToolResult({
        tool_name: "lookup",
        args: { id: "b" },
        error: "invalid",
      });
    }
    const d = state.detect();
    expect(d.candidate).toBe(true);
    expect(d.pattern).toBe("ping_pong");
    expect(d.run_length).toBe(6);
    expect(d.cycle_length).toBe(2);
    expect(d.poll).toBe(false);
    expect(d.signatures).toHaveLength(2);
    expect(d.signatures[0]).toMatch(HEX64);
    expect(d.signatures[1]).toMatch(HEX64);
    expect(d.signatures[0]).not.toBe(d.signatures[1]);
    expect(d.cluster_id).toMatch(CLUSTER_ID_RE);
    expect(d.cluster_id).toBe(clusterId(d.signatures));
  });

  it("does not fire at 2 cycles", async () => {
    const state = new RunState({ detect: { budget_ms: 20 } });
    for (let i = 0; i < 2; i++) {
      await state.recordToolResult({
        tool_name: "lookup",
        args: { id: "a" },
        error: "invalid",
      });
      await state.recordToolResult({
        tool_name: "lookup",
        args: { id: "b" },
        error: "invalid",
      });
    }
    const d = state.detect();
    expect(d.pattern).not.toBe("ping_pong");
    expect(d.candidate).toBe(false);
  });
});

describe("detect cycle", () => {
  it("fires on period 3 repeated 3 times with err_invalid", async () => {
    const state = new RunState({ detect: { budget_ms: 20 } });
    for (let i = 0; i < 3; i++) {
      await state.recordToolResult({ tool_name: "t1", args: {}, error: "invalid" });
      await state.recordToolResult({ tool_name: "t2", args: {}, error: "invalid" });
      await state.recordToolResult({ tool_name: "t3", args: {}, error: "invalid" });
    }
    const d = state.detect();
    expect(d.candidate).toBe(true);
    expect(d.pattern).toBe("cycle");
    expect(d.cycle_length).toBe(3);
    expect(d.run_length).toBe(9);
    expect(d.signatures).toHaveLength(3);
    for (const sig of d.signatures) expect(sig).toMatch(HEX64);
    expect(new Set(d.signatures).size).toBe(3);
    expect(d.cluster_id).toMatch(CLUSTER_ID_RE);
    expect(d.cluster_id).toBe(clusterId(d.signatures));
  });
});

describe("detect poll", () => {
  it("get_status x7 ok is not exact_repeat; x8 is poll exact_repeat", async () => {
    const seven = new RunState({ detect: { budget_ms: 20 } });
    await recordN(seven, 7, "get_status", { n: 1 });
    const d7 = seven.detect();
    expect(d7.candidate).toBe(false);
    expect(d7.pattern).not.toBe("exact_repeat");

    const eight = new RunState({ detect: { budget_ms: 20 } });
    await recordN(eight, 8, "get_status", { n: 1 });
    const d8 = eight.detect();
    expect(d8.candidate).toBe(true);
    expect(d8.pattern).toBe("exact_repeat");
    expect(d8.poll).toBe(true);
    expect(d8.run_length).toBe(8);
  });

  it("process allowlist exact name x8 ok is poll exact_repeat", async () => {
    const state = new RunState({ detect: { budget_ms: 20 } });
    await recordN(state, 8, "process", { pid: 1 });
    const d = state.detect();
    expect(isPollTool("process", defaultDetectConfig())).toBe(true);
    expect(d.candidate).toBe(true);
    expect(d.pattern).toBe("exact_repeat");
    expect(d.poll).toBe(true);
    expect(d.run_length).toBe(8);
  });
});

describe("detect intervention_id exclusion", () => {
  it("excludes a sentinel-tagged step from the window", async () => {
    const tagged = new RunState({ detect: { budget_ms: 20 } });
    await recordN(tagged, 2, "lookup", { q: 1 }, "invalid");
    await tagged.recordToolResult({
      tool_name: "lookup",
      args: { q: 1 },
      error: "invalid",
      intervention_id: newInterventionId(),
    });
    const dTagged = tagged.detect();
    expect(dTagged.candidate).toBe(false);

    const plusOne = new RunState({ detect: { budget_ms: 20 } });
    await recordN(plusOne, 3, "lookup", { q: 1 }, "invalid");
    await plusOne.recordToolResult({
      tool_name: "lookup",
      args: { q: 1 },
      error: "invalid",
      intervention_id: newInterventionId(),
    });
    const dPlus = plusOne.detect();
    expect(dPlus.candidate).toBe(true);
    expect(dPlus.pattern).toBe("exact_repeat");
    expect(dPlus.run_length).toBe(3);
    expect(dPlus.window_used).toBe(3);
  });
});

describe("detect budget skip", () => {
  it("emits reason detect_budget when elapsed exceeds budget", async () => {
    expect(checkBudget({ elapsed_ms: 5, budget_ms: 2 })).toBe(true);
    expect(shouldSkipDetect(5, 2)).toBe(true);
    expect(shouldSkipDetect(2, 2)).toBe(false);

    let n = 0;
    const now = () => {
      n += 1;
      return n === 1 ? 0 : 5;
    };
    const state = new RunState({ now });
    await recordN(state, 3, "lookup", { q: 1 }, "invalid");
    const d = state.detect();
    expect(d.candidate).toBe(false);
    expect(d.pattern).toBe("none");
    expect(state.skipped.some((s) => s.reason === "detect_budget")).toBe(true);
    const skip = state.skipped.find((s) => s.reason === "detect_budget");
    expect(skip?.elapsed_ms).toBe(5);
    expect(skip?.budget_ms).toBe(2);
  });
});

describe("detect ring overflow", () => {
  it("records ring_overflow after capacity 64", async () => {
    const state = new RunState({ detect: { ring_capacity: 64, budget_ms: 20 } });
    await recordN(state, 65, "lookup", { q: 1 }, "invalid");
    expect(state.steps).toHaveLength(64);
    expect(state.skipped.some((s) => s.reason === "ring_overflow")).toBe(true);
    expect(state.steps[0]?.seq).toBe(2);
    expect(state.steps[63]?.seq).toBe(65);
  });
});

describe("detect ignores open tool_call rows", () => {
  it("does not count tool_call rows in min_run", async () => {
    const state = new RunState({ detect: { budget_ms: 20 } });
    await recordN(state, 2, "lookup", { q: 1 }, "invalid");
    await state.recordToolCall({ tool_name: "lookup", args: { q: 1 } });
    await state.recordToolResult({
      tool_name: "lookup",
      args: { q: 1 },
      error: "invalid",
    });
    const d = state.detect();
    expect(d.candidate).toBe(true);
    expect(d.pattern).toBe("exact_repeat");
    expect(d.run_length).toBe(3);
    expect(d.window_used).toBe(3);
  });
});

describe("isPollTool", () => {
  it("matches default regex case-insensitively and exact allowlist names", () => {
    const cfg = defaultDetectConfig();
    expect(isPollTool("get_status", cfg)).toBe(true);
    expect(isPollTool("GET_STATUS", cfg)).toBe(true);
    expect(isPollTool("process", cfg)).toBe(true);
    expect(isPollTool("lookup", cfg)).toBe(false);
  });

  it("empty allowlist drops exact-name exemptions; empty regex matches none", () => {
    const noExact = defaultDetectConfig();
    noExact.poll.allowlist = [];
    expect(isPollTool("process", noExact)).toBe(false);
    expect(isPollTool("get_status", noExact)).toBe(true);

    const noRegex = defaultDetectConfig();
    noRegex.poll.name_regex = "";
    expect(isPollTool("get_status", noRegex)).toBe(false);
    expect(isPollTool("process", noRegex)).toBe(true);
  });
});

describe("sentinel", () => {
  it("matches injected intervention prefix", () => {
    const id = newInterventionId();
    const text = `[lexloop intervention id=${id} level=soft] try another tool`;
    expect(SENTINEL_RE.test(text)).toBe(true);
    expect(isSentinelText(text)).toBe(true);
    expect(matchSentinel(text)).toEqual({ intervention_id: id, level: "soft" });
    expect(isSentinelText("nope")).toBe(false);
  });
});

describe("noteSkip degraded", () => {
  it("sets detect_degraded after 3 consecutive skips", () => {
    const state: DetectBudgetState = {
      detect_degraded: false,
      consecutive_skips: 0,
      sample_tick: 0,
      skipped: [],
    };
    noteSkip(state);
    noteSkip(state);
    expect(state.detect_degraded).toBe(false);
    noteSkip(state);
    expect(state.detect_degraded).toBe(true);
  });
});

describe("detect() function matches RunState.detect for the algorithm", () => {
  it("uses the same window filter", async () => {
    const state = new RunState({ detect: { budget_ms: 20 } });
    await recordN(state, 3, "lookup", { q: 1 }, "invalid");
    const a = detect(state, defaultDetectConfig());
    const b = state.detect();
    expect(a.candidate).toBe(b.candidate);
    expect(a.pattern).toBe(b.pattern);
    expect(a.cluster_id).toBe(b.cluster_id);
    expect(a.run_length).toBe(b.run_length);
  });
});
