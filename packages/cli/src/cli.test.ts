import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const distCli = join(here, "../dist/cli.js");

function run(
  args: string[],
  opts?: { cwd?: string; env?: NodeJS.ProcessEnv },
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [distCli, ...args], {
    encoding: "utf8",
    cwd: opts?.cwd,
    env: { ...process.env, ...opts?.env, LEXLOOP_CONFIG: opts?.env?.LEXLOOP_CONFIG ?? "" },
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

describe("lexloop cli", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("--help exits 0 and lists commands", () => {
    const result = run(["--help"]);
    expect(result.status).toBe(0);
    const out = `${result.stdout}${result.stderr}`;
    for (const name of ["init", "watch", "report", "config", "bench", "doctor", "version"]) {
      expect(out).toContain(name);
    }
  });

  it("version prints 0.1.0", () => {
    const result = run(["version"]);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("0.1.0");
  });

  it("init then config validate exits 0", () => {
    const dir = mkdtempSync(join(tmpdir(), "lexloop-cli-"));
    dirs.push(dir);
    const init = run(["init"], { cwd: dir, env: { ...process.env, LEXLOOP_CONFIG: "", LEXLOOP_MODE: "" } });
    expect(init.status).toBe(0);
    expect(existsSync(join(dir, "lexloop.json"))).toBe(true);
    expect(existsSync(join(dir, ".lexloop"))).toBe(true);
    const cfg = JSON.parse(readFileSync(join(dir, "lexloop.json"), "utf8")) as { schema_version: number };
    expect(cfg.schema_version).toBe(1);
    const validate = run(["config", "validate"], {
      cwd: dir,
      env: { ...process.env, LEXLOOP_CONFIG: "", LEXLOOP_MODE: "" },
    });
    expect(validate.status).toBe(0);
  });

  it("config set unknown key fails with LL4001 exit 2", () => {
    const dir = mkdtempSync(join(tmpdir(), "lexloop-cli-"));
    dirs.push(dir);
    const init = run(["init"], { cwd: dir, env: { ...process.env, LEXLOOP_CONFIG: "", LEXLOOP_MODE: "" } });
    expect(init.status).toBe(0);
    const set = run(["config", "set", "not_a_key", "true"], {
      cwd: dir,
      env: { ...process.env, LEXLOOP_CONFIG: "", LEXLOOP_MODE: "" },
    });
    expect(set.status).toBe(2);
    expect(`${set.stdout}${set.stderr}`).toContain("LL4001");
  });

  it("doctor --offline exits 0", () => {
    const dir = mkdtempSync(join(tmpdir(), "lexloop-cli-"));
    dirs.push(dir);
    const result = run(["doctor", "--offline"], {
      cwd: dir,
      env: {
        ...process.env,
        LEXLOOP_CONFIG: "",
        LEXLOOP_MODE: "",
        LEXLOOP_ALLOW_UNREDACTED: "",
        NODE_ENV: "test",
      },
    });
    expect(result.status).toBe(0);
    const out = `${result.stdout}${result.stderr}`;
    expect(out).toMatch(/node:/);
  });

  it("watch --from-jsonl with --mode intervene exits 2", () => {
    const dir = mkdtempSync(join(tmpdir(), "lexloop-cli-"));
    dirs.push(dir);
    const jsonl = join(dir, "replay.jsonl");
    writeFileSync(jsonl, "{}\n");
    const result = run(["watch", "--from-jsonl", jsonl, "--mode", "intervene"], { cwd: dir });
    expect(result.status).toBe(2);
    expect(`${result.stdout}${result.stderr}`).toContain("replay is observe-only");
  });
});
