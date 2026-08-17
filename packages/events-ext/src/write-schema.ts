import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ZodTypeAny } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { latticeExtensionEnvelopeSchema, lexLoopEventSchema } from "./schema.ts";

const DRAFT_2020_12 = "https://json-schema.org/draft/2020-12/schema";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(pkgRoot, "schemas");

function toJsonSchemaDocument(schema: ZodTypeAny, name: string): string {
  const generated = zodToJsonSchema(schema, {
    name,
    $refStrategy: "root",
    target: "jsonSchema7",
  }) as Record<string, unknown>;
  generated.$schema = DRAFT_2020_12;
  return `${JSON.stringify(generated, null, 2)}\n`;
}

export function writeSchemas(dir = outDir): string[] {
  mkdirSync(dir, { recursive: true });
  const files: Array<[string, ZodTypeAny, string]> = [
    ["lexloop-event.schema.json", lexLoopEventSchema, "LexLoopEvent"],
    ["lattice-extension-envelope.schema.json", latticeExtensionEnvelopeSchema, "LatticeExtensionEnvelope"],
  ];
  const written: string[] = [];
  for (const [file, schema, name] of files) {
    const dest = path.join(dir, file);
    writeFileSync(dest, toJsonSchemaDocument(schema, name));
    written.push(dest);
  }
  return written;
}

const invoked = process.argv[1];
const isMain =
  invoked !== undefined && path.basename(invoked).replace(/\.[cm]?js$/, ".ts") === "write-schema.ts";

if (isMain) {
  for (const dest of writeSchemas()) {
    process.stdout.write(`${dest}\n`);
  }
}
