/** packages/core/src/classify.ts */

import { progress_signal } from "./signals.ts";
import type {
  BeliefSource,
  Classification,
  ClassifyConfig,
  DetectConfig,
  Detection,
  LoopClass,
  LoopStep,
} from "./types.ts";
import { defaultClassifyConfig, defaultDetectConfig } from "./types.ts";

export type ClassifyInput = {
  detection: Detection;
  state: { steps: LoopStep[]; detectCfg?: DetectConfig };
  cfg?: ClassifyConfig;
  detect?: DetectConfig;
  belief_source?: BeliefSource;
};

export function assertBeliefsMvp(cfg: ClassifyConfig): void {
  if (cfg.beliefs_enabled) {
    throw notInMvp();
  }
}

/** Phase 8 row. Throws until beliefs land. */
export function ruleR08(): never {
  throw notInMvp();
}

/** Phase 8 row. Throws until beliefs land. */
export function ruleR08b(): never {
  throw notInMvp();
}

export function classify(input: ClassifyInput): Classification {
  const cfg: ClassifyConfig = { ...defaultClassifyConfig(), ...input.cfg };
  assertBeliefsMvp(cfg);

  const detectCfg = input.detect ?? input.state.detectCfg ?? defaultDetectConfig();
  const belief_source: BeliefSource = input.belief_source ?? "none";
  const detection = input.detection;
  const progress = progress_signal(input.state, detectCfg);
  const latest = latestClosedStep(input.state.steps);

  const done = (rule_id: string, cls: LoopClass): Classification => ({
    class: cls,
    rule_id,
    cluster_id: detection.cluster_id,
    belief_source,
    progress_signal: progress,
    reasons: [rule_id],
  });

  // R01
  if (detection.candidate === false) return done("R01", "productive");
  // no closed step: treat as R01
  if (!latest) return done("R01", "productive");

  // R02
  if (latest.intervention_id) return done("R02", "productive");

  // R03
  if (
    detection.poll === true &&
    (latest.outcome_class === "ok" || latest.outcome_class === "err_empty")
  ) {
    return done("R03", "productive");
  }

  // R04
  if (
    detection.poll === true &&
    detection.pattern === "exact_repeat" &&
    detection.run_length < detectCfg.poll.min_run
  ) {
    return done("R04", "productive");
  }

  // R05
  if (progress === true && detection.pattern !== "ping_pong" && detection.pattern !== "cycle") {
    return done("R05", "productive");
  }

  // R06
  if (detection.pattern === "ping_pong" && progress === false) {
    return done("R06", "thrashing");
  }

  // R07
  if (detection.pattern === "cycle" && progress === false) {
    return done("R07", "thrashing");
  }

  // R08 / R10: skipped in MVP while beliefs_enabled is false.
  // If the flag is true, assertBeliefsMvp already threw.

  // R09
  if (
    detection.pattern === "exact_repeat" &&
    isErrOutcome(latest.outcome_class) &&
    belief_source === "none" &&
    detection.run_length >= 4
  ) {
    return done("R09", "stuck");
  }

  // R11
  if (detection.pattern === "exact_repeat" && latest.outcome_class === "ok") {
    return done("R11", "productive");
  }

  // R12
  return done("R12", "productive");
}

export function latestClosedStep(steps: LoopStep[]): LoopStep | undefined {
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i]!;
    if (s.kind === "tool_result" && s.outcome_class && s.outcome_class !== "unknown") {
      return s;
    }
  }
  return undefined;
}

function isErrOutcome(cls: LoopStep["outcome_class"]): boolean {
  return typeof cls === "string" && cls.startsWith("err_");
}

function notInMvp(): Error & { code: string } {
  return Object.assign(new Error("not_in_mvp"), { code: "LL3004" });
}
