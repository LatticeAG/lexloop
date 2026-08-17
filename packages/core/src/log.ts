/** packages/core/src/log.ts */

import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { redact } from "./redact.ts";

export const DEFAULT_LOG_PATH = ".lexloop/events.jsonl";
export const DEFAULT_MAX_BYTES = 67_108_864;

export type NativeLexLoopEvent = {
  v: "lexloop/v1";
  id: string;
  ts: string;
  run_id: string;
  session_id: string;
  seq: number;
  name:
    | "loop_detected"
    | "loop_classified"
    | "intervention_injected"
    | "loop_escalated"
    | "budget_skipped"
    | "run_summary";
  payload: Record<string, unknown>;
};

export type EventLogOpts = {
  path: string;
  max_bytes: number;
  persist_fail: "log" | "throw";
  extraKeys?: string[];
  onRotate?: (code: "LL5001") => void;
  onAfterAppend?: (event: NativeLexLoopEvent) => void | Promise<void>;
};

function isEnoent(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === "ENOENT"
  );
}

function failMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class EventLog {
  readonly path: string;
  readonly max_bytes: number;
  readonly persist_fail: "log" | "throw";
  readonly extraKeys?: string[];
  readonly onRotate?: (code: "LL5001") => void;
  readonly onAfterAppend?: (event: NativeLexLoopEvent) => void | Promise<void>;

  #queue: Promise<void> = Promise.resolve();
  #rotateSeq = 0;

  constructor(opts: EventLogOpts) {
    this.path = opts.path;
    this.max_bytes = opts.max_bytes;
    this.persist_fail = opts.persist_fail;
    this.extraKeys = opts.extraKeys;
    this.onRotate = opts.onRotate;
    this.onAfterAppend = opts.onAfterAppend;
  }

  async append(event: NativeLexLoopEvent): Promise<void> {
    const run = this.#queue.then(() => this.#appendUnlocked(event));
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async close(): Promise<void> {
    await this.#queue;
  }

  async #appendUnlocked(event: NativeLexLoopEvent): Promise<void> {
    let persisted: NativeLexLoopEvent | undefined;
    try {
      persisted = redact(event, this.extraKeys) as NativeLexLoopEvent;
      const line = `${JSON.stringify(persisted)}\n`;
      const lineBytes = Buffer.byteLength(line, "utf8");
      await mkdir(dirname(this.path), { recursive: true });
      await this.#rotateIfNeeded(lineBytes);
      await appendFile(this.path, line, "utf8");
    } catch (err) {
      this.#persistFail(err);
      return;
    }

    if (!this.onAfterAppend || persisted === undefined) return;
    try {
      await this.onAfterAppend(persisted);
    } catch (err) {
      this.#persistFail(err);
    }
  }

  async #rotateIfNeeded(lineBytes: number): Promise<void> {
    let size = 0;
    try {
      size = (await stat(this.path)).size;
    } catch (err) {
      if (isEnoent(err)) return;
      throw err;
    }
    if (size === 0) return;
    if (size + lineBytes <= this.max_bytes) return;

    this.#rotateSeq += 1;
    const utc = new Date().toISOString();
    let archive = `${this.path}.${utc}`;
    try {
      await stat(archive);
      archive = `${this.path}.${utc}.${this.#rotateSeq}`;
    } catch (err) {
      if (!isEnoent(err)) throw err;
    }
    await rename(this.path, archive);
    this.#emitRotate();
  }

  #emitRotate(): void {
    try {
      this.onRotate?.("LL5001");
    } catch (err) {
      this.#persistFail(err);
    }
  }

  #persistFail(err: unknown): void {
    console.error(`[lexloop] persist_fail ${failMessage(err)}`);
    if (this.persist_fail === "throw") {
      throw err instanceof Error ? err : new Error(failMessage(err));
    }
  }
}
