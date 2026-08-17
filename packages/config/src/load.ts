import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { lexloopConfigSchema, type LexLoopConfig } from "./schema.ts";

export class ConfigError extends Error {
  readonly code = "LL4001" as const;
  readonly offset?: number;

  constructor(message: string, options?: { offset?: number; cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "ConfigError";
    this.offset = options?.offset;
  }
}

export function defaultConfig(): LexLoopConfig {
  return lexloopConfigSchema.parse({ schema_version: 1 });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepMerge(base: unknown, over: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(over)) return over;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(over)) {
    if (value === undefined) continue;
    const current = out[key];
    out[key] = isPlainObject(current) && isPlainObject(value) ? deepMerge(current, value) : value;
  }
  return out;
}

function charOffsetToByteOffset(text: string, charOffset: number): number {
  return Buffer.byteLength(text.slice(0, charOffset), "utf8");
}

function parseJsonStrict(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const match = message.match(/position\s+(\d+)/i);
    const charOffset = match?.[1] !== undefined ? Number(match[1]) : undefined;
    const offset =
      charOffset !== undefined && Number.isFinite(charOffset)
        ? charOffsetToByteOffset(text, charOffset)
        : undefined;
    throw new ConfigError(
      offset !== undefined
        ? `LL4001 invalid JSON at byte offset ${offset}`
        : `LL4001 invalid JSON: ${message}`,
      { offset, cause: err },
    );
  }
}

function parseConfig(data: unknown): LexLoopConfig {
  const result = lexloopConfigSchema.safeParse(data);
  if (!result.success) {
    throw new ConfigError(`LL4001 invalid config: ${result.error.message}`);
  }
  return result.data;
}

export function findLexloopJson(cwd: string): string | undefined {
  let dir = cwd;
  while (true) {
    const candidate = join(dir, "lexloop.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export function readConfigFile(path: string): LexLoopConfig {
  if (!existsSync(path)) {
    throw new ConfigError(`LL4001 config file not found: ${path}`);
  }
  const text = readFileSync(path, "utf8");
  return parseConfig(parseJsonStrict(text));
}

export function resolveWritePath(cwd: string = process.cwd()): string {
  const envPath = process.env.LEXLOOP_CONFIG;
  if (envPath !== undefined && envPath !== "") {
    return resolvePath(envPath, cwd);
  }
  return findLexloopJson(cwd) ?? join(cwd, "lexloop.json");
}

function resolvePath(path: string, cwd: string): string {
  return isAbsolute(path) ? path : join(cwd, path);
}

export function applyModeEnv(
  cfg: LexLoopConfig,
  env: NodeJS.ProcessEnv = process.env,
): LexLoopConfig {
  const raw = env.LEXLOOP_MODE;
  if (raw === undefined || raw === "") return cfg;
  if (raw === "log-only" || raw === "intervene") {
    return { ...cfg, mode: raw };
  }
  return { ...cfg, mode: "log-only" };
}

export function loadConfig(opts?: {
  cwd?: string;
  path?: string;
  overrides?: Partial<LexLoopConfig>;
}): LexLoopConfig {
  const cwd = opts?.cwd ?? process.cwd();
  const envPath = process.env.LEXLOOP_CONFIG;
  const chosen =
    opts?.path !== undefined
      ? resolvePath(opts.path, cwd)
      : envPath !== undefined && envPath !== ""
        ? resolvePath(envPath, cwd)
        : findLexloopJson(cwd);

  let parsed: LexLoopConfig;
  if (chosen === undefined) {
    parsed = defaultConfig();
  } else {
    if (!existsSync(chosen)) {
      throw new ConfigError(`LL4001 config file not found: ${chosen}`);
    }
    const text = readFileSync(chosen, "utf8");
    parsed = parseConfig(parseJsonStrict(text));
  }

  if (opts?.overrides) {
    parsed = parseConfig(deepMerge(parsed, opts.overrides));
  }

  return applyModeEnv(parsed);
}
