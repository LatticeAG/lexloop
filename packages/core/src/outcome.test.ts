import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "./canonicalize.ts";
import { classifyOutcome, normalizeOutcomeText } from "./outcome.ts";

interface OutcomeConformanceRow {
  id: string;
  error?: string;
  result?: unknown;
  http_status?: number;
  empty_as_error?: boolean;
  expect_class: string;
  expect_hash_is_class: boolean;
}

const CONFORMANCE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../conformance/outcome",
);

function loadRows(): OutcomeConformanceRow[] {
  const files = readdirSync(CONFORMANCE_DIR)
    .filter((name) => name.endsWith(".json"))
    .sort();
  const rows: OutcomeConformanceRow[] = [];
  for (const file of files) {
    const parsed: unknown = JSON.parse(readFileSync(join(CONFORMANCE_DIR, file), "utf8"));
    if (Array.isArray(parsed)) {
      for (const row of parsed) rows.push(row as OutcomeConformanceRow);
    } else {
      rows.push(parsed as OutcomeConformanceRow);
    }
  }
  return rows;
}

const rows = loadRows();

describe("conformance/outcome", () => {
  it("loads every json row", () => {
    expect(rows.length).toBeGreaterThan(0);
    const ids = new Set(rows.map((row) => row.id));
    for (const required of [
      "ok_true_payload",
      "empty_list_default_ok",
      "empty_list_as_error",
      "enoent",
      "http_404",
      "eacces",
      "http_403",
      "http_401",
      "timeout_fetch_abort",
      "etimedout",
      "http_429",
      "syntax_error",
      "http_400",
      "http_422",
      "zod_fail",
      "econnrefused",
      "dns",
      "http_502",
      "http_409_no_body",
      "err_other_unique",
      "timestamped_stderr_a",
      "timestamped_stderr_b",
      "http_200_error_payload_not_found",
    ]) {
      expect(ids.has(required)).toBe(true);
    }
  });

  it.each(rows)("$id -> $expect_class", async (row) => {
    const got = await classifyOutcome({
      error: row.error,
      result: row.result,
      http_status: row.http_status,
      empty_as_error: row.empty_as_error,
    });
    expect(got.outcome_class).toBe(row.expect_class);
    if (row.expect_hash_is_class) {
      expect(got.outcome_hash).toBe(row.expect_class);
    } else {
      const raw = row.error ?? stringifyForHash(row.result);
      const expectedHash = await sha256Hex(normalizeOutcomeText(raw).slice(0, 80));
      expect(got.outcome_hash).toBe(expectedHash);
      expect(got.outcome_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(got.outcome_hash).not.toBe(row.expect_class);
    }
  });
});

describe("classifyOutcome", () => {
  it("timestamped stderr collapses to the same class and hash", async () => {
    const a = await classifyOutcome({ error: "fail at 12:01:00" });
    const b = await classifyOutcome({ error: "fail at 12:01:01" });
    expect(a.outcome_class).toBe("err_other");
    expect(b.outcome_class).toBe("err_other");
    expect(a.outcome_class).toBe(b.outcome_class);
    expect(a.outcome_hash).toBe(b.outcome_hash);
  });

  it("ISO-timestamped stderr shares err_other hash after digit collapse", async () => {
    const a = await classifyOutcome({ error: "fail at 2024-01-15T12:01:00Z" });
    const b = await classifyOutcome({ error: "fail at 2024-01-15T12:01:01Z" });
    expect(a.outcome_class).toBe("err_other");
    expect(a.outcome_hash).toBe(b.outcome_hash);
  });

  it("named timeout classes share the class string as hash", async () => {
    const a = await classifyOutcome({ error: "deadline exceeded" });
    const b = await classifyOutcome({ error: "request timed out" });
    expect(a.outcome_class).toBe("err_timeout");
    expect(b.outcome_class).toBe("err_timeout");
    expect(a.outcome_hash).toBe("err_timeout");
    expect(b.outcome_hash).toBe("err_timeout");
  });

  it("never throws on circular result", async () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;
    const got = await classifyOutcome({ result: circular });
    expect(got.outcome_class).toBeDefined();
    expect(got.outcome_hash).toBeDefined();
  });
});

describe("normalizeOutcomeText", () => {
  it("lowercases and collapses whitespace", () => {
    expect(normalizeOutcomeText("  ENOENT\nNo  Such   FILE  ")).toBe("enoent no such file");
  });

  it("replaces digits in UUIDs and ULIDs", () => {
    const uuid = normalizeOutcomeText("id 550e8400-e29b-41d4-a716-446655440000");
    expect(uuid).toBe("id ###e####-e##b-##d#-a###-############");
    const ulid = normalizeOutcomeText("run 01ARZ3NDEKTSV4RRFFQ69G5FAV");
    expect(ulid).toBe("run ##arz#ndektsv#rrffq##g#fav");
  });
});

function stringifyForHash(result: unknown): string {
  if (typeof result === "string") return result;
  if (result === undefined) return "";
  try {
    return JSON.stringify(result) ?? "";
  } catch {
    return String(result);
  }
}
