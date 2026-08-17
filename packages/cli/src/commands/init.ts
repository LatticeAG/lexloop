import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import {
  ConfigError,
  defaultConfig,
  readConfigFile,
  writeConfig,
} from "@latticeag/lexloop-config";
import { exitWith, formatUnknown } from "../exit.ts";

export function addInitCommand(program: Command): void {
  program
    .command("init")
    .description("Write lexloop.json defaults and create .lexloop/")
    .option("--force", "overwrite an existing file")
    .action(async (opts: { force?: boolean }) => {
      const cwd = process.cwd();
      const file = join(cwd, "lexloop.json");
      const dir = join(cwd, ".lexloop");
      await mkdir(dir, { recursive: true });

      if (existsSync(file) && !opts.force) {
        try {
          readConfigFile(file);
          process.exit(0);
        } catch (err) {
          if (err instanceof ConfigError) {
            exitWith(2, err.message);
          }
          exitWith(2, `LL4001 ${formatUnknown(err)}`);
        }
      }

      await writeConfig(file, defaultConfig());
    });
}
