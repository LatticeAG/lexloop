import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type JsonlEvent = {
  v?: string;
  id?: string;
  ts?: string;
  run_id?: string;
  session_id?: string;
  seq?: number;
  name?: string;
  payload?: Record<string, unknown>;
};

function readEvents(path: string, runId: string): JsonlEvent[] {
  if (!existsSync(path)) return [];
  const out: JsonlEvent[] = [];
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as JsonlEvent;
      if (event?.run_id === runId) out.push(event);
    } catch {
      // Skip malformed lines.
    }
  }
  return out;
}

export function readRunEvents(snapshotPath: string, logPath: string, runId: string): JsonlEvent[] {
  const saved = readEvents(snapshotPath, runId);
  const current = readEvents(logPath, runId);
  const seen = new Set(saved.map((event) => event.id).filter(Boolean));
  return [...saved, ...current.filter((event) => !event.id || !seen.has(event.id))]
    .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
}

export async function saveRunEvents(path: string, events: JsonlEvent[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, events.map((event) => JSON.stringify(event)).join("\n") + "\n", "utf8");
}
