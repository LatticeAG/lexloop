/** packages/sdk/src/attach/openai-completions.ts */

import { matchSentinel, clipName } from "@latticeag/lexloop-core";
import { sdkLog } from "../debug.ts";
import {
  capToolNames,
  contentToText,
  isErrorLooking,
  maybeSpliceMessages,
  messagesHash,
  parseJsonish,
  rememberTools,
  type SdkHandle,
} from "../engine.ts";

export const K_OPENAI_CREATE = Symbol.for("lexloop.openai.create");

export type OpenAIToolCall = {
  index?: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
};

export type OpenAIChatMessage = {
  role: string;
  content?: unknown;
  tool_call_id?: string;
  tool_calls?: OpenAIToolCall[];
};

type OpenAICreateParams = {
  messages?: OpenAIChatMessage[];
  tools?: unknown;
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

export function extractOpenAIToolNames(tools: unknown): string[] {
  if (!Array.isArray(tools)) return [];
  const names: string[] = [];
  for (const tool of tools) {
    const rec = asRecord(tool);
    const fn = rec ? asRecord(rec.function) : undefined;
    const name = typeof fn?.name === "string" ? clipName(fn.name) : "";
    if (name) names.push(name);
  }
  return capToolNames(names);
}

function toolMessageKey(msg: OpenAIChatMessage, index: number): string {
  if (typeof msg.tool_call_id === "string" && msg.tool_call_id !== "") {
    return `openai:${msg.tool_call_id}`;
  }
  return `openai:idx:${index}:${String(msg.content ?? "")}`;
}

export function joinOpenAIToolCall(
  messages: OpenAIChatMessage[],
  toolCallId: string | undefined,
): { name: string; args: unknown } {
  if (!toolCallId) return { name: "unknown_tool", args: undefined };
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    if (msg.role !== "assistant" || !Array.isArray(msg.tool_calls)) continue;
    for (const tc of msg.tool_calls) {
      if (tc.id !== toolCallId) continue;
      const name =
        typeof tc.function?.name === "string" && tc.function.name !== ""
          ? tc.function.name
          : "unknown_tool";
      return { name, args: parseJsonish(tc.function?.arguments) };
    }
  }
  return { name: "unknown_tool", args: undefined };
}

function resultFields(content: unknown): {
  result?: unknown;
  error?: string;
  text: string;
} {
  const text = contentToText(content);
  const hit = matchSentinel(text);
  if (typeof content === "string" && isErrorLooking(content)) {
    return { error: content, text };
  }
  if (hit) return { result: content, text };
  if (typeof content === "string") {
    const parsed = parseJsonish(content);
    return { result: parsed, text };
  }
  return { result: content, text };
}

export async function observeOpenAIInbound(
  loop: SdkHandle,
  messages: OpenAIChatMessage[] | undefined,
): Promise<void> {
  if (!messages) return;
  const hash = messagesHash(messages);
  loop.lastInboundHash = hash;
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    if (msg.role !== "tool") continue;
    const key = toolMessageKey(msg, i);
    if (loop.seenToolKeys.has(key)) continue;
    loop.seenToolKeys.add(key);
    const joined = joinOpenAIToolCall(messages, msg.tool_call_id);
    const fields = resultFields(msg.content);
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

export async function beforeOpenAIRequest(
  loop: SdkHandle,
  params: OpenAICreateParams,
): Promise<OpenAICreateParams> {
  rememberTools(loop, extractOpenAIToolNames(params.tools));
  const messages = Array.isArray(params.messages) ? params.messages : [];
  await observeOpenAIInbound(loop, messages);
  const spliced = await maybeSpliceMessages(loop, messages);
  if (spliced === messages) return params;
  return { ...params, messages: spliced };
}

function chunkObject(chunk: unknown): Record<string, unknown> | undefined {
  if (typeof chunk === "string") {
    const line = chunk.trim();
    if (line === "" || line === "data: [DONE]" || line === "[DONE]") return undefined;
    const data = line.startsWith("data:") ? line.slice(5).trim() : line;
    if (data === "[DONE]" || data === "") return undefined;
    try {
      return asRecord(JSON.parse(data));
    } catch {
      return undefined;
    }
  }
  return asRecord(chunk);
}

export function coalesceOpenAIToolCalls(chunks: unknown[]): OpenAIToolCall[] {
  const byIndex = new Map<number, { id?: string; name?: string; arguments: string }>();
  let fromMessage: OpenAIToolCall[] | undefined;

  for (const raw of chunks) {
    const obj = chunkObject(raw);
    if (!obj) continue;
    const choices = Array.isArray(obj.choices) ? obj.choices : [];
    const choice = asRecord(choices[0]);
    if (!choice) continue;
    const message = asRecord(choice.message);
    if (message && Array.isArray(message.tool_calls)) {
      fromMessage = message.tool_calls as OpenAIToolCall[];
    }
    const delta = asRecord(choice.delta);
    const tcs = delta && Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
    for (const item of tcs) {
      const rec = asRecord(item);
      if (!rec) continue;
      const index = typeof rec.index === "number" ? rec.index : 0;
      let acc = byIndex.get(index);
      if (!acc) {
        acc = { arguments: "" };
        byIndex.set(index, acc);
      }
      if (typeof rec.id === "string" && rec.id !== "") acc.id = rec.id;
      const fn = asRecord(rec.function);
      if (typeof fn?.name === "string" && fn.name !== "") acc.name = fn.name;
      if (typeof fn?.arguments === "string") acc.arguments += fn.arguments;
    }
  }

  if (fromMessage && fromMessage.length > 0) return fromMessage;
  const out: OpenAIToolCall[] = [];
  const indexes = [...byIndex.keys()].sort((a, b) => a - b);
  for (const index of indexes) {
    const acc = byIndex.get(index)!;
    out.push({
      index,
      id: acc.id,
      function: { name: acc.name, arguments: acc.arguments },
    });
  }
  return out;
}

export async function recordOpenAIToolCalls(
  loop: SdkHandle,
  toolCalls: OpenAIToolCall[] | undefined,
): Promise<void> {
  if (!toolCalls) return;
  for (const tc of toolCalls) {
    const name =
      typeof tc.function?.name === "string" && tc.function.name !== ""
        ? tc.function.name
        : "unknown_tool";
    const text =
      typeof tc.function?.arguments === "string" ? tc.function.arguments : undefined;
    const sentinel = text ? matchSentinel(text) : null;
    await loop.state.recordToolCall({
      tool_name: name,
      args: parseJsonish(tc.function?.arguments),
      text,
      intervention_id: sentinel?.intervention_id,
    });
  }
}

export async function afterOpenAIResponse(loop: SdkHandle, result: unknown): Promise<void> {
  const rec = asRecord(result);
  const choices = rec && Array.isArray(rec.choices) ? rec.choices : [];
  const choice = asRecord(choices[0]);
  const message = choice ? asRecord(choice.message) : undefined;
  const toolCalls = message && Array.isArray(message.tool_calls) ? message.tool_calls : undefined;
  await recordOpenAIToolCalls(loop, toolCalls as OpenAIToolCall[] | undefined);
}

async function teeOpenAIStream(loop: SdkHandle, source: AsyncIterable<unknown>): Promise<AsyncIterable<unknown>> {
  async function* gen(): AsyncGenerator<unknown> {
    const chunks: unknown[] = [];
    try {
      for await (const chunk of source) {
        chunks.push(chunk);
        yield chunk;
      }
    } finally {
      try {
        await recordOpenAIToolCalls(loop, coalesceOpenAIToolCalls(chunks));
      } catch (err) {
        sdkLog("LL1001", err);
      }
    }
  }
  return gen();
}

export function wrapOpenAIClient<T extends { chat: { completions: { create: Function } } }>(
  loop: SdkHandle,
  client: T,
): T {
  try {
    if (Reflect.get(client, K_OPENAI_CREATE)) return client;
    const completions = client.chat.completions;
    const original = completions.create.bind(completions) as (...args: unknown[]) => unknown;
    Reflect.set(client, K_OPENAI_CREATE, original);

    completions.create = async function wrappedCreate(...args: unknown[]) {
      const params = (asRecord(args[0]) ?? {}) as OpenAICreateParams;
      const rest = args.slice(1);
      let nextParams: unknown = args[0];
      try {
        nextParams = await beforeOpenAIRequest(loop, params);
      } catch (err) {
        sdkLog("LL1001", err);
        nextParams = args[0];
      }

      const result = await original(nextParams, ...rest);

      try {
        if (params.stream === true && isAsyncIterable(result)) {
          return teeOpenAIStream(loop, result);
        }
        await afterOpenAIResponse(loop, result);
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
