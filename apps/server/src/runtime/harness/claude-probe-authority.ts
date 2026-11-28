import { conflict, ServiceError } from "../../errors.js";
import type { HarnessRequest, NativeActorScope, NativeExecutionNode, NativeToolScope } from "../types.js";
import { WorkspaceAccess } from "../workspace-access.js";
import type { ToolCaller } from "./native-support.js";

export const claudeReadProbeAgent = "teamswarm-read-probe";
const nativeReadTool = "mcp__teamswarm__team_read_file";
const maxInputChars = 12000;
const maxFileChars = 2000;
const maxReads = 4;
const maxRequests = 5;
const lifetimeMs = 25000;
const witnessMs = 2000;
const validId = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
const agentTaskId = (value: unknown): value is string => typeof value === "string" && /^a[0-9a-f]{16}$/i.test(value);

type ToolWitness = { name: string; parent: string | null };
type Accepted = { outer: string; paths: ReadonlySet<string> };
type Child = { node: NativeExecutionNode; abort: AbortController; signal: AbortSignal; reads: number; requests: number };

export class ClaudeProbeAuthority {
  private readonly rootAbort = new AbortController();
  private readonly tools = new Map<string, ToolWitness | null>();
  private readonly waits = new Map<string, Set<() => void>>();
  private accepted?: Accepted;
  private child?: Child;
  private summaryRevoked = false;

  constructor(private root: string, private turn: string, private assertCurrent: () => void,
    private publish: HarnessRequest["onEvent"]) {}

  private observeNode(node: NativeExecutionNode) { this.publish({ type: "execution.node", data: { ...node } }); }
  private wake(key: string) { for (const next of this.waits.get(key) ?? []) next(); }

  private async awaitWitness<T>(key: string, signal: AbortSignal, read: () => T | undefined, milliseconds = witnessMs) {
    const current = AbortSignal.any([signal, this.rootAbort.signal]);
    if (current.aborted) return;
    const existing = read();
    if (existing !== undefined) return existing;
    if (this.waits.size >= 32 && !this.waits.has(key)) return;
    const waiters = this.waits.get(key) ?? new Set<() => void>();
    if (waiters.size >= 4) return;
    return new Promise<T | undefined>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;
      const clear = () => {
        clearTimeout(timer);
        current.removeEventListener("abort", finish);
        waiters.delete(finish);
        if (!waiters.size) this.waits.delete(key);
      };
      const finish = () => {
        try {
          const result = current.aborted ? undefined : read();
          if (!current.aborted && result === undefined) return;
          clear(); resolve(result);
        } catch (error) { clear(); reject(error); }
      };
      timer = setTimeout(() => { clear(); resolve(undefined); }, milliseconds);
      this.waits.set(key, waiters);
      waiters.add(finish);
      current.addEventListener("abort", finish, { once: true });
      finish();
    });
  }

  async approve(toolUseId: unknown, tool: unknown, value: unknown, signal: AbortSignal) {
    if (!validId(toolUseId) || tool !== "Agent" || signal.aborted || this.rootAbort.signal.aborted || this.accepted ||
        !value || typeof value !== "object" || Array.isArray(value)) return false;
    const input = value as Record<string, unknown>;
    if (Object.keys(input).some(key => !["subagent_type", "description", "prompt", "run_in_background"].includes(key)) ||
        input.subagent_type !== claudeReadProbeAgent || typeof input.description !== "string" || !input.description.trim() || input.description.length > 200 ||
        typeof input.prompt !== "string" || input.prompt.length > maxInputChars ||
        (input.run_in_background !== undefined && input.run_in_background !== false)) return false;
    let paths: string[];
    try {
      const prompt = JSON.parse(input.prompt);
      if (!prompt || typeof prompt !== "object" || Array.isArray(prompt) || Object.keys(prompt).some(key => key !== "question" && key !== "paths") ||
          typeof prompt.question !== "string" || !prompt.question.trim() || prompt.question.length > 1000 ||
          !Array.isArray(prompt.paths) || !prompt.paths.length || prompt.paths.length > 4 ||
          prompt.paths.some((file: unknown) => typeof file !== "string" || !file.length || file.length > 2000)) return false;
      paths = prompt.paths.map((file: string) => WorkspaceAccess.relative(file));
      if (new Set(paths).size !== paths.length) return false;
    } catch { return false; }
    const sibling = await this.awaitWitness("tool:" + toolUseId, signal, () => this.tools.get(toolUseId));
    if (this.accepted || signal.aborted || this.rootAbort.signal.aborted || sibling?.name !== "Agent" || sibling.parent !== null ||
        this.tools.get(toolUseId) !== sibling) return false;
    this.assertCurrent();
    this.accepted = { outer: toolUseId, paths: new Set(paths) };
    return true;
  }

  observe(event: any) {
    if (event.session_id !== this.root) return;
    if (event.type === "system" && event.subtype === "task_started") {
      if (this.rootAbort.signal.aborted) return;
      if (!this.accepted || event.tool_use_id !== this.accepted.outer || !agentTaskId(event.task_id) || this.child)
        throw conflict("claude_probe_scope", "Claude started a task without the exact probe approval.");
      const node: NativeExecutionNode = { threadId: event.task_id, parentThreadId: this.root,
        turnId: `${this.turn}:${event.task_id}`, status: "running", runtimeClosed: false };
      const abort = new AbortController();
      this.child = { node, abort, signal: AbortSignal.any([abort.signal, AbortSignal.timeout(lifetimeMs)]), reads: 0, requests: 0 };
      this.observeNode(node);
      this.wake("actor:" + node.threadId);
      for (const [id, witness] of this.tools) if (witness?.parent === this.accepted.outer) this.wake("tool:" + id);
      return;
    }
    if (event.type === "system" && event.subtype === "task_notification") {
      const child = this.child;
      const outer = this.accepted?.outer;
      if (!child || !outer || event.task_id !== child.node.threadId || event.tool_use_id !== outer || child.node.runtimeClosed ||
          !["completed", "stopped", "failed"].includes(event.status)) return;
      let completed = event.status === "completed" && !child.signal.aborted;
      if (completed) {
        try { this.assertCurrent(); }
        catch (error) { if (!(error instanceof ServiceError)) throw error; completed = false; }
      }
      this.summaryRevoked = event.status === "completed" && !completed;
      child.abort.abort();
      child.node.runtimeClosed = true;
      child.node.status = completed ? "completed" : event.status === "failed" ? "failed" : "interrupted";
      this.observeNode(child.node);
      this.wake("root");
      for (const [id, witness] of this.tools) if (witness?.parent === outer) this.wake("tool:" + id);
      return;
    }
    if (this.rootAbort.signal.aborted || (event.parent_tool_use_id !== null && !validId(event.parent_tool_use_id))) return;
    const blocks = event.type === "assistant" && Array.isArray(event.message?.content) ? event.message.content :
      event.type === "stream_event" && event.event?.type === "content_block_start" ? [event.event.content_block] : [];
    for (const block of blocks) if (block?.type === "tool_use" && validId(block.id) && typeof block.name === "string") {
      if (this.tools.size >= 512 && !this.tools.has(block.id)) continue;
      const next = { name: block.name, parent: event.parent_tool_use_id };
      const old = this.tools.get(block.id);
      if (old === undefined) this.tools.set(block.id, next);
      else if (!old || old.name !== next.name || old.parent !== next.parent) this.tools.set(block.id, null);
      this.wake("tool:" + block.id);
    }
  }

  private childScope(actor: string): NativeActorScope | undefined {
    const child = this.child;
    if (!child || child.node.threadId !== actor || child.node.runtimeClosed || child.signal.aborted) return;
    try { this.assertCurrent(); }
    catch (error) { child.abort.abort(); if (!(error instanceof ServiceError)) throw error; else return; }
    return { sessionId: this.root, threadId: actor, parentThreadId: this.root, turnId: child.node.turnId, signal: child.signal };
  }

  async resolveModel(actor: string, signal: AbortSignal): Promise<NativeActorScope | undefined> {
    if (signal.aborted || this.rootAbort.signal.aborted) return;
    if (actor === this.root) {
      if (this.child && !this.child.node.runtimeClosed && !await this.awaitWitness("root", signal,
        () => this.child?.node.runtimeClosed ? true : undefined, lifetimeMs)) return;
      if (this.summaryRevoked) return;
      return { sessionId: this.root, threadId: this.root, turnId: this.turn, signal: this.rootAbort.signal };
    }
    if (!agentTaskId(actor) || !this.accepted) return;
    const observed = await this.awaitWitness("actor:" + actor, signal, () => this.child?.node.threadId === actor ? true : undefined);
    return observed ? this.childScope(actor) : undefined;
  }

  async resolveTool(caller: ToolCaller, signal: AbortSignal): Promise<NativeActorScope | undefined> {
    const { tool, toolUseId } = caller;
    if (typeof tool !== "string" || !validId(toolUseId)) return;
    const witness = await this.awaitWitness("tool:" + toolUseId, signal, () => this.tools.get(toolUseId));
    if (!witness || witness.name !== `mcp__teamswarm__${tool}` || this.tools.get(toolUseId) !== witness) return;
    if (witness.parent === null)
      return this.resolveModel(this.root, signal);
    if (!this.accepted || witness.parent !== this.accepted.outer || witness.name !== nativeReadTool) return;
    const actor = this.child?.node.threadId;
    return actor ? this.childScope(actor) : undefined;
  }

  private currentChild(scope: NativeToolScope) {
    const child = this.child;
    if (this.rootAbort.signal.aborted || !child || child.signal.aborted || child.node.runtimeClosed || scope.sessionId !== this.root ||
        scope.parentThreadId !== this.root || scope.threadId !== child.node.threadId || scope.turnId !== child.node.turnId)
      throw conflict("claude_probe_scope", "The Claude probe lease has ended.");
    try { this.assertCurrent(); } catch (error) { child.abort.abort(); throw error; }
    return child;
  }

  authorizeModelSend(scope: NativeToolScope) {
    if (!scope.parentThreadId) {
      if (this.summaryRevoked || this.rootAbort.signal.aborted || (this.child && !this.child.node.runtimeClosed))
        throw conflict("claude_probe_scope", "The current Claude probe cannot return a summary.");
      return;
    }
    const child = this.currentChild(scope);
    if (child.requests >= maxRequests) throw conflict("claude_probe_budget", "The Claude probe reached its model request limit.");
    child.requests++;
  }

  readArguments(scope: NativeToolScope, args: unknown) {
    const child = this.currentChild(scope);
    if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).some(key => !["path", "offset", "limit"].includes(key)))
      throw conflict("claude_probe_paths", "Use the declared Claude probe file paths.");
    const { path, offset = 0, limit = maxFileChars } = args as Record<string, unknown>;
    const canonical = typeof path === "string" ? WorkspaceAccess.relative(path) : "";
    if (!this.accepted?.paths.has(canonical)) throw conflict("claude_probe_paths", "Use the declared Claude probe file paths.");
    if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0 || offset > 2 * 1024 * 1024 ||
        typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > maxFileChars || child.reads >= maxReads)
      throw conflict("claude_probe_budget", "The Claude probe reached its file read limit.");
    child.reads++;
    return { path: canonical, offset, limit };
  }

  revoke() {
    this.rootAbort.abort();
    this.child?.abort.abort();
  }

  settled() { return !this.child || this.child.node.runtimeClosed === true; }
  permitsResult() { return !this.summaryRevoked; }

  processExited(confirmed: boolean, stopping: boolean) {
    const child = this.child;
    if (!child || child.node.runtimeClosed) return;
    child.node.status = confirmed && stopping ? "interrupted" : "unknown";
    child.node.runtimeClosed = confirmed;
    this.observeNode(child.node);
  }
}
