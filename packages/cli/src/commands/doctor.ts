import { createServer } from "node:net";
import { access, mkdir, unlink, writeFile } from "node:fs/promises";
import { constants, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Command } from "commander";
import {
  ConfigError,
  defaultConfig,
  findLexloopJson,
  loadConfig,
  type LexLoopConfig,
} from "@latticeag/lexloop-config";
import { toLatticeExtension } from "@latticeag/lexloop-events";
import type { LexLoopEvent } from "@latticeag/lexloop-events";

export type DoctorStatus = "ok" | "fail" | "warn" | "skip";

export type DoctorCheck = {
  id: number;
  name: string;
  status: DoctorStatus;
  detail?: string;
};

export type DoctorReport = {
  ok: boolean;
  checks: DoctorCheck[];
};

function parseNode(version: string): { major: number; minor: number } {
  const [maj, min] = version.split(".").map((p) => Number.parseInt(p, 10));
  return { major: maj ?? 0, minor: min ?? 0 };
}

export function nodeVersionOk(version: string): boolean {
  const { major, minor } = parseNode(version);
  if (major > 20) return true;
  if (major === 20 && minor >= 19) return true;
  return false;
}

function isPortFree(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, host);
  });
}

function sampleExtensionEvent(): LexLoopEvent {
  return {
    v: "lexloop/v1",
    id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    ts: "2026-08-17T15:00:00.123Z",
    run_id: "run_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    session_id: "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    seq: 1,
    name: "budget_skipped",
    payload: {
      v: "lexloop/v1",
      reason: "detect_budget",
      budget_ms: 2,
      elapsed_ms: 3,
    },
  };
}

function tryResolveEvents(cwd: string): string | undefined {
  const require = createRequire(join(cwd, "package.json"));
  try {
    return require.resolve("@latticeag/events");
  } catch {
    try {
      return createRequire(import.meta.url).resolve("@latticeag/events");
    } catch {
      return undefined;
    }
  }
}

async function checkLatticeEvents(cwd: string): Promise<DoctorCheck> {
  const resolved = tryResolveEvents(cwd);
  if (!resolved) {
    return {
      id: 4,
      name: "@latticeag/events",
      status: "skip",
      detail: "not installed",
    };
  }
  try {
    const mod = (await import(pathToFileURL(resolved).href)) as {
      parseEnvelope?: (input: unknown) => unknown;
    };
    const envelope = toLatticeExtension(sampleExtensionEvent());
    if (typeof mod.parseEnvelope === "function") {
      mod.parseEnvelope(envelope);
    }
    return { id: 4, name: "@latticeag/events", status: "ok", detail: "admits extension envelope" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      id: 4,
      name: "@latticeag/events",
      status: "fail",
      detail: `rejects extension envelope: ${message}`,
    };
  }
}

async function checkAxion(cfg: LexLoopConfig, offline: boolean): Promise<DoctorCheck> {
  if (!cfg.axion.enabled) {
    return { id: 5, name: "axion", status: "skip", detail: "axion.enabled is false" };
  }
  if (offline) {
    return { id: 5, name: "axion", status: "skip", detail: "offline" };
  }
  const url = `${cfg.axion.base_url.replace(/\/$/, "")}/api/health`;
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 2000);
    const res = await fetch(url, { signal: ac.signal });
    clearTimeout(t);
    if (!res.ok) {
      return { id: 5, name: "axion", status: "warn", detail: `GET ${url} -> ${res.status}` };
    }
    return { id: 5, name: "axion", status: "ok", detail: `GET ${url} ok` };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { id: 5, name: "axion", status: "warn", detail: message };
  }
}

async function checkWritable(dir: string): Promise<DoctorCheck> {
  try {
    await mkdir(dir, { recursive: true });
    await access(dir, constants.W_OK);
    const probe = join(dir, `.doctor-write-${process.pid}`);
    await writeFile(probe, "ok\n", "utf8");
    await unlink(probe);
    return { id: 3, name: ".lexloop/", status: "ok", detail: "writable" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { id: 3, name: ".lexloop/", status: "fail", detail: message };
  }
}

export async function runDoctor(opts: { offline?: boolean; cwd?: string }): Promise<DoctorReport> {
  const cwd = opts.cwd ?? process.cwd();
  const checks: DoctorCheck[] = [];

  const nodeVer = process.versions.node;
  checks.push({
    id: 1,
    name: "node",
    status: nodeVersionOk(nodeVer) ? "ok" : "fail",
    detail: `v${nodeVer}`,
  });

  let cfg: LexLoopConfig | undefined;
  try {
    cfg = loadConfig({ cwd });
    const file =
      process.env.LEXLOOP_CONFIG && process.env.LEXLOOP_CONFIG !== ""
        ? process.env.LEXLOOP_CONFIG
        : findLexloopJson(cwd);
    if (file && existsSync(file)) {
      checks.push({ id: 2, name: "lexloop.json", status: "ok", detail: file });
    } else {
      checks.push({ id: 2, name: "lexloop.json", status: "ok", detail: "defaults (no file)" });
    }
  } catch (err) {
    const message = err instanceof ConfigError || err instanceof Error ? err.message : String(err);
    checks.push({ id: 2, name: "lexloop.json", status: "fail", detail: message });
  }

  checks.push(await checkWritable(join(cwd, ".lexloop")));
  checks.push(await checkLatticeEvents(cwd));

  const effective = cfg ?? defaultConfig();
  checks.push(await checkAxion(effective, opts.offline === true));

  if (!effective.proxy.enabled) {
    checks.push({
      id: 6,
      name: "proxy port",
      status: "ok",
      detail: "proxy.enabled is false",
    });
  } else {
    const free = await isPortFree(effective.proxy.port, effective.proxy.bind);
    checks.push({
      id: 6,
      name: "proxy port",
      status: free ? "ok" : "fail",
      detail: free
        ? `${effective.proxy.bind}:${effective.proxy.port} free`
        : `${effective.proxy.bind}:${effective.proxy.port} in use`,
    });
  }

  const allow = process.env.LEXLOOP_ALLOW_UNREDACTED;
  const prod = process.env.NODE_ENV === "production";
  if (prod && allow !== undefined && allow !== "") {
    checks.push({
      id: 7,
      name: "LEXLOOP_ALLOW_UNREDACTED",
      status: "fail",
      detail: "set in NODE_ENV=production",
    });
  } else {
    checks.push({
      id: 7,
      name: "LEXLOOP_ALLOW_UNREDACTED",
      status: "ok",
      detail: prod ? "unset in production" : "NODE_ENV is not production",
    });
  }

  const ok = checks.every((c) => c.status !== "fail");
  return { ok, checks };
}

function printHuman(report: DoctorReport): void {
  for (const check of report.checks) {
    const label = check.detail ? `${check.status} (${check.detail})` : check.status;
    process.stdout.write(`${check.id} ${check.name}: ${label}\n`);
  }
}

export function addDoctorCommand(program: Command): void {
  program
    .command("doctor")
    .description("Check Node, config, and local wiring")
    .option("--json", "print JSON")
    .option("--offline", "skip network checks")
    .action(async (opts: { json?: boolean; offline?: boolean }) => {
      const report = await runDoctor({ offline: opts.offline === true, cwd: process.cwd() });
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(report)}\n`);
      } else {
        printHuman(report);
      }
      if (!report.ok) process.exit(4);
    });
}
