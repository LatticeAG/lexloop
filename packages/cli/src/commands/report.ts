import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import type { Command } from "commander";
import { loadConfig } from "@latticeag/lexloop-config";
import type { LoopClass, RunReport } from "@latticeag/lexloop-core";
import { exitWith, formatUnknown } from "../exit.ts";

type JsonlEvent = {
  v?: string;
  id?: string;
  ts?: string;
  run_id?: string;
  session_id?: string;
  seq?: number;
  name?: string;
  payload?: Record<string, unknown>;
};

function resolveLogPath(cwd: string, configured: string): string {
  return isAbsolute(configured) ? configured : join(cwd, configured);
}

function readEvents(path: string, runId: string): JsonlEvent[] {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  const out: JsonlEvent[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      const obj = JSON.parse(trimmed) as JsonlEvent;
      if (obj.run_id === runId) out.push(obj);
    } catch {
      // skip malformed
    }
  }
  return out;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function asNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function buildReport(runId: string, events: JsonlEvent[], mode: "log-only" | "intervene"): RunReport {
  const first = events[0]!;
  const last = events[events.length - 1]!;
  const by_class: Record<LoopClass, number> = { productive: 0, stuck: 0, thrashing: 0 };
  const detections: JsonlEvent[] = [];
  const classified: JsonlEvent[] = [];
  const injected: JsonlEvent[] = [];
  let summary: JsonlEvent | undefined;
  const detectMs: number[] = [];

  for (const ev of events) {
    if (ev.name === "loop_detected") {
      detections.push(ev);
      const ms = asNumber(ev.payload?.detect_ms);
      if (ms !== undefined) detectMs.push(ms);
    } else if (ev.name === "loop_classified") {
      classified.push(ev);
      const cls = ev.payload?.class;
      if (cls === "productive" || cls === "stuck" || cls === "thrashing") {
        by_class[cls] += 1;
      }
    } else if (ev.name === "intervention_injected") {
      injected.push(ev);
    } else if (ev.name === "run_summary") {
      summary = ev;
    }
  }

  const clusterById = new Map<
    string,
    {
      cluster_id: string;
      tool_name: string;
      pattern: RunReport["clusters"][number]["pattern"];
      rule_id: string;
      class: LoopClass;
      run_length: number;
      outcome?: string;
    }
  >();

  for (const ev of detections) {
    const cluster_id = asString(ev.payload?.cluster_id);
    if (!cluster_id) continue;
    const pattern = ev.payload?.pattern;
    clusterById.set(cluster_id, {
      cluster_id,
      tool_name: asString(ev.payload?.tool_name) ?? "unknown_tool",
      pattern:
        pattern === "exact_repeat" || pattern === "ping_pong" || pattern === "cycle" || pattern === "none"
          ? pattern
          : "none",
      rule_id: "",
      class: "productive",
      run_length: asNumber(ev.payload?.run_length) ?? 0,
      outcome: asString(ev.payload?.outcome_class),
    });
  }
  for (const ev of classified) {
    const cluster_id = asString(ev.payload?.cluster_id);
    if (!cluster_id) continue;
    const prev = clusterById.get(cluster_id);
    const cls = ev.payload?.class;
    const klass: LoopClass =
      cls === "stuck" || cls === "thrashing" || cls === "productive" ? cls : "productive";
    if (prev) {
      prev.rule_id = asString(ev.payload?.rule_id) ?? prev.rule_id;
      prev.class = klass;
    } else {
      clusterById.set(cluster_id, {
        cluster_id,
        tool_name: "unknown_tool",
        pattern: "none",
        rule_id: asString(ev.payload?.rule_id) ?? "",
        class: klass,
        run_length: 0,
      });
    }
  }

  const interventions = injected.map((ev) => {
    const raw = ev.payload?.level;
    const level: "soft" | "hard" | "human" =
      raw === "hard" || raw === "human" || raw === "soft" ? raw : "soft";
    return {
      intervention_id: asString(ev.payload?.intervention_id) ?? "",
      level,
      cluster_id: asString(ev.payload?.cluster_id) ?? "",
      unstuck: "unknown" as const,
    };
  });

  if (summary?.payload) {
    const p = summary.payload;
    if (p.by_class && typeof p.by_class === "object") {
      const bc = p.by_class as Record<string, unknown>;
      if (typeof bc.productive === "number") by_class.productive = bc.productive;
      if (typeof bc.stuck === "number") by_class.stuck = bc.stuck;
      if (typeof bc.thrashing === "number") by_class.thrashing = bc.thrashing;
    }
  }

  let detect_p99_ms = 0;
  if (detectMs.length > 0) {
    const sorted = [...detectMs].sort((a, b) => a - b);
    const idx = Math.ceil(sorted.length * 0.99) - 1;
    detect_p99_ms = sorted[Math.max(0, idx)] ?? 0;
  }
  if (typeof summary?.payload?.detect_p99_ms === "number") {
    detect_p99_ms = summary.payload.detect_p99_ms;
  }

  const belief =
    summary?.payload?.belief_source === "axion" ||
    summary?.payload?.belief_source === "mixed" ||
    summary?.payload?.belief_source === "none"
      ? summary.payload.belief_source
      : "none";

  return {
    v: "lexloop/v1",
    run_id: runId,
    session_id: asString(first.session_id) ?? "",
    started_ts: asString(first.ts) ?? new Date().toISOString(),
    ended_ts: asString(last.ts),
    mode,
    belief_source: belief,
    detections: detections.length,
    by_class,
    interventions,
    clusters: [...clusterById.values()].map((c) => ({
      cluster_id: c.cluster_id,
      tool_name: c.tool_name,
      pattern: c.pattern,
      rule_id: c.rule_id,
      class: c.class,
      run_length: c.run_length,
    })),
    detect_p99_ms,
  };
}

function nearMissCount(events: JsonlEvent[]): number {
  const byLoop = new Map<string, { pattern?: string; run_length?: number; class?: string }>();
  for (const ev of events) {
    const loop_id = asString(ev.payload?.loop_id) ?? asString(ev.payload?.cluster_id);
    if (!loop_id) continue;
    const row = byLoop.get(loop_id) ?? {};
    if (ev.name === "loop_detected") {
      row.pattern = asString(ev.payload?.pattern);
      row.run_length = asNumber(ev.payload?.run_length);
    }
    if (ev.name === "loop_classified") {
      row.class = asString(ev.payload?.class);
    }
    byLoop.set(loop_id, row);
  }
  let n = 0;
  for (const row of byLoop.values()) {
    if (row.class === "productive" && row.pattern === "exact_repeat" && row.run_length === 3) n += 1;
  }
  return n;
}

function unstickPair(events: JsonlEvent[], report: RunReport): { a: number; b: number } {
  const summary = [...events].reverse().find((e) => e.name === "run_summary");
  if (summary?.payload) {
    const t = asNumber(summary.payload.unstick_true) ?? 0;
    const f = asNumber(summary.payload.unstick_false) ?? 0;
    return { a: t, b: t + f };
  }
  const known = report.interventions.filter((i) => i.unstuck !== "unknown");
  const t = known.filter((i) => i.unstuck === true).length;
  return { a: t, b: known.length };
}

function topClusterLine(events: JsonlEvent[], report: RunReport): string {
  const ranked = [...report.clusters].sort((a, b) => b.run_length - a.run_length);
  const top = ranked.find((c) => c.class === "stuck" || c.class === "thrashing") ?? ranked[0];
  if (!top) return "top cluster: none";
  let outcome = "";
  for (const ev of events) {
    if (ev.name === "loop_detected" && ev.payload?.cluster_id === top.cluster_id) {
      outcome = asString(ev.payload.outcome_class) ?? "";
    }
  }
  return `top cluster: ${top.cluster_id}  tool=${top.tool_name}  outcome=${outcome}  rule=${top.rule_id}`;
}

function printHuman(report: RunReport, events: JsonlEvent[]): void {
  const soft = report.interventions.filter((i) => i.level === "soft").length;
  const near = nearMissCount(events);
  const unstick = unstickPair(events, report);
  process.stdout.write(`run_id: ${report.run_id}\n`);
  process.stdout.write(
    `loops: ${report.detections}  stuck: ${report.by_class.stuck}  thrashing: ${report.by_class.thrashing}  productive_near_miss: ${near}\n`,
  );
  process.stdout.write(`interventions: ${soft} soft\n`);
  process.stdout.write(`unstick: ${unstick.a}/${unstick.b}\n`);
  process.stdout.write(`${topClusterLine(events, report)}\n`);
}

function wantsUnredacted(opts: { redact?: boolean; noRedact?: boolean }): boolean {
  if (opts.noRedact === true) return true;
  if (opts.redact === false) return true;
  return false;
}

export function addReportCommand(program: Command): void {
  program
    .command("report")
    .description("Print a run report")
    .argument("<run-id>")
    .option("--json", "print RunReport JSON")
    .option("--no-redact", "requires TTY and LEXLOOP_ALLOW_UNREDACTED=1")
    .option("--config <path>", "config path")
    .action(async (runId: string, opts: { json?: boolean; redact?: boolean; noRedact?: boolean; config?: string }) => {
      if (wantsUnredacted(opts)) {
        if (!process.stdout.isTTY || process.env.LEXLOOP_ALLOW_UNREDACTED !== "1") {
          exitWith(1, "report --no-redact requires a TTY and LEXLOOP_ALLOW_UNREDACTED=1");
        }
      }

      let logPath: string;
      let mode: "log-only" | "intervene" = "log-only";
      try {
        const cfg = loadConfig({ path: opts.config, cwd: process.cwd() });
        logPath = resolveLogPath(process.cwd(), cfg.log.path);
        mode = cfg.mode;
      } catch (err) {
        exitWith(2, formatUnknown(err));
      }

      const events = readEvents(logPath, runId);
      if (events.length === 0) {
        exitWith(2, `LL4003 run unknown: ${runId}`);
      }

      const report = buildReport(runId, events, mode);
      const outPath = join(process.cwd(), ".lexloop", "runs", runId, "report.json");
      try {
        await mkdir(dirname(outPath), { recursive: true });
        await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
      } catch (err) {
        process.stderr.write(`[lexloop] persist_fail ${formatUnknown(err)}\n`);
      }

      if (opts.json) {
        process.stdout.write(`${JSON.stringify(report)}\n`);
      } else {
        printHuman(report, events);
      }
    });
}
