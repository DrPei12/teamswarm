import { randomBytes } from "node:crypto";
import { conflict, ServiceError } from "../../errors.js";
import type { HarnessRequest, NativeActorScope, NativeExecutionNode, NativeToolScope, PiSubspaceExecution } from "../types.js";
import { WorkspaceAccess } from "../workspace-access.js";
import { piChildLifetimeMs, piChildMaxPaths, piChildMaxRequests, piChildReadChars, piChildToolNames } from "./pi-subspace-contract.js";

const proof = () => randomBytes(32).toString("base64url");
const childIdPattern = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const denied = () => conflict("pi_subspace_scope", "The Pi child does not own an active isolated subworkspace.");

type Child = {
  node: NativeExecutionNode;
  lease: string;
  abort: AbortController;
  signal: AbortSignal;
  paths: string[];
  requests: number;
  id?: string;
};

export class PiSubspaceAuthority {
  readonly rootProof = proof();
  private readonly abort = new AbortController();
  private readonly children = new Map<string, Child>();

  constructor(readonly sessionId: string, private readonly turnId: string,
    private readonly execution: PiSubspaceExecution, private readonly publish: HarnessRequest["onEvent"]) {}

  private observe(node: NativeExecutionNode) { this.publish({ type: "execution.node", data: { ...node } }); }

  private identity(child?: Child): NativeToolScope {
    return child ? { sessionId: this.sessionId, threadId: child.node.threadId,
      parentThreadId: this.sessionId, turnId: child.node.turnId }
      : { sessionId: this.sessionId, threadId: this.sessionId, turnId: this.turnId };
  }

  assertRoot() {
    if (this.abort.signal.aborted) throw denied();
    this.execution.assertCurrent();
  }

  open(childId: string, paths: string[]) {
    this.assertRoot();
    if (typeof childId !== "string" || !childIdPattern.test(childId) || childId === this.sessionId ||
        this.children.has(childId) || this.children.size >= 16 ||
        [...this.children.values()].filter(child => !child.node.runtimeClosed).length >= 4)
      throw denied();
    if (!Array.isArray(paths) || !paths.length || paths.length > piChildMaxPaths ||
        paths.some(file => typeof file !== "string" || file.length > 1000))
      throw conflict("subspace_write_scope", "Assign exact project file paths to the child.");
    const files = paths.map(file => WorkspaceAccess.relative(file)).sort();
    const abort = new AbortController();
    const child: Child = { node: { threadId: childId, parentThreadId: this.sessionId, turnId: `${this.turnId}:${childId}`,
      status: "running", runtimeClosed: false }, lease: proof(), paths: files, requests: 0, abort,
      signal: AbortSignal.any([this.abort.signal, abort.signal, AbortSignal.timeout(piChildLifetimeMs)]) };
    this.children.set(childId, child);
    this.observe(child.node);
    try {
      child.id = this.execution.prepare(this.identity(child), files);
      return { lease: child.lease, paths: files };
    } catch (error) {
      this.close(childId, "failed");
      throw error;
    }
  }

  close(childId: string, status: "completed" | "failed" | "interrupted") {
    const child = this.children.get(childId);
    if (!child || child.node.runtimeClosed || !["completed", "failed", "interrupted"].includes(status)) throw denied();
    child.node.status = status;
    let submission: ReturnType<PiSubspaceExecution["finish"]>;
    try {
      try {
        if (status === "completed") {
          this.assertRoot();
          if (child.signal.aborted) throw denied();
          submission = this.execution.finish(this.identity(child), true);
          if (!submission || submission.id !== child.id || !submission.files.length) child.node.status = "failed";
        }
      } catch (error) {
        if (!(error instanceof ServiceError)) throw error;
        child.node.status = "interrupted";
      }
      if (child.node.status !== "completed") {
        submission = undefined;
        this.execution.finish(this.identity(child), false);
      }
      return { status: child.node.status, submission };
    } catch (error) {
      child.node.status = "failed";
      throw error;
    } finally {
      child.abort.abort();
      child.node.runtimeClosed = true;
      this.observe(child.node);
    }
  }

  revoke() { this.abort.abort(); }
  settled() { return [...this.children.values()].every(child => child.node.runtimeClosed); }

  finalize(confirmedExit: boolean) {
    this.revoke();
    for (const child of this.children.values()) {
      if (child.node.runtimeClosed || child.node.status === "unknown" && !confirmedExit) continue;
      child.node.status = "unknown";
      if (confirmedExit) this.execution.finish(this.identity(child), false);
      child.node.runtimeClosed = confirmedExit;
      this.observe(child.node);
    }
  }

  private current(scope: NativeToolScope) {
    const child = scope.threadId && this.children.get(scope.threadId);
    if (!child || scope.sessionId !== this.sessionId || scope.parentThreadId !== this.sessionId ||
        scope.turnId !== child.node.turnId || child.node.runtimeClosed || child.signal.aborted) throw denied();
    try { this.assertRoot(); }
    catch (error) { child.abort.abort(); throw error; }
    return child;
  }

  resolve(lease: string, signal: AbortSignal, allowRoot: boolean): NativeActorScope | undefined {
    if (signal.aborted || this.abort.signal.aborted) return;
    try {
      if (allowRoot && lease === this.rootProof) {
        this.assertRoot();
        return { ...this.identity(), signal: this.abort.signal };
      }
      const child = [...this.children.values()].find(child => child.lease === lease);
      if (!child) return;
      const scope = this.identity(child);
      this.current(scope);
      return { ...scope, signal: child.signal, piSubspacePaths: child.paths };
    } catch (error) {
      if (!(error instanceof ServiceError)) throw error;
    }
  }

  authorizeModelSend(scope: NativeToolScope) {
    if (!scope.parentThreadId) {
      if (scope.sessionId !== this.sessionId || scope.threadId !== this.sessionId || scope.turnId !== this.turnId) throw denied();
      this.assertRoot();
      return;
    }
    const child = this.current(scope);
    if (++child.requests > piChildMaxRequests) throw conflict("pi_subspace_budget", "The Pi child reached its model request limit.");
  }

  toolArguments(scope: NativeToolScope, name: string, args: unknown) {
    const child = this.current(scope);
    if (!piChildToolNames.some(tool => tool === name) || !args || typeof args !== "object" || Array.isArray(args)) throw denied();
    if (name === "team_subspace_submit") return args;
    const { path, offset, limit } = args as Record<string, unknown>;
    const file = typeof path === "string" ? WorkspaceAccess.relative(path) : "";
    if (!child.paths.includes(file)) throw conflict("subspace_write_scope", "This Pi child may only access its exact assigned files.");
    if (name !== "team_read_file") return { ...args, path: file };
    if (offset !== undefined && (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0 || offset > 2 * 1024 * 1024) ||
        limit !== undefined && (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > piChildReadChars))
      throw conflict("pi_subspace_read_range", `Read at most ${piChildReadChars} characters at a time.`);
    return { ...args, path: file, offset: offset ?? 0, limit: limit ?? piChildReadChars };
  }
}
