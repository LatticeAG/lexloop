/** packages/core/src/redact.ts */

export const REDACTED = "[REDACTED]";

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

const DEFAULT_KEYS_LOWER = new Set<string>(
  DEFAULT_REDACT_KEYS.map((key) => key.toLowerCase()),
);

const ARGUMENTS_EXCERPT_MAX = 200;

function extraKeySet(extraKeys?: string[]): Set<string> | null {
  if (!extraKeys || !Array.isArray(extraKeys) || extraKeys.length === 0) return null;
  const set = new Set<string>();
  for (const key of extraKeys) {
    if (typeof key !== "string" || key === "") continue;
    set.add(key);
    set.add(key.toLowerCase());
  }
  return set.size === 0 ? null : set;
}

function shouldRedactKey(key: string, extra: Set<string> | null): boolean {
  if (DEFAULT_KEYS_LOWER.has(key.toLowerCase())) return true;
  if (!extra) return false;
  return extra.has(key) || extra.has(key.toLowerCase());
}

function clipExcerpt(key: string, value: unknown): unknown {
  if (key !== "arguments_excerpt") return value;
  if (typeof value !== "string") return value;
  if (value.length <= ARGUMENTS_EXCERPT_MAX) return value;
  return value.slice(0, ARGUMENTS_EXCERPT_MAX);
}

function redactInner(
  value: unknown,
  extra: Set<string> | null,
  seen: WeakSet<object>,
): unknown {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return REDACTED;
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redactInner(item, extra, seen));
  }

  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(record)) {
    if (shouldRedactKey(key, extra)) {
      out[key] = REDACTED;
      continue;
    }
    out[key] = clipExcerpt(key, redactInner(record[key], extra, seen));
  }
  return out;
}

export function redact(value: unknown, extraKeys?: string[]): unknown {
  try {
    return redactInner(value, extraKeySet(extraKeys), new WeakSet<object>());
  } catch {
    return REDACTED;
  }
}

export function redactRecord(
  obj: Record<string, unknown>,
  extraKeys?: string[],
): Record<string, unknown> {
  try {
    const next = redact(obj, extraKeys);
    if (next !== null && typeof next === "object" && !Array.isArray(next)) {
      return next as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}
