/** packages/core/src/budget.ts */

import type { BudgetSkip, DetectConfig } from "./types.ts";

export interface DetectBudgetState {
  detect_degraded: boolean;
  consecutive_skips: number;
  sample_tick: number;
  skipped: BudgetSkip[];
}

export function shouldSkipDetect(elapsedMs: number, budgetMs: number): boolean {
  return elapsedMs > budgetMs;
}

export function checkBudget(input: { elapsed_ms: number; budget_ms: number }): boolean {
  return shouldSkipDetect(input.elapsed_ms, input.budget_ms);
}

export function noteSkip(state: DetectBudgetState): void {
  state.consecutive_skips += 1;
  if (state.consecutive_skips >= 3) {
    state.detect_degraded = true;
  }
}

export function noteDetectOk(state: DetectBudgetState): void {
  state.consecutive_skips = 0;
}

export function shouldRunDegradedSample(
  state: DetectBudgetState,
  degradedSample: number,
): boolean {
  if (!state.detect_degraded) return true;
  const n = degradedSample < 1 ? 1 : degradedSample;
  state.sample_tick += 1;
  return state.sample_tick % n === 0;
}

export function recordDetectBudgetSkip(
  state: DetectBudgetState,
  cfg: Pick<DetectConfig, "budget_ms">,
  elapsedMs?: number,
): BudgetSkip {
  const skip: BudgetSkip = {
    reason: "detect_budget",
    budget_ms: cfg.budget_ms,
  };
  if (elapsedMs !== undefined) skip.elapsed_ms = elapsedMs;
  noteSkip(state);
  state.skipped.push(skip);
  return skip;
}
