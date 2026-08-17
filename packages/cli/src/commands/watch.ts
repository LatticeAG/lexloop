import { existsSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import type { Command } from "commander";
import { execa } from "execa";
import stringArgv from "string-argv";
import { loadConfig, type LexLoopConfig } from "@latticeag/lexloop-config";
import { RunState, newRunId, newSessionId } from "@latticeag/lexloop-core";
import { recordGoldenStep, loadGoldenFixture } from "../../../../bench/golden.ts";
import { exitWith, formatUnknown } from "../exit.ts";

function resolveArgv(cmd: string | string[] | undefined): string[] | undefined {
  if (cmd === undefined) return undefined;
  if (Array.isArray(cmd)) {
    if (cmd.length === 1 && /\s/.test(cmd[0]!)) return stringArgv(cmd[0]!);
    return cmd;
  }
  return stringArgv(cmd);
}

function resolveWatchMode(opts: {
  mode?: string;
  fromJsonl?: boolean;
}): "log-only" | "intervene" {
  const fromJsonl = Boolean(opts.fromJsonl);
  const explicit = opts.mode;
  const env = process.env.LEXLOOP_MODE;

  const picked =
    explicit === "log-only" || explicit === "intervene"
      ? explicit
      : env === "log-only" || env === "intervene"
        ? env
        : fromJsonl
          ? "log-only"
          : "intervene";

  if (fromJsonl && picked === "intervene") {
    exitWith(2, "LL4004 replay is observe-only");
  }
  if (picked !== "log-only" && picked !== "intervene") {
    return "log-only";
  }
  return picked;
}

function isLexloopEventLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed === "") return false;
  try {
    const obj = JSON.parse(trimmed) as Record<string, unknown>;
    if (obj.v === "lexloop/v1") return true;
    if (obj.name === "extension") return true;
    if (typeof obj.name === "string" && obj.name.startsWith("lexloop.")) return true;
    const payload = obj.payload;
    if (payload && typeof payload === "object" && "extension_name" in payload) {
      const name = (payload as { extension_name?: unknown }).extension_name;
      if (typeof name === "string" && name.startsWith("lexloop.")) return true;
    }
    return false;
  } catch {
    return trimmed.includes("lexloop");
  }
}

function fileHasLexloopEvent(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    const text = readFileSync(path, "utf8");
    for (const line of text.split(/\r?\n/)) {
      if (isLexloopEventLine(line)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

function looksLikeStep(obj: Record<string, unknown>): boolean {
  if (typeof obj.tool_name !== "string") return false;
  if (obj.v === "lexloop/v1" && typeof obj.name === "string") return false;
  if (obj.name === "extension") return false;
  return true;
}

async function replayJsonl(path: string): Promise<void> {
  if (!existsSync(path)) {
    exitWith(2, `LL4001 replay file not found: ${path}`);
  }
  const text = readFileSync(path, "utf8");
  const trimmed = text.trim();
  const state = new RunState({ detect: { budget_ms: 20 } });
  let n = 0;

  const feedUnknown = async (raw: unknown): Promise<void> => {
    if (Array.isArray(raw)) {
      for (const item of raw) await feedUnknown(item);
      return;
    }
    if (!raw || typeof raw !== "object") return;
    const obj = raw as Record<string, unknown>;
    if (Array.isArray(obj.steps)) {
      const fixture = loadGoldenFixture(obj, "replay");
      for (const step of fixture.steps) {
        await recordGoldenStep(state, step);
        n += 1;
      }
      return;
    }
    if (looksLikeStep(obj)) {
      await recordGoldenStep(state, obj as { tool_name: string });
      n += 1;
    }
  };

  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      await feedUnknown(JSON.parse(trimmed));
    } catch {
      for (const line of text.split(/\r?\n/)) {
        const t = line.trim();
        if (t === "") continue;
        try {
          await feedUnknown(JSON.parse(t));
        } catch {
          // skip malformed
        }
      }
    }
  } else {
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim();
      if (t === "") continue;
      try {
        await feedUnknown(JSON.parse(t));
      } catch {
        // skip malformed
      }
    }
  }

  process.stdout.write(`replayed ${n} steps (observe-only)\n`);
}

function printAttachHints(
  attach: string | undefined,
  verbose: boolean,
  env: Record<string, string>,
): void {
  if (!attach && !verbose) return;
  if (attach) {
    process.stderr.write(
      `[lexloop] attach=${attach}: v0.1 prints env hints only; no proxy on :8790\n`,
    );
    if (attach === "openai-completions") {
      process.stderr.write("[lexloop] wrap the OpenAI chat.completions client with wrapOpenAI\n");
    } else if (attach === "anthropic-messages") {
      process.stderr.write("[lexloop] wrap the Anthropic messages client with wrapAnthropic\n");
    } else if (attach === "custom") {
      process.stderr.write("[lexloop] use observe() and maybeInject()\n");
    }
  }
  if (verbose || attach) {
    for (const [k, v] of Object.entries(env)) {
      process.stderr.write(`[lexloop] ${k}=${v}\n`);
    }
  }
}

function resolveLogPath(cfg: LexLoopConfig, cwd: string): string {
  const p = cfg.log.path;
  return isAbsolute(p) ? p : join(cwd, p);
}

async function waitForEvent(path: string, deadline: number): Promise<boolean> {
  while (Date.now() < deadline) {
    if (fileHasLexloopEvent(path)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return fileHasLexloopEvent(path);
}

export function addWatchCommand(program: Command): void {
  program
    .command("watch")
    .description("Run a command with LexLoop env, or replay JSONL")
    .option("--cmd <argv...>", "command argv")
    .option("--mode <mode>", "log-only or intervene")
    .option("--require-sdk", "fail if the child never emits a lexloop event")
    .option("--config <path>", "config path")
    .option("--from-jsonl <path>", "replay JSONL, observe-only")
    .option("--attach <kit>", "openai-completions, anthropic-messages, or custom")
    .option("--verbose", "print env hints to stderr")
    .action(async (opts: {
      cmd?: string | string[];
      mode?: string;
      requireSdk?: boolean;
      config?: string;
      fromJsonl?: string;
      attach?: string;
      verbose?: boolean;
    }) => {
      const fromJsonl = opts.fromJsonl;
      const cmd = resolveArgv(opts.cmd);
      if (!fromJsonl && (!cmd || cmd.length === 0)) {
        exitWith(2, "watch requires --cmd or --from-jsonl");
      }
      if (fromJsonl && cmd && cmd.length > 0) {
        exitWith(2, "watch --cmd and --from-jsonl are mutually exclusive");
      }

      const mode = resolveWatchMode({ mode: opts.mode, fromJsonl: Boolean(fromJsonl) });

      if (fromJsonl) {
        await replayJsonl(fromJsonl);
        return;
      }

      let cfg: LexLoopConfig;
      try {
        cfg = loadConfig({ path: opts.config, cwd: process.cwd() });
      } catch (err) {
        exitWith(2, formatUnknown(err));
      }

      const cwd = process.cwd();
      const logPath = resolveLogPath(cfg, cwd);
      await mkdir(dirname(logPath), { recursive: true });
      await mkdir(join(cwd, ".lexloop"), { recursive: true });

      const runId = process.env.LATTICEAG_RUN_ID || process.env.LEXLOOP_RUN_ID || newRunId();
      const sessionId = process.env.LATTICEAG_SESSION_ID || newSessionId();
      const configPath = opts.config ?? process.env.LEXLOOP_CONFIG ?? "";

      const injected: Record<string, string> = {
        LATTICEAG_RUN_ID: runId,
        LATTICEAG_SESSION_ID: sessionId,
        LATTICEAG_EVENTS_PATH: logPath,
        LEXLOOP_MODE: mode,
        LEXLOOP_RUN_ID: runId,
      };
      if (configPath) injected.LEXLOOP_CONFIG = configPath;

      printAttachHints(opts.attach, Boolean(opts.verbose), injected);

      const file = cmd![0]!;
      const args = cmd!.slice(1);
      const start = Date.now();
      const timeout = cfg.watch.sdk_timeout_ms;

      const child = await execa(file, args, {
        shell: false,
        stdio: "inherit",
        reject: false,
        env: { ...process.env, ...injected },
      });

      if (opts.requireSdk) {
        const deadline = start + timeout;
        const seen = await waitForEvent(logPath, deadline);
        if (!seen) {
          exitWith(2, "LL4002 --require-sdk timeout: no lexloop event");
        }
      }

      process.exit(child.exitCode ?? 1);
    });
}
