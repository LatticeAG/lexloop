import { z } from "zod";
import {
  CLUSTER_ID_RE,
  INTERVENTION_ID_RE,
  LOOP_ID_RE,
  ULID_RE,
} from "@latticeag/lexloop-core";

const isoUtcMs = z.string().datetime().regex(/Z$/);

const outcomeClassSchema = z.enum([
  "ok",
  "err_not_found",
  "err_permission",
  "err_timeout",
  "err_rate_limit",
  "err_invalid",
  "err_network",
  "err_conflict",
  "err_empty",
  "err_other",
]);

const loopClassSchema = z.enum(["productive", "stuck", "thrashing"]);

const vLiteral = z.literal("lexloop/v1");

const loopDetectedPayloadSchema = z
  .object({
    v: vLiteral,
    loop_id: z.string().regex(LOOP_ID_RE),
    cluster_id: z.string().regex(CLUSTER_ID_RE),
    pattern: z.enum(["exact_repeat", "ping_pong", "cycle"]),
    signatures: z.array(z.string()),
    run_length: z.number().int(),
    cycle_length: z.number().int(),
    poll: z.boolean(),
    tool_name: z.string(),
    outcome_class: outcomeClassSchema,
    window_used: z.number().int(),
    detect_ms: z.number(),
  })
  .strict();

const loopClassifiedPayloadSchema = z
  .object({
    v: vLiteral,
    loop_id: z.string().regex(LOOP_ID_RE),
    cluster_id: z.string().regex(CLUSTER_ID_RE),
    class: loopClassSchema,
    rule_id: z.string(),
    belief_source: z.enum(["axion", "none"]),
    belief_jaccard: z.number().optional(),
    revision_signal: z.number().optional(),
    progress_signal: z.boolean(),
    reasons: z.array(z.string()),
  })
  .strict();

const interventionInjectedPayloadSchema = z
  .object({
    v: vLiteral,
    loop_id: z.string().regex(LOOP_ID_RE),
    cluster_id: z.string().regex(CLUSTER_ID_RE),
    intervention_id: z.string().regex(INTERVENTION_ID_RE),
    level: z.enum(["soft", "hard", "human"]),
    template_version: z.string(),
    fingerprint: z.string(),
    role: z.enum(["system", "user"]),
    chars: z.number().int(),
    delta: z
      .object({
        tried_tools: z.array(z.string()),
        untried_tools: z.array(z.string()),
        frozen_arg_hashes: z.boolean(),
        tried_outcomes: z.array(
          z
            .object({
              class: outcomeClassSchema,
              n: z.number().int(),
            })
            .strict(),
        ),
      })
      .strict(),
  })
  .strict();

const loopEscalatedPayloadSchema = z
  .object({
    v: vLiteral,
    loop_id: z.string().regex(LOOP_ID_RE),
    cluster_id: z.string().regex(CLUSTER_ID_RE),
    level: z.literal("human"),
    vekinbox_request_id: z.string().optional(),
    halt_recommended: z.literal(true),
    rule_id: z.string(),
  })
  .strict();

const budgetSkippedPayloadSchema = z
  .object({
    v: vLiteral,
    reason: z.enum([
      "detect_budget",
      "ring_overflow",
      "semantic_budget",
      "ladder_hold",
      "oversize_intervention",
    ]),
    budget_ms: z.number().optional(),
    elapsed_ms: z.number().optional(),
  })
  .strict();

const runSummaryPayloadSchema = z
  .object({
    v: vLiteral,
    loop_count: z.number().int(),
    by_class: z
      .object({
        productive: z.number().int(),
        stuck: z.number().int(),
        thrashing: z.number().int(),
      })
      .strict(),
    interventions: z.number().int(),
    unstick_true: z.number().int(),
    unstick_false: z.number().int(),
    unstick_unknown: z.number().int(),
    detect_p99_ms: z.number(),
    belief_source: z.enum(["axion", "none", "mixed"]),
  })
  .strict();

const eventBase = {
  v: vLiteral,
  id: z.string().regex(ULID_RE),
  ts: isoUtcMs,
  run_id: z.string().min(1),
  session_id: z.string().min(1),
  seq: z.number().int().positive(),
};

export const lexLoopEventSchema = z.discriminatedUnion("name", [
  z
    .object({
      ...eventBase,
      name: z.literal("loop_detected"),
      payload: loopDetectedPayloadSchema,
    })
    .strict(),
  z
    .object({
      ...eventBase,
      name: z.literal("loop_classified"),
      payload: loopClassifiedPayloadSchema,
    })
    .strict(),
  z
    .object({
      ...eventBase,
      name: z.literal("intervention_injected"),
      payload: interventionInjectedPayloadSchema,
    })
    .strict(),
  z
    .object({
      ...eventBase,
      name: z.literal("loop_escalated"),
      payload: loopEscalatedPayloadSchema,
    })
    .strict(),
  z
    .object({
      ...eventBase,
      name: z.literal("budget_skipped"),
      payload: budgetSkippedPayloadSchema,
    })
    .strict(),
  z
    .object({
      ...eventBase,
      name: z.literal("run_summary"),
      payload: runSummaryPayloadSchema,
    })
    .strict(),
]);

export const latticeExtensionEnvelopeSchema = z
  .object({
    $schema: z.literal("latticeag.events/1.0"),
    schema_version: z.literal(1),
    id: z.string().regex(ULID_RE),
    seq: z.number().int().min(1),
    ts: isoUtcMs,
    run_id: z.string().min(1),
    session_id: z.string().min(1),
    producer: z
      .object({
        product: z.literal("latticeag"),
        adapter: z.literal("@latticeag/lexloop"),
        adapter_version: z.string(),
      })
      .strict(),
    correlation_id: z.string().min(1),
    causation_id: z.string().optional(),
    redaction: z
      .object({
        applied: z.boolean(),
        keys: z.array(z.string()),
        pattern_hits: z.number().int().min(0),
      })
      .strict(),
    name: z.literal("extension"),
    payload: z
      .object({
        extension_name: z.enum([
          "lexloop.loop_detected",
          "lexloop.loop_classified",
          "lexloop.intervention_injected",
          "lexloop.loop_escalated",
          "lexloop.budget_skipped",
          "lexloop.run_summary",
        ]),
        payload: z
          .object({
            v: vLiteral,
          })
          .passthrough(),
      })
      .strict(),
  })
  .strict();

export type LexLoopEventParsed = z.infer<typeof lexLoopEventSchema>;
export type LatticeExtensionEnvelopeParsed = z.infer<typeof latticeExtensionEnvelopeSchema>;
