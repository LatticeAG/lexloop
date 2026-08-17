import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigError, defaultConfig, loadConfig } from "./load.ts";

const POLL_NAME_REGEX = "^(get|list|status|health|poll|wait|sleep|head)(_|$)?";

function restoreEnv(key: string, prev: string | undefined): void {
  if (prev === undefined) delete process.env[key];
  else process.env[key] = prev;
}

describe("defaultConfig", () => {
  it("defaults match spec", () => {
    const cfg = defaultConfig();
    expect(cfg.schema_version).toBe(1);
    expect(cfg.mode).toBe("log-only");
    expect(cfg.detect.stuck.min_run).toBe(3);
    expect(cfg.detect.poll.min_run).toBe(8);
    expect(cfg.detect.poll.allowlist).toEqual(["process"]);
    expect(cfg.detect.poll.name_regex).toBe(POLL_NAME_REGEX);
    expect(cfg.detect.budget_ms).toBe(2);
    expect(cfg.detect.empty_as_error).toBe(false);
    expect(cfg.intervene.cooldown_steps).toBe(4);
    expect(cfg.classify.beliefs_enabled).toBe(false);
    expect(cfg.axion.enabled).toBe(false);
    expect(cfg.proxy.port).toBe(8790);
    expect(cfg.log.path).toBe(".lexloop/events.jsonl");
    expect(cfg.run).toBeUndefined();
    expect(cfg.hosted).toBeUndefined();
  });
});

describe("loadConfig", () => {
  const dirs: string[] = [];
  const envKeys = ["LEXLOOP_CONFIG", "LEXLOOP_MODE"] as const;
  const saved: Record<string, string | undefined> = {};

  afterEach(() => {
    for (const key of envKeys) restoreEnv(key, saved[key]);
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function snapshotEnv(): void {
    for (const key of envKeys) saved[key] = process.env[key];
  }

  it("unknown key fails with LL4001", () => {
    snapshotEnv();
    delete process.env.LEXLOOP_CONFIG;
    delete process.env.LEXLOOP_MODE;
    const dir = mkdtempSync(join(tmpdir(), "lexloop-config-"));
    dirs.push(dir);
    const file = join(dir, "lexloop.json");
    writeFileSync(file, JSON.stringify({ schema_version: 1, not_a_key: true }));
    expect(() => loadConfig({ path: file })).toThrow(ConfigError);
    try {
      loadConfig({ path: file });
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toMatchObject({ code: "LL4001" });
    }
  });

  it("LEXLOOP_CONFIG path used", () => {
    snapshotEnv();
    delete process.env.LEXLOOP_MODE;
    const dir = mkdtempSync(join(tmpdir(), "lexloop-config-"));
    dirs.push(dir);
    const file = join(dir, "custom.json");
    writeFileSync(file, JSON.stringify({ schema_version: 1, mode: "intervene" }));
    process.env.LEXLOOP_CONFIG = file;
    const cfg = loadConfig({ cwd: tmpdir() });
    expect(cfg.mode).toBe("intervene");
  });
});
