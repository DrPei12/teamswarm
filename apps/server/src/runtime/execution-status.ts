import { nativeAccess } from "./permission-options.js";
import type { Attempt, ExecutionConfig } from "./types.js";

/** A compact, credential-free view shared by prompts and model-facing tools. */
export function executionConfiguration(config: ExecutionConfig) {
  return {
    harness: config.harness, model: config.model, effort: config.effort,
    access: config.access, nativeAccess: nativeAccess(config),
    connection: config.chatgptAccountId ? "chatgpt" : config.baseUrl ? "api" : "native_harness",
  };
}

export function attemptExecution(attempt: Attempt) {
  const actual = attempt.actual;
  const nativeEffort = actual?.requestedTurnEffort ?? actual?.threadEffort ?? actual?.effort;
  return {
    ...executionConfiguration(attempt.config),
    source: "attempt" as const,
    attemptId: attempt.id, workId: attempt.workId, status: attempt.status,
    modelRequest: attempt.modelRequest ?? null,
    nativeObservation: actual ? {
      source: actual.configured === true ? "adapter_configuration" : "native_session",
      model: typeof actual.model === "string" ? actual.model : null,
      effort: typeof nativeEffort === "string" ? nativeEffort : null,
      protocol: typeof actual.protocol === "string" ? actual.protocol : null,
    } : null,
  };
}

export const isCurrentAttempt = (attempt: Attempt) =>
  ["running", "stopping", "recovery_required"].includes(attempt.status);

export const executionStatusGuidance = "nativeAccess describes device authority: full-access permits native filesystem and shell operations outside the working directory; access is the separate Team project publication permission. Current execution comes from the frozen Attempt snapshot; nextExecution is a saved default for future Attempts, and task selections take precedence. A null currentExecution means no running turn; lastExecution is historical. A null effort means no explicit request (provider/native default), not unsupported reasoning. modelRequest records the serialized upstream request and HTTP acceptance when the model gateway is used; absence means no captured request. nativeObservation reports native session or adapter configuration separately. Native Harness capability flags do not describe the model gateway's effort support.";
