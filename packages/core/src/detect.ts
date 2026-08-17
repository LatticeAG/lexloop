/** packages/core/src/detect.ts */

import { clusterId } from "./ids.ts";
import type { DetectConfig, Detection, DetectPattern, LoopStep } from "./types.ts";
import { defaultDetectConfig } from "./types.ts";

export type { DetectPattern, Detection };
export { defaultDetectConfig };

export function nowMs(): number {
  return performance.now();
}

export function emptyDetection(detect_ms: number): Detection {
  return {
    candidate: false,
    pattern: "none",
    cluster_id: clusterId([]),
    signatures: [],
    run_length: 0,
    cycle_length: 0,
    poll: false,
    window_used: 0,
    detect_ms,
  };
}

export function isPollTool(toolName: string | undefined, cfg: DetectConfig): boolean {
  if (!toolName) return false;
  if (cfg.poll.allowlist.includes(toolName)) return true;
  if (cfg.poll.name_regex === "") return false;
  try {
    return new RegExp(cfg.poll.name_regex, "i").test(toolName);
  } catch {
    return false;
  }
}

export function detect(
  state: { steps: LoopStep[] },
  cfg: DetectConfig,
  now: () => number = nowMs,
): Detection {
  const t0 = now();
  const closed = state.steps.filter(
    (s) =>
      s.kind === "tool_result" &&
      !s.intervention_id &&
      s.outcome_class &&
      s.outcome_class !== "unknown",
  );
  const window = closed.slice(-cfg.window_steps);
  if (window.length < cfg.stuck.min_run) {
    return emptyDetection(elapsed(t0, now));
  }

  const tailSig = window[window.length - 1]!.signature;
  const runLength = tailRun(window);
  const poll = isPollTool(window[window.length - 1]!.tool_name, cfg);
  const minRun = poll ? cfg.poll.min_run : cfg.stuck.min_run;

  if (runLength >= minRun) {
    return hit("exact_repeat", [tailSig], runLength, 1, poll, window.length, t0, now);
  }

  const calls = window.slice(-cfg.pingpong.window);
  const ping = pingPong(calls, cfg.pingpong.min_cycles);
  if (ping) {
    return hit("ping_pong", ping.signatures, ping.cycles * 2, 2, false, calls.length, t0, now);
  }

  const cyc = smallestCycle(calls, 2, 4, cfg.cycle.min_cycles);
  if (cyc) {
    return hit("cycle", cyc.signatures, cyc.repeats * cyc.period, cyc.period, false, calls.length, t0, now);
  }

  return emptyDetection(elapsed(t0, now));
}

export function tailRun(window: LoopStep[]): number {
  const sig = window[window.length - 1]!.signature;
  let n = 0;
  for (let i = window.length - 1; i >= 0; i--) {
    if (window[i]!.signature !== sig) break;
    n++;
  }
  return n;
}

export function pingPong(
  steps: LoopStep[],
  minCycles: number,
): { signatures: [string, string]; cycles: number } | null {
  if (steps.length < minCycles * 2) return null;
  const a = steps[steps.length - 2]!.signature;
  const b = steps[steps.length - 1]!.signature;
  if (a === b) return null;
  let cycles = 0;
  for (let i = steps.length - 1; i >= 1; i -= 2) {
    if (steps[i]!.signature !== b || steps[i - 1]!.signature !== a) break;
    cycles++;
  }
  if (cycles >= minCycles) return { signatures: [a, b], cycles };
  return null;
}

export function smallestCycle(
  steps: LoopStep[],
  minPeriod: number,
  maxPeriod: number,
  minCycles: number,
): { signatures: string[]; period: number; repeats: number } | null {
  for (let p = minPeriod; p <= maxPeriod; p++) {
    if (steps.length < p * minCycles) continue;
    const slice = steps.slice(-p * minCycles);
    let ok = true;
    for (let i = 0; i < slice.length; i++) {
      if (slice[i]!.signature !== slice[i % p]!.signature) {
        ok = false;
        break;
      }
    }
    const uniq = new Set(slice.slice(0, p).map((s) => s.signature));
    if (ok && uniq.size === p) {
      return { signatures: slice.slice(0, p).map((s) => s.signature), period: p, repeats: minCycles };
    }
  }
  return null;
}

function elapsed(t0: number, now: () => number): number {
  return now() - t0;
}

function hit(
  pattern: DetectPattern,
  signatures: string[],
  run_length: number,
  cycle_length: number,
  poll: boolean,
  window_used: number,
  t0: number,
  now: () => number,
): Detection {
  return {
    candidate: true,
    pattern,
    cluster_id: clusterId(signatures),
    signatures,
    run_length,
    cycle_length,
    poll,
    window_used,
    detect_ms: elapsed(t0, now),
  };
}
