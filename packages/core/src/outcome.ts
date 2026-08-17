import { sha256Hex } from "./canonicalize.ts";
import type { OutcomeClass } from "./types.ts";

export type { OutcomeClass };

const NAMED_ERROR_PATTERNS: ReadonlyArray<
  readonly [Exclude<OutcomeClass, "ok" | "err_empty" | "err_other">, RegExp]
> = [
  ["err_not_found", /\b(not found|404|enoent|no such file|unknown (tool|command|id))\b/],
  ["err_permission", /\b(eacces|eperm|403|401|permission denied|not authorized|forbidden)\b/],
  ["err_timeout", /\b(timeout|timed out|etimedout|deadline exceeded)\b/],
  ["err_rate_limit", /\b(rate limit|429|too many requests|quota exceeded)\b/],
  ["err_invalid", /\b(invalid|syntax error|parse error|400|422|zod|json schema)\b/],
  ["err_network", /\b(econnrefused|enotfound|dns|eai_again|network|502|503|504)\b/],
  ["err_conflict", /\b(conflict|409|already exists|eexist)\b/],
];

const ISO_TIMESTAMP_RE =
  /\d{4}-\d{2}-\d{2}(?:[t ]\d{2}:\d{2}:\d{2}(?:\.\d+)?)?(?:z|[+-]\d{2}:?\d{2})?/g;
const CLOCK_TIME_RE = /\b\d{1,2}:\d{2}:\d{2}(?:\.\d+)?\b/g;
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g;
const ULID_RE = /[0-7][0-9a-hjkmnp-tv-z]{25}/g;

export function normalizeOutcomeText(errorOrResult: string): string {
  const utf8 = new TextDecoder("utf-8").decode(new TextEncoder().encode(errorOrResult));
  let s = utf8.toLowerCase().replace(/\s+/g, " ").trim();
  ISO_TIMESTAMP_RE.lastIndex = 0;
  CLOCK_TIME_RE.lastIndex = 0;
  UUID_RE.lastIndex = 0;
  ULID_RE.lastIndex = 0;
  s = s.replace(ISO_TIMESTAMP_RE, replaceDigits);
  s = s.replace(CLOCK_TIME_RE, replaceDigits);
  s = s.replace(UUID_RE, replaceDigits);
  s = s.replace(ULID_RE, replaceDigits);
  return s;
}

export async function classifyOutcome(input: {
  error?: string;
  result?: unknown;
  http_status?: number;
  empty_as_error?: boolean;
}): Promise<{ outcome_class: OutcomeClass; outcome_hash: string }> {
  try {
    const emptyAsError = input.empty_as_error === true;
    const status = extractHttpStatus(input);
    const is2xx = status !== undefined && status >= 200 && status < 300;
    const statusClass = status !== undefined ? mapHttpStatus(status) : undefined;

    const errorText = typeof input.error === "string" ? input.error : undefined;
    const hasErrorChannel = Boolean(errorText && errorText.trim() !== "");
    const rawText = hasErrorChannel ? errorText! : stringifyResult(input.result);
    const normalized = normalizeOutcomeText(rawText);
    const regexClass = matchNamedError(normalized);
    const okFalse = isOkFlag(input.result, false);

    let outcome_class: OutcomeClass;

    if (is2xx) {
      if (regexClass) {
        outcome_class = regexClass;
      } else if (hasErrorChannel) {
        outcome_class = "err_other";
      } else {
        outcome_class = okPathClass(input.result, emptyAsError);
      }
    } else if (statusClass) {
      outcome_class = statusClass;
    } else if (regexClass) {
      outcome_class = regexClass;
    } else if (hasErrorChannel || okFalse || (status !== undefined && !is2xx)) {
      outcome_class = "err_other";
    } else {
      outcome_class = okPathClass(input.result, emptyAsError);
    }

    return hashForClass(outcome_class, normalized);
  } catch {
    return hashForClass("err_other", "");
  }
}

function replaceDigits(match: string): string {
  return match.replace(/\d/g, "#");
}

function extractHttpStatus(input: {
  http_status?: number;
  result?: unknown;
}): number | undefined {
  if (isHttpCode(input.http_status)) return input.http_status;
  const result = input.result;
  if (result === null || typeof result !== "object" || Array.isArray(result)) return undefined;
  const record = result as Record<string, unknown>;
  for (const key of ["status", "status_code", "httpStatus"] as const) {
    const value = record[key];
    if (isHttpCode(value)) return value;
  }
  return undefined;
}

function isHttpCode(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function mapHttpStatus(status: number): Exclude<OutcomeClass, "err_empty" | "err_other"> | undefined {
  if (status >= 200 && status < 300) return "ok";
  switch (status) {
    case 401:
    case 403:
      return "err_permission";
    case 404:
      return "err_not_found";
    case 409:
      return "err_conflict";
    case 429:
      return "err_rate_limit";
    case 400:
    case 422:
      return "err_invalid";
    case 408:
      return "err_timeout";
    case 502:
    case 503:
    case 504:
      return "err_network";
    default:
      return undefined;
  }
}

function matchNamedError(
  normalized: string,
): Exclude<OutcomeClass, "ok" | "err_empty" | "err_other"> | undefined {
  for (const [cls, re] of NAMED_ERROR_PATTERNS) {
    if (re.test(normalized)) return cls;
  }
  return undefined;
}

function stringifyResult(result: unknown): string {
  if (typeof result === "string") return result;
  if (result === undefined) return "";
  try {
    const json = JSON.stringify(result);
    return json ?? "";
  } catch {
    try {
      return String(result);
    } catch {
      return "";
    }
  }
}

function isOkFlag(result: unknown, expected: boolean): boolean {
  if (result === null || typeof result !== "object" || Array.isArray(result)) return false;
  return (result as { ok?: unknown }).ok === expected;
}

function isEmptyResult(result: unknown): boolean {
  if (typeof result === "string") return result.trim() === "";
  if (Array.isArray(result)) return result.length === 0;
  if (result === null || typeof result !== "object") return false;
  const obj = result as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length === 0) return true;
  const withoutOk = keys.filter((key) => !(key === "ok" && obj.ok === true));
  if (withoutOk.length === 1 && withoutOk[0] === "items") {
    return Array.isArray(obj.items) && obj.items.length === 0;
  }
  return false;
}

function okPathClass(result: unknown, emptyAsError: boolean): OutcomeClass {
  if (emptyAsError && isEmptyResult(result)) return "err_empty";
  return "ok";
}

async function hashForClass(
  outcome_class: OutcomeClass,
  normalized: string,
): Promise<{ outcome_class: OutcomeClass; outcome_hash: string }> {
  if (outcome_class === "err_other") {
    return { outcome_class, outcome_hash: await sha256Hex(normalized.slice(0, 80)) };
  }
  return { outcome_class, outcome_hash: outcome_class };
}
