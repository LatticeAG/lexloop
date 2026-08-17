/** Spec: esbuild src/cli.ts --bundle --platform=node --format=esm --outfile=dist/cli.js --banner:js="#!/usr/bin/env node"
 * Extra banner lines define `require` via createRequire so bundled CJS (commander) can `require("node:events")` under ESM.
 */
import { chmodSync } from "node:fs";
import * as esbuild from "esbuild";

const banner = [
  "#!/usr/bin/env node",
  "import { createRequire as __lexloopCreateRequire } from 'node:module';",
  "const require = __lexloopCreateRequire(import.meta.url);",
].join("\n");

await esbuild.build({
  entryPoints: ["src/cli.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: "dist/cli.js",
  banner: { js: banner },
  legalComments: "none",
});

chmodSync("dist/cli.js", 0o755);
