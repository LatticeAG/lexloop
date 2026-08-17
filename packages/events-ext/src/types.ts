/** packages/events-ext/src/types.ts */

import type { LoopClass, OutcomeClass } from "@latticeag/lexloop-core";

export type LexLoopEventName =
  | "loop_detected"
  | "loop_classified"
  | "intervention_injected"
  | "loop_escalated"
  | "budget_skipped"
  | "run_summary";

export interface LexLoopEvent<N extends LexLoopEventName = LexLoopEventName> {
  v: "lexloop/v1";
  id: string;
  ts: string;
  run_id: string;
  session_id: string;
  seq: number;
  name: N;
  payload: LexLoopPayload[N];
}

export interface LoopDetectedPayload {
  v: "lexloop/v1";
  loop_id: string;
  cluster_id: string;
  pattern: "exact_repeat" | "ping_pong" | "cycle";
  signatures: string[];
  run_length: number;
  cycle_length: number;
  poll: boolean;
  tool_name: string;
  outcome_class: OutcomeClass;
  window_used: number;
  detect_ms: number;
}

export interface LoopClassifiedPayload {
  v: "lexloop/v1";
  loop_id: string;
  cluster_id: string;
  class: LoopClass;
  rule_id: string;
  belief_source: "axion" | "none";
  belief_jaccard?: number;
  revision_signal?: number;
  progress_signal: boolean;
  reasons: string[];
}

export interface InterventionInjectedPayload {
  v: "lexloop/v1";
  loop_id: string;
  cluster_id: string;
  intervention_id: string;
  level: "soft" | "hard" | "human";
  template_version: string;
  fingerprint: string;
  role: "system" | "user";
  chars: number;
  delta: {
    tried_tools: string[];
    untried_tools: string[];
    frozen_arg_hashes: boolean;
    tried_outcomes: Array<{ class: OutcomeClass; n: number }>;
  };
}

export interface LoopEscalatedPayload {
  v: "lexloop/v1";
  loop_id: string;
  cluster_id: string;
  level: "human";
  vekinbox_request_id?: string;
  halt_recommended: true;
  rule_id: string;
}

export interface BudgetSkippedPayload {
  v: "lexloop/v1";
  reason:
    | "detect_budget"
    | "ring_overflow"
    | "semantic_budget"
    | "ladder_hold"
    | "oversize_intervention";
  budget_ms?: number;
  elapsed_ms?: number;
}

export interface RunSummaryPayload {
  v: "lexloop/v1";
  loop_count: number;
  by_class: Record<LoopClass, number>;
  interventions: number;
  unstick_true: number;
  unstick_false: number;
  unstick_unknown: number;
  detect_p99_ms: number;
  belief_source: "axion" | "none" | "mixed";
}

export interface LexLoopPayload {
  loop_detected: LoopDetectedPayload;
  loop_classified: LoopClassifiedPayload;
  intervention_injected: InterventionInjectedPayload;
  loop_escalated: LoopEscalatedPayload;
  budget_skipped: BudgetSkippedPayload;
  run_summary: RunSummaryPayload;
}

export type LatticeExtensionName =
  | "lexloop.loop_detected"
  | "lexloop.loop_classified"
  | "lexloop.intervention_injected"
  | "lexloop.loop_escalated"
  | "lexloop.budget_skipped"
  | "lexloop.run_summary";

export interface LatticeProducer {
  product: "latticeag";
  adapter: "@latticeag/lexloop";
  adapter_version: string;
}

export interface LatticeRedaction {
  applied: boolean;
  keys: string[];
  pattern_hits: number;
}

export interface LatticeExtensionInner {
  extension_name: LatticeExtensionName;
  payload: { v: "lexloop/v1" } & Record<string, unknown>;
}

export interface LatticeExtensionEnvelope {
  $schema: "latticeag.events/1.0";
  schema_version: 1;
  id: string;
  seq: number;
  ts: string;
  run_id: string;
  session_id: string;
  producer: LatticeProducer;
  correlation_id: string;
  causation_id?: string;
  redaction: LatticeRedaction;
  name: "extension";
  payload: LatticeExtensionInner;
}
