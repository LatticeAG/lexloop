/** packages/core/src/unstick.ts */

import type { LoopStep } from "./types.ts";

export function measureUnstick(input: {
  cluster_signatures: string[];
  after: LoopStep[];
  window: number;
}): boolean | "unknown" {
  const known = new Set(input.cluster_signatures);
  const closed = input.after.filter((s) => s.kind === "tool_result");
  const slice = closed.slice(0, input.window);
  if (slice.some((s) => !known.has(s.signature))) return true;
  if (slice.length >= input.window) return false;
  return "unknown";
}
