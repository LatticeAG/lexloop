/** packages/core/src/types.ts */

export type StepKind = "tool_call" | "tool_result" | "plan_revision" | "assistant";

export type OutcomeClass =
  | "ok"
  | "err_not_found"
  | "err_permission"
  | "err_timeout"
  | "err_rate_limit"
  | "err_invalid"
  | "err_network"
  | "err_conflict"
  | "err_empty"
  | "err_other";

export type ArgHashSource = "canonical" | "raw" | "axion_fingerprint";

export interface LoopStep {
  seq: number;
  ts: string;
  kind: StepKind;
  tool_name?: string;
  arg_hash?: string;
  arg_hash_source?: ArgHashSource;
  arg_hash_degraded?: boolean;
  outcome_class?: OutcomeClass | "unknown";
  outcome_hash?: string;
  text_hash?: string;
  signature: string;
  intervention_id?: string;
  bytes_hashed: number;
  detect_ms: number;
}

export type LoopClass = "productive" | "stuck" | "thrashing";

export type BeliefSource = "axion" | "none";

export type DetectPattern = "exact_repeat" | "ping_pong" | "cycle" | "none";

export interface Detection {
  candidate: boolean;
  pattern: DetectPattern;
  cluster_id: string;
  signatures: string[];
  run_length: number;
  cycle_length: number;
  poll: boolean;
  window_used: number;
  detect_ms: number;
}

export interface Classification {
  class: LoopClass;
  rule_id: string;
  cluster_id: string;
  belief_source: BeliefSource;
  belief_jaccard?: number;
  revision_signal?: number;
  progress_signal: boolean;
  reasons: string[];
}

export interface RunReport {
  v: "lexloop/v1";
  run_id: string;
  session_id: string;
  started_ts: string;
  ended_ts?: string;
  mode: "log-only" | "intervene";
  belief_source: "axion" | "none" | "mixed";
  detections: number;
  by_class: Record<LoopClass, number>;
  interventions: Array<{
    intervention_id: string;
    level: "soft" | "hard" | "human";
    cluster_id: string;
    unstuck: boolean | "unknown";
  }>;
  clusters: Array<{
    cluster_id: string;
    tool_name: string;
    pattern: DetectPattern;
    rule_id: string;
    class: LoopClass;
    run_length: number;
  }>;
  detect_p99_ms: number;
}

export interface ClassifyConfig {
  belief_window: number;
  jaccard_stuck: number;
  axion_stale_ms: number;
  beliefs_enabled: boolean;
}

export interface DetectConfig {
  window_steps: number;
  budget_ms: number;
  ring_capacity: number;
  stuck: { min_run: number };
  poll: { min_run: number; allowlist: string[]; name_regex: string };
  pingpong: { window: number; min_cycles: number };
  cycle: { min_cycles: number };
  empty_as_error: boolean;
  degraded_sample: number;
}

export const DEFAULT_POLL_NAME_REGEX =
  "^(get|list|status|health|poll|wait|sleep|head)(_|$)?";

export function defaultDetectConfig(): DetectConfig {
  return {
    window_steps: 16,
    budget_ms: 2,
    ring_capacity: 4096,
    stuck: { min_run: 3 },
    poll: {
      min_run: 8,
      allowlist: ["process"],
      name_regex: DEFAULT_POLL_NAME_REGEX,
    },
    pingpong: { window: 12, min_cycles: 3 },
    cycle: { min_cycles: 3 },
    empty_as_error: false,
    degraded_sample: 4,
  };
}

export function defaultClassifyConfig(): ClassifyConfig {
  return {
    belief_window: 12,
    jaccard_stuck: 0.75,
    axion_stale_ms: 15_000,
    beliefs_enabled: false,
  };
}

export type BudgetSkipReason =
  | "detect_budget"
  | "ring_overflow"
  | "semantic_budget"
  | "ladder_hold"
  | "oversize_intervention";

export interface BudgetSkip {
  reason: BudgetSkipReason;
  budget_ms?: number;
  elapsed_ms?: number;
}

export type LadderLevel = "soft" | "hard" | "human" | "exhausted";

export interface ClusterLadder {
  cluster_id: string;
  injected: Array<{
    level: LadderLevel;
    fingerprint: string;
    intervention_id: string;
    seq: number;
  }>;
  cooldown_until_seq: number;
}

export interface LoopDelta {
  tried_tools: string[];
  tried_signatures: string[];
  tried_outcomes: Array<{ class: OutcomeClass; n: number }>;
  frozen_arg_hashes: boolean;
  untried_tools: string[];
  note_vary_args: boolean;
  note_change_tool: boolean;
  excerpts: string[];
}

export interface Intervention {
  intervention_id: string;
  level: "soft" | "hard" | "human";
  cluster_id: string;
  template_version: string;
  fingerprint: string;
  text: string;
  seq: number;
}

export interface InterveneConfig {
  max_chars: number;
  cooldown_steps: number;
  unstick_window: number;
  include_error_excerpt: boolean;
}

export function defaultInterveneConfig(): InterveneConfig {
  return {
    max_chars: 4096,
    cooldown_steps: 4,
    unstick_window: 4,
    include_error_excerpt: false,
  };
}
