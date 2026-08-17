import { describe, expect, it } from "vitest";
import { DEFAULT_REDACT_KEYS, REDACTED, redact, redactRecord } from "./redact.ts";

describe("redact", () => {
  it("redacts nested api_key", () => {
    const out = redact({
      tool: "lookup",
      nested: { api_key: "live-secret", keep: 1 },
    });
    expect(out).toEqual({
      tool: "lookup",
      nested: { api_key: REDACTED, keep: 1 },
    });
  });

  it("redacts Authorization header", () => {
    const out = redact({
      headers: { Authorization: "Bearer abc", Accept: "application/json" },
    });
    expect(out).toEqual({
      headers: { Authorization: REDACTED, Accept: "application/json" },
    });
  });

  it("redacts authorization lowercase key", () => {
    const out = redact({ authorization: "secret-header" });
    expect(out).toEqual({ authorization: REDACTED });
  });

  it("redacts rawText", () => {
    const out = redact({ rawText: "full transcript", ok: true });
    expect(out).toEqual({ rawText: REDACTED, ok: true });
  });

  it("redacts extra_keys and leaves others", () => {
    const out = redact(
      { sessionCookie: "abc", ok: true, nested: { sessionCookie: "def" } },
      ["sessionCookie"],
    );
    expect(out).toEqual({
      sessionCookie: REDACTED,
      ok: true,
      nested: { sessionCookie: REDACTED },
    });
  });

  it("does not redact unrelated keys like token_count", () => {
    const out = redact({ token: "sekrit", token_count: 42, apiKeyFingerprint: "abc" });
    expect(out).toEqual({
      token: REDACTED,
      token_count: 42,
      apiKeyFingerprint: "abc",
    });
  });

  it("redacts default keys case-insensitively", () => {
    const out = redact({ TOKEN: "x", ApiKey: "y", API_KEY: "z", Password: "p" });
    expect(out).toEqual({
      TOKEN: REDACTED,
      ApiKey: REDACTED,
      API_KEY: REDACTED,
      Password: REDACTED,
    });
  });

  it("walks arrays", () => {
    const out = redact([{ secret: "a" }, { password: "b", n: 1 }]);
    expect(out).toEqual([{ secret: REDACTED }, { password: REDACTED, n: 1 }]);
  });

  it("clips arguments_excerpt to 200 after redact", () => {
    const out = redact({
      arguments_excerpt: "n".repeat(250),
      other: "keep",
    }) as Record<string, unknown>;
    expect(out.arguments_excerpt).toBe("n".repeat(200));
    expect(out.other).toBe("keep");
  });

  it("omits arguments_excerpt when the field is absent", () => {
    const out = redactRecord({ tool_name: "bash" });
    expect(out).toEqual({ tool_name: "bash" });
    expect("arguments_excerpt" in out).toBe(false);
  });

  it("never throws on circular objects", () => {
    const cyclic: Record<string, unknown> = { api_key: "x", keep: 1 };
    cyclic.self = cyclic;
    expect(() => redact(cyclic)).not.toThrow();
    const out = redact(cyclic) as Record<string, unknown>;
    expect(out.api_key).toBe(REDACTED);
    expect(out.keep).toBe(1);
    expect(out.self).toBe(REDACTED);
  });

  it("never throws on invalid extraKeys", () => {
    expect(() => redact({ a: 1 }, undefined)).not.toThrow();
    expect(redact({ a: 1 }, "nope" as unknown as string[])).toEqual({ a: 1 });
  });

  it("lists the D15 default keys", () => {
    expect([...DEFAULT_REDACT_KEYS]).toEqual([
      "authorization",
      "Authorization",
      "apiKey",
      "api_key",
      "token",
      "secret",
      "password",
      "rawText",
    ]);
  });
});

describe("redactRecord", () => {
  it("returns a record with nested secrets replaced", () => {
    const out = redactRecord({
      headers: { authorization: "Bearer x" },
      count: 3,
    });
    expect(out).toEqual({
      headers: { authorization: REDACTED },
      count: 3,
    });
  });
});
