/** packages/sdk/src/engine.ts */

import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { LexLoopConfig } from "@latticeag/lexloop-config";
import {
  buildIntervention,
  classify,
  closedDetectWindow,
  loopId,
  measureUnstick,
  newEnvelopeId,
  type BudgetSkip,
  type Classification,
  type ClusterLadder,
  type Detection,
  type EventLog,
  type InterventionHit,
  type LoopClass,
  type NativeLexLoopEvent,
  type RunReport,
  type RunState,
} from "@latticeag/lexloop-core";
import {
  toLatticeExtension,
  type LexLoopEvent,
  type LoopClassifiedPayload,
  type LoopDetectedPayload,
  type InterventionInjectedPayload,
  type BudgetSkippedPayload,
  type RunSummaryPayload,
} from "@latticeag/lexloop-events";
import { sdkLog } from "./debug.ts";
import { spliceMessages } from "./attach/splice.ts";

export type InterventionRow = {
  intervention_id: string;
  level: "soft" | "hard" | "human";
  cluster_id: string;
  signatures: string[];
  afterSeq: number;
  unstuck: boolean | "unknown";
};

export type ClusterRow = {
  cluster_id: string;
  tool_name: string;
  pattern: Detection["pattern"];
  rule_id: string;
  class: LoopClass;
  run_length: number;
};

export type SdkHandle = {
  config: LexLoopConfig;
  runId: string;
  sessionId: string;
  state: RunState;
  log: EventLog;
  ladders: Map<string, ClusterLadder>;
  lastInboundHash: string | undefined;
  seenToolKeys: Set<string>;
  classifications: Classification[];
  detections: Detection[];
  interventionRows: InterventionRow[];
  mode: "log-only" | "intervene";
  availableTools: string[];
  toolsPinned: boolean;
  eventSeq: number;
  closed: boolean;
  startedTs: string;
  endedTs?: string;
  detectMs: number[];
  onEvent?: (ev: LexLoopEvent) => void;
  lastEmitKey: string | undefined;
  lastClassification: Classification | undefined;
  lastDetection: Detection | undefined;
  lastDetectedEventId: string | undefined;
  loopIdByCluster: Map<string, string>;
  clusterRows: Map<string, ClusterRow>;
};

export type TickInboundOpts = {
  messages?: Array<{ role: string; content?: unknown }>;
  allowInject: boolean;
};

export type TickInboundResult = {
  text?: string;
  role?: "system" | "user";
};

export function getOrCreateLadder(loop: SdkHandle, cluster_id: string): ClusterLadder {
  const existing = loop.ladders.get(cluster_id);
  if (existing) return existing;
  const created: ClusterLadder = {
    cluster_id,
    injected: [],
    cooldown_until_seq: 0,
  };
  loop.ladders.set(cluster_id, created);
  return created;
}

export function messagesHash(messages: unknown): string | undefined {
  try {
    return JSON.stringify(messages);
  } catch {
    return undefined;
  }
}

export function lastMessageText(
  messages: Array<{ content?: unknown }> | undefined,
): string | undefined {
  if (!messages || messages.length === 0) return undefined;
  const last = messages[messages.length - 1];
  if (typeof last?.content === "string") return last.content;
  return undefined;
}

export function p99(samples: number[]): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.ceil(sorted.length * 0.99) - 1;
  return sorted[Math.max(0, idx)] ?? 0;
}

function latestToolMeta(loop: SdkHandle): { tool_name: string; outcome_class: LoopDetectedPayload["outcome_class"] } {
  const steps = loop.state.steps;
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i]!;
    if (step.kind !== "tool_result") continue;
    const name = step.tool_name ?? "unknown_tool";
    const oc = step.outcome_class;
    if (oc && oc !== "unknown") {
      return { tool_name: name, outcome_class: oc };
    }
    return { tool_name: name, outcome_class: "err_other" };
  }
  return { tool_name: "unknown_tool", outcome_class: "err_other" };
}

function resolveLoopId(loop: SdkHandle, detection: Detection): string {
  const cached = loop.loopIdByCluster.get(detection.cluster_id);
  if (cached) return cached;
  const closed = closedDetectWindow(loop.state.steps, loop.state.detectCfg.window_steps);
  let firstSeq = 0;
  if (closed.length > 0) {
    const idx = Math.max(0, closed.length - Math.max(1, detection.run_length));
    firstSeq = closed[idx]?.seq ?? closed[0]!.seq;
  } else {
    firstSeq = loop.state.steps[loop.state.steps.length - 1]?.seq ?? 0;
  }
  const id = loopId(loop.runId, detection.cluster_id, firstSeq);
  loop.loopIdByCluster.set(detection.cluster_id, id);
  return id;
}

function nowTs(): string {
  return new Date().toISOString();
}

export async function emitNative(
  loop: SdkHandle,
  name: LexLoopEvent["name"],
  payload: LexLoopEvent["payload"],
  causation_id?: string,
): Promise<string> {
  loop.eventSeq += 1;
  const event = {
    v: "lexloop/v1" as const,
    id: newEnvelopeId(),
    ts: nowTs(),
    run_id: loop.runId,
    session_id: loop.sessionId,
    seq: loop.eventSeq,
    name,
    payload,
  } as LexLoopEvent;
  try {
    loop.onEvent?.(event);
  } catch (err) {
    sdkLog("LL1001", err);
  }
  try {
    await loop.log.append(event as unknown as NativeLexLoopEvent);
  } catch (err) {
    sdkLog("persist_fail", err);
  }
  try {
    await dualWriteLattice(event, causation_id);
  } catch (err) {
    sdkLog("persist_fail", err);
  }
  return event.id;
}

async function dualWriteLattice(event: LexLoopEvent, causation_id?: string): Promise<void> {
  const path = process.env.LATTICEAG_EVENTS_PATH;
  if (!path) return;
  const envelope = toLatticeExtension(
    event,
    causation_id !== undefined && causation_id !== "" ? { causation_id } : undefined,
  );
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(envelope)}\n`, "utf8");
}

export async function emitBudgetSkipped(loop: SdkHandle, skip: BudgetSkip): Promise<void> {
  const payload: BudgetSkippedPayload = {
    v: "lexloop/v1",
    reason: skip.reason,
  };
  if (skip.budget_ms !== undefined) payload.budget_ms = skip.budget_ms;
  if (skip.elapsed_ms !== undefined) payload.elapsed_ms = skip.elapsed_ms;
  await emitNative(loop, "budget_skipped", payload);
}

export async function tickInbound(
  loop: SdkHandle,
  opts: TickInboundOpts,
): Promise<TickInboundResult> {
  const detection = loop.state.detect();
  loop.detectMs.push(detection.detect_ms);

  let classification = loop.lastClassification;
  let active = loop.lastDetection;

  if (detection.candidate) {
    const lastSeq = loop.state.steps[loop.state.steps.length - 1]?.seq ?? 0;
    const key = `${lastSeq}:${detection.cluster_id}:${detection.run_length}:${detection.pattern}`;
    const id = resolveLoopId(loop, detection);
    if (loop.lastEmitKey !== key) {
      const meta = latestToolMeta(loop);
      const detectedPayload: LoopDetectedPayload = {
        v: "lexloop/v1",
        loop_id: id,
        cluster_id: detection.cluster_id,
        pattern: detection.pattern === "none" ? "exact_repeat" : detection.pattern,
        signatures: detection.signatures,
        run_length: detection.run_length,
        cycle_length: detection.cycle_length,
        poll: detection.poll,
        tool_name: meta.tool_name,
        outcome_class: meta.outcome_class,
        window_used: detection.window_used,
        detect_ms: detection.detect_ms,
      };
      const detectedId = await emitNative(loop, "loop_detected", detectedPayload);
      loop.lastDetectedEventId = detectedId;

      classification = classify({
        detection,
        state: loop.state,
        cfg: loop.config.classify,
        detect: loop.state.detectCfg,
        belief_source: "none",
      });
      loop.classifications.push(classification);
      loop.detections.push(detection);
      loop.lastClassification = classification;
      loop.lastDetection = detection;
      loop.lastEmitKey = key;
      active = detection;

      const classifiedPayload: LoopClassifiedPayload = {
        v: "lexloop/v1",
        loop_id: id,
        cluster_id: classification.cluster_id,
        class: classification.class,
        rule_id: classification.rule_id,
        belief_source: classification.belief_source,
        progress_signal: classification.progress_signal,
        reasons: classification.reasons,
      };
      if (classification.belief_jaccard !== undefined) {
        classifiedPayload.belief_jaccard = classification.belief_jaccard;
      }
      if (classification.revision_signal !== undefined) {
        classifiedPayload.revision_signal = classification.revision_signal;
      }
      await emitNative(loop, "loop_classified", classifiedPayload, detectedId);

      loop.clusterRows.set(detection.cluster_id, {
        cluster_id: detection.cluster_id,
        tool_name: meta.tool_name,
        pattern: detection.pattern,
        rule_id: classification.rule_id,
        class: classification.class,
        run_length: detection.run_length,
      });
    } else {
      classification = loop.lastClassification;
      active = loop.lastDetection;
    }
  }

  if (!opts.allowInject) return {};
  if (loop.mode !== "intervene") return {};
  if (!classification || !active) return {};
  if (classification.class !== "stuck" && classification.class !== "thrashing") return {};

  const cluster = getOrCreateLadder(loop, active.cluster_id);
  const window = closedDetectWindow(loop.state.steps, loop.state.detectCfg.window_steps);
  const seq = loop.state.steps[loop.state.steps.length - 1]?.seq ?? 0;
  const built = await buildIntervention({
    mode: loop.mode,
    classification,
    detection: active,
    window,
    cluster,
    available_tools: loop.availableTools,
    seq,
    lastMessage: lastMessageText(opts.messages),
    mvp: true,
    intervene: loop.config.intervene,
  });

  if (!built.injected) {
    if (built.budget_skipped) {
      await emitBudgetSkipped(loop, built.budget_skipped);
    }
    return {};
  }

  const loop_id = resolveLoopId(loop, active);
  await emitInjected(loop, built, active, loop_id);
  loop.interventionRows.push({
    intervention_id: built.intervention_id,
    level: built.level,
    cluster_id: active.cluster_id,
    signatures: active.signatures,
    afterSeq: seq,
    unstuck: "unknown",
  });
  return { text: built.text, role: loop.config.intervene.role };
}

async function emitInjected(
  loop: SdkHandle,
  built: InterventionHit,
  detection: Detection,
  loop_id: string,
): Promise<void> {
  const payload: InterventionInjectedPayload = {
    v: "lexloop/v1",
    loop_id,
    cluster_id: detection.cluster_id,
    intervention_id: built.intervention_id,
    level: built.level,
    template_version: built.template_version,
    fingerprint: built.fingerprint,
    role: loop.config.intervene.role,
    chars: built.text.length,
    delta: {
      tried_tools: built.delta.tried_tools,
      untried_tools: built.delta.untried_tools,
      frozen_arg_hashes: built.delta.frozen_arg_hashes,
      tried_outcomes: built.delta.tried_outcomes,
    },
  };
  await emitNative(loop, "intervention_injected", payload, loop.lastDetectedEventId);
}

export async function maybeSpliceMessages<T extends { role: string; content?: unknown }>(
  loop: SdkHandle,
  messages: T[],
): Promise<T[]> {
  const tick = await tickInbound(loop, { messages, allowInject: true });
  if (loop.mode === "log-only") return messages;
  if (!tick.text || !tick.role) return messages;
  return spliceMessages(messages, tick.text, tick.role);
}

export function buildRunReport(loop: SdkHandle): RunReport {
  if (!loop.runId || !loop.sessionId) {
    throw Object.assign(new Error("LL4003 run unknown"), { code: "LL4003" });
  }

  const by_class: Record<LoopClass, number> = {
    productive: 0,
    stuck: 0,
    thrashing: 0,
  };
  for (const c of loop.classifications) {
    by_class[c.class] += 1;
  }

  const window = loop.config.intervene.unstick_window;
  const interventions = loop.interventionRows.map((row) => {
    const after = loop.state.steps.filter((s) => s.seq > row.afterSeq);
    const unstuck = measureUnstick({
      cluster_signatures: row.signatures,
      after,
      window,
    });
    return {
      intervention_id: row.intervention_id,
      level: row.level,
      cluster_id: row.cluster_id,
      unstuck,
    };
  });

  return {
    v: "lexloop/v1",
    run_id: loop.runId,
    session_id: loop.sessionId,
    started_ts: loop.startedTs,
    ended_ts: loop.endedTs,
    mode: loop.mode,
    belief_source: "none",
    detections: loop.detections.length,
    by_class,
    interventions,
    clusters: [...loop.clusterRows.values()],
    detect_p99_ms: p99(loop.detectMs),
  };
}

export async function emitRunSummary(loop: SdkHandle): Promise<void> {
  const report = buildRunReport(loop);
  let unstick_true = 0;
  let unstick_false = 0;
  let unstick_unknown = 0;
  for (const row of report.interventions) {
    if (row.unstuck === true) unstick_true += 1;
    else if (row.unstuck === false) unstick_false += 1;
    else unstick_unknown += 1;
  }
  const payload: RunSummaryPayload = {
    v: "lexloop/v1",
    loop_count: loop.detections.length,
    by_class: report.by_class,
    interventions: report.interventions.length,
    unstick_true,
    unstick_false,
    unstick_unknown,
    detect_p99_ms: report.detect_p99_ms,
    belief_source: report.belief_source,
  };
  await emitNative(loop, "run_summary", payload);
  await writeRunReportFile(loop, report);
}

export async function writeRunReportFile(loop: SdkHandle, report: RunReport): Promise<void> {
  const path = join(".lexloop", "runs", loop.runId, "report.json");
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  } catch (err) {
    sdkLog("persist_fail", err);
  }
}

export function isErrorLooking(text: string): boolean {
  return /\b(enoent|error|exception|failed|not found|eacces|eperm|timeout|invalid)\b/i.test(
    text,
  );
}

export function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (content === null || content === undefined) return "";
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === "string") return block;
        if (block && typeof block === "object" && "text" in block) {
          const text = (block as { text?: unknown }).text;
          return typeof text === "string" ? text : "";
        }
        return "";
      })
      .join("");
  }
  if (typeof content === "object" && "text" in content) {
    const text = (content as { text?: unknown }).text;
    if (typeof text === "string") return text;
  }
  try {
    return JSON.stringify(content) ?? "";
  } catch {
    return String(content);
  }
}

export function parseJsonish(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  const trimmed = raw.trim();
  if (trimmed === "") return raw;
  try {
    return JSON.parse(trimmed);
  } catch {
    return raw;
  }
}

export function capToolNames(names: string[], max = 64): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
    if (out.length >= max) break;
  }
  return out;
}

export function rememberTools(loop: SdkHandle, names: string[]): void {
  if (loop.toolsPinned) return;
  if (names.length === 0) return;
  loop.availableTools = capToolNames(names);
}
