import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  latticeExtensionEnvelopeSchema,
  lexLoopEventSchema,
} from "../src/schema.ts";
import {
  DEFAULT_REDACT_KEYS,
  MAX_ENVELOPE_BYTES,
  toLatticeExtension,
} from "../src/toLattice.ts";
import type { LexLoopEvent, LexLoopEventName } from "../src/types.ts";

const EXTENSION_NAME_RE = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;
const EXPECTED_NAMES: LexLoopEventName[] = [
  "loop_detected",
  "loop_classified",
  "intervention_injected",
  "loop_escalated",
  "budget_skipped",
  "run_summary",
];

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../fixtures");

function loadFixtures(): LexLoopEvent[] {
  const files = readdirSync(fixturesDir)
    .filter((name) => name.endsWith(".json"))
    .sort();
  return files.map((name) => {
    const raw = readFileSync(path.join(fixturesDir, name), "utf8");
    return JSON.parse(raw) as LexLoopEvent;
  });
}

async function tryLoadParseEnvelope(): Promise<((input: unknown) => unknown) | null> {
  const candidates = [
    "@latticeag/events",
    "/home/ubuntu/latticeag-cli/packages/events/dist/index.js",
    pathToFileURL("/home/ubuntu/latticeag-cli/packages/events/dist/index.js").href,
  ];
  for (const spec of candidates) {
    try {
      const mod = (await import(spec)) as { parseEnvelope?: (input: unknown) => unknown };
      if (typeof mod.parseEnvelope === "function") {
        return mod.parseEnvelope;
      }
    } catch {
      // not installed in this workspace
    }
  }
  return null;
}

describe("events schema compat", () => {
  const fixtures = loadFixtures();

  it("has one fixture per native event name", () => {
    const names = fixtures.map((ev) => ev.name).sort();
    expect(names).toEqual([...EXPECTED_NAMES].sort());
  });

  it("every fixture roundtrips through lexLoopEventSchema", () => {
    expect(fixtures.length).toBeGreaterThan(0);
    for (const fixture of fixtures) {
      const parsed = lexLoopEventSchema.parse(fixture);
      const roundtrip = lexLoopEventSchema.parse(JSON.parse(JSON.stringify(parsed)));
      expect(roundtrip).toEqual(parsed);
      expect(parsed.v).toBe("lexloop/v1");
      expect(parsed.payload.v).toBe("lexloop/v1");
    }
  });

  it("toLatticeExtension envelopes parse, stay under the byte cap, and use lexloop.<name>", () => {
    for (const fixture of fixtures) {
      const envelope = toLatticeExtension(fixture);
      const parsed = latticeExtensionEnvelopeSchema.parse(envelope);
      const serialized = JSON.stringify(parsed);
      expect(serialized.length).toBeLessThanOrEqual(MAX_ENVELOPE_BYTES);
      expect(parsed.payload.payload.v).toBe("lexloop/v1");
      expect(parsed.payload.extension_name).toBe(`lexloop.${fixture.name}`);
      expect(parsed.payload.extension_name).toMatch(EXTENSION_NAME_RE);
      expect(parsed.id).toBe(fixture.id);
      expect(parsed.seq).toBe(fixture.seq);
      expect(parsed.correlation_id).toBe(fixture.run_id);
      expect(parsed.producer).toEqual({
        product: "latticeag",
        adapter: "@latticeag/lexloop",
        adapter_version: "0.1.0",
      });
      expect(parsed.redaction.applied).toBe(true);
      expect(parsed.redaction.keys).toEqual([...DEFAULT_REDACT_KEYS]);
      expect(parsed.redaction.pattern_hits).toBe(0);
    }
  });

  it("drops excerpts, tried_signatures, and untried_tools when the envelope would exceed 262144 bytes", () => {
    const base = fixtures.find((ev) => ev.name === "loop_detected");
    expect(base).toBeDefined();
    const oversized = {
      ...base,
      payload: {
        ...base!.payload,
        excerpts: ["e".repeat(2_000)],
        tried_signatures: ["t".repeat(2_000)],
        untried_tools: ["u".repeat(270_000)],
        loop_id: (base!.payload as { loop_id: string }).loop_id,
        cluster_id: (base!.payload as { cluster_id: string }).cluster_id,
      },
    } as LexLoopEvent;

    expect(JSON.stringify(oversized).length).toBeGreaterThan(MAX_ENVELOPE_BYTES);

    const envelope = toLatticeExtension(oversized);
    const inner = envelope.payload.payload;
    expect(inner.excerpts).toBeUndefined();
    expect(inner.tried_signatures).toBeUndefined();
    expect(inner.untried_tools).toBeUndefined();
    expect(inner.v).toBe("lexloop/v1");
    expect(inner.loop_id).toBe((base!.payload as { loop_id: string }).loop_id);
    expect(inner.cluster_id).toBe((base!.payload as { cluster_id: string }).cluster_id);
    expect(JSON.stringify(envelope).length).toBeLessThanOrEqual(MAX_ENVELOPE_BYTES);
    latticeExtensionEnvelopeSchema.parse(envelope);
  });

  it("drops nested delta.untried_tools on oversize intervention envelopes", () => {
    const base = fixtures.find((ev) => ev.name === "intervention_injected");
    expect(base).toBeDefined();
    const huge = "tool_" + "a".repeat(270_000);
    const payload = structuredClone(base!.payload) as Record<string, unknown> & {
      delta: { untried_tools: string[]; tried_tools: string[] };
    };
    payload.excerpts = ["x".repeat(1000)];
    payload.tried_signatures = ["y".repeat(1000)];
    payload.delta = {
      ...payload.delta,
      untried_tools: [huge],
    };
    const oversized = { ...base!, payload } as LexLoopEvent;
    const envelope = toLatticeExtension(oversized);
    const inner = envelope.payload.payload;
    expect(inner.excerpts).toBeUndefined();
    expect(inner.tried_signatures).toBeUndefined();
    expect(inner.untried_tools).toBeUndefined();
    const delta = inner.delta as { untried_tools?: string[]; tried_tools: string[] };
    expect(delta.untried_tools).toBeUndefined();
    expect(delta.tried_tools).toEqual(
      (base!.payload as { delta: { tried_tools: string[] } }).delta.tried_tools,
    );
    expect(inner.v).toBe("lexloop/v1");
    expect(inner.loop_id).toBe((base!.payload as { loop_id: string }).loop_id);
    expect(JSON.stringify(envelope).length).toBeLessThanOrEqual(MAX_ENVELOPE_BYTES);
  });

  it("parseEnvelope accepts envelopes when @latticeag/events is available", async () => {
    const parseEnvelope = await tryLoadParseEnvelope();
    if (!parseEnvelope) {
      return;
    }
    for (const fixture of fixtures) {
      const envelope = toLatticeExtension(fixture);
      expect(() => parseEnvelope(envelope)).not.toThrow();
    }
  });
});
