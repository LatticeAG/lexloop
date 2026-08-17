import type { Command } from "commander";
import { goldenPassed, runGoldenBench } from "../../../../bench/golden.ts";
import { CI_FAIL_MS, detectLoadPassed, runDetectLoad } from "../../../../bench/detect_load.ts";

export function addBenchCommand(program: Command): void {
  const bench = program.command("bench").description("Golden corpus and detect load bench");

  bench
    .command("golden")
    .description("Replay fixtures/golden")
    .option("--dir <dir>", "fixtures/golden", "fixtures/golden")
    .action(async (opts: { dir?: string }) => {
      const dir = opts.dir ?? "fixtures/golden";
      const { result } = await runGoldenBench(dir);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      if (!goldenPassed(result)) process.exit(3);
    });

  bench
    .command("detect")
    .description("Synthetic detect latency bench")
    .option("-n, --n <n>", "step count", "10000")
    .action(async (opts: { n?: string }) => {
      const n = Number.parseInt(opts.n ?? "10000", 10);
      if (!Number.isFinite(n) || n < 1) {
        console.error("LL4001 invalid --n");
        process.exit(2);
      }
      const result = await runDetectLoad(n);
      process.stdout.write(`${JSON.stringify(result)}\n`);
      if (!detectLoadPassed(result)) {
        console.error(`detect p99 ${result.p99_ms} ms exceeds ci_fail_ms ${CI_FAIL_MS}`);
        process.exit(1);
      }
    });
}
