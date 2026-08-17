import {
  RunState,
  detect,
} from "@latticeag/lexloop-core";
import { p99 } from "./stats.ts";

export const SOFT_TARGET_MS = 2;
export const CI_FAIL_MS = 8;

export type DetectLoadResult = {
  p99_ms: number;
  n: number;
  soft_target_ms: number;
  ci_fail_ms: number;
};

export async function runDetectLoad(n = 10_000): Promise<DetectLoadResult> {
  const state = new RunState({
    detect: { budget_ms: 20, ring_capacity: 65_536, window_steps: 16 },
  });
  const samples: number[] = [];
  const half = Math.floor(n / 2);

  for (let i = 0; i < n; i++) {
    if (i < half) {
      await state.recordToolResult({
        tool_name: "bash",
        args: { cmd: "cat /nope" },
        error: "ENOENT: no such file or directory, open '/nope'",
      });
    } else {
      await state.recordToolResult({
        tool_name: `tool_${i}`,
        args: { i, nonce: `u-${i}` },
        error: `fail-${i}`,
      });
    }
    const detection = detect(state, state.detectCfg);
    samples.push(detection.detect_ms);
  }

  return {
    p99_ms: p99(samples),
    n,
    soft_target_ms: SOFT_TARGET_MS,
    ci_fail_ms: CI_FAIL_MS,
  };
}

export function detectLoadPassed(result: DetectLoadResult): boolean {
  return result.p99_ms <= result.ci_fail_ms;
}
