import {windowBinding} from "../context-window.js";
import { ClaudeTurnUsage } from "../claude-turn-usage.js";
import { nativeAccess, deepseekPermissionOptions, grokPermissionOptions, piPermissionOptions, claudePermissionOptions, openCodePermissionOptions, openCodePermissions, withDefaultPermissions } from "../permission-options.js";
import { conversationInput } from "./conversation-input.js";
import { execFileSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { spawnOwned, confirmOwnedExit } from "./owned-process.js";
import { createHash, randomUUID } from "node:crypto";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  realpathSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { createInterface } from "node:readline";
import type {
  Harness,
  HarnessRequest,
  HarnessResult,
  ExecutionConfig,
  NativeModelTurnProtocol,
} from "../types.js";
import { conflict, ServiceError } from "../../errors.js";
import { redact } from "../redact.js";
import { sessionStoreScope } from "./session-scope.js";
import { NativeUsage } from "./native-usage.js";
import { contextObservation, DEEPSEEK_NATIVE_WINDOW, estimateTokens, PI_COMPACTION_KEEP_RECENT } from "../context-budget.js";
import { preflight, inspectExecution, type PreflightInput } from "./preflight.js";
import { prepareExecutionEnvironment } from "./execution-environment.js";
import { readOnlyPermissions, validateNativePermissions, policyFor } from "./permissions.js";
import { nativeQuestions, unansweredQuestion } from "../native-questions.js";
import { CommandObservations } from "./command-observations.js";
import { OpenCodeAcp } from "./opencode-acp.js";
import { grokModelConfig, isolateGrokEnvironment } from "./grok-config.js";
import { accountHome, subscriptionEnvironment, subscriptionInspection, subscriptionAccounts, subscriptionScope, claudeSubscriptionFlags } from "./subscriptions.js";
import { rebootConfirmsTermination, systemBootTime } from "./native-recovery.js";
import { recoverOpenCodeTruncation } from "./opencode-recovery.js";
import { NativeTranscript } from "./native-transcript.js";
import {
  childEnvironment,
  nativeEnvironment,
  nativeEntry,
  nativeHome,
  toolBridge,
  toolEndpoint,
  openCodeProbeModelTokenEnv,
  prepareOpenCodeProbeProcess,
  terminateNative,
} from "./native-support.js";
import { tagModelTurn } from "./model-turn.js";
import { RetainedProcess, ToolUseGate, terminateRetainedProcess } from "./retained-process.js";
import { harnessManifest } from "@team/contracts/harness-catalog";
import { apiEffortPolicy } from "@team/contracts/model-effort";
import { packageFor } from "./device-tools.js";
import { PiDaemon, type PiTurnCheckpoint } from "./pi-daemon.js";
import { PiProbeAuthority } from "./pi-probe-authority.js";
import { PiSubspaceAuthority } from "./pi-subspace-authority.js";
import { piChildTools, piDelegateTool } from "./pi-subspace-contract.js";
import { ClaudeProbeAuthority, claudeReadProbeAgent } from "./claude-probe-authority.js";
import { OpenCodeProbeAuthority, openCodeReadProbeAgent, openCodeReceiptArgument } from "./opencode-probe-authority.js";
import { assertOpenCodeProbeHost, openCodeProbeSdkDirectory, openCodeProbeSdkVersion, stageOpenCodeProbeSdk } from "./opencode-probe-sdk.js";
import { prepareGrok, grokSession } from "./grok-worker.js";
import { needsModelRoute, supportsPiSubspaces } from "../model-routing.js";
import { DshProbeTree } from "./dsh-probe-tree.js";

function piCompaction(event: any) {
  if (event.type !== "pi.event" || event.event?.type !== "compaction_end" || event.event.aborted || !event.event.result) return;
  const result = event.event.result;
  return {
    ...event.boundary,
    ...(typeof result.summary === "string" ? { summaryTokensEstimate: estimateTokens(result.summary) } : {}),
    ...(Number.isSafeInteger(result.usage?.totalTokens) && result.usage.totalTokens > 0 ? { compactionTokens: result.usage.totalTokens } : {}),
  };
}

type AcpDriver = Pick<OpenCodeAcp, "receive" | "start" | "cancel" | "close">;

type NativeId = "claude-code" | "grok" | "pi" | "opencode" | "deepseek-harness";
function scopedClaudeReview(id: NativeId, request: Pick<HarnessRequest, "config" | "workspaceBoundary" | "assertReviewCommand">) {
  return id === "claude-code" && request.config.access === "read-only" &&
    request.workspaceBoundary?.writePaths.length === 0 && !!request.assertReviewCommand;
}
const grokVersions = new Map<string, { identity: string; version?: string }>();
function standaloneGrokVersion(entry: string): string | undefined {
  if (/\.[cm]?js$/i.test(entry)) return;
  const stat = statSync(entry);
  const identity = JSON.stringify([stat.dev, stat.ino, stat.size, stat.mtimeMs]);
  const cached = grokVersions.get(entry);
  if (cached?.identity === identity) return cached.version;
  let version: string | undefined;
  try {
    const env = nativeEnvironment();
    isolateGrokEnvironment(env);
    version = /^grok\s+(\d+\.\d+\.\d+)\b/i.exec(execFileSync(entry, ["--version"], {
      encoding: "utf8", windowsHide: true, timeout: 3000, env,
    }).trim())?.[1];
  } catch {}
  grokVersions.set(entry, { identity, version });
  return version;
}
type Active = {
  turnId: string;
  revoke: () => Promise<void>;
  terminate: () => Promise<boolean>;
  resourceId: string;
  child: ChildProcessWithoutNullStreams;
  done: Promise<HarnessResult>;
  stopping: boolean;
  termination?: Promise<boolean>;
  acp?: AcpDriver;
};

/** Native loops stay in their own executable/SDK. No model-loop emulation here. */
export class NativeHarness implements Harness {
  permissionOptions() { return this.id === "claude-code" ? claudePermissionOptions : this.id === "opencode" ? openCodePermissionOptions : this.id === "deepseek-harness" ? deepseekPermissionOptions : this.id === "grok" ? grokPermissionOptions : piPermissionOptions; }
  readonly capabilities;
  get sessionScope(): string {
    return sessionStoreScope(nativeHome(this.id)) + (this.id === "claude-code" || this.id === "grok" ? ":" + subscriptionScope(this.id) : "") + (this.id === "grok" ? ":acp-profile-v1" : this.id === "deepseek-harness" ? ":acp-resume-v1" : "") + ":device-access-v1";
  }
  private active = new Map<string, Active>();
  private unconfirmed = new Map<string, {
    child: ChildProcessWithoutNullStreams;
    resourceId: string;
    observe: HarnessRequest["onEvent"];
    cleanup?: () => Promise<void>;
  }>();
  private executions = new Map<string, Promise<HarnessResult>>();
  private readonly waitingForProcess = new Set<string>();
  private retained = new Map<string, RetainedProcess>();
  private pi?: PiDaemon;
  private openingPi?: Promise<PiDaemon>;
  private piRuns = new Map<string, { turnId: string; daemon: PiDaemon; cancel: () => void }>();
  private closing = false;
  resources() {
    const records = new Map<string, { id: string; pid: number; sessions: number; retainedIdleSince?: number }>();
    for (const active of this.active.values()) {
      if (active.child.pid) records.set(active.resourceId, { id: active.resourceId, pid: active.child.pid, sessions: 1 });
    }
    for (const owner of this.unconfirmed.values()) {
      if (owner.child.pid) records.set(owner.resourceId, { id: owner.resourceId, pid: owner.child.pid, sessions: 1 });
    }
    for (const [sessionId, worker] of this.retained) {
      if (worker.child.pid && !worker.closed) {
        const idleSince = worker.available && !this.ownsProcess(sessionId) ? worker.idleSince : undefined;
        records.set(worker.id, { id: worker.id, pid: worker.child.pid, sessions: idleSince === undefined ? 1 : 0,
          ...(idleSince === undefined ? {} : { retainedIdleSince: idleSince }) });
      }
    }
    if (this.pi?.child.pid && this.pi.child.exitCode === null && this.pi.child.signalCode === null)
      records.set(this.pi.id, { id: this.pi.id, pid: this.pi.child.pid, sessions: this.piRuns.size });
    return [...records.values()];
  }
  private admit(request: HarnessRequest, sessionId: string, candidate?: { id: string; pid: number }) {
    const wait = request.admitProcess?.(candidate);
    if (!wait) return;
    // A CPU waiter owns a session slot but not the idle process. Maintenance
    // may retire it; on wake the selection loop checks the actual binding again.
    this.waitingForProcess.add(sessionId);
    return wait.finally(() => this.waitingForProcess.delete(sessionId));
  }
  private ownsProcess(sessionId: string) {
    return this.executions.has(sessionId) && !this.waitingForProcess.has(sessionId);
  }
  private piInUse() {
    return this.piRuns.size > 0 || [...this.executions.keys()].some(id => this.ownsProcess(id));
  }
  mayPrepareReuse(config: ExecutionConfig) {
    if (this.closing || config.access !== "read-only") return false;
    if (this.id === "pi") return !!this.pi?.available && !this.piRuns.size;
    return !config.nativeReadProbes && [...this.retained.values()].some(w => w.available && w.idleSince !== undefined);
  }
  retainModelEndpoint(request: Pick<HarnessRequest, "config" | "modelRoute" | "executionRequirements" | "executionEnvironment" | "verificationDirectory" | "workspaceBoundary" | "assertReviewCommand" | "signedRootReview">): NativeModelTurnProtocol | undefined {
    if (!["claude-code", "deepseek-harness", "opencode", "grok"].includes(this.id)) return;
    const config = withDefaultPermissions(request.modelRoute?.sourceConfig ?? request.config);
    if (request.signedRootReview || config.nativeReadProbes || config.access !== "read-only" || scopedClaudeReview(this.id, request) ||
      this.id === "claude-code" && policyFor(config, "claude-code")?.mode !== "dontAsk" ||
      this.id === "deepseek-harness" && config.permissions?.sandbox && config.permissions.sandbox !== "read-only" ||
      this.id === "opencode" && config.protocol !== "chat-completions" ||
      this.id === "grok" && config.protocol !== "chat-completions" ||
      request.verificationDirectory || request.executionEnvironment ||
      Object.values(request.executionRequirements ?? {}).some(Boolean)) return;
    const runtime = harnessManifest(this.id)?.runtime;
    if (runtime) {
      const entry = nativeEntry(this.id);
      const version = packageFor(entry, runtime.package)?.version ?? (this.id === "grok" ? standaloneGrokVersion(entry) : undefined);
      if (version && runtime.testedVersions.includes(version))
        return this.id === "grok" ? "grok-chat-completions" : this.id === "opencode" ? "chat-completions" : "messages";
    }
  }
  supportsResume(request: Parameters<NonNullable<Harness["supportsResume"]>>[0]) {
    if ((this.id === "claude-code" || this.id === "opencode") && request.config.nativeReadProbes) return false;
    return this.id !== "deepseek-harness" || Boolean(needsModelRoute(request.config) && this.retainModelEndpoint(request));
  }
  async reconcileResources() {
    const pi = this.pi;
    if (pi && !pi.available && await pi.reconcileExit() && this.pi === pi) this.pi = undefined;
    for (const [id, owner] of this.unconfirmed) {
      if (await confirmOwnedExit(owner.child)) await this.releaseConfirmed(id, owner);
    }
    for (const [id, worker] of this.retained) {
      if (worker.closed && await worker.reconcileExit() && this.retained.get(id) === worker) this.retained.delete(id);
    }
  }
  async maintain({ now, pressure, warmIdleMs = 30000, maxWarmProcesses = Infinity, daemonIdleBytes = Infinity, privateBytesByGroup }: {
    now: number; pressure: boolean; warmIdleMs?: number; maxWarmProcesses?: number; daemonIdleBytes?: number;
    privateBytesByGroup?: ReadonlyMap<string, number>;
  }) {
    await this.reconcileResources();
    const pi = this.pi;
    if (pi?.available && !this.piInUse()) {
      const oversized = (privateBytesByGroup?.get(pi.id) ?? 0) > daemonIdleBytes;
      if (pressure || oversized || now - pi.idleSince >= warmIdleMs)
        await pi.close(false, pressure ? "memory_pressure" : oversized ? "idle_memory_limit" : "idle_timeout");
    }
    const idle = [...this.retained].filter(([id, worker]) => !this.ownsProcess(id) && worker.available && worker.idleSince !== undefined)
      .sort((a, b) => a[1].idleSince! - b[1].idleSince!);
    const excess = Math.max(0, idle.length - maxWarmProcesses);
    await Promise.all(idle.map(async ([id, worker], index) => {
      if (this.retained.get(id) !== worker || this.ownsProcess(id) || !worker.available || worker.idleSince === undefined) return;
      const overLimit = index < excess;
      if (!pressure && !overLimit && now - worker.idleSince < warmIdleMs) return;
      await worker.close(pressure ? "memory_pressure" : overLimit ? "idle_pool_limit" : "idle_timeout");
    }));
  }
  async releaseIdleGroup(groupId: string, reason: "idle_pool_limit" | "workflow_complete" = "workflow_complete") {
    if (this.closing) return false;
    if (this.pi?.id === groupId && this.pi.available && !this.piInUse())
      return this.pi.close(false, reason);
    for (const [sessionId, worker] of this.retained) {
      if (worker.id === groupId && worker.available && worker.idleSince !== undefined && !this.ownsProcess(sessionId))
        return worker.close(reason);
    }
    return false;
  }
  constructor(readonly id: NativeId) {
    this.capabilities = {
      dispatchTracking: true,
      reviewCommands: (id === "pi" || id === "claude-code" || id === "opencode" && process.arch === "x64") && process.platform === "win32",
      boundedWorkspaceWrites: true,
      sessions: true,
      resume: true,
      streaming: true,
      dynamicTools: true,
      interrupt: true,
      usage: true,
      contextCompaction: id === "pi" || id === "claude-code" || id === "opencode",
      contextCompactionEvents: id === "pi" || id === "claude-code",
      customModel: true,
      customProvider: true,
      nativeChecks: true,
      reasoningEffort: false,
      protocol:
        id === "pi" || id === "opencode" || id === "grok"
          ? "chat-completions"
          : "anthropic-messages",
      isolation:
        id === "pi"
          ? "tool selection; native file tools are not an OS sandbox"
          : "native permissions; no cross-user isolation",
      cancellation:
        id === "pi" || id === "claude-code"
          ? "native interrupt; OS process-tree termination fallback"
          : "native shutdown or OS process-tree termination; uncertain execution remains recovery_required",
    };
  }
  async inspect() {
    if (this.id === "claude-code" || this.id === "grok") {
      const result = await subscriptionInspection(this.id);
      return { ...result, capabilities: { ...this.capabilities, ...result.capabilities } };
    }
    try {
      return {
        available: true,
        id: this.id,
        entry: nativeEntry(this.id),
        capabilities: this.capabilities,
      };
    } catch (error) {
      return { available: false, id: this.id, error: (error as Error).message };
    }
  }
  validateConfig(config: ExecutionConfig) {
    validateNativePermissions(config);
    const entry = nativeEntry(this.id);
    if (config.nativeReadProbes) {
      const runtime = harnessManifest(this.id)?.runtime;
      const version = runtime && packageFor(entry, runtime.package)?.version;
      if (!["pi", "deepseek-harness", "claude-code", "opencode"].includes(this.id) || config.access !== "read-only" ||
          !version || !runtime?.testedVersions.includes(version))
        throw new Error("Native probes require a tested read-only runtime.");
      if (this.id === "opencode") assertOpenCodeProbeHost();
    }
    if (config.contextWindowTokens != null && !["pi", "opencode"].includes(this.id))
      throw new Error("An explicit context window requires Pi or OpenCode.");
    if (config.maxOutputTokens != null && !["pi", "opencode"].includes(this.id))
      throw new Error("An explicit output token budget requires Pi or OpenCode.");
    if (this.id === "grok" && path.basename(entry) === "grok-bootstrap.js") throw new Error("Finish the device installation check, then refresh the account status.");
    if ((this.id === "claude-code" || this.id === "grok") && !config.baseUrl && !config.credentialEnv) {
      if (config.protocol && config.protocol !== (this.id === "claude-code" ? "anthropic-messages" : "chat-completions")) throw new Error("Subscription access uses the harness's native protocol.");
      if (config.thinkingFormat) throw new Error("A custom thinking format is not supported for subscription access.");
      if (config.effort && this.id === "grok") throw new Error("Use the Grok subscription's default effort.");
      return;
    }
    if (!config.model || !config.baseUrl || !config.credentialEnv)
      throw new Error(
        `${this.id} requires an explicit model, baseUrl and credentialEnv.`,
      );
    if (
      config.protocol &&
      ["claude-code", "deepseek-harness"].includes(this.id) &&
      config.protocol !== "anthropic-messages"
    )
      throw new Error(`${this.id} requires Anthropic Messages.`);
    if (config.effort != null && !(this.id === "pi" && (!config.protocol || config.protocol === "chat-completions") && ["minimal", "low", "medium", "high", "xhigh", "max"].includes(config.effort)))
      throw new Error(
        `${this.id} does not yet support an explicit reasoning effort; use null.`,
      );
    if (
      config.thinkingFormat &&
      (this.id !== "pi" ||
        (config.protocol && config.protocol !== "chat-completions"))
    )
      throw new Error(
        "The configured thinking format requires Pi Chat Completions.",
      );
  }
  async preflight(request: PreflightInput) {
    this.validateConfig(request.config);
    validateNativePermissions(request.config);
    if (Object.values(request.requirements).some(Boolean)) {
      try {
        if (!request.isolatedWorkspace && nativeAccess(request.config) !== "full-access") throw new Error("native_workspace_required: assign an isolated member working directory for native commands.");
        const piPolicy = policyFor(request.config, "pi");
        const policy = request.config.permissions;
        if (piPolicy && !piPolicy.tools.some(tool => ["bash", "powershell"].includes(tool)))
          throw new Error("native_command_disabled: the selected Pi tool registry has no shell tool.");
        if ((policy?.harness === "claude-code" || policy?.harness === "grok") && policy.mode === "plan")
          throw new Error("native_command_disabled: the selected native plan mode does not permit execution.");
        if (policyFor(request.config, "opencode")?.permission.bash === "deny")
          throw new Error("native_command_disabled: the selected OpenCode policy denies Bash.");
        const identity = inspectExecution(request, nativeEntry(this.id));
        const environment = prepareExecutionEnvironment(request.scratchDirectory, request.requirements);
        return { passed: true, mode: "native-member-workspace", identity, environment, modelRequests: 0,
          nativeRuntime: this.id, isolation: this.capabilities.isolation };
      } catch (error) { return { passed: false, error: (error as Error).message, modelRequests: 0 }; }
    }
    return preflight(request, nativeEntry(this.id), false);
  }
  serviceExecution(config: HarnessRequest["config"]) {
    validateNativePermissions(config);
    const policy = policyFor(config, "pi");
    if (this.id !== "pi" || config.access !== "workspace-write" || !policy?.tools?.some(tool => tool === "bash" || tool === "powershell"))
      throw new Error("This native policy has no verified project-service launcher. Use a Harness with an explicit supported shell policy.");
    return { harness: this.id, boundary: "device-account" as const };
  }
  async execute(request: HarnessRequest): Promise<HarnessResult> {
    if (this.closing) throw new Error("Harness is closing.");
    const id = request.sessionId ?? randomUUID();
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id))
      throw new Error("Invalid native session reference.");
    if (this.executions.has(id) || this.active.has(id) || this.unconfirmed.has(id)) throw new Error("Native session is busy.");
    const execution = this.executeTurn(request, id);
    this.executions.set(id, execution);
    try { return await execution; }
    finally { if (this.executions.get(id) === execution) this.executions.delete(id); }
  }
  private async executeTurn(request: HarnessRequest, id: string): Promise<HarnessResult> {
    request.config = withDefaultPermissions(request.config);
    const c = request.workspaceBoundary ? request.piSubspaces ? readOnlyPermissions(request.config)
      : { ...request.config, access: "read-only" as const } : request.config;
    this.validateConfig(c);
    validateNativePermissions(c);
    const nativeCommands = !request.workspaceBoundary && (c.access === "workspace-write" || Boolean(request.isolatedWorkspace && request.executionRequirements?.nativeCommands));
    const subscription = (this.id === "claude-code" || this.id === "grok") && !c.baseUrl && !c.credentialEnv;
    if (!subscription && (!c.model || !c.baseUrl || !c.credentialEnv))
      throw new Error(
        `${this.id} requires an explicit model, baseUrl and credentialEnv.`,
      );
    const entry = nativeEntry(this.id);
    const turnId = randomUUID();
    const piRuntime = this.id === "pi" ? harnessManifest(this.id)?.runtime : undefined;
    const piVersion = piRuntime ? packageFor(entry, piRuntime.package)?.version : undefined;
    const piDaemonReady = !!piVersion && !!piRuntime?.testedVersions.includes(piVersion) && (!!request.modelRoute || !!request.checkpointCompaction) &&
      c.access === "read-only" && !nativeCommands && !request.executionEnvironment && !request.verificationDirectory;
    const piWrite = request.piSubspaces;
    if (piWrite && (this.id !== "pi" || !piDaemonReady || piVersion !== "1.3.0" || !request.isolatedWorkspace ||
        request.config.access !== "workspace-write" || request.config.nativeReadProbes || !request.workspaceBoundary?.writePaths.length ||
        Object.values(request.executionRequirements ?? {}).some(Boolean) || !request.modelRoute?.sourceConfig ||
        !supportsPiSubspaces(request.modelRoute.sourceConfig) || !request.modelRoute.bindNativeSessionScope ||
        !request.modelRoute.bindBeforeForward || !request.modelRoute.release))
      throw conflict("pi_subspace_unavailable", "Use isolated Pi 1.3.0 work with bounded writes and a supported DeepSeek Chat Completions route.");
    const piProbes = this.id === "pi" && c.nativeReadProbes === true;
    if (piProbes && (!piDaemonReady || piVersion !== "1.3.0" || request.config.access !== "read-only" ||
        !request.assertReadProbeCurrent || !request.modelRoute?.bindNativeSessionScope || !request.modelRoute.bindBeforeForward ||
        !apiEffortPolicy(request.modelRoute.sourceConfig)))
      throw conflict("pi_probe_unavailable", "Pi probes need a verified read-only SDK runtime on the supported model route.");
    const claudeProbes = this.id === "claude-code" && c.nativeReadProbes === true;
    const claudeReview = scopedClaudeReview(this.id, request);
    const claudeRuntime = claudeProbes || claudeReview ? harnessManifest(this.id)?.runtime : undefined;
    const claudeIsolated = !!claudeRuntime && packageFor(entry, claudeRuntime.package)?.version === "2.1.274";
    if (claudeReview && (!claudeIsolated || process.platform !== "win32" || subscription || request.sessionId || !request.modelRoute ||
        request.modelRoute.sourceConfig.protocol !== "chat-completions" || !apiEffortPolicy(request.modelRoute.sourceConfig)))
      throw conflict("scoped_review_unavailable", "Use a fresh read-only Claude Code 2.1.274 review on the supported DeepSeek connection.");
    if (claudeProbes && (!claudeIsolated ||
        request.config.access !== "read-only" || request.sessionId || subscription || nativeCommands || request.workspaceBoundary ||
        request.verificationDirectory || request.executionEnvironment || Object.values(request.executionRequirements ?? {}).some(Boolean) ||
        !request.assertReadProbeCurrent || !request.modelRoute?.bindNativeSessionScope || !request.modelRoute.bindBeforeForward ||
        request.modelRoute.sourceConfig.protocol !== "chat-completions" || !apiEffortPolicy(request.modelRoute.sourceConfig)))
      throw conflict("claude_probe_unavailable", "Claude probes need a fresh read-only Claude Code 2.1.274 attempt on the supported model route.");
    const claudeTree = claudeProbes ? new ClaudeProbeAuthority(id, turnId, request.assertReadProbeCurrent!, request.onEvent) : undefined;
    const openCodeProbes = this.id === "opencode" && c.nativeReadProbes === true;
    if (openCodeProbes && (packageFor(entry, "opencode-ai")?.version !== openCodeProbeSdkVersion ||
        request.config.access !== "read-only" || request.sessionId || nativeCommands || request.workspaceBoundary ||
        request.verificationDirectory || request.executionEnvironment || Object.values(request.executionRequirements ?? {}).some(Boolean) ||
        !request.assertReadProbeCurrent || !request.modelRoute?.bindNativeSessionScope || !request.modelRoute.bindBeforeForward ||
        request.modelRoute.sourceConfig.protocol !== "chat-completions" || !apiEffortPolicy(request.modelRoute.sourceConfig)))
      throw conflict("opencode_probe_unavailable", "OpenCode probes need a fresh read-only OpenCode 1.18.35 attempt on the supported model route.");
    const openCodeReview = request.signedRootReview === true;
    if (openCodeReview && (this.id !== "opencode" || packageFor(entry, "opencode-ai")?.version !== openCodeProbeSdkVersion ||
        request.sessionId || openCodeProbes || request.config.access !== "read-only" || !request.isolatedWorkspace ||
        request.workspaceBoundary?.writePaths.length !== 0 || nativeCommands || request.verificationDirectory || request.executionEnvironment ||
        Object.values(request.executionRequirements ?? {}).some(Boolean) || !request.assertReviewCommand || !request.recordReviewCommand ||
        !request.modelRoute?.release || !request.modelRoute.bindNativeSessionScope || !request.modelRoute.bindBeforeForward ||
        request.modelRoute.sourceConfig.protocol !== "chat-completions" || !apiEffortPolicy(request.modelRoute.sourceConfig)))
      throw conflict("scoped_review_unavailable", "Select isolated OpenCode 1.18.35 on a supported DeepSeek Chat Completions route.");
    let reviewDispatched = false, reviewDecided = false;
    // A successful verdict changes the target state. Permit its final model reply, but no further tool authority.
    const assertOpenCodeCurrent = openCodeReview ? () => { if (!reviewDecided) request.assertReviewCommand!(); } : request.assertReadProbeCurrent;
    const openCodeTree = openCodeProbes || openCodeReview
      ? new OpenCodeProbeAuthority(turnId, assertOpenCodeCurrent!, request.onEvent, openCodeReview) : undefined;
    const dshTree = this.id === "deepseek-harness" && c.nativeReadProbes ? new DshProbeTree(id, turnId, request.onEvent) : undefined;
    if (dshTree && (!request.modelRoute?.bindNativeSessionScope || nativeCommands))
      throw new Error("Native probes require a read-only model route without command execution.");
    const retain = !!request.modelRoute?.bindNativeTurn && !!this.retainModelEndpoint(request);
    const dshAcp = retain && this.id === "deepseek-harness";
    const retainedAcp = retain && (dshAcp || this.id === "opencode" || this.id === "grok");
    const acpTransport = this.id === "opencode" || this.id === "grok" || dshAcp;
    if (request.sessionId && this.id === "deepseek-harness" && !dshAcp) {
      throw new Error("DeepSeek Harness session resume requires an ACP-capable read-only model connection.");
    }
    const home = path.join(nativeHome(this.id), id);
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const binding = JSON.stringify({
      workspace: path.resolve(request.workspace),
      config: request.modelRoute?.sourceConfig ?? c,
      ...(request.contextWindow ? {contextWindow:windowBinding(request.contextWindow)} : {}),
      ...(request.workspaceBoundary ? { workspaceBoundary: request.workspaceBoundary } : {}),
      ...(piWrite ? { piSubspaces: true } : {}),
      ...(subscription ? { accountScope: subscriptionScope(this.id as "claude-code" | "grok") } : {}),
    });
    const bindingPath = path.join(home, "binding.json");
    if (
      existsSync(bindingPath) &&
      readFileSync(bindingPath, "utf8") !== binding
    )
      throw new Error("Session configuration or workspace changed.");
    if (request.sessionId && !existsSync(bindingPath))
      throw new Error("Native session history is unavailable.");
    writeFileSync(bindingPath, binding, { mode: 0o600 });
    let env = subscription ? subscriptionEnvironment(this.id as "claude-code" | "grok") : childEnvironment(request);
    if (request.executionEnvironment) {
      env.TMP = request.executionEnvironment.directory;
      env.TEMP = request.executionEnvironment.directory;
      env.TMPDIR = request.executionEnvironment.directory;
    }
    const fingerprint = () => {
      const entryStat = statSync(entry);
      const workspacePath = realpathSync(request.workspace);
      const workspaceStat = statSync(workspacePath);
      return createHash("sha256").update(JSON.stringify([
        binding, workspacePath, workspaceStat.dev, workspaceStat.ino, workspaceStat.birthtimeMs,
        realpathSync(entry), entryStat.dev, entryStat.ino, entryStat.mtimeMs, entryStat.size,
        c.baseUrl, request.modelRoute?.token, request.instructions, request.tools, request.workspaceBoundary,
      ])).digest("hex");
    };
    let worker: RetainedProcess | undefined, workerBinding = "";
    if (!piDaemonReady) for (;;) {
      if (this.closing) throw new Error("Harness is closing.");
      worker = this.retained.get(id);
      workerBinding = retain ? fingerprint() : "";
      if (worker && (!retain || worker.binding !== workerBinding || !worker.available)) {
        if (!await worker.close("configuration_changed")) throw new Error("The previous native process has not confirmed termination.");
        if (this.retained.get(id) === worker) this.retained.delete(id);
        continue;
      }
      const wait = this.admit(request, id, worker?.child.pid && worker.idleSince !== undefined
        ? { id: worker.id, pid: worker.child.pid } : undefined);
      if (wait) { await wait; continue; }
      // execute() owns this session. Pin this exact worker; never substitute a
      // newly spawned process if its transport fails after the claim.
      if (worker) worker.idleSince = undefined;
      break;
    }
    const endpoint = claudeTree || openCodeTree || retain && !retainedAcp ? worker?.endpoint ?? await toolEndpoint(this.id) : undefined;
    const toolUses = new ToolUseGate();
    const lease = endpoint?.bind(openCodeTree ? { ...request, onPermission: undefined,
      onTool: async (name, args, callId, signal, scope) => {
        if (openCodeReview && reviewDecided) throw conflict("scoped_review_ended", "The reviewer already recorded a verdict.");
        const result = await request.onTool(name, args, callId, signal, scope);
        if (openCodeReview && name === "team_accept_work") reviewDecided = true;
        if (scope?.parentThreadId) request.assertReadProbeCurrent!();
        return result;
      },
      tools: request.tools.map(tool => ({ ...tool, inputSchema: { ...tool.inputSchema,
        properties: { ...tool.inputSchema.properties as Record<string, unknown>, [openCodeReceiptArgument]: { type: "string" } },
      } })),
    } : claudeTree ? { ...request, onPermission: undefined,
      onTool: (name, args, callId, signal, scope) => {
        signal?.throwIfAborted();
        if (!scope?.parentThreadId) return request.onTool(name, args, callId, signal, scope);
        if (name !== "team_read_file") throw conflict("claude_probe_scope", "Claude probes may only read assigned project files.");
        return request.onTool(name, claudeTree.readArguments(scope, args), callId, signal, scope);
      },
    } : request, openCodeTree ? undefined :
      (caller, signal) => claudeTree ? claudeTree.resolveTool(caller, signal) : toolUses.authorize(caller, signal),
    openCodeTree ? {
      acceptControl: receipt => openCodeTree.acceptControl(receipt),
      verifyTool: (name, args, signal) => openCodeTree.verifyTool(name, args, signal),
    } : undefined);
    const bridge = endpoint ? { url: endpoint.url, permissionUrl: endpoint.permissionUrl,
      close: claudeTree || openCodeTree ? endpoint.close : lease!.close } : await toolBridge(piWrite ? {
        ...request, tools: request.tools.filter(tool => tool.name !== piDelegateTool.name), onPermission: undefined,
        onTool: (name, args, callId, signal) => {
          signal?.throwIfAborted();
          piWrite.assertCurrent();
          return request.onTool(name, args, callId, signal);
        },
      } : request);
    let probeEndpoint: Awaited<ReturnType<typeof toolEndpoint>> | undefined;
    let isolatedNativeDirectory: string | undefined;
    let openCodeSigner: string | undefined;
    const closeTools = () => Promise.all([bridge.close(), probeEndpoint?.close()]);
    const closeBeforeSpawn = async () => {
      dshTree?.end();
      claudeTree?.revoke();
      openCodeTree?.revoke();
      await Promise.all([closeTools(), openCodeTree ? request.modelRoute?.release?.() : undefined]);
      if (isolatedNativeDirectory) await rm(isolatedNativeDirectory, { recursive: true, force: true });
      if (worker) await worker.close();
      else await endpoint?.close();
    };
    let command = /\.[cm]?js$/.test(entry) ? process.execPath : entry;
    let args = command === process.execPath ? [entry] : [];
    let stdin = "";
    let cwd = request.workspace;
    const spec = {
      contextWindow: request.contextWindow,
      ...(this.id === "pi" && request.contextWindow?.overrideNative ? { compactionKeepRecent: PI_COMPACTION_KEEP_RECENT } : {}),
      entry,
      home,
      workspace: request.workspace,
      config: c,
      instructions: request.instructions,
      input: retainedAcp ? tagModelTurn(conversationInput(request.input), turnId) : conversationInput(request.input),
      tools: request.tools,
      bridge: bridge.url,
      resume: Boolean(request.sessionId),
      nativeCommands,
      permissionUrl: bridge.permissionUrl,
    };
    if (piDaemonReady) {
      try { return await this.executePi(request, id, turnId, spec, bridge, env[c.credentialEnv!]!, piVersion!, piProbes); }
      finally { await bridge.close(); }
    }
    let grokTools = "";
    try {
      if (claudeTree) {
        if (!request.tools.some(tool => tool.name === "team_read_file"))
          throw conflict("claude_probe_unavailable", "The current execution does not expose project file reads.");
        request.modelRoute!.bindNativeSessionScope!((actor, signal) => claudeTree.resolveModel(actor, signal));
        request.modelRoute!.bindBeforeForward!(scope => claudeTree.authorizeModelSend(scope));
      }
      if (openCodeTree) {
        if (!request.tools.some(tool => tool.name === "team_read_file"))
          throw conflict(openCodeReview ? "scoped_review_unavailable" : "opencode_probe_unavailable", "The current execution does not expose project file reads.");
        request.modelRoute!.bindNativeSessionScope!((actor, signal, parent) => openCodeTree.ownModelScope(actor, parent, signal));
        request.modelRoute!.bindBeforeForward!(scope => {
          if (openCodeReview && !reviewDispatched) throw conflict("scoped_review_owner", "The review turn has not dispatched.");
          openCodeTree.authorizeModelSend(scope);
        });
      }
      if (dshTree) {
        request.modelRoute!.bindNativeSessionScope!((actor, signal) => dshTree.resolve(actor, signal));
        const readTool = request.tools.find(tool => tool.name === "team_read_file");
        if (!readTool) throw new Error("The current execution does not expose project file access.");
        probeEndpoint = await toolEndpoint(this.id);
        probeEndpoint.bind({ ...request, tools: [readTool] }, (caller, signal) =>
          caller.sessionId === id && caller.threadId && caller.threadId !== id
            ? dshTree.resolve(caller.threadId, signal) : false);
      }
      if (this.id === "grok") {
        if (!subscription) {
          isolateGrokEnvironment(env);
          env.GROK_HOME = home;
          writeFileSync(path.join(home, "config.toml"), grokModelConfig(c), { mode: 0o600 });
        }
        const launch = prepareGrok(spec);
        grokTools = launch.tools;
        args.push(...launch.args);
      } else if (this.id === "pi") {
        const configPath = path.join(home, "request.json");
        writeFileSync(configPath, JSON.stringify(spec), { mode: 0o600 });
        command = process.execPath;
        const compiled = fileURLToPath(
          new URL("./pi-worker.js", import.meta.url),
        );
        args = [
          ...(!existsSync(compiled) ? ["--import", import.meta.resolve("tsx")] : []),
          existsSync(compiled)
            ? compiled
            : fileURLToPath(new URL("./pi-worker.ts", import.meta.url)),
          configPath,
        ];
      } else if (this.id === "claude-code") {
        if (request.contextWindow?.overrideNative) {
          env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(request.contextWindow.rawTokens);
          if (request.contextWindow.usableTokens >= 100000)
            env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(Math.min(1000000,request.contextWindow.usableTokens));
        }
        env.CLAUDE_CONFIG_DIR = subscription ? accountHome("claude-code") : home;
        if (!subscription) {
          env.ANTHROPIC_API_KEY = env[c.credentialEnv!];
          env.ANTHROPIC_BASE_URL = c.baseUrl!;
          if (request.modelRoute) {
            env.CLAUDE_CODE_MAX_RETRIES = "0";
            env.ANTHROPIC_DEFAULT_SONNET_MODEL = c.model!;
            env.ANTHROPIC_DEFAULT_OPUS_MODEL = c.model!;
            env.ANTHROPIC_DEFAULT_HAIKU_MODEL = c.model!;
            env.CLAUDE_CODE_SUBAGENT_MODEL = c.model!;
            env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = "1";
          }
        }
        env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
        env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = "8192";
        const mcp = JSON.stringify({
          mcpServers: { teamswarm: { type: "http", url: bridge.url } },
        });
        if (claudeTree || claudeReview) {
          const isolated = path.join(home, turnId, "isolated-native");
          if (claudeReview) isolatedNativeDirectory = isolated;
          cwd = path.join(isolated, "project");
          const userHome = path.join(isolated, "home");
          const appConfig = path.join(isolated, "appdata"), cache = path.join(isolated, "cache"), temp = path.join(isolated, "temp");
          const claudeConfig = path.join(isolated, "settings");
          for (const directory of [cwd, userHome, appConfig, cache, temp, claudeConfig]) mkdirSync(directory, { recursive: true, mode: 0o700 });
          const volume = path.parse(userHome).root;
          const loopback = new URL(c.baseUrl!).origin;
          delete env.NODE_OPTIONS;
          delete env.BUN_OPTIONS;
          Object.assign(env, { CLAUDE_CONFIG_DIR: claudeConfig, HOME: userHome, USERPROFILE: userHome,
            HOMEDRIVE: volume.replace(/\\$/, ""), HOMEPATH: userHome.slice(volume.length - 1), APPDATA: appConfig, LOCALAPPDATA: cache,
            XDG_CONFIG_HOME: appConfig, XDG_DATA_HOME: cache, XDG_CACHE_HOME: cache, TEMP: temp, TMP: temp, TMPDIR: temp,
            CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1", CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
            CLAUDE_CODE_DISABLE_BACKGROUND_PLUGIN_REFRESH: "1", CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: "1",
            DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1", DISABLE_AUTOUPDATER: "1",
            HTTP_PROXY: loopback, HTTPS_PROXY: loopback, ALL_PROXY: loopback, NO_PROXY: "127.0.0.1,localhost" });
          const readOnlyAgent = claudeTree ? { [claudeReadProbeAgent]: {
            description: "Inspect one to four exact project files with the TeamSwarm read-only tool.",
            prompt: "Answer the supplied question using only the declared project paths. Call mcp__teamswarm__team_read_file with at most 2,000 characters per read. Return a short conclusion and cite the file paths. Do not quote entire file contents.",
            tools: ["mcp__teamswarm__team_read_file"], model: "inherit",
          } } : undefined;
          const guidance = claudeTree ? `\n\nFor one independent foreground file probe, call Agent with subagent_type "${claudeReadProbeAgent}", a short description, and a prompt containing only JSON {"question":"your exact question","paths":["relative/file.txt"]}. Specify one to four exact project files. Use TeamSwarm MCP for any other project access.` : "";
          args.push(...(claudeReview ? ["--bare"] : []), "--restricted", "--setting-sources", "", "--settings",
            JSON.stringify({ disableAllHooks: true, ...(claudeTree ? { permissions: { ask: ["Agent"] } } : {}) }),
            "--disable-slash-commands", "--no-session-persistence", "--print", "--verbose", "--output-format", "stream-json", "--include-partial-messages",
            "--model", c.model!, "--permission-mode", claudeTree ? "default" : "dontAsk", "--tools", claudeTree ? "Agent" : "",
            "--allowedTools", "mcp__teamswarm__*", ...(readOnlyAgent ? ["--agents", JSON.stringify(readOnlyAgent)] : []),
            "--mcp-config", mcp, "--strict-mcp-config", "--system-prompt", request.instructions + guidance,
            "--input-format", "stream-json", ...(claudeTree ? ["--permission-prompt-tool", "stdio"] : []), "--session-id", id);
        } else {
          const nativeTools =
            c.access === "read-only"
              ? "Read,Glob,Grep" + (nativeCommands ? ",Bash" : "")
              : "Read,Glob,Grep,Write,Edit,Bash";
          // Claude Code offers AskUserQuestion only outside --bare and only through the stdio prompt channel.
          const questions = !!request.onQuestion && c.permissions?.harness === "claude-code" && policyFor(c, "claude-code")!.mode !== "dontAsk";
          if (questions) env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = "1";
          args.push(
            ...(subscription || questions ? claudeSubscriptionFlags : ["--bare"]),
            ...(nativeAccess(c) === "full-access" ? [] : ["--restricted"]),
            "--print",
            "--verbose",
            "--output-format",
            "stream-json",
            "--include-partial-messages",
            ...(c.model ? ["--model", c.model] : []),
            ...(subscription && c.effort ? ["--effort", c.effort] : []),
            "--permission-mode",
            c.permissions?.harness === "claude-code" ? policyFor(c, "claude-code")!.mode : "dontAsk",
            "--tools",
            nativeTools + (questions ? ",AskUserQuestion" : ""),
            "--allowedTools",
            (c.permissions ? "Read,Glob,Grep" : nativeTools) + ",mcp__teamswarm__*" +
              (c.permissions?.harness === "claude-code" && c.access === "workspace-write" && policyFor(c, "claude-code")!.allow?.length ? "," + policyFor(c, "claude-code")!.allow!.join(",") : ""),
            ...(c.permissions?.harness === "claude-code" && policyFor(c, "claude-code")!.deny?.length ? ["--disallowedTools", policyFor(c, "claude-code")!.deny!.join(",")] : []),
            "--mcp-config",
            mcp,
            "--strict-mcp-config",
            "--system-prompt",
            request.instructions,
            "--input-format",
            "stream-json",
            ...(c.permissions?.harness === "claude-code" && policyFor(c, "claude-code")!.mode !== "dontAsk" ? ["--permission-prompt-tool", "stdio"] : []),
            ...(request.sessionId ? ["--resume", id] : ["--session-id", id]),
          );
        }
        stdin =
          JSON.stringify({
            type: "user",
            message: { role: "user", content: retain ? tagModelTurn(conversationInput(request.input), turnId) : conversationInput(request.input) },
          }) + "\n";
      } else if (this.id === "opencode") {
        const windowsShell = process.platform === "win32";
        const instructions = request.instructions + (windowsShell && nativeCommands
          ? "\nThe OpenCode command tool runs Windows PowerShell, even when named bash. Use PowerShell syntax and native Windows paths. For file inspection prefer the native read, glob, and grep tools. In a shell search, ripgrep exit code 1 means no matches; report that result without retrying the same search."
          : "");
        if (openCodeTree) {
          assertOpenCodeProbeHost();
          assertOpenCodeCurrent!();
          const directory = path.join(home, turnId);
          mkdirSync(directory, { recursive: true, mode: 0o700 });
          isolatedNativeDirectory = path.join(directory, "isolated-native");
          mkdirSync(isolatedNativeDirectory, { mode: 0o700 });
          const isolated = prepareOpenCodeProbeProcess(isolatedNativeDirectory, request.modelRoute!.token, bridge.url);
          cwd = isolated.cwd;
          env = isolated.env;
          await stageOpenCodeProbeSdk(openCodeProbeSdkDirectory(), isolated.configDir);
          openCodeSigner = path.join(isolatedNativeDirectory, "teamswarm-signer.mjs");
          writeFileSync(openCodeSigner, openCodeTree.signerSource(bridge.permissionUrl, openCodeReview ? env : undefined), { mode: 0o600, flag: "wx" });
        } else {
          env.XDG_CONFIG_HOME = path.join(home, "config");
          env.XDG_DATA_HOME = path.join(home, "data");
          env.XDG_STATE_HOME = path.join(home, "state");
          env.OPENCODE_DISABLE_PROJECT_CONFIG = "true";
          env.OPENCODE_DISABLE_DEFAULT_PLUGINS = "true";
          env.OPENCODE_DISABLE_MODELS_FETCH = "true";
        }
        env.OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX = String(c.maxOutputTokens ?? 8192);
        const probePermission = openCodeTree ? {
          "*": "deny",
          ...(openCodeProbes ? { task: { "*": "deny", [openCodeReadProbeAgent]: "allow" } } : {}),
          ...Object.fromEntries(request.tools.map(tool => ["teamswarm_" + tool.name, "allow"])),
        } : undefined;
        const probeGuidance = `\n\nFor one independent foreground file probe, call task with subagent_type "${openCodeReadProbeAgent}", a short description, and a prompt containing only JSON {"question":"your exact question","paths":["relative/file.txt"]}. Specify one to four exact project files. Use TeamSwarm MCP for project access.`;
        env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          share: "disabled",
          ...(windowsShell && !openCodeTree ? { shell: "powershell.exe" } : {}),
          ...(openCodeSigner ? { snapshot: false, enabled_providers: ["teamswarm"], plugin: [pathToFileURL(openCodeSigner).href] } : {}),
          ...(request.contextWindow?.overrideNative ? {compaction:{auto:true,reserved:request.contextWindow.rawTokens-request.contextWindow.usableTokens}} : {}),
          model: `teamswarm/${c.model}`,
          default_agent: "teamswarm",
          autoupdate: false,
          provider: {
            teamswarm: {
              npm:
                c.protocol === "responses"
                  ? "@ai-sdk/openai"
                  : c.protocol === "anthropic-messages"
                    ? "@ai-sdk/anthropic"
                    : "@ai-sdk/openai-compatible",
              name: c.provider ?? "TeamSwarm",
              options: {
                baseURL:
                  c.protocol === "anthropic-messages" &&
                  !/\/v1\/?$/.test(c.baseUrl!)
                    ? c.baseUrl!.replace(/\/$/, "") + "/v1"
                    : c.baseUrl,
                apiKey: `{env:${openCodeTree ? openCodeProbeModelTokenEnv : c.credentialEnv}}`,
              },
              models: {
                [c.model!]: {
                  name: c.model,
                  limit: { context: request.contextWindow?.rawTokens ?? c.contextWindowTokens ?? 131072, output: c.maxOutputTokens ?? 8192 },
                },
              },
            },
          },
          permission: probePermission ?? openCodePermissions(c, nativeCommands),
          ...(!retainedAcp && !openCodeTree ? { mcp: {
            teamswarm: { type: "remote", url: bridge.url, enabled: true },
          } } : {}),
          agent: {
            teamswarm: {
              mode: "primary",
              prompt: instructions + (openCodeProbes ? probeGuidance : ""),
              steps: 64,
            },
            ...(openCodeProbes ? { [openCodeReadProbeAgent]: {
              mode: "subagent", model: `teamswarm/${c.model}`, steps: 5,
              description: "Inspect one to four assigned project files and report evidence.",
              prompt: "Use the TeamSwarm file tool to inspect only the assigned paths. Answer the question with a short summary grounded in those reads.",
              permission: { "*": "deny", teamswarm_team_read_file: "allow" },
            } } : {}),
          },
        });
        args.push("acp", ...(!openCodeTree ? ["--pure"] : []), "--cwd", cwd);
      } else {
        env.DSH_HOME = home;
        env.DEEPSEEK_API_KEY = env[c.credentialEnv!];
        env.DEEPSEEK_BASE_URL = c.baseUrl!;
        env.DSH_PRIMARY_RUNTIME = "";
        env.DSH_PERMISSION_MODE = c.permissions?.harness === "deepseek-harness" ? policyFor(c, "deepseek-harness")!.sandbox : c.access;
        env.DSH_MAX_TOKENS_AS_SUCCESS = "false";
        // JSON is a YAML subset. No raw credential is written into the native patch.
        const patch = [
          ...(request.contextWindow?.overrideNative ? [{id:"compaction-basic",config:{
            thresholdRatio:request.contextWindow.effectivePercent/100,
            headroomTokens:Math.min(65536,Math.floor(request.contextWindow.rawTokens/2))
          }}] : []),
          { id: "approval", config: { policy: c.permissions?.harness === "deepseek-harness" ? policyFor(c, "deepseek-harness")!.approval : "never" } },
          ...(dshAcp ? [{ id: "acp", config: { provider: "deepseek-official", model: c.model } }] : []),
          {
            id: "llm-deepseek",
            config: {
              baseURL: c.baseUrl,
              apiKeyEnv: "DEEPSEEK_API_KEY",
              thinking: "disabled",
              maxTokens: 8192,
              models: [{ id: c.model, contextWindow: request.contextWindow?.rawTokens ?? DEEPSEEK_NATIVE_WINDOW, maxTokens: 8192 }],
              retryPolicy: { mode: "normal", maxRetries: 0 },
            },
          },
          ...[
            // The retained ACP session has one gateway-backed API-key route. Do not
            // boot unrelated provider, installer and telemetry stacks before stdin opens.
            ...(dshAcp ? ["llm-pi-ai", "llm-deepseek-account", "deepseek-account", "plugin-manager", "otel", "session-telemetry-otel"] : []),
            ...(!dshTree ? ["tool-subagent"] : []),
            "tool-subagent-fork",
            "tool-subagent-control",
            "tool-subagent-list-agents",
            "tool-web",
            "workflow-ptc",
            "tool-workflow",
            "tool-plugin-manager",
            ...(request.workspaceBoundary || dshAcp || dshTree ? ["tool-fs"] : []),
            ...(dshTree ? ["tool-fs-search"] : []),
            ...(!nativeCommands || process.env.TEAM_DSH_DISABLE_SHELL === "1"
              ? ["tool-bash", "tool-pwsh", "tool-jobs"]
              : []),
          ].map((id) => ({ id, disabled: true })),
          ...(dshTree ? [{ id: "tool-subagent", config: { provider: "spawn", maxDepth: 1, enableRunInBackground: false,
            modelSelectionSettings: false, persona: "Inspect the requested project files using teamswarm_probe_read. Return the findings to the parent.",
            toolFilter: { allow: ["teamswarm_probe_read"] } } }] : []),
          {
            id: "system-prompt",
            config: {
              personaPrefix:
                request.instructions +
                (process.env.TEAM_DSH_DISABLE_SHELL === "1"
                  ? "\nThis deployment disables general shell tools. Use native file tools for your owned source files and Team tools for collaboration and submission. Do not emulate shell execution through another tool. Submit code for the independent reviewer to execute checks. Never remove shared directories or other members' files."
                  : ""),
              personaSuffix: "Your working directory is {{cwd}}.",
            },
          },
          ...(!dshAcp ? [{
            insert: [
              { id: "teamswarm-native-observer", name: fileURLToPath(new URL(existsSync(fileURLToPath(new URL("./dsh-observer.js", import.meta.url))) ? "./dsh-observer.js" : "./dsh-observer.ts", import.meta.url)), config: { permissionUrl: bridge.permissionUrl, ...(dshTree ? { rootSessionId: id } : {}) } },
              ...(probeEndpoint ? [{ id: "teamswarm-probe", name: fileURLToPath(new URL(existsSync(fileURLToPath(new URL("./dsh-probe-extension.js", import.meta.url))) ? "./dsh-probe-extension.js" : "./dsh-probe-extension.ts", import.meta.url)), config: { url: probeEndpoint.url, root: id } }] : []),
              {
                id: "teamswarm-mcp",
                name: "@deepseek-ai/dsh-mcp-client",
                config: {
                  serverName: "teamswarm",
                  transport: "streamable-http",
                  url: bridge.url,
                  failOnStartupError: true,
                  reconnect: { enabled: false },
                },
              },
            ],
          }] : []),
        ];
        const patchPath = path.join(home, "teamswarm.patch.json");
        writeFileSync(patchPath, JSON.stringify(patch), { mode: 0o600 });
        args.push("--profile", dshAcp ? "acp" : "sdk", "--patch", patchPath);
      }
    } catch (error) {
      await closeBeforeSpawn();
      throw error;
    }
    if (this.closing) {
      await closeBeforeSpawn();
      return { status: "interrupted", text: "", error: "Harness closed before dispatch." };
    }
    // Commit both adapter identities before spawning a process that can execute
    // input immediately (including CLI arguments and worker specification files).
    try {
      request.onSession(id, {
        model: c.model,
        provider: c.provider,
        harness: this.id,
        protocol: c.protocol ?? this.capabilities.protocol,
        configured: true,
        // This identity is committed before the native process exists.
        nativeSession: request.sessionId ? "inherited" : "unconfirmed",
        nativePermissions: c.permissions ?? null,
        nativeCommands,
        ...(retain ? { processReused: !!worker } : {}),
        ...(dshTree || claudeTree || openCodeProbes ? { nativeReadProbes: true } : {}),
        workspace: request.workspace,
        ...(request.workspaceBoundary ? { workspaceBoundary: request.workspaceBoundary, nativeSourceAccess: "read-only" } : {}),
        ...(this.id === "deepseek-harness" && process.env.TEAM_DSH_DISABLE_SHELL === "1" ? { shellTools: "disabled" } : {}),
        turnIdentity: "adapter control token; native identifiers are separate events",
      });
      request.onTurn(turnId);
      if (!acpTransport && this.id !== "claude-code" && this.id !== "deepseek-harness") request.onDispatch?.();
      if (retain && !retainedAcp) request.modelRoute!.bindNativeTurn!(turnId);
    } catch (error) {
      await closeBeforeSpawn();
      throw error;
    }
    if (this.closing) {
      await closeBeforeSpawn();
      return { status: "interrupted", text: "", error: "Harness closed before native process creation." };
    }
    let child: ChildProcessWithoutNullStreams;
    const startupResourceId = retain && !worker ? randomUUID() : undefined;
    let startupRecorded = false;
    try {
      if (openCodeTree) {
        assertOpenCodeProbeHost();
        assertOpenCodeCurrent!();
      }
      child = worker?.child ?? await spawnOwned(command, args, {
        cwd,
        env,
        windowsHide: true,
        detached: process.platform !== "win32",
      }, process.platform === "win32" && startupResourceId ? {
        beforeStart: target => {
          if (this.closing) throw new Error("Harness closed before granting native startup.");
          request.assertNativeStart?.();
          request.onEvent({ type: "resource.acquired", data: { id: startupResourceId, pid: target.pid, scope: "harness", ownership: "windows-retained-job" } });
          startupRecorded = true;
        },
        onDenied: (target, exitEvidence) => {
          if (startupRecorded) request.onEvent({ type: exitEvidence ? "resource.released" : "resource.unconfirmed", data: {
            id: startupResourceId, pid: target.pid, scope: "harness", ...(exitEvidence ? { exitEvidence } : {}),
          } });
        },
      } : false);
    } catch (error) {
      await closeBeforeSpawn();
      throw error;
    }
    const terminate = () => worker ? terminateRetainedProcess(child) : terminateNative(child);
    if (retain && !worker) {
      const owned = worker = new RetainedProcess(child, endpoint, workerBinding, request.onEvent, undefined, startupResourceId);
      this.retained.set(id, owned);
      void owned.exited.then(confirmed => {
        if (confirmed && this.retained.get(id) === owned) this.retained.delete(id);
      });
    }
    const receiptPath = path.join(home, `${turnId}.json`);
    const resourceId = worker?.id ?? randomUUID();
    const receipt = (result?: HarnessResult) => {
      writeFileSync(
        receiptPath + ".tmp",
        JSON.stringify({
          sessionId: id,
          turnId,
          pid: child.pid,
          result,
          updatedAt: new Date().toISOString(),
        }),
        { mode: 0o600 },
      );
      renameSync(receiptPath + ".tmp", receiptPath);
    };
    let observationFailure: string | undefined;
    let text = "";
    let terminal: HarnessResult | undefined;
    let stderr = "";
    let nativeSession: string | undefined;
    let signedAcpRoot: string | undefined;
    let sessionSeen = false;
    let dshRunning = false;
    let shutdownAcknowledged = false;
    const usageTotal = new NativeUsage();
    let acp: AcpDriver | undefined;
    const permissionAbort = new AbortController();
    let draining: Promise<void> | undefined;
    const revoke = () => {
      permissionAbort.abort();
      dshTree?.end();
      claudeTree?.revoke();
      openCodeTree?.revoke();
      return draining ??= Promise.all([closeTools(), retain || claudeTree || openCodeTree ? request.modelRoute?.release?.() : undefined]).then(() => undefined);
    };
    let promptAttempted = false, promptBlocked = false;
    const dispatchStdinPrompt = (send: () => void) => {
      if (promptAttempted) return;
      promptAttempted = true;
      try {
        request.onDispatch?.();
        send();
      } catch (error) {
        promptBlocked = true;
        const interrupted = error instanceof ServiceError && error.code === "execution_cancelled";
        terminal = { status: interrupted ? "interrupted" : "failed", text: "", error: error instanceof Error ? error.message : "Native prompt dispatch failed." };
        const active = this.active.get(id);
        if (active) active.termination ??= terminate();
        child.stdin.end();
      }
    };
    let auditStart: ReturnType<RetainedProcess["sampleTurnProcesses"]> | undefined;
    let eventSequence = 0;
    const done = new Promise<HarnessResult>((resolve) => {
      const lines = worker?.lines ?? createInterface({
        input: child.stdout,
        crlfDelay: Infinity,
      });
      const emit = (type: string, data: Record<string, unknown>) => {
        if (observationFailure) return;
        try {
          let safe = redact(data, c.credentialEnv, request.modelRoute?.token);
          const serialized = JSON.stringify(safe);
          if (Buffer.byteLength(serialized) > 256 * 1024) {
            const directory = path.join(home, turnId, "events"); mkdirSync(directory, { recursive: true, mode: 0o700 });
            const eventPath = path.join(directory, `${++eventSequence}.json`); writeFileSync(eventPath, serialized, { mode: 0o600 });
            safe = { harness: this.id, eventPath, bytes: Buffer.byteLength(serialized), preview: serialized.slice(0, 8192) };
          }
          request.onEvent({ type, data: safe });
        } catch {
          observationFailure = "Runtime could not persist native observations.";
          child.stdin.end();
          const active = this.active.get(id);
          if (active) {
            active.stopping = true;
            active.termination ??= terminate();
          }
        }
      };
      const usage = (u: any, replace = false) => {
        const observation = usageTotal.observe(u, replace);
        if (observation) emit("usage", observation);
      };
      const claudeUsage = new ClaudeTurnUsage();
      const context = (u: any) => {
        const observation = contextObservation(this.id, u);
        if (observation) emit("context.usage", { ...observation });
      };
      const commands = new CommandObservations(this.id, path.join(home, turnId, "commands"), emit);
      const transcript = new NativeTranscript(this.id, turnId, emit);
      if (acpTransport) {
        const observeAcp = (event: any) => {
          const safe = redact(event, c.credentialEnv, request.modelRoute?.token); emit("native.event", { harness: this.id, event: safe }); commands.observe(safe); transcript.observe(safe);
          if (event.type === "session") { sessionSeen = true; emit("session.native", { harness: this.id, nativeSessionId: event.id }); }
        };
        const finishAcp = (result: HarnessResult) => {
          try { transcript.finish(result.status); }
          catch { observationFailure = "Native transcript could not be saved."; }
          terminal = redact(result, c.credentialEnv, request.modelRoute?.token);
          if (openCodeTree) void revoke();
          const active = this.active.get(id);
          if (retainedAcp && worker && result.status === "completed") { void finish(null, true); return; }
          if (active) active.termination ??= terminate();
        };
        acp = this.id === "grok"
          ? grokSession(child, spec, grokTools, observeAcp, finishAcp, request.onDispatch, retainedAcp ? {
              initialState: worker?.initialization,
              onInitialize: state => { worker!.initialization = state; },
              nextRequestId: () => ++worker!.nextRpcId,
              onNativeSession: sessionId => request.modelRoute!.bindNativeTurn!(turnId, sessionId),
              onPromptTerminal: revoke,
            } : undefined)
          : new OpenCodeAcp(child, openCodeReview ? { ...request, onDispatch: () => {
              request.onDispatch?.({ sessionId: signedAcpRoot, turnId });
              reviewDispatched = true;
            } } : request, bridge.url, path.join(home, "native-session.json"), observeAcp, finishAcp,
            (retainedAcp ? {
              name: dshAcp ? "DeepSeek Harness" : "OpenCode", eventType: "acp.event", prompt: spec.input, resumeAndClose: true,
              initialState: worker?.initialization, onInitialize: state => { worker!.initialization = state; },
              nextRequestId: () => ++worker!.nextRpcId,
              configure: async (_call, sessionId) => { request.modelRoute!.bindNativeTurn!(turnId, sessionId); return {}; },
            } : openCodeTree ? {
              cwd,
              prompt: conversationInput(request.input),
              requireHttpMcp: true,
              denyNativePermissions: true,
              configure: async (_call, nativeId, _description, signal) => {
                openCodeTree.setRoot(nativeId);
                signedAcpRoot = nativeId;
                if (!await openCodeTree.waitSignerReady(signal))
                  throw new Error("OpenCode did not authenticate the probe signer before dispatch.");
                return { probeSigner: "verified" };
              },
            } : { prompt: conversationInput(request.input) }));
      }
      const receive = (line: string) => {
        let event: any;
        try {
          event = JSON.parse(line);
        } catch {
          if (this.id !== "grok") emit("native.stdout", { harness: this.id, text: line });
          return;
        }
        try {
          if (!event || typeof event !== "object" || Array.isArray(event)) throw new Error("Invalid native message.");
          if (this.id === "grok" && acp) { acp.receive(event); return; }
          if (worker && event.session_id && event.session_id !== id) return;
          if (worker && event.type === "result" && event.result_index <= worker.lastResultIndex) return;
          event = redact(event, c.credentialEnv, request.modelRoute?.token);
          if (openCodeTree) event = JSON.parse(JSON.stringify(event, (key, value) => key === openCodeReceiptArgument ? undefined : value));
          if (dshTree?.observe(event)) return;
          if (claudeTree) {
            claudeTree.observe(event);
            if (typeof event.parent_tool_use_id === "string" && event.type !== "control_request") return;
          }
          emit("native.event", { harness: this.id, event });
          transcript.observe(event);
          if (acp) { acp.receive(event); return; }
          commands.observe(event);
          if (this.id === "pi") {
            const compacted = piCompaction(event);
            if (compacted) emit("context.compacted", compacted);
            if (event.type === "session") nativeSession = event.id;
            if (
              event.type === "pi.event" &&
              event.event.type === "message_end"
            ) {
              const message = event.event.message;
              if (message.role === "assistant") {
                usage(message.usage ?? {});
                context(message.usage ?? {});
                emit("model.observed", {
                  model: message.model,
                  provider: message.provider,
                });
              }
            }
            if (event.type === "result") terminal = event;
          } else if (this.id === "claude-code") {
            if (claudeTree && event.type === "control_request" && event.request?.subtype === "can_use_tool") {
              const r = event.request;
              void (async () => {
                let allowed = false;
                try { allowed = (event.session_id === undefined || event.session_id === id) &&
                  await claudeTree.approve(r.tool_use_id, r.tool_name, r.input, permissionAbort.signal); }
                catch { /* The permission reply defaults to denial. */ }
                if (typeof event.request_id === "string" && !child.stdin.destroyed)
                  child.stdin.write(JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: event.request_id,
                    response: allowed && !permissionAbort.signal.aborted ? { behavior: "allow", updatedInput: r.input } :
                      { behavior: "deny", message: "Only the exact foreground read-only probe is authorized." } } }) + "\n");
              })();
            } else if (event.type === "control_request" && event.request?.subtype === "can_use_tool" && event.request.tool_name === "AskUserQuestion") {
              const r = event.request;
              void (async () => {
                // Claude Code always lets the user answer in their own words.
                const questions = nativeQuestions(r.input?.questions).map(q => ({ ...q, allowOther: true }));
                let answers: string[][] | null = null;
                try { if (questions.length) answers = await request.onQuestion?.({ nativeId: r.tool_use_id ?? event.request_id, tool: r.tool_name, questions }, permissionAbort.signal) ?? null; } catch {}
                if (!child.stdin.destroyed) child.stdin.write(JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: event.request_id,
                  response: answers && !permissionAbort.signal.aborted
                    ? { behavior: "allow", updatedInput: { ...r.input, answers: Object.fromEntries(questions.map((q, i) => [q.question, answers![i].join(", ")])) } }
                    : { behavior: "deny", message: unansweredQuestion } } }) + "\n");
              })();
            } else if (event.type === "control_request" && event.request?.subtype === "can_use_tool") {
              const r = event.request;
              void (async () => {
                let decision = "deny";
                try { decision = c.access === "workspace-write" && !request.workspaceBoundary ? await request.onPermission?.({ nativeId: r.tool_use_id ?? event.request_id, tool: r.tool_name, input: r.input, reason: r.decision_reason }, permissionAbort.signal) ?? "deny" : "deny"; } catch {}
                if (!child.stdin.destroyed) child.stdin.write(JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: event.request_id,
                  response: decision === "allow" && !permissionAbort.signal.aborted ? { behavior: "allow", updatedInput: r.input } : { behavior: "deny", message: "Permission was denied or the task ended." } } }) + "\n");
              })();
            }
            const perRequest = claudeUsage.observe(event,c.model);
            if (perRequest) emit("context.usage", { ...perRequest });
            if (event.type === "system" && event.subtype === "compact_boundary" && event.session_id === id && event.parent_tool_use_id == null)
              emit("context.compacted", { nativeBoundaryId: event.uuid, nativeSessionId: event.session_id,
                trigger: event.compact_metadata?.trigger, tokensBefore: event.compact_metadata?.pre_tokens });
            if (event.type === "system" && event.subtype === "init") {
              nativeSession = event.session_id;
              emit("model.observed", { model: event.model });
            }
            if (event.type === "assistant") {
              if (worker && event.session_id === id) for (const block of event.message?.content ?? [])
                if (block.type === "tool_use") toolUses.observe(block.id, block.name, worker.retiredToolUses);
              text += (event.message?.content ?? [])
                .filter((b: any) => b.type === "text")
                .map((b: any) => b.text)
                .join("");
            }
            if (event.type === "result") {
              usage(event.usage ?? {}, true);
              terminal = {
                status: this.active.get(id)?.stopping
                  ? "interrupted"
                  : event.is_error
                    ? "failed"
                    : "completed",
                text: event.result ?? text,
                error: event.is_error
                  ? JSON.stringify(event.errors ?? event.result)
                  : undefined,
              };
              const nextResult = !worker || event.session_id === id && event.result_index === worker.lastResultIndex + 1;
              if (!nextResult) terminal = { status: "unknown", text, error: "The native result did not match the active turn." };
              const keep = worker && nextResult && terminal.status === "completed" && event.queued_turn_count === 0;
              if (keep) {
                worker!.lastResultIndex = event.result_index;
                void finish(null, true);
              } else child.stdin.end();
            }
          } else {
            if (event.id === 99 && !event.error && event.result)
              shutdownAcknowledged = true;
            if (event.id === 1) {
              if (event.error) {
                terminal = {
                  status: "failed",
                  text,
                  error: JSON.stringify(event.error),
                };
                child.stdin.end();
              } else {
                if (dshTree && !dshTree.begin()) return;
                dispatchStdinPrompt(() => child.stdin.write(
                  JSON.stringify({
                    jsonrpc: "2.0",
                    id: 2,
                    method: "session/prompt",
                    params: {
                      sessionId: id,
                      contentBlocks: [{ type: "text", text: conversationInput(request.input) }],
                    },
                  }) + "\n",
                ));
              }
            }
            if (event.id === 2 && event.error) {
              terminal = {
                status: "failed",
                text,
                error: JSON.stringify(event.error),
              };
              child.stdin.end();
            }
            if (
              event.method === "session.status" &&
              event.params?.sessionId === id
            ) {
              if (event.params.status === "running") dshRunning = true;
              if (event.params.status === "idle" && dshRunning) {
                terminal ??= {
                  status: "unknown",
                  text,
                  error:
                    "DeepSeek became idle without a confirmed successful end event.",
                };
                child.stdin.write(
                  JSON.stringify({
                    jsonrpc: "2.0",
                    id: 3,
                    method: "shutdown",
                  }) + "\n",
                );
              }
            }
            if (event.method === "session.event") {
              const fact = event.params.event;
              if (event.params.sessionId !== id) return;
              if (fact.type === "assistant/message") {
                text = (fact.data?.message?.content ?? [])
                  .filter((b: any) => b.type === "text")
                  .map((b: any) => b.text)
                  .join("");
                usage(fact.data?.usage);
                const stepUsage=contextObservation(this.id,fact.data?.usage??{});
                if (stepUsage && ((stepUsage.inputTokens??0)>0 || (stepUsage.outputTokens??0)>0))
                  emit("context.usage",{...stepUsage});
              }
              if (fact.type === "request/context") {
                context({contextWindow: fact.data?.contextWindow});
                emit("model.observed", {
                  model: fact.data.model,
                  provider: fact.data.provider,
                });
              }
              // Raw facts are retained; only an explicit native turn end can establish success.
              if (fact.type === "turn/end") {
                if (dshTree) void revoke();
                const reason = fact.data?.reason;
                terminal = {
                  status:
                    reason?.kind === "completed"
                      ? "completed"
                      : reason?.kind === "aborted"
                        ? "interrupted"
                        : "failed",
                  text,
                  error:
                    reason?.kind === "completed"
                      ? undefined
                      : JSON.stringify(reason),
                };
              }
            }
          }
          if (nativeSession) {
            sessionSeen = true;
            emit("session.native", { nativeSessionId: nativeSession });
            nativeSession = undefined;
          }
        } catch {
          observationFailure =
            "Native event could not be interpreted or persisted.";
          child.stdin.end();
          const active = this.active.get(id);
          if (active) {
            active.stopping = true;
            active.termination ??= terminate();
          }
        }
      };
      lines.on("line", receive);
      const receiveError = (chunk: Buffer) => {
        if (this.id === "grok") return;
        emit("native.stderr", { harness: this.id, text: String(chunk) });
        stderr = (stderr + redact(String(chunk), c.credentialEnv, request.modelRoute?.token)).slice(-8000);
      };
      child.stderr.on("data", receiveError);
      if (!worker) child.stdin.on("error", () => {});
      const processError = (error: Error) => {
        terminal = { status: "failed", text, error: error.message };
      };
      child.on("error", processError);
      let settled = false;
      let drainTimer: ReturnType<typeof setTimeout> | undefined;
      const finish = async (code: number | null, keep = false) => {
        if (settled) return;
        settled = true;
        const drained = revoke();
        acp?.close();
        try { commands.close(Boolean(this.active.get(id)?.stopping)); } catch { observationFailure = "Native command completion could not be persisted."; }
        clearTimeout(drainTimer);
        lines.removeListener("line", receive);
        child.stderr.removeListener("data", receiveError);
        child.removeListener("error", processError);
        child.removeListener("close", processClosed);
        child.removeListener("exit", processExited);
        if (!worker) lines.close();
        if (!keep && !worker) await Promise.all(
          [child.stdin, child.stdout, child.stderr].map((stream) => {
            stream.destroy();
            return stream.closed
              ? Promise.resolve()
              : new Promise<void>((resolve) => stream.once("close", resolve));
          }),
        );
        const active = this.active.get(id);
        const terminated = active?.termination ? await active.termination : false;
        await drained.catch(() => { observationFailure = "Execution requests could not finish draining."; });
        if (worker) toolUses.retireInto(worker.retiredToolUses);
        const reusable = () => keep && !!worker?.available && worker.retiredToolUses.size < 4096 && !this.closing && !active?.stopping && !observationFailure;
        let audit: Awaited<ReturnType<RetainedProcess["auditTurnEnd"]>> | undefined;
        if (worker && reusable() && process.platform === "win32") {
          audit = await worker.auditTurnEnd(await auditStart);
          emit("resource.turn_audit", { id: worker.id, audit });
        }
        const stopping = active?.stopping;
        const retained = reusable() && (audit === undefined || audit === "clear");
        const reclaimed = retained ? false : worker ? await worker.close(
          stopping ? "interrupted" : audit === "residual" ? "turn_residual_process" : audit === "unavailable" ? "turn_audit_unavailable" : "turn_not_reusable",
          !!stopping || audit !== undefined && audit !== "clear" || !!observationFailure,
        ) : await confirmOwnedExit(child);
        const claudeSettled = claudeTree?.settled();
        const openCodeSettled = openCodeTree?.settled();
        const clearIsolatedDirectory = isolatedNativeDirectory ? () => rm(isolatedNativeDirectory, { recursive: true, force: true }) : undefined;
        try { claudeTree?.processExited(reclaimed, stopping === true); }
        catch { observationFailure = "Claude probe termination could not be persisted."; }
        try {
          openCodeTree?.finalize(reclaimed, stopping === true);
          if (reclaimed) await clearIsolatedDirectory?.();
          else if (openCodeSigner) await rm(openCodeSigner, { force: true });
        } catch { observationFailure = "Native execution disposal could not be recorded."; }
        this.active.delete(id);
        if (!worker) emit(reclaimed ? "resource.released" : "resource.unconfirmed", { id: resourceId, pid: child.pid, scope: "attempt" });
        if (reclaimed) dshTree?.processExited(stopping === true);
        let result: HarnessResult = observationFailure
          ? { status: "unknown", text, error: observationFailure }
          : stopping && shutdownAcknowledged && code === 0
            ? {
                status: "interrupted",
                text,
                error: "Native SDK acknowledged shutdown and exited cleanly.",
              }
            : stopping && terminated
              ? {
                  status: "interrupted",
                  text,
                  error: "OS confirmed termination of the native process tree.",
                }
              : (terminal ?? {
                  status: "unknown",
                  text,
                  error: `Native process exited (${code}) without a completion receipt. ${stderr}`,
                });
        if ((acp || claudeTree || claudeReview || promptBlocked) && !reclaimed && !retained) {
          this.unconfirmed.set(id, { child, resourceId, observe: request.onEvent,
            ...(clearIsolatedDirectory ? { cleanup: async () => {
              openCodeTree?.finalize(true, stopping === true);
              await clearIsolatedDirectory();
            } } : {}),
          });
          result = { status: "unknown", text: result.text, error: "Native process termination could not be confirmed." };
        }
        if (worker && !retained && !reclaimed) result = { status: "unknown", text, error: "Native process termination could not be confirmed." };
        if (dshTree && result.status === "completed" && !dshTree.settled())
          result = { status: "unknown", text: result.text, error: "A native probe has no confirmed terminal state and disposal." };
        if (claudeTree && result.status === "completed" && !claudeSettled)
          result = { status: "unknown", text: "", error: "Claude did not report the probe terminal state." };
        if (claudeTree && !claudeTree.permitsResult() && result.status === "completed")
          result = { status: "failed", text: "", error: "Claude probe permission changed before the summary returned." };
        if (openCodeTree && result.status === "completed" && !openCodeSettled)
          result = { status: "unknown", text: "", error: "OpenCode did not report the probe terminal state." };
        if (openCodeTree && result.status === "completed") {
          try {
            if (!openCodeTree.permitsResult()) throw new Error("OpenCode probe permission changed before the summary returned.");
            assertOpenCodeCurrent!();
          } catch (error) {
            result = { status: "failed", text: "", error: (error as Error).message };
          }
        }
        // The process ran and ended without loading the session it was asked to resume:
        // resuming the same identity again would fail the same way.
        if (request.sessionId && !sessionSeen && child.pid !== undefined && !stopping && !promptBlocked &&
            (result.status === "failed" || result.status === "unknown"))
          emit("session.native_unavailable", { harness: this.id });
        try {
          receipt(result);
        } catch {
          result = {
            status: "unknown",
            text,
            error:
              "Native terminal state could not be persisted. Reconciliation is required.",
          };
        }
        if (retained && result.status === "completed") worker!.idleSince = Date.now();
        else if (retained) await worker!.close();
        resolve(result);
      };
      const processClosed = (code: number | null) => {
        void finish(code);
      };
      const processExited = () => {
        if (settled) return;
        // Descendants may outlive the root while retaining inherited stdio. Stop
        // waiting locally, but never release runtime ownership on that evidence.
        drainTimer = setTimeout(() => {
          observationFailure =
            "Native root exited but inherited output pipes remained open; descendant execution is unknown.";
          child.stdin.destroy();
          child.stdout.destroy();
          child.stderr.destroy();
          void finish(child.exitCode);
        }, 2000);
      };
      child.once("close", processClosed);
      child.once("exit", processExited);
    });
    const active: Active = { turnId, revoke, terminate, resourceId, child, done, stopping: this.closing, acp };
    this.active.set(id, active);
    try {
      if (!startupRecorded) request.onEvent({ type: "resource.acquired", data: { id: resourceId, pid: child.pid, scope: worker ? "harness" : "attempt" } });
      worker?.observeFromAttempt(request.onEvent);
      receipt();
    } catch {
      observationFailure =
        "Runtime could not persist native execution identity.";
      child.stdin.end();
      const active = this.active.get(id)!;
      active.stopping = true;
      active.termination ??= terminate();
      return done;
    }
    if (worker && process.platform === "win32") {
      auditStart = worker.sampleTurnProcesses();
      await auditStart;
      if (this.active.get(id) !== active || active.stopping) return done;
      if (!worker.available) {
        observationFailure = "The retained transport stopped during the process audit.";
        void revoke();
        active.termination ??= terminate();
        child.stdin.end();
        return done;
      }
    }
    if (this.closing) {
      void revoke();
      active.termination ??= terminate();
      child.stdin.end();
      return done;
    }
    if (this.id === "deepseek-harness" && !dshAcp)
      child.stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            cwd: request.workspace,
            provider: "deepseek-official",
            model: c.model,
            reasoningEffort:
              c.effort === "none" || !c.effort ? "off" : c.effort,
            maxTokens: 8192,
          },
        }) + "\n",
      );
    else if (acp) void acp.start();
    else if (this.id === "claude-code") dispatchStdinPrompt(() => child.stdin.write(stdin));
    else if (this.id !== "pi") child.stdin.end(stdin);
    return done;
  }
  async interrupt(sessionId: string, turnId: string) {
    const pi = this.piRuns.get(sessionId);
    if (pi) { if (pi.turnId === turnId) pi.cancel(); return; }
    const active = this.active.get(sessionId);
    if (!active)
      throw new Error(
        "Native session is not active; reconcile before retrying.",
      );
    if (active.turnId !== turnId) return;
    if (active.stopping) return;
    active.stopping = true;
    void active.revoke();
    if (active.acp) active.acp.cancel();
    else if (this.id === "pi") active.child.stdin.write("abort\n");
    else if (this.id === "claude-code")
      active.child.stdin.write(
        JSON.stringify({
          type: "control_request",
          request_id: randomUUID(),
          request: { subtype: "interrupt" },
        }) + "\n",
      );
    else if (this.id === "deepseek-harness")
      active.child.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id: 99, method: "shutdown" }) + "\n",
      );
    else active.termination ??= active.terminate();
    const timer = setTimeout(() => {
      if (this.active.get(sessionId) === active)
        active.termination ??= active.terminate();
    }, 5000);
    void active.done.finally(() => clearTimeout(timer));
  }
  async reconcile(sessionId: string, turnId: string, context?: { workId: string; attemptId: string; startedAt: string }): Promise<HarnessResult> {
    if (
      !/^[a-zA-Z0-9_-]{1,100}$/.test(sessionId) ||
      !/^[a-zA-Z0-9_-]{1,100}$/.test(turnId)
    )
      throw new Error("Invalid execution reference.");
    if (this.active.get(sessionId)?.turnId === turnId || this.piRuns.get(sessionId)?.turnId === turnId)
      return {
        status: "unknown",
        text: "",
        error: "Native execution is still active.",
      };
    const file = path.join(nativeHome(this.id), sessionId, `${turnId}.json`);
    if (!existsSync(file))
      return {
        status: "unknown",
        text: "",
        error:
          "No durable native terminal receipt. Inspect the original native process before retrying.",
      };
    const value = JSON.parse(readFileSync(file, "utf8"));
    if (value.sessionId !== sessionId || value.turnId !== turnId)
      throw new Error("Native receipt identity does not match this execution.");
    if (!value.result || value.result.status === "unknown") {
      if (this.id === "opencode" && context) {
        const recovered = recoverOpenCodeTruncation(path.dirname(file), value, context);
        if (recovered) return recovered;
      }
      const bootedAt = await systemBootTime();
      if (rebootConfirmsTermination(value.updatedAt, bootedAt))
        return {
          status: "interrupted",
          text: value.result?.text ?? "",
          error: `OS boot at ${bootedAt} is later than the native receipt at ${value.updatedAt}; the previous process tree has ended. The original receipt is preserved and no successful completion is inferred.`,
        };
    }
    return (
      value.result ?? {
        status: "unknown",
        text: "",
        error:
          "Service lost observation before native termination; execution ownership remains held.",
      }
    );
  }
  async close() {
    this.closing = true;
    for (const turn of this.piRuns.values()) turn.cancel();
    for (const active of this.active.values()) {
      active.stopping = true;
      void active.revoke();
      active.termination ??= active.terminate();
    }
    await Promise.allSettled([
      ...this.executions.values(),
      ...[...this.active.values()].map(active => active.done),
      ...[...this.retained.values()].map(worker => worker.close()),
      ...[...this.unconfirmed].map(async ([id, owner]) => {
        if (await confirmOwnedExit(owner.child) || await terminateNative(owner.child)) await this.releaseConfirmed(id, owner);
      }),
      ...(this.pi ? [this.pi.close()] : []),
      ...(this.id === "claude-code" || this.id === "grok" ? [subscriptionAccounts.close(this.id)] : []),
    ]);
  }

  private async releaseConfirmed(id: string, owner: { child: ChildProcessWithoutNullStreams; resourceId: string; observe: HarnessRequest["onEvent"]; cleanup?: () => Promise<void> }) {
    if (this.unconfirmed.get(id) !== owner) return;
    if (owner.cleanup) await owner.cleanup();
    if (this.unconfirmed.get(id) !== owner) return;
    this.unconfirmed.delete(id);
    owner.observe({ type: "resource.released", data: { id: owner.resourceId, pid: owner.child.pid, scope: "attempt" } });
  }

  private openPi(entry: string, binding: string, onEvent: HarnessRequest["onEvent"]): Promise<PiDaemon> {
    if (this.pi?.available) {
      if (this.pi.binding !== binding) return Promise.reject(new Error("The Pi installation changed while its process was active."));
      return Promise.resolve(this.pi);
    }
    return this.openingPi ??= (async () => {
      if (this.pi && !await this.pi.close()) throw new Error("The previous Pi process has not confirmed termination.");
      if (this.closing) throw new Error("Harness is closing.");
      const directory = path.join(nativeHome("pi"), "daemon");
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const compiled = fileURLToPath(new URL("./pi-worker.js", import.meta.url));
      const args = existsSync(compiled) ? [compiled] : ["--import", import.meta.resolve("tsx"), fileURLToPath(new URL("./pi-worker.ts", import.meta.url))];
      const child = await spawnOwned(process.execPath, [...args, "--daemon", entry, directory], { cwd: directory, env: nativeEnvironment(), windowsHide: true });
      const daemon = this.pi = new PiDaemon(child, binding, onEvent);
      if (this.closing) { await daemon.close(); throw new Error("Harness closed during Pi startup."); }
      return daemon;
    })().finally(() => { this.openingPi = undefined; });
  }

  private async executePi(
    request: HarnessRequest, sessionId: string, turnId: string,
    spec: { entry: string; home: string; config: ExecutionConfig },
    bridge: { close: () => Promise<void> }, apiKey: string, version: string,
    withProbes: boolean,
  ): Promise<HarnessResult> {
    let daemon: PiDaemon;
    for (;;) {
      if (this.closing) throw new Error("Harness is closing.");
      if (this.openingPi) { await this.openingPi; continue; }
      const binding = workerBindingForPi(spec.entry, version);
      const current = this.pi?.available ? this.pi : undefined;
      if (current && current.binding !== binding) {
        if (this.piRuns.size) throw new Error("The Pi installation changed during an active turn.");
        if (!await current.close(false, "configuration_changed")) throw new Error("The previous Pi process has not confirmed termination.");
        continue;
      }
      const wait = this.admit(request, sessionId, current?.turnsStarted && current.child.pid
        ? { id: current.id, pid: current.child.pid } : undefined);
      if (wait) { await wait; continue; }
      daemon = current ?? await this.openPi(spec.entry, binding, request.onEvent);
      break;
    }
    if (this.closing) return { status: "interrupted", text: "", error: "Harness closed before dispatch." };
    daemon.observeFromAttempt(request.onEvent);
    request.onSession(sessionId, {
      model: spec.config.model, harness: this.id, protocol: spec.config.protocol,
      nativeSession: request.sessionId ? "inherited" : "unconfirmed", nativePermissions: spec.config.permissions ?? null,
      nativeCommands: false, workspace: request.workspace, processReused: daemon.turnsStarted > 0,
      ...(request.piSubspaces ? { isolatedSubspaces: true, nativeSourceAccess: "read-only", workspaceBoundary: request.workspaceBoundary } : {}),
    });
    request.onTurn(turnId);
    request.onEvent({ type: "resource.acquired", data: { id: daemon.id, pid: daemon.child.pid, scope: "harness" } });
    const file = path.join(spec.home, turnId + ".json");
    const receipt = (result?: HarnessResult) => {
      writeFileSync(file + ".tmp", JSON.stringify({ sessionId, turnId, pid: daemon.child.pid, result, updatedAt: new Date().toISOString() }), { mode: 0o600 });
      renameSync(file + ".tmp", file);
    };
    receipt();
    request.onDispatch?.();
    const transcript = new NativeTranscript("pi", turnId, (type, data) => request.onEvent({ type, data }));
    const usage = new NativeUsage();
    let stopping = false, sessionSeen = false, timer: ReturnType<typeof setTimeout> | undefined;
    let nativeSessionId: string | undefined;
    let denial: ServiceError | undefined;
    const probes = withProbes ? new PiProbeAuthority(sessionId, turnId, request.assertReadProbeCurrent!, request.onEvent) : undefined;
    const subspaces = request.piSubspaces ? new PiSubspaceAuthority(sessionId, turnId, request.piSubspaces, request.onEvent) : undefined;
    let probeEndpoint: Awaited<ReturnType<typeof toolEndpoint>> | undefined;
    let subspaceEndpoint: Awaited<ReturnType<typeof toolEndpoint>> | undefined;
    const cancel = () => {
      if (stopping) return;
      stopping = true;
      probes?.revoke();
      subspaces?.revoke();
      void bridge.close();
      void probeEndpoint?.close();
      void subspaceEndpoint?.close();
      void request.modelRoute?.release?.();
      daemon.abort(turnId);
      timer = setTimeout(() => { void daemon.close(true); }, 5000);
    };
    this.piRuns.set(sessionId, { turnId, daemon, cancel });
    const deny = (error: unknown) => {
      if (error instanceof ServiceError) denial ??= error;
      cancel();
    };
    const checkpoint = (request.checkpointCompaction || probes || subspaces) && ((boundary: PiTurnCheckpoint) => {
      if (boundary?.stage === "subspace_open" || boundary?.stage === "subspace_close") {
        if (!subspaces || !nativeSessionId || boundary.nativeSessionId !== nativeSessionId) return;
        try {
          return JSON.stringify(boundary.stage === "subspace_open"
            ? subspaces.open(boundary.childId, boundary.paths)
            : subspaces.close(boundary.childId, boundary.status));
        } catch (error) {
          if (!(error instanceof ServiceError)) { cancel(); throw error; }
          return JSON.stringify({ error: redact(error.message, spec.config.credentialEnv, request.modelRoute?.token) });
        }
      }
      if (boundary?.stage === "probe_open" || boundary?.stage === "probe_close") {
        if (!probes || !nativeSessionId || boundary.nativeSessionId !== nativeSessionId) return;
        try {
          if (boundary.stage === "probe_open") probes.open(boundary.probeId, boundary.paths);
          else if (!probes.close(boundary.probeId, boundary.status)) return;
          return "authorized";
        } catch (error) {
          if (!(error instanceof ServiceError)) { cancel(); throw error; }
          return;
        }
      }
      try {
        if (!nativeSessionId || boundary?.nativeSessionId !== nativeSessionId)
          throw conflict("compaction_identity", "Pi reported a checkpoint for a different native session.");
        if (boundary.stage === "model") {
          request.assertCompactionCurrent?.();
          return "authorized";
        }
        return request.checkpointCompaction?.(boundary);
      } catch (error) {
        deny(error);
        if (!(error instanceof ServiceError)) throw error;
      }
    });
    try {
      if (probes) {
        const read = request.tools.find(tool => tool.name === "team_read_file");
        if (!read) throw conflict("pi_probe_unavailable", "The current execution does not expose project file reads.");
        probeEndpoint = await toolEndpoint(this.id);
        if (stopping) return { status: "interrupted", text: "" };
        probeEndpoint.bind({ ...request, tools: [read], onPermission: undefined, onTool: (name, args, callId, signal, scope) => {
          signal?.throwIfAborted();
          if (name !== read.name || !scope?.parentThreadId)
            throw conflict("pi_probe_scope", "This endpoint belongs to the active Pi child probe.");
          return request.onTool(name, probes.readArguments(scope.threadId, args), callId, signal, scope);
        } }, (caller, signal) => caller.sessionId === sessionId && caller.threadId && caller.tool === read.name
          ? probes.resolve(caller.threadId, signal, false) : false);
        request.modelRoute!.bindNativeSessionScope!(async (actor, signal) => probes.resolve(actor, signal, true));
      }
      if (subspaces) {
        subspaces.assertRoot();
        subspaceEndpoint = await toolEndpoint(this.id);
        if (stopping) return { status: "interrupted", text: "" };
        subspaceEndpoint.bind({ ...request, tools: piChildTools([]), onPermission: undefined, onTool: (name, args, callId, signal, scope) => {
          signal?.throwIfAborted();
          if (!scope?.parentThreadId) throw conflict("pi_subspace_scope", "Use the assigned Pi child turn.");
          return request.onTool(name, subspaces.toolArguments(scope, name, args), callId, signal, scope);
        } }, (caller, signal) => caller.sessionId === sessionId && typeof caller.threadId === "string"
          ? subspaces.resolve(caller.threadId, signal, false) : false);
        request.modelRoute!.bindNativeSessionScope!(async (actor, signal) => {
          if (actor === subspaces.rootProof) {
            try { subspaces.assertRoot(); }
            catch (error) { deny(error); return; }
          }
          return subspaces.resolve(actor, signal, true);
        });
      }
      if (checkpoint) request.modelRoute?.bindBeforeForward?.((scope) => {
        if (subspaces) {
          try { subspaces.authorizeModelSend(scope); }
          catch (error) { if (!scope.parentThreadId) deny(error); throw error; }
          return;
        }
        if (scope.parentThreadId && probes) {
          probes.authorizeModelSend(scope);
          return;
        }
        try {
          request.assertCompactionCurrent?.();
        } catch (error) {
          deny(error);
          throw error;
        }
      });
      let result = await daemon.run(turnId, { ...spec, ...(request.checkpointCompaction ? {
        memoryCheckpoint: true, checkedModelFetch: !request.modelRoute,
      } : {}), ...(probes ? { probe: { rootActor: probes.rootActor, toolUrl: probeEndpoint!.url, modelUrl: spec.config.baseUrl! } } : {}),
        ...(subspaces ? { subspaces: { rootActor: subspaces.rootProof, sessionId, toolUrl: subspaceEndpoint!.url, modelUrl: spec.config.baseUrl! } } : {}),
      }, apiKey, native => {
        const event = redact(native, spec.config.credentialEnv, request.modelRoute?.token);
        if (event.type === "pi.session.identity") {
          if (typeof event.id !== "string" || !event.id || (nativeSessionId !== undefined && event.id !== nativeSessionId))
            throw new Error("Pi native session identity changed during the turn.");
          nativeSessionId = event.id;
          return;
        }
        request.onEvent({ type: "native.event", data: { harness: this.id, event } });
        transcript.observe(event);
        if (event.type === "session") {
          sessionSeen = true;
          request.onEvent({ type: "session.native", data: { nativeSessionId: event.id } });
        }
        const compacted = piCompaction(event);
        if (compacted) request.onEvent({ type: "context.compacted", data: compacted });
        if (event.type === "pi.event" && event.event?.type === "message_end" && event.event.message?.role === "assistant") {
          const message = event.event.message;
          const observation = usage.observe(message.usage ?? {});
          const context = contextObservation(this.id, message.usage ?? {});
          if (observation) request.onEvent({ type: "usage", data: observation });
          if (context) request.onEvent({ type: "context.usage", data: { ...context } });
          request.onEvent({ type: "model.observed", data: { model: message.model, provider: message.provider } });
        }
      }, checkpoint);
      if (probes && !probes.settled()) {
        const exited = daemon.child.exitCode !== null || daemon.child.signalCode !== null;
        probes.finalize(exited && await daemon.closed);
        if (result.status !== "unknown")
          result = { status: "unknown", text: "", error: "Pi child probe termination was not observed." };
      }
      if (subspaces && !subspaces.settled()) {
        const exited = daemon.child.exitCode !== null || daemon.child.signalCode !== null;
        subspaces.finalize(exited && await daemon.closed);
        if (result.status !== "unknown") result = { status: "unknown", text: "", error: "Pi child subworkspace termination was not observed." };
      }
      if (result.status === "completed" && !denial) {
        try {
          request.piSubspaces?.assertCurrent();
          request.assertCompactionCurrent?.();
        } catch (error) {
          if (!(error instanceof ServiceError)) throw error;
          denial = error;
        }
      }
      if (denial && result.status !== "unknown") result = denial.code === "stale_attempt"
        ? { status: "interrupted", text: "" }
        : { status: "failed", text: "", error: denial.message };
      await Promise.all([bridge.close(), request.modelRoute?.release?.()]);
      result = redact(result, spec.config.credentialEnv, request.modelRoute?.token);
      transcript.finish(result.status);
      if (request.sessionId && !sessionSeen && result.status === "failed")
        request.onEvent({ type: "session.native_unavailable", data: { harness: this.id } });
      receipt(result);
      return result;
    } catch {
      return { status: "unknown", text: "", error: "Pi execution could not be reconciled with its observations." };
    } finally {
      clearTimeout(timer);
      this.piRuns.delete(sessionId);
      probes?.finalize(false);
      subspaces?.finalize(false);
      await Promise.all([probeEndpoint?.close(), subspaceEndpoint?.close()]);
    }
  }
}

function workerBindingForPi(entry: string, version: string) {
  const stat = statSync(entry);
  return JSON.stringify([realpathSync(entry), stat.dev, stat.ino, stat.mtimeMs, stat.size, version, sessionStoreScope(nativeHome("pi"))]);
}
