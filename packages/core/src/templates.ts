/** packages/core/src/templates.ts */

import type { LoopDelta } from "./types.ts";

export const SOFT_TEMPLATE_VERSION = "tmpl_soft_v1";
export const HARD_TEMPLATE_VERSION = "tmpl_hard_v1";

export const AXION_CONNECTIVE_DENYLIST = [
  "because",
  "because of",
  "since",
  "due to",
  "as a result of",
  "assuming",
  "presumably",
  "I believe",
  "I think",
  "I will",
  "I'll",
  "I intend",
  "I plan",
  "based on",
  "according to",
] as const;

export const TMPL_SOFT_V1 = `[lexloop intervention id=llint_<ULID> level=soft]
Observed: tool <tool_name> repeated <run_length> times with equivalent arguments.
Outcomes: <class>=<n>, ...
Tried tools: <comma list, max 8>
Not tried tools: <comma list or "none listed on this request">
Arguments: <unchanged across attempts | varied>
Next step: pick a not-tried tool, or change an argument. Do not repeat the same call.`;

export const TMPL_HARD_V1 = `[lexloop intervention id=llint_<ULID> level=hard]
Constraint: re-read the task. Then pick a path that is not in Tried.
Task: <task_excerpt, max 1500 chars>
Constraint: <constraints_excerpt, max 500 chars>
Observed: ...
Tried: ...
Not tried: ...
Constraint: acknowledge by using a different tool or argument before another call to <tool_name>.`;

const DEFAULT_MAX_CHARS = 4096;
const MAX_LIST = 8;

export type FillSoftTemplateInput = {
  intervention_id: string;
  tool_name: string;
  run_length: number;
  delta: LoopDelta;
  max_chars?: number;
};

export function fillSoftTemplate(input: FillSoftTemplateInput): string {
  const maxChars = input.max_chars ?? DEFAULT_MAX_CHARS;
  const tried = input.delta.tried_tools.slice(0, MAX_LIST).join(", ");
  const untried = input.delta.untried_tools.slice(0, MAX_LIST);
  const notTried =
    untried.length > 0 ? untried.join(", ") : "none listed on this request";
  const outcomes = input.delta.tried_outcomes
    .map((row) => `${row.class}=${row.n}`)
    .join(", ");
  const args = input.delta.frozen_arg_hashes
    ? "unchanged across attempts"
    : "varied";

  const sentinel = `[lexloop intervention id=${input.intervention_id} level=soft]`;
  const observed = `Observed: tool ${input.tool_name} repeated ${input.run_length} times with equivalent arguments.`;
  const outcomesLine = `Outcomes: ${outcomes}`;
  const triedLine = `Tried tools: ${tried}`;
  const notTriedLine = `Not tried tools: ${notTried}`;
  const argsLine = `Arguments: ${args}`;
  const next = `Next step: pick a not-tried tool, or change an argument. Do not repeat the same call.`;

  return fitSoftMaxChars(
    {
      sentinel,
      observed,
      outcomesLine,
      triedLine,
      notTriedLine,
      argsLine,
      next,
    },
    maxChars,
  );
}

export function fillHardTemplate(): never {
  throw notInMvp();
}

function fitSoftMaxChars(
  parts: {
    sentinel: string;
    observed: string;
    outcomesLine: string;
    triedLine: string;
    notTriedLine: string;
    argsLine: string;
    next: string;
  },
  maxChars: number,
): string {
  const join = (lines: string[]) => lines.join("\n");

  let lines = [
    parts.sentinel,
    parts.observed,
    parts.outcomesLine,
    parts.triedLine,
    parts.notTriedLine,
    parts.argsLine,
    parts.next,
  ];
  if (join(lines).length <= maxChars) return join(lines);

  // Drop Tried tools, then Not tried tools, then Outcomes detail. Never first or last line.
  lines = [
    parts.sentinel,
    parts.observed,
    parts.outcomesLine,
    parts.notTriedLine,
    parts.argsLine,
    parts.next,
  ];
  if (join(lines).length <= maxChars) return join(lines);

  lines = [
    parts.sentinel,
    parts.observed,
    parts.outcomesLine,
    parts.argsLine,
    parts.next,
  ];
  if (join(lines).length <= maxChars) return join(lines);

  return join([parts.sentinel, parts.observed, parts.argsLine, parts.next]);
}

function notInMvp(): Error & { code: string } {
  return Object.assign(new Error("not_in_mvp"), { code: "LL3004" });
}
