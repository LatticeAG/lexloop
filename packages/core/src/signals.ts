/** packages/core/src/signals.ts */

import type { DetectConfig, LoopStep, OutcomeClass } from "./types.ts";
import { defaultDetectConfig } from "./types.ts";

/** Same closed window detect uses: last window_steps tool_results excluding intervention_id / unknown. */
export function closedDetectWindow(
  steps: LoopStep[],
  windowSteps: number = defaultDetectConfig().window_steps,
): LoopStep[] {
  const closed = steps.filter(
    (s) =>
      s.kind === "tool_result" &&
      !s.intervention_id &&
      s.outcome_class &&
      s.outcome_class !== "unknown",
  );
  return closed.slice(-windowSteps);
}

const OUTCOME_RANK: Record<OutcomeClass, number> = {
  err_other: 0,
  err_network: 1,
  err_timeout: 1,
  err_rate_limit: 1,
  err_not_found: 2,
  err_permission: 2,
  err_invalid: 2,
  err_conflict: 2,
  err_empty: 3,
  ok: 4,
};

export function outcome_rank(cls: OutcomeClass | "unknown" | undefined): number {
  if (!cls || cls === "unknown") return -1;
  return OUTCOME_RANK[cls];
}

/**
 * True if the latest closed detect-window step improved vs the previous same tool,
 * changed args in a pagination-like way, or introduced a new tool_name.
 * Predicate 4 (revision_signal) is Phase 8 and skipped in MVP.
 */
export function progress_signal(
  state: { steps: LoopStep[] },
  detectCfg: DetectConfig = defaultDetectConfig(),
): boolean {
  const window = closedDetectWindow(state.steps, detectCfg.window_steps);
  if (window.length === 0) return false;

  const current = window[window.length - 1]!;
  const prior = window.slice(0, -1);

  if (rankProgress(current, prior)) return true;
  if (argHashProgress(current, prior)) return true;
  if (newToolProgress(current, prior)) return true;
  return false;
}

function previousSameTool(prior: LoopStep[], toolName: string | undefined): LoopStep | undefined {
  if (!toolName) return undefined;
  for (let i = prior.length - 1; i >= 0; i--) {
    if (prior[i]!.tool_name === toolName) return prior[i];
  }
  return undefined;
}

function rankProgress(current: LoopStep, prior: LoopStep[]): boolean {
  const prev = previousSameTool(prior, current.tool_name);
  if (!prev) return false;
  return outcome_rank(current.outcome_class) > outcome_rank(prev.outcome_class);
}

function argHashProgress(current: LoopStep, prior: LoopStep[]): boolean {
  const prev = previousSameTool(prior, current.tool_name);
  if (!prev) return false;
  if (current.arg_hash === prev.arg_hash) return false;
  const prevClass = prev.outcome_class;
  const currClass = current.outcome_class;
  return currClass !== prevClass || prevClass === "ok";
}

function newToolProgress(current: LoopStep, prior: LoopStep[]): boolean {
  const name = current.tool_name;
  if (!name) return false;
  return !prior.some((s) => s.tool_name === name);
}
