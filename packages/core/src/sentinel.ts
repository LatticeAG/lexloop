/** packages/core/src/sentinel.ts */

export type SentinelLevel = "soft" | "hard" | "human";

export interface SentinelMatch {
  intervention_id: string;
  level: SentinelLevel;
}

/** Injected text starts with `[lexloop intervention id=llint_<ULID> level=<soft|hard|human>]`. */
export const SENTINEL_RE =
  /^\[lexloop intervention id=(llint_[0-7][0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{25}) level=(soft|hard|human)\]/;

export function matchSentinel(text: string): SentinelMatch | null {
  const m = SENTINEL_RE.exec(text);
  if (!m) return null;
  const intervention_id = m[1];
  const level = m[2];
  if (!intervention_id || !level) return null;
  if (level !== "soft" && level !== "hard" && level !== "human") return null;
  return { intervention_id, level };
}

export function isSentinelText(text: string): boolean {
  return matchSentinel(text) !== null;
}
