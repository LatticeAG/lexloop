import { Command } from "commander";
import { addBenchCommand } from "./commands/bench.ts";
import { addConfigCommand } from "./commands/config.ts";
import { addDoctorCommand } from "./commands/doctor.ts";
import { addInitCommand } from "./commands/init.ts";
import { addReportCommand } from "./commands/report.ts";
import { addVersionCommand } from "./commands/version.ts";
import { addWatchCommand } from "./commands/watch.ts";

const program = new Command();
program
  .name("lexloop")
  .description("Watch agent runs, classify stuck vs productive, inject a targeted message");

addInitCommand(program);
addWatchCommand(program);
addReportCommand(program);
addConfigCommand(program);
addBenchCommand(program);
addDoctorCommand(program);
addVersionCommand(program);

await program.parseAsync(process.argv);
