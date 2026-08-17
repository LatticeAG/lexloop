import { describe, expect, it } from "vitest";
import { INTERVENTION_ID_RE, RUN_ID_RE, SESSION_ID_RE } from "./ids.ts";
import { RunState, recordN } from "./run.ts";
import { matchSentinel } from "./sentinel.ts";
import { newInterventionId } from "./ids.ts";

describe("RunState", () => {
  it("assigns seq from 1 and UTC ms timestamps ending in Z", async () => {
    const state = new RunState();
    expect(state.run_id).toMatch(RUN_ID_RE);
    expect(state.session_id).toMatch(SESSION_ID_RE);
    const a = await state.recordToolCall({ tool_name: "lookup", args: { q: 1 } });
    const b = await state.recordToolResult({
      tool_name: "lookup",
      args: { q: 1 },
      error: "invalid",
    });
    expect(a.seq).toBe(1);
    expect(b.seq).toBe(2);
    expect(a.ts.endsWith("Z")).toBe(true);
    expect(b.ts.endsWith("Z")).toBe(true);
    expect(a.kind).toBe("tool_call");
    expect(a.outcome_class).toBe("unknown");
    expect(b.kind).toBe("tool_result");
    expect(b.outcome_class).toBe("err_invalid");
  });

  it("tags steps whose inbound text matches the sentinel", async () => {
    const id = newInterventionId();
    const text = `[lexloop intervention id=${id} level=hard] stop`;
    expect(matchSentinel(text)?.intervention_id).toBe(id);
    const state = new RunState();
    const step = await state.recordToolResult({
      tool_name: "lookup",
      args: { q: 1 },
      error: text,
    });
    expect(step.intervention_id).toBe(id);
    expect(step.intervention_id).toMatch(INTERVENTION_ID_RE);
  });

  it("recordN writes n tool_results", async () => {
    const state = new RunState();
    const steps = await recordN(state, 4, "lookup", { q: 1 }, "invalid");
    expect(steps).toHaveLength(4);
    expect(state.steps).toHaveLength(4);
    expect(steps[3]?.seq).toBe(4);
  });
});
