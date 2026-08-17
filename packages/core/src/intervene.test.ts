import { describe, expect, it } from "vitest";
import { classify } from "./classify.ts";
import { emptyLadder, nextLevel } from "./ladder.ts";
import {
  buildHardIntervention,
  buildHumanIntervention,
  buildIntervention,
} from "./intervene.ts";
import { fillHardTemplate, fillSoftTemplate, SOFT_TEMPLATE_VERSION } from "./templates.ts";
import { SENTINEL_RE } from "./sentinel.ts";
import { RunState, recordN } from "./run.ts";
import { measureUnstick } from "./unstick.ts";
import type { ClusterLadder } from "./types.ts";

function freshState(): RunState {
  return new RunState({ detect: { budget_ms: 20 } });
}

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

function ladderWithSoft(cluster_id: string): ClusterLadder {
  return {
    cluster_id,
    injected: [
      {
        level: "soft",
        fingerprint: "fp_soft",
        intervention_id: "llint_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        seq: 4,
      },
    ],
    cooldown_until_seq: 8,
  };
}

describe("soft template", () => {
  it("starts with the sentinel line", () => {
    const text = fillSoftTemplate({
      intervention_id: "llint_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      tool_name: "bash",
      run_length: 5,
      delta: {
        tried_tools: ["bash"],
        tried_signatures: ["sig"],
        tried_outcomes: [{ class: "err_not_found", n: 5 }],
        frozen_arg_hashes: true,
        untried_tools: ["read_file", "grep"],
        note_vary_args: true,
        note_change_tool: true,
        excerpts: [],
      },
    });
    expect(text.startsWith("[lexloop intervention id=llint_01ARZ3NDEKTSV4RRFFQ69G5FAV level=soft]")).toBe(
      true,
    );
    expect(SENTINEL_RE.test(text)).toBe(true);
  });

  it("max_chars truncation keeps first and last line", () => {
    const long = (n: number) => `tool_${n}_` + "x".repeat(110);
    const tried = Array.from({ length: 8 }, (_, i) => long(i));
    const untried = Array.from({ length: 8 }, (_, i) => long(i + 20));
    const text = fillSoftTemplate({
      intervention_id: "llint_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      tool_name: "bash",
      run_length: 5,
      max_chars: 400,
      delta: {
        tried_tools: tried,
        tried_signatures: [],
        tried_outcomes: [{ class: "err_not_found", n: 5 }],
        frozen_arg_hashes: true,
        untried_tools: untried,
        note_vary_args: true,
        note_change_tool: true,
        excerpts: [],
      },
    });
    const lines = text.split("\n");
    expect(lines[0]).toBe(
      "[lexloop intervention id=llint_01ARZ3NDEKTSV4RRFFQ69G5FAV level=soft]",
    );
    expect(lines[lines.length - 1]).toBe(
      "Next step: pick a not-tried tool, or change an argument. Do not repeat the same call.",
    );
    expect(text.includes("Tried tools:")).toBe(false);
    expect(text.length).toBeLessThanOrEqual(400);
  });
});

describe("ladder nextLevel", () => {
  it("after one soft with mvp=false is hard", () => {
    const cluster = ladderWithSoft("clus_aaaaaaaaaaaaaaaa");
    expect(nextLevel(cluster, false)).toBe("hard");
  });

  it("after one soft with mvp=true is exhausted", () => {
    const cluster = ladderWithSoft("clus_aaaaaaaaaaaaaaaa");
    expect(nextLevel(cluster, true)).toBe("exhausted");
  });
});

describe("buildHardIntervention", () => {
  it("throws LL3004 not_in_mvp", () => {
    expectNotInMvp(() => buildHardIntervention());
  });

  it("buildHumanIntervention throws LL3004 not_in_mvp", () => {
    expectNotInMvp(() => buildHumanIntervention());
  });

  it("fillHardTemplate throws LL3004 not_in_mvp", () => {
    expectNotInMvp(() => fillHardTemplate());
  });
});

describe("buildIntervention guards", () => {
  it("mode log-only does not inject", async () => {
    const state = freshState();
    await recordN(state, 4, "lookup", { q: 1 }, "invalid");
    const detection = state.detect();
    const classification = classify({ detection, state });
    expect(classification.class).toBe("stuck");
    const result = await buildIntervention({
      mode: "log-only",
      classification,
      detection,
      window: state.steps,
      cluster: emptyLadder(detection.cluster_id),
      available_tools: [],
    });
    expect(result.injected).toBe(false);
  });

  it("productive class does not inject", async () => {
    const state = freshState();
    await recordN(state, 3, "lookup", { q: 1 }, "invalid");
    const detection = state.detect();
    const classification = classify({ detection, state });
    expect(classification.class).toBe("productive");
    const result = await buildIntervention({
      mode: "intervene",
      classification,
      detection,
      window: state.steps,
      cluster: emptyLadder(detection.cluster_id),
      available_tools: [],
    });
    expect(result.injected).toBe(false);
  });

  it("second soft skipped by fingerprint and ladder", async () => {
    const state = freshState();
    await recordN(state, 4, "lookup", { q: 1 }, "invalid");
    const detection = state.detect();
    const classification = classify({ detection, state });
    const cluster = emptyLadder(detection.cluster_id);
    const first = await buildIntervention({
      mode: "intervene",
      classification,
      detection,
      window: state.steps,
      cluster,
      available_tools: [],
    });
    expect(first.injected).toBe(true);
    const second = await buildIntervention({
      mode: "intervene",
      classification,
      detection,
      window: state.steps,
      cluster,
      available_tools: [],
    });
    expect(second.injected).toBe(false);
  });

  it("cooldown: inject then immediately again is skipped", async () => {
    const state = freshState();
    await recordN(state, 4, "lookup", { q: 1 }, "invalid");
    const detection = state.detect();
    const classification = classify({ detection, state });
    const seq = state.steps[state.steps.length - 1]!.seq;
    const cluster = emptyLadder(detection.cluster_id);
    const first = await buildIntervention({
      mode: "intervene",
      classification,
      detection,
      window: state.steps,
      cluster,
      seq,
      available_tools: [],
    });
    expect(first.injected).toBe(true);
    expect(cluster.cooldown_until_seq).toBe(seq + 4);

    cluster.injected = [];
    const again = await buildIntervention({
      mode: "intervene",
      classification,
      detection,
      window: state.steps,
      cluster,
      seq,
      available_tools: [],
    });
    expect(again.injected).toBe(false);
    if (again.injected === false) {
      expect(again.budget_skipped?.reason).toBe("ladder_hold");
    }
  });

  it("buildIntervention with mvp still refuses hard", async () => {
    const state = freshState();
    await recordN(state, 4, "lookup", { q: 1 }, "invalid");
    const detection = state.detect();
    const classification = classify({ detection, state });
    const cluster = ladderWithSoft(detection.cluster_id);
    cluster.cooldown_until_seq = 0;
    const refusedMvp = await buildIntervention({
      mode: "intervene",
      classification,
      detection,
      window: state.steps,
      cluster,
      mvp: true,
      available_tools: [],
    });
    expect(refusedMvp.injected).toBe(false);

    const refusedHard = await buildIntervention({
      mode: "intervene",
      classification,
      detection,
      window: state.steps,
      cluster,
      mvp: false,
      available_tools: [],
    });
    expect(refusedHard.injected).toBe(false);
    if (refusedHard.injected === false) {
      expect(refusedHard.ladder_blocked).toBe("mvp");
      expect(refusedHard.code).toBe("LL3004");
    }
  });

  it("oversize intervention skips with LL3003", async () => {
    const state = freshState();
    await recordN(state, 4, "lookup", { q: 1 }, "invalid");
    const detection = state.detect();
    const classification = classify({ detection, state });
    const result = await buildIntervention({
      mode: "intervene",
      classification,
      detection,
      window: state.steps,
      cluster: emptyLadder(detection.cluster_id),
      available_tools: [],
      intervene: { max_chars: 80 },
    });
    expect(result.injected).toBe(false);
    if (result.injected === false) {
      expect(result.code).toBe("LL3003");
      expect(result.budget_skipped?.reason).toBe("oversize_intervention");
    }
  });
});

describe("L01 unstick", () => {
  it("5x bash ENOENT injects once, then a different bash is unstuck", async () => {
    const state = freshState();
    await recordN(state, 5, "bash", { cmd: "cat /nope" }, "ENOENT");
    const detection = state.detect();
    const classification = classify({ detection, state });
    expect(classification.class).toBe("stuck");
    expect(classification.rule_id).toBe("R09");

    const cluster = emptyLadder(detection.cluster_id);
    const first = await buildIntervention({
      mode: "intervene",
      classification,
      detection,
      window: state.steps,
      cluster,
      available_tools: ["read_file", "grep"],
    });
    expect(first.injected).toBe(true);
    if (first.injected !== true) throw new Error("expected inject");
    expect(first.level).toBe("soft");
    expect(first.template_version).toBe(SOFT_TEMPLATE_VERSION);
    expect(SENTINEL_RE.test(first.text)).toBe(true);
    expect(first.delta.tried_tools).toEqual(["bash"]);
    expect(first.delta.untried_tools).toEqual(["read_file", "grep"]);
    expect(first.delta.frozen_arg_hashes).toBe(true);
    expect(first.delta.excerpts).toEqual([]);

    const afterIndex = state.steps.length;
    await state.recordToolResult({
      tool_name: "bash",
      args: { cmd: "ls /tmp" },
      error: "ENOENT",
    });
    const after = state.steps.slice(afterIndex);
    expect(
      measureUnstick({
        cluster_signatures: detection.signatures,
        after,
        window: 4,
      }),
    ).toBe(true);

    const second = await buildIntervention({
      mode: "intervene",
      classification,
      detection,
      window: state.steps,
      cluster,
      available_tools: ["read_file", "grep"],
    });
    expect(second.injected).toBe(false);
  });
});
