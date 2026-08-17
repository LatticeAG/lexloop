import { describe, expect, it } from "vitest";
import {
  CLUSTER_ID_RE,
  INTERVENTION_ID_RE,
  LOOP_ID_RE,
  RUN_ID_RE,
  SESSION_ID_RE,
  ULID_RE,
  clusterId,
  loopId,
  newEnvelopeId,
  newInterventionId,
  newRunId,
  newSessionId,
} from "./ids.ts";

describe("ids", () => {
  it("ULID regex matches envelope ids", () => {
    const id = newEnvelopeId();
    expect(id).toMatch(ULID_RE);
    expect(id).toHaveLength(26);
  });

  it("prefixes run_/ses_/loop_/clus_/llint_", () => {
    const run = newRunId();
    const ses = newSessionId();
    const clus = clusterId(["aaa", "bbb"]);
    const loop = loopId(run, clus, 1);
    const llint = newInterventionId();

    expect(run.startsWith("run_")).toBe(true);
    expect(ses.startsWith("ses_")).toBe(true);
    expect(loop.startsWith("loop_")).toBe(true);
    expect(clus.startsWith("clus_")).toBe(true);
    expect(llint.startsWith("llint_")).toBe(true);

    expect(run).toMatch(RUN_ID_RE);
    expect(ses).toMatch(SESSION_ID_RE);
    expect(loop).toMatch(LOOP_ID_RE);
    expect(clus).toMatch(CLUSTER_ID_RE);
    expect(llint).toMatch(INTERVENTION_ID_RE);
  });
});
