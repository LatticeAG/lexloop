/** packages/core/src/delta.ts */

import { clipName } from "./signature.ts";
import type { LoopDelta, LoopStep, OutcomeClass } from "./types.ts";

const MAX_AVAILABLE_TOOLS = 64;
const MAX_TEMPLATE_LIST = 8;
const EXCERPT_MAX = 200;

export type { LoopDelta };

export type ComputeDeltaInput = {
  window: LoopStep[];
  available_tools: string[];
  arg_excerpts?: Array<{ tool_name: string; keys: string[] }>;
  include_error_excerpt?: boolean;
};

export function computeDelta(input: ComputeDeltaInput): LoopDelta {
  const results = input.window.filter((s) => s.kind === "tool_result");

  const triedToolAll: string[] = [];
  const triedToolSet = new Set<string>();
  const triedSigAll: string[] = [];
  const triedSigSet = new Set<string>();
  const outcomeOrder: OutcomeClass[] = [];
  const outcomeCounts = new Map<OutcomeClass, number>();
  const argHashes = new Set<string>();

  for (const step of results) {
    const name = step.tool_name ? clipName(step.tool_name) : "";
    if (name && !triedToolSet.has(name)) {
      triedToolSet.add(name);
      triedToolAll.push(name);
    }
    if (step.signature && !triedSigSet.has(step.signature)) {
      triedSigSet.add(step.signature);
      triedSigAll.push(step.signature);
    }
    const cls = step.outcome_class;
    if (cls && cls !== "unknown") {
      const prev = outcomeCounts.get(cls);
      if (prev === undefined) {
        outcomeOrder.push(cls);
        outcomeCounts.set(cls, 1);
      } else {
        outcomeCounts.set(cls, prev + 1);
      }
    }
    argHashes.add(step.arg_hash ?? "");
  }

  const tried_tools = triedToolAll.slice(0, MAX_TEMPLATE_LIST);
  const tried_signatures = triedSigAll.slice(0, MAX_TEMPLATE_LIST);
  const tried_outcomes = outcomeOrder.map((cls) => ({
    class: cls,
    n: outcomeCounts.get(cls) ?? 0,
  }));

  const frozen_arg_hashes = argHashes.size <= 1;

  const available: string[] = [];
  const availableSeen = new Set<string>();
  for (const raw of input.available_tools) {
    if (available.length >= MAX_AVAILABLE_TOOLS) break;
    if (typeof raw !== "string" || raw === "") continue;
    const name = clipName(raw);
    if (name === "" || availableSeen.has(name)) continue;
    availableSeen.add(name);
    available.push(name);
  }

  const untried_tools: string[] = [];
  for (const name of available) {
    if (triedToolSet.has(name)) continue;
    untried_tools.push(name);
    if (untried_tools.length >= MAX_TEMPLATE_LIST) break;
  }

  const note_vary_args = frozen_arg_hashes && results.length >= 2;
  const note_change_tool = untried_tools.length > 0;

  let excerpts: string[] = [];
  if (input.include_error_excerpt === true) {
    excerpts = results
      .filter((s) => s.outcome_class && s.outcome_class !== "unknown")
      .map((s) => String(s.outcome_class).slice(0, EXCERPT_MAX));
  }

  return {
    tried_tools,
    tried_signatures,
    tried_outcomes,
    frozen_arg_hashes,
    untried_tools,
    note_vary_args,
    note_change_tool,
    excerpts,
  };
}
