import {
  applyModeEnv,
  lexloopConfigSchema,
  loadConfig,
  type LexLoopConfig,
} from "@latticeag/lexloop-config";
import {
  EventLog,
  RunState,
  matchSentinel,
  newRunId,
  newSessionId,
  type DetectConfig,
  type RunReport,
} from "@latticeag/lexloop-core";
import type { LexLoopEvent } from "@latticeag/lexloop-events";
import { wrapAnthropicClient } from "./attach/anthropic-messages.ts";
import { wrapOpenAIClient } from "./attach/openai-completions.ts";
import { sdkLog } from "./debug.ts";
import {
  buildRunReport,
  capToolNames,
  emitBudgetSkipped,
  emitRunSummary,
  maybeSpliceMessages,
  tickInbound,
  type ClusterRow,
  type InterventionRow,
  type SdkHandle,
} from "./engine.ts";
import type { Classification, ClusterLadder, Detection } from "@latticeag/lexloop-core";

export interface LexLoopOptions {
  mode?: "log-only" | "intervene";
  runId?: string;
  sessionId?: string;
  configPath?: string;
  config?: LexLoopConfig;
  availableTools?: string[];
  onEvent?: (ev: LexLoopEvent) => void;
}

export type ObserveInput = {
  tool_name: string;
  args?: unknown;
  error?: string;
  result?: unknown;
  http_status?: number;
  kind?: "tool_call" | "tool_result" | "plan_revision" | "assistant";
};

export type OpenAiMessage = {
  role: string;
  content?: string | null;
};

function detectFromConfig(cfg: LexLoopConfig): Partial<DetectConfig> {
  const d = cfg.detect;
  return {
    window_steps: d.window_steps,
    budget_ms: d.budget_ms,
    ring_capacity: d.ring_capacity,
    stuck: d.stuck,
    poll: d.poll,
    pingpong: d.pingpong,
    cycle: d.cycle,
    empty_as_error: d.empty_as_error,
    degraded_sample: d.degraded_sample,
  };
}

export class LexLoop implements SdkHandle {
  readonly config: LexLoopConfig;
  readonly runId: string;
  readonly sessionId: string;
  state: RunState;
  log: EventLog;
  ladders: Map<string, ClusterLadder> = new Map();
  lastInboundHash: string | undefined;
  seenToolKeys: Set<string> = new Set();
  classifications: Classification[] = [];
  detections: Detection[] = [];
  interventionRows: InterventionRow[] = [];
  mode: "log-only" | "intervene";
  availableTools: string[] = [];
  toolsPinned = false;
  eventSeq = 0;
  closed = false;
  startedTs: string;
  endedTs?: string;
  detectMs: number[] = [];
  onEvent?: (ev: LexLoopEvent) => void;
  lastEmitKey: string | undefined;
  lastClassification: Classification | undefined;
  lastDetection: Detection | undefined;
  lastDetectedEventId: string | undefined;
  loopIdByCluster: Map<string, string> = new Map();
  clusterRows: Map<string, ClusterRow> = new Map();
  #onBeforeExit?: () => void;

  constructor(opts?: LexLoopOptions) {
    const loaded = opts?.config
      ? lexloopConfigSchema.parse({
          ...opts.config,
          ...(opts.mode ? { mode: opts.mode } : {}),
        })
      : loadConfig({
          path: opts?.configPath,
          overrides: opts?.mode ? { mode: opts.mode } : undefined,
        });
    this.config = applyModeEnv(loaded);
    this.mode = this.config.mode;
    this.runId =
      opts?.runId ??
      process.env.LATTICEAG_RUN_ID ??
      process.env.LEXLOOP_RUN_ID ??
      newRunId();
    this.sessionId = opts?.sessionId ?? process.env.LATTICEAG_SESSION_ID ?? newSessionId();
    this.onEvent = opts?.onEvent;
    this.startedTs = new Date().toISOString();
    if (opts?.availableTools && opts.availableTools.length > 0) {
      this.availableTools = capToolNames(opts.availableTools);
      this.toolsPinned = true;
    }

    this.state = new RunState({
      run_id: this.runId,
      session_id: this.sessionId,
      detect: detectFromConfig(this.config),
      onEvent: (e) => {
        void emitBudgetSkipped(this, e);
      },
    });
    this.log = new EventLog({
      path: this.config.log.path,
      max_bytes: this.config.log.max_bytes,
      persist_fail: this.config.log.persist_fail,
      extraKeys: this.config.redaction.extra_keys,
    });

    this.#onBeforeExit = () => {
      void this.close();
    };
    process.once("beforeExit", this.#onBeforeExit);
  }

  wrapOpenAI<T extends { chat: { completions: { create: Function } } }>(client: T): T {
    try {
      return wrapOpenAIClient(this, client);
    } catch (err) {
      sdkLog("LL1001", err);
      return client;
    }
  }

  wrapAnthropic<T extends { messages: { create: Function } }>(client: T): T {
    try {
      return wrapAnthropicClient(this, client);
    } catch (err) {
      sdkLog("LL1001", err);
      return client;
    }
  }

  async observe(step: ObserveInput): Promise<void> {
    try {
      if (!step || typeof step !== "object" || typeof step.tool_name !== "string" || step.tool_name === "") {
        sdkLog("LL1002", new Error("invalid observe input"));
        return;
      }
      const text =
        typeof step.error === "string"
          ? step.error
          : typeof step.result === "string"
            ? step.result
            : undefined;
      const sentinel = text ? matchSentinel(text) : null;
      if (step.kind === "tool_call") {
        await this.state.recordToolCall({
          tool_name: step.tool_name,
          args: step.args,
          text,
          intervention_id: sentinel?.intervention_id,
        });
      } else {
        await this.state.recordToolResult({
          tool_name: step.tool_name,
          args: step.args,
          error: step.error,
          result: step.result,
          http_status: step.http_status,
          text,
          intervention_id: sentinel?.intervention_id,
        });
      }
      await tickInbound(this, { allowInject: false });
    } catch (err) {
      sdkLog("LL1002", err);
    }
  }

  async maybeInject(messages: OpenAiMessage[]): Promise<OpenAiMessage[]> {
    try {
      if (!Array.isArray(messages)) return messages;
      return await maybeSpliceMessages(this, messages);
    } catch {
      return messages;
    }
  }

  async report(): Promise<RunReport> {
    return buildRunReport(this);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.#onBeforeExit) {
      process.removeListener("beforeExit", this.#onBeforeExit);
      this.#onBeforeExit = undefined;
    }
    this.endedTs = new Date().toISOString();
    try {
      await emitRunSummary(this);
    } catch (err) {
      sdkLog("persist_fail", err);
    }
    try {
      await this.log.close();
    } catch (err) {
      sdkLog("persist_fail", err);
    }
  }
}

export type { LexLoopConfig, LexLoopEvent, RunReport };
