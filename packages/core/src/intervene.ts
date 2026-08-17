/** packages/core/src/intervene.ts */

import { computeDelta } from "./delta.ts";
import { newInterventionId } from "./ids.ts";
import { fingerprint, nextLevel } from "./ladder.ts";
import { SENTINEL_RE } from "./sentinel.ts";
import { clipName } from "./signature.ts";
import { fillSoftTemplate, SOFT_TEMPLATE_VERSION } from "./templates.ts";
import type {
  BudgetSkip,
  Classification,
  ClusterLadder,
  Detection,
  InterveneConfig,
  LoopDelta,
  LoopStep,
} from "./types.ts";
import { defaultInterveneConfig } from "./types.ts";

export type BuildInterventionInput = {
  mode: "log-only" | "intervene";
  classification: Pick<Classification, "class">;
  detection: Detection;
  window: LoopStep[];
  cluster: ClusterLadder;
  available_tools?: string[];
  seq?: number;
  lastMessage?: string;
  mvp?: boolean;
  intervene?: Partial<InterveneConfig>;
  intervention_id?: string;
};

export type InterventionHit = {
  injected: true;
  text: string;
  intervention_id: string;
  level: "soft";
  template_version: string;
  fingerprint: string;
  delta: LoopDelta;
};

export type InterventionSkip = {
  injected: false;
  ladder_blocked?: "mvp";
  budget_skipped?: BudgetSkip;
  code?: "LL3003" | "LL3004";
};

export type BuildInterventionResult = InterventionHit | InterventionSkip;

export function assertBudget(text: string, maxChars: number): boolean {
  return text.length <= maxChars;
}

export function buildHardIntervention(): never {
  throw notInMvp();
}

export function buildHumanIntervention(): never {
  throw notInMvp();
}

export async function buildIntervention(
  input: BuildInterventionInput,
): Promise<BuildInterventionResult> {
  const mvp = input.mvp !== false;
  const cfg: InterveneConfig = {
    ...defaultInterveneConfig(),
    ...input.intervene,
  };

  if (input.mode !== "intervene") {
    return { injected: false };
  }

  const cls = input.classification.class;
  if (cls !== "stuck" && cls !== "thrashing") {
    return { injected: false };
  }

  const cluster = input.cluster;
  const level = nextLevel(cluster, mvp);
  if (level === "exhausted") {
    return skipHold();
  }
  if (level !== "soft") {
    return { injected: false, ladder_blocked: "mvp", code: "LL3004" };
  }

  const seq = resolveSeq(input);
  if (seq < cluster.cooldown_until_seq) {
    return skipHold();
  }

  const fp = await fingerprint(level, cluster.cluster_id, SOFT_TEMPLATE_VERSION);
  if (cluster.injected.some((row) => row.fingerprint === fp)) {
    return { injected: false };
  }

  const available_tools = input.available_tools ?? [];
  const delta = computeDelta({
    window: input.window,
    available_tools,
    include_error_excerpt: cfg.include_error_excerpt,
  });

  const intervention_id = input.intervention_id ?? newInterventionId();
  const tool_name = resolveToolName(input, delta);
  const text = fillSoftTemplate({
    intervention_id,
    tool_name,
    run_length: input.detection.run_length,
    delta,
    max_chars: cfg.max_chars,
  });

  if (!SENTINEL_RE.test(text) || !assertBudget(text, cfg.max_chars)) {
    return {
      injected: false,
      budget_skipped: { reason: "oversize_intervention" },
      code: "LL3003",
    };
  }

  if (input.lastMessage !== undefined && input.lastMessage === text) {
    return { injected: false };
  }

  cluster.injected.push({
    level: "soft",
    fingerprint: fp,
    intervention_id,
    seq,
  });
  cluster.cooldown_until_seq = seq + cfg.cooldown_steps;

  return {
    injected: true,
    text,
    intervention_id,
    level: "soft",
    template_version: SOFT_TEMPLATE_VERSION,
    fingerprint: fp,
    delta,
  };
}

function skipHold(): InterventionSkip {
  return { injected: false, budget_skipped: { reason: "ladder_hold" } };
}

function resolveSeq(input: BuildInterventionInput): number {
  if (input.seq !== undefined) return input.seq;
  const last = input.window[input.window.length - 1];
  return last?.seq ?? 0;
}

function resolveToolName(input: BuildInterventionInput, delta: LoopDelta): string {
  for (let i = input.window.length - 1; i >= 0; i--) {
    const step = input.window[i]!;
    if (step.kind === "tool_result" && step.tool_name) {
      return clipName(step.tool_name);
    }
  }
  return delta.tried_tools[0] ?? "";
}

function notInMvp(): Error & { code: string } {
  return Object.assign(new Error("not_in_mvp"), { code: "LL3004" });
}
