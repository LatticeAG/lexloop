import { describe, expect, it } from "vitest";
import { sha256Hex } from "./canonicalize.ts";
import {
  argHashFromArgs,
  clipName,
  resolveArgHash,
  textHash,
  toolSignature,
} from "./signature.ts";

const HEX64 = /^[0-9a-f]{64}$/;

describe("toolSignature", () => {
  it("is equal when arg hashes come from reordered object keys", async () => {
    const a = await argHashFromArgs({ b: 1, a: 2 });
    const b = await argHashFromArgs({ a: 2, b: 1 });
    expect(a.arg_hash).toBe(b.arg_hash);
    expect(a.arg_hash_source).toBe("canonical");
    expect(b.arg_hash_source).toBe("canonical");

    const sigA = await toolSignature({
      tool_name: "lookup",
      arg_hash: a.arg_hash,
      outcome_class: "ok",
    });
    const sigB = await toolSignature({
      tool_name: "lookup",
      arg_hash: b.arg_hash,
      outcome_class: "ok",
    });
    expect(sigA).toBe(sigB);
    expect(sigA).toMatch(HEX64);
  });

  it("clipName truncates to 128 chars", () => {
    const exact = "n".repeat(128);
    const over = "n".repeat(200);
    expect(clipName(exact)).toHaveLength(128);
    expect(clipName(over)).toHaveLength(128);
    expect(clipName(over)).toBe(exact);
    expect(clipName("short")).toBe("short");
  });

  it("allows unknown outcome_class", async () => {
    const { arg_hash } = await argHashFromArgs({ n: 1, q: "trace" });
    const sig = await toolSignature({
      tool_name: "lookup",
      arg_hash,
      outcome_class: "unknown",
    });
    expect(sig).toMatch(HEX64);
  });

  it("returns 64 lowercase hex chars", async () => {
    const { arg_hash } = await argHashFromArgs({ q: "trace" });
    const sig = await toolSignature({
      tool_name: "lookup",
      arg_hash,
      outcome_class: "ok",
    });
    expect(sig).toHaveLength(64);
    expect(sig).toMatch(HEX64);
    expect(sig).toBe(sig.toLowerCase());
  });
});

describe("argHashFromArgs", () => {
  it("hashes JSON objects via canonicalJson", async () => {
    const hashed = await argHashFromArgs({ b: 2, a: 1 });
    expect(hashed.arg_hash_source).toBe("canonical");
    expect(hashed.arg_hash).toMatch(HEX64);
    expect(hashed.bytes_hashed).toBe(new TextEncoder().encode('{"a":1,"b":2}').byteLength);
  });

  it("parses JSON strings before hashing", async () => {
    const fromObject = await argHashFromArgs({ n: 1, q: "trace" });
    const fromString = await argHashFromArgs('{"q":"trace","n":1}');
    expect(fromString.arg_hash_source).toBe("canonical");
    expect(fromString.arg_hash).toBe(fromObject.arg_hash);
  });

  it("hashes non-JSON strings as raw", async () => {
    const hashed = await argHashFromArgs("{not-json");
    expect(hashed.arg_hash_source).toBe("raw");
    expect(hashed.arg_hash).toBe(await sha256Hex("{not-json"));
    expect(hashed.bytes_hashed).toBe(new TextEncoder().encode("{not-json").byteLength);
  });
});

describe("resolveArgHash", () => {
  it("reuses a canonical Axion fingerprint without rehashing", async () => {
    const fingerprint = "aa".repeat(32);
    const resolved = await resolveArgHash({
      args: { n: 1, q: "trace" },
      argumentFingerprint: fingerprint,
      argumentFingerprintSource: "canonical",
    });
    expect(resolved.arg_hash).toBe(fingerprint);
    expect(resolved.arg_hash_source).toBe("axion_fingerprint");
    expect(resolved.arg_hash_degraded).toBeUndefined();
  });

  it("recomputes from parsed args when the fingerprint source is raw", async () => {
    const canonical = await argHashFromArgs({ n: 1, q: "trace" });
    const resolved = await resolveArgHash({
      args: '{"q":"trace","n":1}',
      argumentFingerprint: "deadbeef",
      argumentFingerprintSource: "raw",
    });
    expect(resolved.arg_hash).toBe(canonical.arg_hash);
    expect(resolved.arg_hash_source).toBe("canonical");
    expect(resolved.arg_hash_degraded).toBeUndefined();
  });

  it("keeps a raw fingerprint and marks degraded when args cannot be parsed", async () => {
    const fingerprint = "bb".repeat(32);
    const resolved = await resolveArgHash({
      args: "{not-json",
      argumentFingerprint: fingerprint,
      argumentFingerprintSource: "raw",
    });
    expect(resolved.arg_hash).toBe(fingerprint);
    expect(resolved.arg_hash_source).toBe("raw");
    expect(resolved.arg_hash_degraded).toBe(true);
  });
});

describe("textHash", () => {
  it("collapses whitespace before hashing", async () => {
    const a = await textHash("hello   world");
    const b = await textHash("hello world");
    expect(a).toBe(b);
    expect(a).toMatch(HEX64);
  });
});
