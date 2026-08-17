import { randomBytes } from "node:crypto";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { LexLoopConfig } from "./schema.ts";

export async function writeConfig(path: string, cfg: LexLoopConfig): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const json = `${JSON.stringify(cfg, null, 2)}\n`;
  const tmp = join(dir, `.lexloop-json.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  try {
    await writeFile(tmp, json, "utf8");
    await rename(tmp, path);
  } catch (err) {
    try {
      await unlink(tmp);
    } catch {
      // tmp may not exist
    }
    throw err;
  }
}
