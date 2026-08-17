import { canonicalJson, sha256Hex } from "./canonicalize.ts";
import type { OutcomeClass } from "./types.ts";

export type SignatureKind = "tool" | "plan" | "assistant";

export type ArgHashFromArgs = {
  arg_hash: string;
  arg_hash_source: "canonical" | "raw";
  bytes_hashed: number;
};

export type ResolvedArgHash = {
  arg_hash: string;
  arg_hash_source: "canonical" | "raw" | "axion_fingerprint";
  arg_hash_degraded?: boolean;
  bytes_hashed: number;
};

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

function parseJsonString(value: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(value) };
  } catch {
    return { ok: false };
  }
}

/** Collapse runs of whitespace to a single space and trim. */
export function normalizeWs(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export async function toolSignature(input: {
  tool_name: string;
  arg_hash: string;
  outcome_class: OutcomeClass | "unknown";
}): Promise<string> {
  const payload = {
    k: "tool" as const,
    n: clipName(input.tool_name),
    a: input.arg_hash,
    o: input.outcome_class,
  };
  return sha256Hex(canonicalJson(payload));
}

export function clipName(name: string): string {
  return name.slice(0, 128);
}

export async function argHashFromArgs(args: unknown): Promise<ArgHashFromArgs> {
  if (typeof args === "string") {
    const parsed = parseJsonString(args);
    if (!parsed.ok) {
      return {
        arg_hash: await sha256Hex(args),
        arg_hash_source: "raw",
        bytes_hashed: utf8Bytes(args),
      };
    }
    const canonical = canonicalJson(parsed.value);
    return {
      arg_hash: await sha256Hex(canonical),
      arg_hash_source: "canonical",
      bytes_hashed: utf8Bytes(canonical),
    };
  }

  const canonical = canonicalJson(args);
  return {
    arg_hash: await sha256Hex(canonical),
    arg_hash_source: "canonical",
    bytes_hashed: utf8Bytes(canonical),
  };
}

function hashedPayloadBytes(args: unknown): number {
  if (args === undefined) return 0;
  if (typeof args === "string") {
    const parsed = parseJsonString(args);
    if (!parsed.ok) return utf8Bytes(args);
    return utf8Bytes(canonicalJson(parsed.value));
  }
  return utf8Bytes(canonicalJson(args));
}

function canRecomputeCanonical(args: unknown): boolean {
  if (args === undefined) return false;
  if (typeof args === "string") return parseJsonString(args).ok;
  return true;
}

export async function resolveArgHash(input: {
  args?: unknown;
  argumentFingerprint?: string;
  argumentFingerprintSource?: "canonical" | "raw";
}): Promise<ResolvedArgHash> {
  const fingerprint = input.argumentFingerprint;
  const source = input.argumentFingerprintSource;

  if (fingerprint && source === "canonical") {
    return {
      arg_hash: fingerprint,
      arg_hash_source: "axion_fingerprint",
      bytes_hashed: hashedPayloadBytes(input.args),
    };
  }

  if (fingerprint && source === "raw") {
    if (canRecomputeCanonical(input.args)) {
      return argHashFromArgs(input.args);
    }
    return {
      arg_hash: fingerprint,
      arg_hash_source: "raw",
      arg_hash_degraded: true,
      bytes_hashed: hashedPayloadBytes(input.args),
    };
  }

  if (input.args !== undefined) {
    return argHashFromArgs(input.args);
  }

  return argHashFromArgs({});
}

/** MVP plan/assistant helper. Does not participate in detect. */
export async function textHash(text: string): Promise<string> {
  return sha256Hex(normalizeWs(text).slice(0, 4096));
}
