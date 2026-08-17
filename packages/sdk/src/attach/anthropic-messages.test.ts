import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { lexloopConfigSchema } from "@latticeag/lexloop-config";
import { LexLoop } from "../index.ts";

const tmpDirs: string[] = [];
const loops: LexLoop[] = [];

async function freshDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "lexloop-sdk-anth-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(loops.splice(0).map((ll) => ll.close()));
  const dirs = tmpDirs.splice(0);
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

function testConfig(path: string, mode: "log-only" | "intervene") {
  return lexloopConfigSchema.parse({
    schema_version: 1,
    mode,
    log: { path },
    detect: { budget_ms: 20 },
  });
}

function failBlocks(n: number) {
  const messages: Array<{ role: string; content: unknown }> = [];
  for (let i = 0; i < n; i++) {
    messages.push({
      role: "assistant",
      content: [{ type: "tool_use", id: `toolu_${i}`, name: "lookup", input: { q: "x" } }],
    });
    messages.push({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: `toolu_${i}`,
          content: "ENOENT: no such file",
          is_error: true,
        },
      ],
    });
  }
  return messages;
}

describe("Anthropic wrap", () => {
  it("appends sentinel to system after 4 identical tool_result blocks in intervene mode", async () => {
    const dir = await freshDir();
    const ll = new LexLoop({
      mode: "intervene",
      config: testConfig(join(dir, "events.jsonl"), "intervene"),
    });
    loops.push(ll);

    const received: Array<{ system?: unknown; messages?: unknown }> = [];
    const client = {
      messages: {
        create: async (params: { system?: unknown; messages?: unknown; tools?: unknown }) => {
          received.push({ system: params.system, messages: params.messages });
          return { content: [{ type: "text", text: "ok" }] };
        },
      },
    };

    ll.wrapAnthropic(client);
    await client.messages.create({
      system: "You are a careful assistant.",
      messages: failBlocks(4),
      tools: [{ name: "lookup" }, { name: "read_file" }],
    });

    expect(received).toHaveLength(1);
    const system = received[0]?.system;
    expect(typeof system).toBe("string");
    expect(String(system)).toContain("You are a careful assistant.");
    expect(String(system)).toContain("[lexloop intervention");
    expect(String(system).includes("\n\n[lexloop intervention")).toBe(true);
  });
});
