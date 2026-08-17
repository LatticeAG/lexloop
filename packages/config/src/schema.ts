import { z } from "zod";

const POLL_NAME_REGEX = "^(get|list|status|health|poll|wait|sleep|head)(_|$)?";

const logSchema = z
  .object({
    path: z.string().min(1).default(".lexloop/events.jsonl"),
    max_bytes: z.number().int().min(1_048_576).max(1_073_741_824).default(67_108_864),
    persist_fail: z.enum(["log", "throw"]).default("log"),
  })
  .strict();

const detectStuckSchema = z
  .object({
    min_run: z.number().int().min(2).max(20).default(3),
  })
  .strict();

const detectPollSchema = z
  .object({
    min_run: z.number().int().min(2).max(40).default(8),
    allowlist: z.array(z.string()).default(["process"]),
    name_regex: z.string().default(POLL_NAME_REGEX),
  })
  .strict();

const detectPingpongSchema = z
  .object({
    window: z.number().int().min(4).max(32).default(12),
    min_cycles: z.number().int().min(2).max(10).default(3),
  })
  .strict();

const detectCycleSchema = z
  .object({
    min_cycles: z.number().int().min(2).max(8).default(3),
  })
  .strict();

const detectSemanticSchema = z
  .object({
    enabled: z.boolean().default(false),
    backend: z.enum(["none", "token_sort", "minilm"]).default("none"),
    budget_ms: z.number().int().min(1).max(200).default(40),
    threshold: z.number().min(0.5).max(1).default(0.92),
    plan_window: z.number().int().min(2).max(16).default(6),
  })
  .strict();

const detectSchema = z
  .object({
    window_steps: z.number().int().min(4).max(64).default(16),
    budget_ms: z.number().int().min(1).max(20).default(2),
    ring_capacity: z.number().int().min(64).max(65_536).default(4096),
    stuck: detectStuckSchema.default({}),
    poll: detectPollSchema.default({}),
    pingpong: detectPingpongSchema.default({}),
    cycle: detectCycleSchema.default({}),
    empty_as_error: z.boolean().default(false),
    degraded_sample: z.number().int().min(1).max(100).default(4),
    semantic: detectSemanticSchema.default({}),
  })
  .strict();

const classifySchema = z
  .object({
    belief_window: z.number().int().min(2).max(48).default(12),
    jaccard_stuck: z.number().min(0).max(1).default(0.75),
    axion_stale_ms: z.number().int().min(500).max(120_000).default(15_000),
    beliefs_enabled: z.boolean().default(false),
  })
  .strict();

const interveneModelSchema = z
  .object({
    enabled: z.boolean().default(false),
  })
  .strict();

const interveneSchema = z
  .object({
    max_chars: z.number().int().min(256).max(16_384).default(4096),
    cooldown_steps: z.number().int().min(0).max(32).default(4),
    unstick_window: z.number().int().min(1).max(16).default(4),
    role: z.enum(["system", "user"]).default("system"),
    anthropic_system_append: z.boolean().default(true),
    include_error_excerpt: z.boolean().default(false),
    model: interveneModelSchema.default({}),
  })
  .strict();

const axionSchema = z
  .object({
    enabled: z.boolean().default(false),
    mode: z.enum(["webhook", "poll"]).default("poll"),
    base_url: z.string().url().default("http://127.0.0.1:8787"),
    poll_interval_ms: z.number().int().min(200).max(10_000).default(1000),
  })
  .strict();

const runSchema = z
  .object({
    task: z.string().max(1500).optional(),
    constraints: z.string().max(500).optional(),
  })
  .strict();

const redactionSchema = z
  .object({
    extra_keys: z.array(z.string()).default([]),
  })
  .strict();

const proxySchema = z
  .object({
    enabled: z.boolean().default(false),
    bind: z.literal("127.0.0.1").default("127.0.0.1"),
    port: z.number().int().min(1024).max(65_535).default(8790),
    upstream: z.string().url().default("http://127.0.0.1:8787/v1/chat/completions"),
  })
  .strict();

const watchSchema = z
  .object({
    sdk_timeout_ms: z.number().int().min(1000).max(120_000).default(30_000),
  })
  .strict();

const hostedSchema = z
  .object({
    url: z.string().url().optional(),
  })
  .strict();

export const lexloopConfigSchema = z
  .object({
    $schema: z.string().optional(),
    schema_version: z.literal(1),
    mode: z.enum(["log-only", "intervene"]).default("log-only"),
    log: logSchema.default({}),
    detect: detectSchema.default({}),
    classify: classifySchema.default({}),
    intervene: interveneSchema.default({}),
    axion: axionSchema.default({}),
    run: runSchema.optional(),
    redaction: redactionSchema.default({}),
    proxy: proxySchema.default({}),
    watch: watchSchema.default({}),
    hosted: hostedSchema.optional(),
  })
  .strict();

export type LexLoopConfig = z.infer<typeof lexloopConfigSchema>;
export type LexLoopConfigInput = z.input<typeof lexloopConfigSchema>;
