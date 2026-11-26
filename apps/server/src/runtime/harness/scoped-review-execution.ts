import { conflict } from "../../errors.js";
import { apiEffortPolicy } from "@team/contracts/model-effort";
import type { ExecutionConfig, Harness, HarnessRequest, HarnessResult } from "../types.js";
import { codexCommand, codexReviewPermissions, isBoundedReviewSandbox } from "./codex.js";
import { CodexReviewCommands, codexReviewCommandTool } from "./codex-review-commands.js";
import { prepareExecutionEnvironment } from "./execution-environment.js";
import { policyFor } from "./permissions.js";

const nativeReads = ["read", "grep", "find", "ls"];
const blockedTools = new Set(["team_pi_probe", "team_write_file", "team_edit_file", "team_host_inline_edit"]);

const rootReviewTools = new Set(["team_state", "team_project_context", "team_context_index", "team_context_read",
  "team_read_work", "team_read_artifact", "team_read_artifacts", "team_list_files", "team_read_file",
  "team_review_evidence", "team_execution_environment", "team_accept_work", "team_yield"]);
const additionalReviewAdapters = new Map([
  ["deepseek-harness", "The DeepSeek root MCP bridge does not attest the command caller."],
  ["grok", "Grok reports its root model turn, but its MCP bridge does not attest the command caller."],
  ["antigravity", "Antigravity model requests do not identify a native root turn."],
  ["opencode", "OpenCode command reviews require the supported Windows x64 DeepSeek Chat Completions configuration."],
]);

export function supportsScopedReview(harness: string, config: ExecutionConfig) {
  return process.platform === "win32" && harness === config.harness && config.access === "read-only" &&
    (harness === "pi" || (harness === "claude-code" || harness === "opencode" && process.arch === "x64") && config.protocol === "chat-completions" && Boolean(apiEffortPolicy(config)));
}

/** Never turn a read-only adjudication into a general native shell when the detached lane is unavailable. */
export function selectScopedReview(harness: Harness, config: ExecutionConfig, requirements?: HarnessRequest["executionRequirements"]) {
  if (!requirements || !Object.values(requirements).some(Boolean)) return false;
  // These adapters gain a detached lane only for executable evidence. Judgment-only and ordinary work stay native.
  if (additionalReviewAdapters.has(harness.id) && !requirements.nativeCommands) return false;
  const supported = harness.capabilities.reviewCommands === true && supportsScopedReview(harness.id, config);
  if (!supported && config.access === "read-only" && additionalReviewAdapters.has(harness.id))
    throw conflict("scoped_review_unavailable", `${additionalReviewAdapters.get(harness.id)} Select a supported read-only reviewer for executable checks.`);
  return supported;
}

export async function executeScopedReview(harness: Harness, request: HarnessRequest): Promise<HarnessResult> {
  if (!supportsScopedReview(harness.id, request.config) || !request.isolatedWorkspace || !request.verificationDirectory ||
      !request.assertReviewCommand || !request.recordReviewCommand)
    throw conflict("scoped_review_unavailable", "Select an isolated read-only review with a verified Windows command runner.");

  request.assertReviewCommand();
  const permissions = codexReviewPermissions(request.workspace, request.verificationDirectory);
  const environment = prepareExecutionEnvironment(request.verificationDirectory, request.executionRequirements ?? {});
  const runner = new CodexReviewCommands(codexCommand(), permissions, request, environment, isBoundedReviewSandbox);
  const lifetime = new AbortController();
  const signedRoot = harness.id === "opencode";
  const nativePermissions: ExecutionConfig["permissions"] = harness.id === "pi"
    ? { harness: "pi", tools: (policyFor(request.config, "pi")?.tools ?? nativeReads).filter(tool => nativeReads.includes(tool)) }
    : signedRoot ? { harness: "opencode", permission: { "*": "deny" } } : { harness: "claude-code", mode: "dontAsk" };
  const remainingTools = request.tools.filter(tool => (!signedRoot || rootReviewTools.has(tool.name)) && !blockedTools.has(tool.name) && tool.name !== codexReviewCommandTool.name);
  let rootSession: string | undefined, rootTurn: string | undefined;
  let dispatched = false;

  const scoped: HarnessRequest = {
    ...request,
    sessionId: undefined,
    input: request.sessionId ? request.onContextRebuild?.() ?? request.input : request.input,
    config: { ...request.config, nativeReadProbes: false, permissions: nativePermissions },
    workspaceBoundary: { writePaths: [] },
    executionRequirements: undefined,
    executionEnvironment: undefined,
    verificationDirectory: undefined,
    assertReadProbeCurrent: undefined,
    ...(signedRoot ? { signedRootReview: true } : {}),
    ...(signedRoot || harness.id === "claude-code" ? { onPermission: undefined, onQuestion: undefined } : {}),
    tools: [...remainingTools, codexReviewCommandTool],
    instructions: request.instructions + "\nUse team_review_command for executable checks. If a check writes temporary files, call team_execution_environment and pass its directory explicitly to the command. Use the command's evidence event ID to record the review.",
    onSession(id, actual) {
      rootSession = id;
      request.onSession(id, { ...actual, detachedReviewCommands: true, nativeSourceAccess: "read-only" });
    },
    onTurn(id) {
      rootTurn = id;
      request.onTurn(id);
    },
    onDispatch(native) {
      if (signedRoot) {
        if (!rootSession || !rootTurn || typeof native?.sessionId !== "string" || !native.sessionId || native.turnId !== rootTurn)
          throw conflict("scoped_review_owner", "The native review session was not confirmed before dispatch.");
        rootSession = native.sessionId;
      }
      request.onDispatch?.(native);
      dispatched = true;
    },
    onEvent(event) {
      if (event.type !== "execution.item" || event.data.type !== "commandExecution") request.onEvent(event);
    },
    async onTool(name, input, callId, signal, scope) {
      lifetime.signal.throwIfAborted();
      if (signedRoot && (!dispatched || !scope || !signal || (!rootReviewTools.has(name) && name !== codexReviewCommandTool.name)))
        throw conflict("scoped_review_owner", "Only signed root review tools are available.");
      if (scope && (scope.parentThreadId || scope.sessionId !== rootSession || scope.threadId !== rootSession || scope.turnId !== rootTurn))
        throw conflict("scoped_review_owner", "Review tools belong to the active root reviewer.");
      if (signedRoot) request.assertReviewCommand!();
      if (blockedTools.has(name)) throw conflict("scoped_review_read_only", "The review workspace is read-only.");
      if (name !== codexReviewCommandTool.name) return request.onTool(name, input, callId, signal, scope);
      if (!rootSession || !rootTurn || !dispatched || !signal)
        throw conflict("scoped_review_owner", "Review commands need an active, cancellable reviewer turn.");
      return runner.call(callId, input, AbortSignal.any([signal, lifetime.signal]));
    },
  };

  const execution = await Promise.resolve().then(() => harness.execute(scoped)).then(
    result => ({ result }), error => ({ error }),
  );
  lifetime.abort();
  const [command, model] = await Promise.allSettled([runner.close(), Promise.resolve().then(() => request.modelRoute?.release?.())]);
  if (command.status === "rejected")
    return { status: "unknown", text: "", error: "The review command process has no termination receipt." };
  if (model.status === "rejected")
    return { status: "unknown", text: "", error: "The review model lease could not be closed." };
  if ("error" in execution) throw execution.error;
  return execution.result;
}
