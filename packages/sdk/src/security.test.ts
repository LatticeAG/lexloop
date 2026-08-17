import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig } from "@latticeag/lexloop-config";
import { matchSentinel } from "@latticeag/lexloop-core";
import { LexLoop } from "./index.ts";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "../../..");

function walk(dir: string, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, acc);
    else if (name.endsWith(".ts") || name.endsWith(".js")) acc.push(p);
  }
  return acc;
}

function lineIsComment(line: string): boolean {
  const t = line.trim();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
}

function grepHits(
  files: string[],
  pattern: RegExp,
  opts?: { skipComments?: boolean },
): Array<{ file: string; line: number; text: string }> {
  const hits: Array<{ file: string; line: number; text: string }> = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    const lines = text.split(/\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (opts?.skipComments && lineIsComment(line)) continue;
      if (pattern.test(line)) {
        hits.push({ file: relative(repoRoot, file), line: i + 1, text: line.trim() });
      }
    }
  }
  return hits;
}

describe("security grep", () => {
  it("attach and core (except log.ts) do not use execa, child_process, or fs.writeFile", () => {
    const attach = walk(join(repoRoot, "packages/sdk/src/attach"));
    const core = walk(join(repoRoot, "packages/core/src")).filter(
      (p) => !p.endsWith(`${join("src", "log.ts")}`) && !p.includes("/log.ts"),
    );
    const files = [...attach, ...core];
    const hits = grepHits(files, /\bexeca\b|\bchild_process\b|fs\.writeFile\b/);
    expect(hits).toEqual([]);
  });

  it("sdk and core have no halt(), SIGKILL, or process.kill except comments", () => {
    const files = [
      ...walk(join(repoRoot, "packages/sdk/src")),
      ...walk(join(repoRoot, "packages/core/src")),
    ].filter((p) => !p.endsWith(".test.ts"));
    const hits = grepHits(files, /\bhalt\(\)|SIGKILL|\bprocess\.kill\b/, { skipComments: true });
    expect(hits).toEqual([]);
  });

  it("src tree has no hardcoded token prefixes", () => {
    const files = walk(join(repoRoot, "packages")).filter(
      (p) => p.includes("/src/") && !p.endsWith(".test.ts"),
    );
    const a = "sk" + "-";
    const b = "gh" + "p_";
    const c = "xox" + "b-";
    const d = "apiKey:" + ' "';
    const hits = grepHits(files, new RegExp(`${a}|${b}|${c}|${d}`));
    expect(hits).toEqual([]);
  });
});

describe("maybeInject log-only", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("returns the same array reference or a shallow-equal copy without a sentinel", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lexloop-sec-"));
    dirs.push(dir);
    const cfg = defaultConfig();
    const loop = new LexLoop({
      mode: "log-only",
      config: {
        ...cfg,
        mode: "log-only",
        log: { ...cfg.log, path: join(dir, "events.jsonl") },
      },
    });
    const messages = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "ok" },
    ];
    const out = await loop.maybeInject(messages);
    const sameRef = out === messages;
    const shallowEqual =
      out.length === messages.length &&
      out.every((m, i) => m.role === messages[i]!.role && m.content === messages[i]!.content);
    expect(sameRef || shallowEqual).toBe(true);
    for (const m of out) {
      if (typeof m.content === "string") {
        expect(matchSentinel(m.content)).toBeNull();
        expect(m.content.includes("[lexloop intervention")).toBe(false);
      }
    }
    await loop.close();
  });
});
