import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  RunState,
  buildIntervention,
  classify,
  closedDetectWindow,
  detect,
  emptyLadder,
  measureUnstick,
  type Classification,
  type Detection,
  type LoopClass,
} from "@latticeag/lexloop-core";
import { p99 } from "./stats.ts";

export interface GoldenFixture {
  id: string;
  expect?: {
    detect_any?: boolean;
    classes?: LoopClass[];
    intervene_levels?: Array<"soft" | "hard" | "human">;
    unstuck?: boolean;
  };
  available_tools?: string[];
  beliefs?: Array<{ type: string; text: string }>;
  steps: GoldenStep[];
  steps_after_inject?: GoldenStep[];
}

export type GoldenStep = {
  tool_name: string;
  args?: unknown;
  error?: string;
  result?: unknown;
  http_status?: number;
  intervention_id?: string;
  text?: string;
  kind?: "tool_call" | "tool_result" | "plan_revision" | "assistant";
};

export type GoldenBenchResult = {
  loops: number;
  loops_detected: number;
  loops_intervened_soft: number;
  loops_false_productive: number;
  productive: number;
  productive_stuck: number;
  productive_thrashing: number;
  productive_injected: number;
  detect_p99_ms: number;
};

export type GoldenReplay = {
  id: string;
  kind: "loop" | "productive";
  detection: Detection;
  classification: Classification;
  splices: string[];
  unstuck?: boolean | "unknown";
};

const GOLDEN_DETECT_BUDGET_MS = 20;
const EXPECTED_LOOPS = 16;
const EXPECTED_PRODUCTIVE = 16;
const DETECT_P99_GATE_MS = 2;

export function goldenPassed(result: GoldenBenchResult): boolean {
  return (
    result.loops_detected === EXPECTED_LOOPS &&
    result.loops_intervened_soft === EXPECTED_LOOPS &&
    result.loops_false_productive === 0 &&
    result.productive_stuck === 0 &&
    result.productive_thrashing === 0 &&
    result.productive_injected === 0 &&
    result.detect_p99_ms <= DETECT_P99_GATE_MS
  );
}

export function loadGoldenFixture(raw: unknown, fallbackId: string): GoldenFixture {
  if (Array.isArray(raw)) {
    return { id: fallbackId, steps: raw as GoldenStep[] };
  }
  if (!raw || typeof raw !== "object") {
    throw new Error(`invalid golden fixture: ${fallbackId}`);
  }
  const obj = raw as Record<string, unknown>;
  const steps = obj.steps;
  if (!Array.isArray(steps)) {
    throw new Error(`golden fixture missing steps: ${fallbackId}`);
  }
  const id = typeof obj.id === "string" && obj.id !== "" ? obj.id : fallbackId;
  const fixture: GoldenFixture = { id, steps: steps as GoldenStep[] };
  if (obj.expect && typeof obj.expect === "object") {
    fixture.expect = obj.expect as GoldenFixture["expect"];
  }
  if (Array.isArray(obj.available_tools)) {
    fixture.available_tools = obj.available_tools as string[];
  }
  if (Array.isArray(obj.beliefs)) {
    fixture.beliefs = obj.beliefs as Array<{ type: string; text: string }>;
  }
  if (Array.isArray(obj.steps_after_inject)) {
    fixture.steps_after_inject = obj.steps_after_inject as GoldenStep[];
  }
  return fixture;
}

export async function recordGoldenStep(state: RunState, step: GoldenStep): Promise<void> {
  if (step.kind === "tool_call") {
    await state.recordToolCall({
      tool_name: step.tool_name,
      args: step.args,
      text: step.text,
      intervention_id: step.intervention_id,
    });
    return;
  }
  await state.recordToolResult({
    tool_name: step.tool_name,
    args: step.args,
    error: step.error,
    result: step.result,
    http_status: step.http_status,
    text: step.text,
    intervention_id: step.intervention_id,
  });
}

export async function replayFixture(fixture: GoldenFixture): Promise<GoldenReplay> {
  const state = new RunState({ detect: { budget_ms: GOLDEN_DETECT_BUDGET_MS } });
  for (const step of fixture.steps) {
    await recordGoldenStep(state, step);
  }

  const detection = detect(state, state.detectCfg);
  const classification = classify({
    detection,
    state,
    detect: state.detectCfg,
    belief_source: "none",
  });

  const splices: string[] = [];
  const cluster = emptyLadder(detection.cluster_id);
  const window = closedDetectWindow(state.steps, state.detectCfg.window_steps);
  const seq = state.steps[state.steps.length - 1]?.seq ?? 0;

  if (classification.class === "stuck" || classification.class === "thrashing") {
    const first = await buildIntervention({
      mode: "intervene",
      classification,
      detection,
      window,
      cluster,
      available_tools: fixture.available_tools ?? [],
      seq,
      mvp: true,
    });
    if (first.injected) splices.push(first.text);

    const second = await buildIntervention({
      mode: "intervene",
      classification,
      detection,
      window,
      cluster,
      available_tools: fixture.available_tools ?? [],
      seq,
      mvp: true,
    });
    if (second.injected) splices.push(second.text);
  }

  let unstuck: boolean | "unknown" | undefined;
  if (fixture.steps_after_inject && fixture.steps_after_inject.length > 0) {
    const afterIndex = state.steps.length;
    for (const step of fixture.steps_after_inject) {
      await recordGoldenStep(state, step);
    }
    unstuck = measureUnstick({
      cluster_signatures: detection.signatures,
      after: state.steps.slice(afterIndex),
      window: 4,
    });
  }

  return {
    id: fixture.id,
    kind: "loop",
    detection,
    classification,
    splices,
    unstuck,
  };
}

function listJsonFiles(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .sort()
      .map((name) => join(dir, name));
  } catch (err) {
    const code = err && typeof err === "object" && "code" in err ? (err as { code: unknown }).code : undefined;
    if (code === "ENOENT") return [];
    throw err;
  }
}

function loadFile(path: string): GoldenFixture {
  const name = path.split("/").pop()?.replace(/\.json$/, "") ?? path;
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  return loadGoldenFixture(raw, name);
}

export async function runGoldenBench(dir = "fixtures/golden"): Promise<{
  result: GoldenBenchResult;
  replays: GoldenReplay[];
}> {
  const loopFiles = listJsonFiles(join(dir, "loops"));
  const productiveFiles = listJsonFiles(join(dir, "productive"));
  const detectMs: number[] = [];
  const replays: GoldenReplay[] = [];

  let loops_detected = 0;
  let loops_intervened_soft = 0;
  let loops_false_productive = 0;
  let productive_stuck = 0;
  let productive_thrashing = 0;
  let productive_injected = 0;

  for (const file of loopFiles) {
    const fixture = loadFile(file);
    const replay = await replayFixture(fixture);
    replay.kind = "loop";
    replays.push(replay);
    detectMs.push(replay.detection.detect_ms);

    const loopClass = replay.classification.class;
    if (loopClass === "stuck" || loopClass === "thrashing") {
      loops_detected += 1;
    } else {
      loops_false_productive += 1;
    }
    if (replay.splices.length === 1) loops_intervened_soft += 1;
  }

  for (const file of productiveFiles) {
    const fixture = loadFile(file);
    const replay = await replayFixture(fixture);
    replay.kind = "productive";
    replays.push(replay);
    detectMs.push(replay.detection.detect_ms);

    if (replay.classification.class === "stuck") productive_stuck += 1;
    if (replay.classification.class === "thrashing") productive_thrashing += 1;
    if (replay.splices.length > 0) productive_injected += 1;
  }

  const result: GoldenBenchResult = {
    loops: loopFiles.length,
    loops_detected,
    loops_intervened_soft,
    loops_false_productive,
    productive: productiveFiles.length,
    productive_stuck,
    productive_thrashing,
    productive_injected,
    detect_p99_ms: p99(detectMs),
  };

  return { result, replays };
}
