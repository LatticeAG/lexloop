import { existsSync } from "node:fs";
import type { Command } from "commander";
import {
  ConfigError,
  defaultConfig,
  lexloopConfigSchema,
  loadConfig,
  readConfigFile,
  resolveWritePath,
  writeConfig,
  type LexLoopConfig,
} from "@latticeag/lexloop-config";
import { exitWith, formatUnknown, isConfigError } from "../exit.ts";

function setDotted(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".").filter((p) => p.length > 0);
  if (parts.length === 0) {
    exitWith(2, "LL4001 empty config path");
  }
  let cur: Record<string, unknown> = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i]!;
    const next = cur[key];
    if (next === undefined || next === null || typeof next !== "object" || Array.isArray(next)) {
      const created: Record<string, unknown> = {};
      cur[key] = created;
      cur = created;
    } else {
      cur = next as Record<string, unknown>;
    }
  }
  cur[parts[parts.length - 1]!] = value;
}

function parseJsonValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    exitWith(2, `LL4001 invalid JSON value: ${message}`);
  }
}

export function addConfigCommand(program: Command): void {
  const config = program.command("config").description("Validate, show, or set lexloop.json");

  config
    .command("validate")
    .description("Parse and Zod-check a config file")
    .option("--config <path>", "config path")
    .action((opts: { config?: string }) => {
      try {
        loadConfig({ path: opts.config, cwd: process.cwd() });
      } catch (err) {
        if (isConfigError(err) || err instanceof ConfigError) {
          exitWith(2, err instanceof Error ? err.message : "LL4001 invalid config");
        }
        exitWith(2, `LL4001 ${formatUnknown(err)}`);
      }
    });

  config
    .command("show")
    .description("Print the effective config")
    .option("--json", "print JSON")
    .option("--config <path>", "config path")
    .action((opts: { json?: boolean; config?: string }) => {
      let cfg: LexLoopConfig;
      try {
        cfg = loadConfig({ path: opts.config, cwd: process.cwd() });
      } catch (err) {
        if (isConfigError(err) || err instanceof ConfigError) {
          exitWith(2, err instanceof Error ? err.message : "LL4001 invalid config");
        }
        exitWith(2, `LL4001 ${formatUnknown(err)}`);
      }
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(cfg)}\n`);
      } else {
        process.stdout.write(`${JSON.stringify(cfg, null, 2)}\n`);
      }
    });

  config
    .command("set")
    .description("Write a dotted path as JSON")
    .argument("<dotted.path>")
    .argument("<json-value>")
    .action(async (dotted: string, jsonValue: string) => {
      const path = resolveWritePath(process.cwd());
      let base: LexLoopConfig;
      try {
        if (existsSync(path)) {
          base = readConfigFile(path);
        } else {
          base = defaultConfig();
        }
      } catch (err) {
        if (isConfigError(err) || err instanceof ConfigError) {
          exitWith(2, err instanceof Error ? err.message : "LL4001 invalid config");
        }
        exitWith(2, `LL4001 ${formatUnknown(err)}`);
      }

      const value = parseJsonValue(jsonValue);
      const draft = structuredClone(base) as Record<string, unknown>;
      setDotted(draft, dotted, value);
      const parsed = lexloopConfigSchema.safeParse(draft);
      if (!parsed.success) {
        exitWith(2, `LL4001 invalid config: ${parsed.error.message}`);
      }
      await writeConfig(path, parsed.data);
    });
}
