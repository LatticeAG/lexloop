/** packages/core/src/run.ts */

import {
  noteDetectOk,
  recordDetectBudgetSkip,
  shouldRunDegradedSample,
  shouldSkipDetect,
} from "./budget.ts";
import { detect as detectWindow, emptyDetection, nowMs } from "./detect.ts";
import { newRunId, newSessionId } from "./ids.ts";
import { classifyOutcome } from "./outcome.ts";
import { matchSentinel } from "./sentinel.ts";
import { resolveArgHash, toolSignature } from "./signature.ts";
import type { BudgetSkip, DetectConfig, Detection, LoopStep } from "./types.ts";
import { defaultDetectConfig } from "./types.ts";

export type RunStateEvent = {
  name: "budget_skipped";
} & BudgetSkip;

export type RecordToolCallInput = {
  tool_name: string;
  args?: unknown;
  argumentFingerprint?: string;
  argumentFingerprintSource?: "canonical" | "raw";
  ts?: string;
  intervention_id?: string;
  text?: string;
};

export type RecordToolResultInput = {
  tool_name: string;
  args?: unknown;
  error?: string;
  result?: unknown;
  http_status?: number;
  argumentFingerprint?: string;
  argumentFingerprintSource?: "canonical" | "raw";
  intervention_id?: string;
  ts?: string;
  text?: string;
};

export class RunState {
  readonly run_id: string;
  readonly session_id: string;
  steps: LoopStep[] = [];
  detect_degraded = false;
  consecutive_skips = 0;
  sample_tick = 0;
  skipped: BudgetSkip[] = [];
  readonly detectCfg: DetectConfig;
  readonly now: () => number;
  readonly onEvent?: (e: RunStateEvent) => void;
  #seq = 0;

  constructor(opts?: {
    run_id?: string;
    session_id?: string;
    detect?: Partial<DetectConfig>;
    onEvent?: (e: RunStateEvent) => void;
    now?: () => number;
  }) {
    this.run_id = opts?.run_id ?? newRunId();
    this.session_id = opts?.session_id ?? newSessionId();
    this.detectCfg = mergeDetectConfig(opts?.detect);
    this.onEvent = opts?.onEvent;
    this.now = opts?.now ?? nowMs;
  }

  async recordToolCall(input: RecordToolCallInput): Promise<LoopStep> {
    const seq = this.#nextSeq();
    const resolved = await resolveArgHash({
      args: input.args,
      argumentFingerprint: input.argumentFingerprint,
      argumentFingerprintSource: input.argumentFingerprintSource,
    });
    const signature = await toolSignature({
      tool_name: input.tool_name,
      arg_hash: resolved.arg_hash,
      outcome_class: "unknown",
    });
    const step: LoopStep = {
      seq,
      ts: utcMs(input.ts),
      kind: "tool_call",
      tool_name: input.tool_name,
      arg_hash: resolved.arg_hash,
      arg_hash_source: resolved.arg_hash_source,
      outcome_class: "unknown",
      signature,
      bytes_hashed: resolved.bytes_hashed,
      detect_ms: 0,
    };
    if (resolved.arg_hash_degraded) step.arg_hash_degraded = true;
    const tagged = resolveInterventionId(input);
    if (tagged) step.intervention_id = tagged;
    this.#push(step);
    return step;
  }

  async recordToolResult(input: RecordToolResultInput): Promise<LoopStep> {
    const seq = this.#nextSeq();
    const resolved = await resolveArgHash({
      args: input.args,
      argumentFingerprint: input.argumentFingerprint,
      argumentFingerprintSource: input.argumentFingerprintSource,
    });
    const outcome = await classifyOutcome({
      error: input.error,
      result: input.result,
      http_status: input.http_status,
      empty_as_error: this.detectCfg.empty_as_error,
    });
    const signature = await toolSignature({
      tool_name: input.tool_name,
      arg_hash: resolved.arg_hash,
      outcome_class: outcome.outcome_class,
    });
    const step: LoopStep = {
      seq,
      ts: utcMs(input.ts),
      kind: "tool_result",
      tool_name: input.tool_name,
      arg_hash: resolved.arg_hash,
      arg_hash_source: resolved.arg_hash_source,
      outcome_class: outcome.outcome_class,
      outcome_hash: outcome.outcome_hash,
      signature,
      bytes_hashed: resolved.bytes_hashed,
      detect_ms: 0,
    };
    if (resolved.arg_hash_degraded) step.arg_hash_degraded = true;
    const tagged = resolveInterventionId(input);
    if (tagged) step.intervention_id = tagged;
    this.#push(step);
    return step;
  }

  detect(): Detection {
    const cfg = this.detectCfg;
    if (!shouldRunDegradedSample(this, cfg.degraded_sample)) {
      const skip = recordDetectBudgetSkip(this, cfg);
      this.#emitSkip(skip);
      return emptyDetection(0);
    }

    const detection = detectWindow(this, cfg, this.now);
    if (shouldSkipDetect(detection.detect_ms, cfg.budget_ms)) {
      const skip = recordDetectBudgetSkip(this, cfg, detection.detect_ms);
      this.#emitSkip(skip);
      return emptyDetection(detection.detect_ms);
    }

    noteDetectOk(this);
    return detection;
  }

  #nextSeq(): number {
    this.#seq += 1;
    return this.#seq;
  }

  #push(step: LoopStep): void {
    this.steps.push(step);
    if (this.steps.length > this.detectCfg.ring_capacity) {
      this.steps.shift();
      const skip: BudgetSkip = { reason: "ring_overflow" };
      this.skipped.push(skip);
      this.#emitSkip(skip);
    }
  }

  #emitSkip(skip: BudgetSkip): void {
    this.onEvent?.({ name: "budget_skipped", ...skip });
  }
}

export async function recordN(
  state: RunState,
  n: number,
  tool: string,
  args: unknown,
  error?: string,
): Promise<LoopStep[]> {
  const out: LoopStep[] = [];
  for (let i = 0; i < n; i++) {
    out.push(
      await state.recordToolResult({
        tool_name: tool,
        args,
        error,
        result: error === undefined ? { ok: true } : undefined,
      }),
    );
  }
  return out;
}

function utcMs(ts?: string): string {
  if (ts !== undefined) return ts;
  return new Date().toISOString();
}

function mergeDetectConfig(override?: Partial<DetectConfig>): DetectConfig {
  const base = defaultDetectConfig();
  if (!override) return base;
  return {
    ...base,
    ...override,
    stuck: { ...base.stuck, ...override.stuck },
    poll: { ...base.poll, ...override.poll },
    pingpong: { ...base.pingpong, ...override.pingpong },
    cycle: { ...base.cycle, ...override.cycle },
  };
}

function resolveInterventionId(input: {
  intervention_id?: string;
  error?: string;
  result?: unknown;
  text?: string;
}): string | undefined {
  if (input.intervention_id) return input.intervention_id;
  const blobs: string[] = [];
  if (typeof input.text === "string") blobs.push(input.text);
  if (typeof input.error === "string") blobs.push(input.error);
  if (typeof input.result === "string") blobs.push(input.result);
  for (const blob of blobs) {
    const hit = matchSentinel(blob);
    if (hit) return hit.intervention_id;
  }
  return undefined;
}
