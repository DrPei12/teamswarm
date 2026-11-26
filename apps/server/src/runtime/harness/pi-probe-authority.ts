import { conflict, ServiceError } from "../../errors.js";
import type { HarnessRequest, NativeActorScope, NativeExecutionNode, NativeToolScope } from "../types.js";
import { WorkspaceAccess } from "../workspace-access.js";

export const piProbeOutputTokens = 512;
export const piProbeRequestBytes = 49152;
const maxFileChars = 2000;
const maxReads = 4;
const maxModelRequests = 5;
const probeIdPattern = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

export class PiProbeAuthority {
  private readonly rootAbort = new AbortController();
  private child?: { node: NativeExecutionNode; abort: AbortController; signal: AbortSignal; paths: Set<string>; reads: number; modelRequests: number };

  constructor(readonly rootActor: string, private rootTurn: string,
    private assertCurrent: () => void, private publish: HarnessRequest["onEvent"]) {}

  private observe(node: NativeExecutionNode) { this.publish({ type: "execution.node", data: { ...node } }); }

  open(probeId: string, paths: string[]) {
    if (this.rootAbort.signal.aborted || this.child || typeof probeId !== "string" || !probeIdPattern.test(probeId) || probeId === this.rootActor)
      throw conflict("pi_probe_scope", "This turn cannot open another Pi probe.");
    this.assertCurrent();
    if (!Array.isArray(paths) || !paths.length || paths.length > 4 || paths.some(path => typeof path !== "string" || path.length > 2000))
      throw conflict("pi_probe_paths", "Declare one to four exact project file paths.");
    const files = new Set(paths.map(path => WorkspaceAccess.relative(path)));
    if (files.size !== paths.length) throw conflict("pi_probe_paths", "Declare distinct project file paths.");
    const node: NativeExecutionNode = { threadId: probeId, parentThreadId: this.rootActor, turnId: `${this.rootTurn}:${probeId}`,
      status: "running", runtimeClosed: false };
    const abort = new AbortController();
    this.child = { node, abort, signal: AbortSignal.any([abort.signal, AbortSignal.timeout(25000)]), paths: files, reads: 0, modelRequests: 0 };
    this.observe(node);
  }

  close(probeId: string, status: "completed" | "failed" | "interrupted") {
    const child = this.child;
    if (!child || child.node.threadId !== probeId || child.node.runtimeClosed || !["completed", "failed", "interrupted"].includes(status))
      throw conflict("pi_probe_scope", "This Pi probe does not own the current child turn.");
    let deliverable = status !== "completed";
    if (status === "completed" && !child.signal.aborted) {
      try { this.assertCurrent(); deliverable = true; }
      catch (error) { if (!(error instanceof ServiceError)) throw error; }
    }
    child.node.status = deliverable ? status : "interrupted";
    child.abort.abort();
    child.node.runtimeClosed = true;
    this.observe(child.node);
    return deliverable;
  }

  revoke() {
    this.rootAbort.abort();
    this.child?.abort.abort();
  }

  settled() { return !this.child || this.child.node.runtimeClosed === true; }

  finalize(confirmedProcessExit: boolean) {
    this.revoke();
    const child = this.child;
    if (!child || child.node.runtimeClosed) return;
    if (child.node.status === "unknown" && !confirmedProcessExit) return;
    child.node.status = "unknown";
    child.node.runtimeClosed = confirmedProcessExit;
    this.observe(child.node);
  }

  private currentChild(actor: string | undefined) {
    const child = this.child;
    if (this.rootAbort.signal.aborted || !child || child.node.threadId !== actor || child.signal.aborted || child.node.runtimeClosed)
      throw conflict("pi_probe_scope", "The Pi probe lease has ended.");
    try { this.assertCurrent(); }
    catch (error) { child.abort.abort(); throw error; }
    return child;
  }

  resolve(actor: string, signal: AbortSignal, allowRoot: boolean): NativeActorScope | undefined {
    if (signal.aborted || this.rootAbort.signal.aborted) return;
    if (allowRoot && actor === this.rootActor)
      return { sessionId: this.rootActor, threadId: this.rootActor, turnId: this.rootTurn, signal: this.rootAbort.signal };
    try {
      const child = this.currentChild(actor);
      return { sessionId: this.rootActor, threadId: actor, parentThreadId: this.rootActor,
        turnId: child.node.turnId, signal: child.signal };
    } catch (error) {
      if (!(error instanceof ServiceError)) throw error;
    }
  }

  authorizeModelSend(scope: NativeToolScope) {
    const child = this.currentChild(scope.threadId);
    if (scope.sessionId !== this.rootActor || scope.parentThreadId !== this.rootActor || scope.turnId !== child.node.turnId)
      throw conflict("pi_probe_scope", "The model request does not match the Pi probe turn.");
    if (child.modelRequests >= maxModelRequests)
      throw conflict("pi_probe_budget", "The Pi probe reached its model request limit.");
    child.modelRequests++;
  }

  readArguments(actor: string | undefined, args: unknown) {
    const child = this.currentChild(actor);
    if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).some(key => !["path", "offset", "limit"].includes(key)))
      throw conflict("pi_probe_paths", "Use the declared Pi probe file paths.");
    const { path, offset = 0, limit = maxFileChars } = args as Record<string, unknown>;
    const canonical = typeof path === "string" ? WorkspaceAccess.relative(path) : "";
    if (!child.paths.has(canonical))
      throw conflict("pi_probe_paths", "Use the declared Pi probe file paths.");
    if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0 || offset > 2 * 1024 * 1024 ||
        typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > maxFileChars ||
        child.reads >= maxReads)
      throw conflict("pi_probe_budget", "The Pi probe reached its file read limit.");
    child.reads++;
    return { path: canonical, offset, limit };
  }
}
