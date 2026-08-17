import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { lexloopConfigSchema } from "@latticeag/lexloop-config";
import { LexLoop } from "../index.ts";
import { K_OPENAI_CREATE } from "./openai-completions.ts";

const tmpDirs: string[] = [];
const loops: LexLoop[] = [];

async function freshDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "lexloop-sdk-"));
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

function makeLoop(dir: string, mode: "log-only" | "intervene", extra?: { onEvent?: LexLoop["onEvent"] }) {
  const ll = new LexLoop({
    mode,
    config: testConfig(join(dir, "events.jsonl"), mode),
    onEvent: extra?.onEvent,
  });
  loops.push(ll);
  return ll;
}

const LOOKUP_TOOLS = [
  { type: "function", function: { name: "lookup" } },
  { type: "function", function: { name: "read_file" } },
];

function failMessages(n: number) {
  const messages: Array<Record<string, unknown>> = [{ role: "user", content: "find x" }];
  for (let i = 0; i < n; i++) {
    messages.push({
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: `call_${i}`,
          type: "function",
          function: { name: "lookup", arguments: '{"q":"x"}' },
        },
      ],
    });
    messages.push({
      role: "tool",
      tool_call_id: `call_${i}`,
      content: "ENOENT: no such file",
    });
  }
  return messages;
}

function hasSentinel(messages: unknown): boolean {
  return JSON.stringify(messages).includes("[lexloop intervention");
}

function fakeOpenAI(opts?: { throw?: Error; streamChunks?: unknown[] }) {
  const received: Array<{ messages: unknown; stream?: boolean }> = [];
  const client = {
    chat: {
      completions: {
        create: async (params: { messages: unknown; stream?: boolean; tools?: unknown }) => {
          received.push({ messages: params.messages, stream: params.stream });
          if (opts?.throw) throw opts.throw;
          if (params.stream) {
            const chunks = opts?.streamChunks ?? [];
            return (async function* () {
              for (const chunk of chunks) yield chunk;
            })();
          }
          return { choices: [{ message: { role: "assistant", content: "ok" } }] };
        },
      },
    },
  };
  return { client, received };
}

describe("log-only does not splice", () => {
  it("maybeInject and wrapOpenAI leave messages without a sentinel", async () => {
    const dir = await freshDir();
    const ll = makeLoop(dir, "log-only");
    const messages = failMessages(4);
    for (const msg of messages) {
      if (msg.role !== "tool") continue;
      await ll.observe({
        tool_name: "lookup",
        args: { q: "x" },
        error: "ENOENT: no such file",
      });
    }
    const injected = await ll.maybeInject(messages as { role: string; content?: string | null }[]);
    expect(injected).toBe(messages);
    expect(hasSentinel(injected)).toBe(false);

    const dir2 = await freshDir();
    const wrapLoop = makeLoop(dir2, "log-only");
    const { client, received } = fakeOpenAI();
    wrapLoop.wrapOpenAI(client);
    await client.chat.completions.create({ messages: failMessages(4), tools: LOOKUP_TOOLS });
    expect(received).toHaveLength(1);
    expect(hasSentinel(received[0]?.messages)).toBe(false);
  });
});

describe("intervene splices on 4th identical tool_result inbound", () => {
  it("3rd call has no sentinel, 4th does", async () => {
    const dir = await freshDir();
    const ll = makeLoop(dir, "intervene");
    const { client, received } = fakeOpenAI();
    ll.wrapOpenAI(client);

    await client.chat.completions.create({ messages: failMessages(1), tools: LOOKUP_TOOLS });
    await client.chat.completions.create({ messages: failMessages(2), tools: LOOKUP_TOOLS });
    await client.chat.completions.create({ messages: failMessages(3), tools: LOOKUP_TOOLS });
    expect(hasSentinel(received[2]?.messages)).toBe(false);

    await client.chat.completions.create({ messages: failMessages(4), tools: LOOKUP_TOOLS });
    expect(hasSentinel(received[3]?.messages)).toBe(true);
  });
});

describe("double-wrap", () => {
  it("is a no-op and keeps create identity plus the original symbol", async () => {
    const dir = await freshDir();
    const ll = makeLoop(dir, "log-only");
    const { client } = fakeOpenAI();
    const original = client.chat.completions.create;
    const wrapped = ll.wrapOpenAI(client);
    const firstCreate = wrapped.chat.completions.create;
    expect(wrapped).toBe(client);
    expect(firstCreate).not.toBe(original);
    expect(K_OPENAI_CREATE in wrapped).toBe(true);

    const again = ll.wrapOpenAI(wrapped);
    expect(again).toBe(wrapped);
    expect(again.chat.completions.create).toBe(firstCreate);
  });
});

describe("provider errors", () => {
  it("pass through", async () => {
    const dir = await freshDir();
    const ll = makeLoop(dir, "intervene");
    const boom = new Error("provider down");
    const { client } = fakeOpenAI({ throw: boom });
    ll.wrapOpenAI(client);
    await expect(
      client.chat.completions.create({ messages: failMessages(1), tools: LOOKUP_TOOLS }),
    ).rejects.toThrow("provider down");
  });
});

describe("LexLoop throw does not reach the agent", () => {
  it("monkeypatched detect throw still calls the provider", async () => {
    const dir = await freshDir();
    const ll = makeLoop(dir, "intervene");
    const { client, received } = fakeOpenAI();
    ll.wrapOpenAI(client);
    vi.spyOn(ll.state, "detect").mockImplementation(() => {
      throw new Error("lexloop detect exploded");
    });
    const out = await client.chat.completions.create({
      messages: failMessages(1),
      tools: LOOKUP_TOOLS,
    });
    expect(received).toHaveLength(1);
    expect(out).toEqual({ choices: [{ message: { role: "assistant", content: "ok" } }] });
  });
});

describe("fingerprint cooldown", () => {
  it("after one splice, further identical inbound does not add a second sentinel", async () => {
    const dir = await freshDir();
    const ll = makeLoop(dir, "intervene");
    const { client, received } = fakeOpenAI();
    ll.wrapOpenAI(client);
    await client.chat.completions.create({ messages: failMessages(4), tools: LOOKUP_TOOLS });
    await client.chat.completions.create({ messages: failMessages(5), tools: LOOKUP_TOOLS });
    expect(hasSentinel(received[0]?.messages)).toBe(true);
    expect(hasSentinel(received[1]?.messages)).toBe(false);
    const first = JSON.stringify(received[0]?.messages);
    const sentinels = first.split("[lexloop intervention").length - 1;
    expect(sentinels).toBe(1);
  });
});

describe("events after stuck splice", () => {
  it("onEvent and log file contain v lexloop/v1 plus detected classified injected", async () => {
    const dir = await freshDir();
    const events: Array<{ v: string; name: string }> = [];
    const ll = makeLoop(dir, "intervene", {
      onEvent: (ev) => {
        events.push({ v: ev.v, name: ev.name });
      },
    });
    const { client } = fakeOpenAI();
    ll.wrapOpenAI(client);
    await client.chat.completions.create({ messages: failMessages(4), tools: LOOKUP_TOOLS });
    await ll.log.close();

    const names = events.map((e) => e.name);
    expect(events.every((e) => e.v === "lexloop/v1")).toBe(true);
    expect(names).toContain("loop_detected");
    expect(names).toContain("loop_classified");
    expect(names).toContain("intervention_injected");

    const text = await readFile(join(dir, "events.jsonl"), "utf8");
    expect(text).toContain('"v":"lexloop/v1"');
    expect(text).toContain("loop_detected");
    expect(text).toContain("loop_classified");
    expect(text).toContain("intervention_injected");
  });
});

describe("stream tee", () => {
  it("yields fixture chunks and records a tool_call after the iterator completes", async () => {
    const dir = await freshDir();
    const ll = makeLoop(dir, "log-only");
    const fixturePath = new URL("../../fixtures/openai-sse-tool-calls.txt", import.meta.url);
    const fixture = await readFile(fixturePath, "utf8");
    const chunks: unknown[] = [];
    for (const line of fixture.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (data === "[DONE]" || data === "") continue;
      chunks.push(JSON.parse(data));
    }
    expect(chunks.length).toBeGreaterThan(0);

    const { client } = fakeOpenAI({ streamChunks: chunks });
    ll.wrapOpenAI(client);
    const stream = await client.chat.completions.create({
      messages: [{ role: "user", content: "go" }],
      stream: true,
    });
    const seen: unknown[] = [];
    for await (const chunk of stream as AsyncIterable<unknown>) {
      seen.push(chunk);
    }
    expect(seen).toEqual(chunks);
    const recorded = ll.state.steps.filter((s) => s.kind === "tool_call");
    expect(recorded.length).toBeGreaterThanOrEqual(1);
    expect(recorded[0]?.tool_name).toBe("lookup");
  });
});
