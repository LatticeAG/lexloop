import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MAX_BYTES, EventLog, type NativeLexLoopEvent } from "./log.ts";
import { REDACTED } from "./redact.ts";

const tmpDirs: string[] = [];

async function freshDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "lexloop-log-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  const dirs = tmpDirs.splice(0);
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

function sample(partial: Partial<NativeLexLoopEvent> = {}): NativeLexLoopEvent {
  return {
    v: "lexloop/v1",
    id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    ts: "2026-08-17T15:00:00.123Z",
    run_id: "run_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    session_id: "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    seq: 1,
    name: "budget_skipped",
    payload: { v: "lexloop/v1", reason: "detect_budget" },
    ...partial,
  };
}

function parseLines(text: string): NativeLexLoopEvent[] {
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as NativeLexLoopEvent);
}

describe("EventLog", () => {
  it("appends one JSON line with v lexloop/v1", async () => {
    const dir = await freshDir();
    const path = join(dir, ".lexloop", "events.jsonl");
    const log = new EventLog({
      path,
      max_bytes: DEFAULT_MAX_BYTES,
      persist_fail: "log",
    });
    await log.append(sample());
    await log.close();

    const text = await readFile(path, "utf8");
    expect(text.endsWith("\n")).toBe(true);
    const lines = parseLines(text);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.v).toBe("lexloop/v1");
    expect(lines[0]?.name).toBe("budget_skipped");
    expect(lines[0]?.seq).toBe(1);
  });

  it("rotates when max_bytes would be exceeded, archives, fires LL5001", async () => {
    const dir = await freshDir();
    const path = join(dir, "events.jsonl");
    const rotated: string[] = [];
    const log = new EventLog({
      path,
      max_bytes: 200,
      persist_fail: "log",
      onRotate: (code) => {
        rotated.push(code);
      },
    });

    const first = sample({
      seq: 1,
      payload: { v: "lexloop/v1", reason: "detect_budget", pad: "a".repeat(120) },
    });
    const second = sample({
      seq: 2,
      id: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
      payload: { v: "lexloop/v1", reason: "ring_overflow", pad: "b".repeat(120) },
    });

    await log.append(first);
    await log.append(second);
    await log.close();

    expect(rotated).toEqual(["LL5001"]);

    const current = parseLines(await readFile(path, "utf8"));
    expect(current).toHaveLength(1);
    expect(current[0]?.seq).toBe(2);
    expect(current[0]?.v).toBe("lexloop/v1");

    const names = await readdir(dir);
    const archives = names.filter((name) => name.startsWith("events.jsonl."));
    expect(archives.length).toBeGreaterThanOrEqual(1);
    const archived = parseLines(await readFile(join(dir, archives[0] ?? ""), "utf8"));
    expect(archived).toHaveLength(1);
    expect(archived[0]?.seq).toBe(1);
    expect(names).toContain("events.jsonl");
  });

  it("persist_fail log does not throw when the path is not writable", async () => {
    const dir = await freshDir();
    const blocker = join(dir, "not-a-dir");
    await writeFile(blocker, "file");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = new EventLog({
      path: join(blocker, "events.jsonl"),
      max_bytes: 1024,
      persist_fail: "log",
    });

    await expect(log.append(sample())).resolves.toBeUndefined();
    await expect(log.close()).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("redacts secrets before write and swallows onAfterAppend throw when persist_fail is log", async () => {
    const dir = await freshDir();
    const path = join(dir, "events.jsonl");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const seen: NativeLexLoopEvent[] = [];
    const log = new EventLog({
      path,
      max_bytes: DEFAULT_MAX_BYTES,
      persist_fail: "log",
      extraKeys: ["sessionCookie"],
      onAfterAppend: (event) => {
        seen.push(event);
        throw new Error("hook boom");
      },
    });

    await expect(
      log.append(
        sample({
          payload: { api_key: "sk", sessionCookie: "c", keep: true },
        }),
      ),
    ).resolves.toBeUndefined();
    await log.close();

    const written = parseLines(await readFile(path, "utf8"));
    expect(written[0]?.payload).toEqual({
      api_key: REDACTED,
      sessionCookie: REDACTED,
      keep: true,
    });
    expect(seen).toHaveLength(1);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
