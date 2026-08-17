import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { canonicalJson, sha256Hex } from "./canonicalize.ts";

type ParityCase = {
  id: string;
  input: unknown;
  canonical_json: string;
  sha256: string;
  mode?: "raw";
};

const vectors = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../../../conformance/canonicalize/axion-parity.json"),
    "utf8",
  ),
) as ParityCase[];

describe("canonicalize axion-parity", () => {
  it("loads every frozen vector", () => {
    expect(vectors.length).toBeGreaterThan(0);
    const ids = vectors.map((row) => row.id);
    expect(ids).toContain("axion-lookup");
    expect(ids).toContain("axion-malformed-raw");
  });

  it.each(vectors)("$id", async (row) => {
    if (row.mode === "raw") {
      expect(typeof row.input).toBe("string");
      expect(await sha256Hex(row.input as string)).toBe(row.sha256);
      return;
    }
    expect(canonicalJson(row.input)).toBe(row.canonical_json);
    expect(await sha256Hex(row.canonical_json)).toBe(row.sha256);
  });

  it("key reorder shares canonical_json and sha256", () => {
    const ba = vectors.find((row) => row.id === "key-reorder-ba");
    const ab = vectors.find((row) => row.id === "key-reorder-ab");
    expect(ba).toBeDefined();
    expect(ab).toBeDefined();
    expect(canonicalJson(ba!.input)).toBe(canonicalJson(ab!.input));
    expect(ba!.canonical_json).toBe(ab!.canonical_json);
    expect(ba!.sha256).toBe(ab!.sha256);
  });

  it("arrays keep order", () => {
    expect(canonicalJson([2, 1])).toBe("[2,1]");
    expect(canonicalJson([2, 1])).not.toBe("[1,2]");
  });
});
