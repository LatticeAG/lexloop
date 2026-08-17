import { createHash } from "node:crypto";
import { ulid } from "ulid";

/** Crockford base32 ULID, 26 chars. */
export const ULID_RE = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/i;
export const RUN_ID_RE = /^run_[0-7][0-9A-HJKMNP-TV-Z]{25}$/i;
export const SESSION_ID_RE = /^ses_[0-7][0-9A-HJKMNP-TV-Z]{25}$/i;
export const LOOP_ID_RE = /^loop_[0-9a-f]{26}$/;
export const CLUSTER_ID_RE = /^clus_[0-9a-f]{16}$/;
export const INTERVENTION_ID_RE = /^llint_[0-7][0-9A-HJKMNP-TV-Z]{25}$/i;

function sha256HexSync(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export function newRunId(): string {
  return `run_${ulid()}`;
}

export function newSessionId(): string {
  return `ses_${ulid()}`;
}

export function newInterventionId(): string {
  return `llint_${ulid()}`;
}

export function newEnvelopeId(): string {
  return ulid();
}

export function resolveRunId(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.LATTICEAG_RUN_ID;
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  return newRunId();
}

export function resolveSessionId(input?: {
  header?: string;
  env?: NodeJS.ProcessEnv;
}): string {
  const header = input?.header?.trim();
  if (header) return header;
  const env = input?.env ?? process.env;
  const fromEnv = env.LATTICEAG_SESSION_ID;
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  return newSessionId();
}

export function clusterId(signatures: string[]): string {
  const uniqueSorted = [...new Set(signatures)].sort();
  return `clus_${sha256HexSync(uniqueSorted.join("|")).slice(0, 16)}`;
}

export function loopId(runId: string, clusterIdValue: string, firstSeq: number): string {
  return `loop_${sha256HexSync(`${runId}|${clusterIdValue}|${firstSeq}`).slice(0, 26)}`;
}
