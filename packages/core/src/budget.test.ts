import { describe, expect, it } from "vitest";
import {
  checkBudget,
  noteSkip,
  shouldRunDegradedSample,
  shouldSkipDetect,
} from "./budget.ts";
import type { DetectBudgetState } from "./budget.ts";

function freshState(): DetectBudgetState {
  return {
    detect_degraded: false,
    consecutive_skips: 0,
    sample_tick: 0,
    skipped: [],
  };
}

describe("budget", () => {
  it("skips when elapsed 5 exceeds budget 2", () => {
    expect(checkBudget({ elapsed_ms: 5, budget_ms: 2 })).toBe(true);
    expect(shouldSkipDetect(5, 2)).toBe(true);
    expect(shouldSkipDetect(2, 2)).toBe(false);
    expect(shouldSkipDetect(1.9, 2)).toBe(false);
  });

  it("noteSkip sets detect_degraded after 3 consecutive skips", () => {
    const state = freshState();
    noteSkip(state);
    noteSkip(state);
    expect(state.detect_degraded).toBe(false);
    noteSkip(state);
    expect(state.detect_degraded).toBe(true);
    expect(state.consecutive_skips).toBe(3);
  });

  it("degraded sample is 1/N with default 4", () => {
    const state = freshState();
    state.detect_degraded = true;
    expect(shouldRunDegradedSample(state, 4)).toBe(false);
    expect(shouldRunDegradedSample(state, 4)).toBe(false);
    expect(shouldRunDegradedSample(state, 4)).toBe(false);
    expect(shouldRunDegradedSample(state, 4)).toBe(true);
  });
});
