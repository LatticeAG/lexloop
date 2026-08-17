import { access } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import {
  AXION_CONNECTIVE_DENYLIST,
  fillSoftTemplate,
  TMPL_HARD_V1,
  TMPL_SOFT_V1,
} from "./templates.ts";

const AXION_EXTRACT = "/home/ubuntu/repos/Axion/src/lens/extract.ts";

function assertNoDenylist(text: string): void {
  const lower = text.toLowerCase();
  for (const phrase of AXION_CONNECTIVE_DENYLIST) {
    expect(lower.includes(phrase.toLowerCase()), `denylist hit: ${phrase}`).toBe(false);
  }
}

const sampleFilled = fillSoftTemplate({
  intervention_id: "llint_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  tool_name: "bash",
  run_length: 5,
  delta: {
    tried_tools: ["bash"],
    tried_signatures: ["sig"],
    tried_outcomes: [{ class: "err_not_found", n: 5 }],
    frozen_arg_hashes: true,
    untried_tools: ["read_file", "grep"],
    note_vary_args: true,
    note_change_tool: true,
    excerpts: [],
  },
});

describe("templates Axion-silent", () => {
  it("tmpl_soft_v1 lines contain no denylist phrases", () => {
    for (const line of TMPL_SOFT_V1.split("\n")) {
      assertNoDenylist(line);
    }
  });

  it("tmpl_hard_v1 lines contain no denylist phrases", () => {
    for (const line of TMPL_HARD_V1.split("\n")) {
      assertNoDenylist(line);
    }
  });

  it("filled tmpl_soft_v1 sample contains no denylist phrases", () => {
    for (const line of sampleFilled.split("\n")) {
      assertNoDenylist(line);
    }
    assertNoDenylist(sampleFilled);
  });
});

describe("templates Axion extractBeliefs", () => {
  let extractBeliefs: ((text: string) => Promise<unknown[]>) | undefined;

  beforeAll(async () => {
    try {
      await access(AXION_EXTRACT);
      const mod = (await import(pathToFileURL(AXION_EXTRACT).href)) as {
        extractBeliefs?: (text: string) => Promise<unknown[]>;
      };
      if (typeof mod.extractBeliefs === "function") {
        extractBeliefs = mod.extractBeliefs;
      }
    } catch {
      extractBeliefs = undefined;
    }
  });

  it("extractBeliefs length is 0 on the filled soft template when Axion loads", async () => {
    if (!extractBeliefs) return;
    const beliefs = await extractBeliefs(sampleFilled);
    expect(beliefs).toHaveLength(0);
  });
});
