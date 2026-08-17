export type {
  ArgHashSource,
  BeliefSource,
  BudgetSkip,
  BudgetSkipReason,
  Classification,
  ClassifyConfig,
  ClusterLadder,
  DetectConfig,
  DetectPattern,
  Detection,
  InterveneConfig,
  Intervention,
  LadderLevel,
  LoopClass,
  LoopDelta,
  LoopStep,
  OutcomeClass,
  RunReport,
  StepKind,
} from "./types.ts";
export {
  DEFAULT_POLL_NAME_REGEX,
  defaultClassifyConfig,
  defaultDetectConfig,
  defaultInterveneConfig,
} from "./types.ts";

export {
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
  resolveRunId,
  resolveSessionId,
} from "./ids.ts";

export { canonicalize, canonicalJson, sha256Hex } from "./canonicalize.ts";

export { classifyOutcome, normalizeOutcomeText } from "./outcome.ts";

export type { ArgHashFromArgs, ResolvedArgHash, SignatureKind } from "./signature.ts";
export {
  argHashFromArgs,
  clipName,
  normalizeWs,
  resolveArgHash,
  textHash,
  toolSignature,
} from "./signature.ts";

export {
  detect,
  emptyDetection,
  isPollTool,
  nowMs,
  pingPong,
  smallestCycle,
  tailRun,
} from "./detect.ts";

export { closedDetectWindow, outcome_rank, progress_signal } from "./signals.ts";

export type { ClassifyInput } from "./classify.ts";
export {
  assertBeliefsMvp,
  classify,
  latestClosedStep,
  ruleR08,
  ruleR08b,
} from "./classify.ts";

export type { DetectBudgetState } from "./budget.ts";
export {
  checkBudget,
  noteDetectOk,
  noteSkip,
  recordDetectBudgetSkip,
  shouldRunDegradedSample,
  shouldSkipDetect,
} from "./budget.ts";

export type { SentinelLevel, SentinelMatch } from "./sentinel.ts";
export { SENTINEL_RE, isSentinelText, matchSentinel } from "./sentinel.ts";

export type { RecordToolCallInput, RecordToolResultInput, RunStateEvent } from "./run.ts";
export { RunState, recordN } from "./run.ts";

export { DEFAULT_REDACT_KEYS, REDACTED, redact, redactRecord } from "./redact.ts";

export type { EventLogOpts, NativeLexLoopEvent } from "./log.ts";
export { DEFAULT_LOG_PATH, DEFAULT_MAX_BYTES, EventLog } from "./log.ts";

export type { ComputeDeltaInput } from "./delta.ts";
export { computeDelta } from "./delta.ts";

export type { FillSoftTemplateInput } from "./templates.ts";
export {
  AXION_CONNECTIVE_DENYLIST,
  HARD_TEMPLATE_VERSION,
  SOFT_TEMPLATE_VERSION,
  TMPL_HARD_V1,
  TMPL_SOFT_V1,
  fillHardTemplate,
  fillSoftTemplate,
} from "./templates.ts";

export { emptyLadder, fingerprint, nextLevel } from "./ladder.ts";

export type {
  BuildInterventionInput,
  BuildInterventionResult,
  InterventionHit,
  InterventionSkip,
} from "./intervene.ts";
export {
  assertBudget,
  buildHardIntervention,
  buildHumanIntervention,
  buildIntervention,
} from "./intervene.ts";

export { measureUnstick } from "./unstick.ts";

export { enabled as semanticEnabled, SemanticDisabledError, similarity, embed, tokenSort } from "./semantic.ts";

