import type { LatticeExtensionEnvelope, LatticeExtensionName, LexLoopEvent } from "./types.ts";

export const MAX_ENVELOPE_BYTES = 262144;

/** D15 key list. Value redaction lives in core/src/redact.ts. */
export const DEFAULT_REDACT_KEYS = [
  "authorization",
  "Authorization",
  "apiKey",
  "api_key",
  "token",
  "secret",
  "password",
  "rawText",
] as const;

const DROP_ORDER = ["excerpts", "tried_signatures", "untried_tools"] as const;
const PROTECTED_KEYS = new Set(["v", "loop_id", "cluster_id", "class", "rule_id"]);

const ADAPTER_VERSION = "0.1.0";

export type ToLatticeExtensionOptions = {
  /** Lattice bus seq when assigned; otherwise native seq. */
  seq?: number;
  causation_id?: string;
  extra_keys?: readonly string[];
};

type InnerPayload = { v: "lexloop/v1" } & Record<string, unknown>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function dropPayloadField(payload: Record<string, unknown>, key: string): void {
  if (PROTECTED_KEYS.has(key)) return;
  if (Object.prototype.hasOwnProperty.call(payload, key)) {
    delete payload[key];
  }
  for (const nested of Object.values(payload)) {
    if (!isPlainObject(nested)) continue;
    if (PROTECTED_KEYS.has(key)) continue;
    if (Object.prototype.hasOwnProperty.call(nested, key)) {
      delete nested[key];
    }
  }
}

function fitEnvelope(envelope: LatticeExtensionEnvelope): LatticeExtensionEnvelope {
  if (JSON.stringify(envelope).length <= MAX_ENVELOPE_BYTES) {
    return envelope;
  }
  const inner = envelope.payload.payload;
  for (const key of DROP_ORDER) {
    dropPayloadField(inner, key);
    if (JSON.stringify(envelope).length <= MAX_ENVELOPE_BYTES) {
      return envelope;
    }
  }
  return envelope;
}

export function toLatticeExtension(
  native: LexLoopEvent,
  opts?: ToLatticeExtensionOptions,
): LatticeExtensionEnvelope {
  const keys: string[] = [...DEFAULT_REDACT_KEYS];
  const seen = new Set<string>(keys);
  for (const key of opts?.extra_keys ?? []) {
    if (seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }

  const cloned = structuredClone(native.payload) as unknown as Record<string, unknown>;
  const innerPayload: InnerPayload = { ...cloned, v: "lexloop/v1" };

  const envelope: LatticeExtensionEnvelope = {
    $schema: "latticeag.events/1.0",
    schema_version: 1,
    id: native.id,
    seq: opts?.seq ?? native.seq,
    ts: native.ts,
    run_id: native.run_id,
    session_id: native.session_id,
    producer: {
      product: "latticeag",
      adapter: "@latticeag/lexloop",
      adapter_version: ADAPTER_VERSION,
    },
    correlation_id: native.run_id,
    redaction: {
      applied: true,
      keys,
      pattern_hits: 0,
    },
    name: "extension",
    payload: {
      extension_name: `lexloop.${native.name}` as LatticeExtensionName,
      payload: innerPayload,
    },
  };

  if (opts?.causation_id !== undefined && opts.causation_id !== "") {
    envelope.causation_id = opts.causation_id;
  }

  return fitEnvelope(envelope);
}
