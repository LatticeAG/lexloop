/** packages/sdk/src/attach/anthropic-messages.ts */

import { matchSentinel, clipName } from "@latticeag/lexloop-core";
import { sdkLog } from "../debug.ts";
import { spliceMessages } from "./splice.ts";
import {
  capToolNames,
  contentToText,
  isErrorLooking,
  messagesHash,
  parseJsonish,
  rememberTools,
  tickInbound,
  type SdkHandle,
} from "../engine.ts";

export const K_ANTHROPIC_CREATE = Symbol.for("lexloop.anthropic.create");

export type AnthropicBlock = {
  type?: string;
  id?: string;
  name?: string;
  input?: unknown;
  text?: string;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
  partial_json?: string;
};

export type AnthropicMessage = {
  role: string;
  content?: unknown;
};

type AnthropicCreateParams = {
  messages?: AnthropicMessage[];
  tools?: unknown;
  system?: unknown;
  stream?: boolean;
  [key: string]: unknown;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return value !== null && typeof value === "object" && Symbol.asyncIterator in value;
}

function asBlocks(content: unknown): AnthropicBlock[] {
  if (Array.isArray(content)) return content as AnthropicBlock[];
  return [];
}

export function extractAnthropicToolNames(tools: unknown): string[] {
  if (!Array.isArray(tools)) return [];
  const names: string[] = [];
  for (const tool of tools) {
    const rec = asRecord(tool);
    const name = typeof rec?.name === "string" ? clipName(rec.name) : "";
    if (name) names.push(name);
  }
  return capToolNames(names);
}

function toolResultKey(block: AnthropicBlock, index: number): string {
  if (typeof block.tool_use_id === "string" && block.tool_use_id !== "") {
    return `anthropic:${block.tool_use_id}`;
  }
  return `anthropic:idx:${index}:${contentToText(block.content)}`;
}

export function joinAnthropicToolUse(
  messages: AnthropicMessage[],
  toolUseId: string | undefined,
): { name: string; args: unknown } {
  if (!toolUseId) return { name: "unknown_tool", args: undefined };
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    if (msg.role !== "assistant") continue;
    for (const block of asBlocks(msg.content)) {
      if (block.type !== "tool_use") continue;
      if (block.id !== toolUseId) continue;
      const name = typeof block.name === "string" && block.name !== "" ? block.name : "unknown_tool";
      return { name, args: block.input };
    }
  }
  return { name: "unknown_tool", args: undefined };
}

function resultFields(
  content: unknown,
  isError: boolean | undefined,
): { result?: unknown; error?: string; text: string } {
  const text = contentToText(content);
  if (isError === true || (typeof content === "string" && isErrorLooking(content))) {
    return { error: typeof content === "string" ? content : text, text };
  }
  if (typeof content === "string") {
    return { result: parseJsonish(content), text };
  }
  return { result: content, text };
}

export async function observeAnthropicInbound(
  loop: SdkHandle,
  messages: AnthropicMessage[] | undefined,
): Promise<void> {
  if (!messages) return;
  loop.lastInboundHash = messagesHash(messages);
  let n = 0;
  for (const msg of messages) {
    if (msg.role !== "user") continue;
    for (const block of asBlocks(msg.content)) {
      if (block.type !== "tool_result") continue;
      const key = toolResultKey(block, n);
      n += 1;
      if (loop.seenToolKeys.has(key)) continue;
      loop.seenToolKeys.add(key);
      const joined = joinAnthropicToolUse(messages, block.tool_use_id);
      const fields = resultFields(block.content, block.is_error);
      const sentinel = matchSentinel(fields.text);
      await loop.state.recordToolResult({
        tool_name: joined.name,
        args: joined.args,
        error: fields.error,
        result: fields.error === undefined ? fields.result : undefined,
        text: fields.text,
        intervention_id: sentinel?.intervention_id,
      });
    }
  }
}

function appendAnthropicSystem(system: unknown, text: string): unknown {
  const block = `\n\n${text}`;
  if (system === undefined || system === null) return text;
  if (typeof system === "string") return `${system}${block}`;
  if (Array.isArray(system)) {
    return [...system, { type: "text", text: block }];
  }
  return system;
}

export async function beforeAnthropicRequest(
  loop: SdkHandle,
  params: AnthropicCreateParams,
): Promise<AnthropicCreateParams> {
  rememberTools(loop, extractAnthropicToolNames(params.tools));
  const messages = Array.isArray(params.messages) ? params.messages : [];
  await observeAnthropicInbound(loop, messages);
  const tick = await tickInbound(loop, { messages, allowInject: true });
  if (loop.mode === "log-only") return params;
  if (!tick.text) return params;

  if (tick.role === "user" || loop.config.intervene.role === "user") {
    return { ...params, messages: spliceMessages(messages, tick.text, "user") };
  }
  if (loop.config.intervene.anthropic_system_append) {
    return { ...params, system: appendAnthropicSystem(params.system, tick.text) };
  }
  return { ...params, messages: spliceMessages(messages, tick.text, tick.role ?? "system") };
}

export function coalesceAnthropicToolUses(chunks: unknown[]): AnthropicBlock[] {
  const byIndex = new Map<number, { id?: string; name?: string; json: string }>();
  const fromMessage: AnthropicBlock[] = [];

  for (const raw of chunks) {
    const obj = asRecord(raw);
    if (!obj) continue;
    if (obj.type === "content_block_start") {
      const block = asRecord(obj.content_block);
      const index = typeof obj.index === "number" ? obj.index : byIndex.size;
      if (block?.type === "tool_use") {
        byIndex.set(index, {
          id: typeof block.id === "string" ? block.id : undefined,
          name: typeof block.name === "string" ? block.name : undefined,
          json: "",
        });
      }
    } else if (obj.type === "content_block_delta") {
      const delta = asRecord(obj.delta);
      const index = typeof obj.index === "number" ? obj.index : 0;
      if (delta?.type === "input_json_delta" && typeof delta.partial_json === "string") {
        const acc = byIndex.get(index);
        if (acc) acc.json += delta.partial_json;
      }
    } else if (Array.isArray(obj.content)) {
      for (const block of obj.content) {
        const rec = asRecord(block);
        if (rec?.type === "tool_use") fromMessage.push(rec as AnthropicBlock);
      }
    }
  }

  if (fromMessage.length > 0) return fromMessage;
  const out: AnthropicBlock[] = [];
  for (const acc of byIndex.values()) {
    out.push({
      type: "tool_use",
      id: acc.id,
      name: acc.name,
      input: parseJsonish(acc.json),
    });
  }
  return out;
}

export async function recordAnthropicToolUses(
  loop: SdkHandle,
  blocks: AnthropicBlock[] | undefined,
): Promise<void> {
  if (!blocks) return;
  for (const block of blocks) {
    if (block.type && block.type !== "tool_use") continue;
    const name = typeof block.name === "string" && block.name !== "" ? block.name : "unknown_tool";
    await loop.state.recordToolCall({
      tool_name: name,
      args: block.input,
    });
  }
}

export async function afterAnthropicResponse(loop: SdkHandle, result: unknown): Promise<void> {
  const rec = asRecord(result);
  const content = rec && Array.isArray(rec.content) ? (rec.content as AnthropicBlock[]) : undefined;
  const uses = content?.filter((b) => b.type === "tool_use");
  await recordAnthropicToolUses(loop, uses);
}

async function teeAnthropicStream(
  loop: SdkHandle,
  source: AsyncIterable<unknown>,
): Promise<AsyncIterable<unknown>> {
  async function* gen(): AsyncGenerator<unknown> {
    const chunks: unknown[] = [];
    try {
      for await (const chunk of source) {
        chunks.push(chunk);
        yield chunk;
      }
    } finally {
      try {
        await recordAnthropicToolUses(loop, coalesceAnthropicToolUses(chunks));
      } catch (err) {
        sdkLog("LL1001", err);
      }
    }
  }
  return gen();
}

export function wrapAnthropicClient<T extends { messages: { create: Function } }>(
  loop: SdkHandle,
  client: T,
): T {
  try {
    if (Reflect.get(client, K_ANTHROPIC_CREATE)) return client;
    const messagesApi = client.messages;
    const original = messagesApi.create.bind(messagesApi) as (...args: unknown[]) => unknown;
    Reflect.set(client, K_ANTHROPIC_CREATE, original);

    messagesApi.create = async function wrappedCreate(...args: unknown[]) {
      const params = (asRecord(args[0]) ?? {}) as AnthropicCreateParams;
      const rest = args.slice(1);
      let nextParams: unknown = args[0];
      try {
        nextParams = await beforeAnthropicRequest(loop, params);
      } catch (err) {
        sdkLog("LL1001", err);
        nextParams = args[0];
      }

      const result = await original(nextParams, ...rest);

      try {
        if (params.stream === true && isAsyncIterable(result)) {
          return teeAnthropicStream(loop, result);
        }
        await afterAnthropicResponse(loop, result);
      } catch (err) {
        sdkLog("LL1001", err);
      }
      return result;
    };

    return client;
  } catch (err) {
    sdkLog("LL1001", err);
    return client;
  }
}
