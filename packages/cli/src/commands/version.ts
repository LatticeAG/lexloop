import type { Command } from "commander";

export function addVersionCommand(program: Command): void {
  program
    .command("version")
    .description("Print 0.1.0")
    .action(() => {
      process.stdout.write("0.1.0\n");
    });
}
