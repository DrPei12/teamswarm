import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { conflict, ServiceError } from "../../errors.js";
import type { HarnessRequest, NativeActorScope, NativeExecutionNode, NativeToolScope } from "../types.js";
import { WorkspaceAccess } from "../workspace-access.js";

export const openCodeReadProbeAgent = "teamswarm-read-probe";
export const openCodeReceiptArgument = "_teamswarmReceipt";
const nativePrefix = "teamswarm_";
const maxReads = 4, maxReadChars = 2000, maxModelRequests = 5;
const lifetimeMs = 25000, registrationMs = 3000;
const maxEnvelope = 32 * 1024, maxClaims = 1024;

type Args = Record<string, unknown>;
type Task = { callId: string; paths: ReadonlySet<string>; closed: boolean };
type Child = { node: NativeExecutionNode; partId: string; abort: AbortController; signal: AbortSignal;
  reads: number; modelRequests: number };
const record = (value: unknown): value is Args => !!value && typeof value === "object" && !Array.isArray(value);
const id = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value);

function canonicalJson(value: unknown, depth = 0): string {
  if (depth > 32) throw new Error("OpenCode tool arguments are too deeply nested.");
  if (value === null || typeof value === "boolean" || typeof value === "string" ||
      typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value))
    return "[" + value.map(item => canonicalJson(item, depth + 1)).join(",") + "]";
  if (value && typeof value === "object") {
    const fields = value as Record<string, unknown>;
    return "{" + Object.keys(fields).sort().map(key => JSON.stringify(key) + ":" + canonicalJson(fields[key], depth + 1)).join(",") + "}";
  }
  throw new Error("OpenCode tool arguments must be JSON data.");
}

function scopeError() {
  return conflict("opencode_probe_scope", "The OpenCode request does not belong to the current probe lease.");
}

export class OpenCodeProbeAuthority {
  private readonly lease = randomUUID();
  private readonly secret = randomBytes(32).toString("hex");
  private readonly rootAbort = new AbortController();
  private readonly listeners = new Set<() => void>();
  private readonly consumed = new Set<string>();
  private root?: string;
  private signerReady = false;
  private task?: Task;
  private child?: Child;
  private summaryRevoked = false;

  constructor(private rootTurn: string, private assertCurrent: () => void, private publish: HarnessRequest["onEvent"], private readonly rootOnly = false) {}

  setRoot(nativeSessionId: string) {
    if (!id(nativeSessionId) || this.root && this.root !== nativeSessionId || this.rootAbort.signal.aborted) throw scopeError();
    this.root = nativeSessionId;
  }

  private verify(receipt: unknown) {
    if (typeof receipt !== "string" || receipt.length > maxEnvelope) throw scopeError();
    const [raw, mac, extra] = receipt.split(".");
    if (extra !== undefined || !/^[A-Za-z0-9_-]+$/.test(raw ?? "") || !/^[0-9a-f]{64}$/.test(mac ?? "") ||
        !timingSafeEqual(Buffer.from(mac, "hex"), createHmac("sha256", this.secret).update(raw).digest())) throw scopeError();
    try {
      const value: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
      if (record(value) && value.lease === this.lease) return value;
    } catch { /* Authenticated but malformed requests receive the same denial. */ }
    throw scopeError();
  }

  private assertChildCurrent(child: Child) {
    if (this.rootAbort.signal.aborted || child.node.runtimeClosed || child.signal.aborted) throw scopeError();
    try { this.assertCurrent(); }
    catch (error) { child.abort.abort(); throw error; }
  }

  private observe(child: Child) { this.publish({ type: "execution.node", data: { ...child.node } }); }
  private notify() { for (const listener of this.listeners) listener(); }

  private approvedPaths(value: unknown) {
    if (!record(value) || Object.keys(value).some(key => !["description", "subagent_type", "prompt"].includes(key)) ||
        value.subagent_type !== openCodeReadProbeAgent || typeof value.description !== "string" || !value.description.trim() ||
        value.description.length > 200 || typeof value.prompt !== "string" || value.prompt.length > 12000)
      throw conflict("opencode_probe_paths", "Assign an exact foreground OpenCode read probe.");
    let prompt: unknown;
    try { prompt = JSON.parse(value.prompt); } catch { prompt = undefined; }
    if (!record(prompt) || Object.keys(prompt).some(key => key !== "question" && key !== "paths") ||
        typeof prompt.question !== "string" || !prompt.question.trim() || prompt.question.length > 1000 ||
        !Array.isArray(prompt.paths) || prompt.paths.length < 1 || prompt.paths.length > 4 ||
        prompt.paths.some(file => typeof file !== "string" || !file || file.length > 2000))
      throw conflict("opencode_probe_paths", "Use a question and one to four exact file paths in the probe prompt.");
    const paths = new Set<string>(prompt.paths.map(file => WorkspaceAccess.relative(file)));
    if (paths.size !== prompt.paths.length) throw conflict("opencode_probe_paths", "Use distinct probe paths.");
    return paths;
  }

  acceptControl(receipt: unknown) {
    const envelope = this.verify(receipt);
    if (envelope.stage === "signer_ready") {
      if (this.rootAbort.signal.aborted || envelope.nativeSource !== "plugin.initialize") throw scopeError();
      this.signerReady = true;
      this.notify();
      return;
    }
    if (this.rootOnly || !this.signerReady || !this.root || envelope.rootSession !== this.root || !id(envelope.taskCallId)) throw scopeError();
    if (envelope.stage === "task_before") {
      if (this.task || this.rootAbort.signal.aborted || envelope.nativeSource !== "tool.execute.before") throw scopeError();
      const paths = this.approvedPaths(envelope.args);
      this.assertCurrent();
      this.task = { callId: envelope.taskCallId, paths, closed: false };
      return;
    }
    const task = this.task;
    if (!task || task.closed || envelope.taskCallId !== task.callId) throw scopeError();
    if (envelope.stage === "child_registered") {
      if (this.child || this.rootAbort.signal.aborted || envelope.nativeSource !== "message.part.updated" ||
          envelope.nativeStatus !== "running" || envelope.parentId !== this.root || !id(envelope.partId) ||
          !id(envelope.childId) || envelope.childId === this.root) throw scopeError();
      this.assertCurrent();
      const node: NativeExecutionNode = { threadId: envelope.childId, parentThreadId: this.root,
        turnId: `${this.rootTurn}:${envelope.childId}`, status: "running", runtimeClosed: false };
      const abort = new AbortController();
      this.child = { node, partId: envelope.partId, abort,
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(lifetimeMs)]), reads: 0, modelRequests: 0 };
      this.observe(this.child);
      this.notify();
      return;
    }
    if (envelope.stage !== "task_after" || envelope.nativeSource !== "tool.execute.after") throw scopeError();
    const child = this.child;
    if (!child) {
      if (envelope.childId !== undefined || envelope.partId !== undefined) throw scopeError();
      task.closed = true;
      this.notify();
      return;
    }
    if (envelope.childId !== child.node.threadId || envelope.partId !== child.partId) throw scopeError();
    let completed = true;
    try { this.assertChildCurrent(child); }
    catch (error) { if (!(error instanceof ServiceError)) throw error; completed = false; }
    this.summaryRevoked = !completed;
    child.abort.abort();
    child.node.status = completed ? "completed" : "interrupted";
    child.node.runtimeClosed = true;
    task.closed = true;
    this.observe(child);
    this.notify();
    if (!completed) throw scopeError();
  }

  private async awaitObservation(check: () => boolean, signal: AbortSignal, milliseconds: number) {
    const current = AbortSignal.any([signal, this.rootAbort.signal]);
    if (current.aborted) return false;
    if (check()) return true;
    if (this.listeners.size >= 4) return false;
    return new Promise<boolean>(resolve => {
      const finish = (result: boolean) => {
        clearTimeout(timer);
        current.removeEventListener("abort", cancel);
        this.listeners.delete(notify);
        resolve(result && !current.aborted);
      };
      const notify = () => { if (check()) finish(true); };
      const cancel = () => finish(false);
      const timer = setTimeout(cancel, milliseconds);
      current.addEventListener("abort", cancel, { once: true });
      this.listeners.add(notify);
    });
  }

  waitSignerReady(signal: AbortSignal) {
    return this.awaitObservation(() => this.signerReady, signal, registrationMs);
  }

  private rootScope(): NativeActorScope {
    return { sessionId: this.root, threadId: this.root, turnId: this.rootTurn, signal: this.rootAbort.signal };
  }
  private childScope(child: Child): NativeActorScope {
    return { sessionId: this.root, threadId: child.node.threadId, parentThreadId: this.root,
      turnId: child.node.turnId, signal: child.signal };
  }

  async ownModelScope(actor: string, parent: string | undefined, signal: AbortSignal): Promise<NativeActorScope | undefined> {
    if (!this.root || !this.signerReady || !id(actor) || signal.aborted || this.rootAbort.signal.aborted || this.summaryRevoked) return;
    if (actor === this.root) {
      if (parent !== undefined) return;
      if (this.task && !this.task.closed && !await this.awaitObservation(() => this.task?.closed === true, signal, lifetimeMs)) return;
      return !signal.aborted && !this.rootAbort.signal.aborted && !this.summaryRevoked ? this.rootScope() : undefined;
    }
    if (parent !== this.root || !this.task || this.task.closed) return;
    if (!this.child && !await this.awaitObservation(() => !!this.child || this.task?.closed === true, signal, registrationMs)) return;
    const child = this.child;
    if (!child || child.node.threadId !== actor || signal.aborted) return;
    try { this.assertChildCurrent(child); }
    catch (error) { if (error instanceof ServiceError) return; throw error; }
    return this.childScope(child);
  }

  authorizeModelSend(scope: NativeToolScope) {
    if (!this.root || scope.sessionId !== this.root || this.rootAbort.signal.aborted) throw scopeError();
    if (scope.threadId === this.root) {
      if (scope.parentThreadId || scope.turnId !== this.rootTurn || this.summaryRevoked || this.task && !this.task.closed) throw scopeError();
      this.assertCurrent();
      return;
    }
    const child = this.child;
    if (!child || scope.threadId !== child.node.threadId || scope.parentThreadId !== this.root || scope.turnId !== child.node.turnId) throw scopeError();
    this.assertChildCurrent(child);
    if (child.modelRequests >= maxModelRequests) throw conflict("opencode_probe_budget", "The OpenCode probe reached its model request limit.");
    child.modelRequests++;
  }

  verifyTool(name: string, value: unknown, signal: AbortSignal): { scope: NativeActorScope; input: Args; callId: string } {
    if (!this.root || !this.signerReady || signal.aborted || this.rootAbort.signal.aborted || !record(value)) throw scopeError();
    const { [openCodeReceiptArgument]: receipt, ...input } = value;
    const envelope = this.verify(receipt);
    if (envelope.stage !== "mcp" || !id(envelope.sessionID) || !id(envelope.callID) || envelope.tool !== nativePrefix + name ||
        envelope.argsHash !== createHash("sha256").update(canonicalJson(input)).digest("hex")) throw scopeError();
    const claim = JSON.stringify([envelope.sessionID, envelope.callID]);
    if (this.consumed.size >= maxClaims || this.consumed.has(claim)) throw scopeError();

    let scope: NativeActorScope, verifiedInput = input;
    if (envelope.sessionID === this.root) {
      if (this.summaryRevoked) throw scopeError();
      this.assertCurrent();
      scope = this.rootScope();
    } else {
      const child = this.child;
      if (!child || envelope.sessionID !== child.node.threadId || name !== "team_read_file" || !child.modelRequests) throw scopeError();
      this.assertChildCurrent(child);
      const { path, offset = 0, limit = maxReadChars } = input;
      const relative = typeof path === "string" && path.length <= 2000 ? WorkspaceAccess.relative(path) : "";
      if (!this.task?.paths.has(relative) || Object.keys(input).some(key => !["path", "offset", "limit"].includes(key)))
        throw conflict("opencode_probe_paths", "Read an exact file path assigned to this OpenCode probe.");
      if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0 || offset > 2 * 1024 * 1024 ||
          typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > maxReadChars || child.reads >= maxReads)
        throw conflict("opencode_probe_budget", "The OpenCode probe reached its file read limit.");
      child.reads++;
      verifiedInput = { path: relative, offset, limit };
      scope = this.childScope(child);
    }
    this.consumed.add(claim);
    const callId = createHash("sha256").update(this.lease).update(claim).digest("hex");
    return { scope, input: verifiedInput, callId };
  }

  revoke() {
    this.rootAbort.abort();
    this.child?.abort.abort();
  }
  settled() { return !this.task || this.task.closed; }
  permitsResult() { return !this.summaryRevoked; }

  finalize(confirmedExit: boolean, stopping = false) {
    this.revoke();
    const child = this.child;
    if (this.task && !this.task.closed) this.summaryRevoked = true;
    if (this.task && confirmedExit) this.task.closed = true;
    if (!child || child.node.runtimeClosed || child.node.status === "unknown" && !confirmedExit) return;
    child.node.status = confirmedExit && stopping ? "interrupted" : "unknown";
    child.node.runtimeClosed = confirmedExit;
    this.observe(child);
  }

  signerSource(controlUrl: string, isolatedEnv?: NodeJS.ProcessEnv) {
    const url = new URL(controlUrl);
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.username || url.password)
      throw new Error("OpenCode probe control requires a local endpoint.");
    // A detached checker may read files. Its independent process environment must never receive the signing key.
    const variable = "TEAMSWARM_OPENCODE_SIGNER_KEY";
    if (this.rootOnly && !isolatedEnv) throw new Error("A review signer needs its private native environment.");
    if (isolatedEnv) isolatedEnv[variable] = this.secret;
    return `import { createHash, createHmac } from "node:crypto";
const lease = ${JSON.stringify(this.lease)}, key = ${isolatedEnv ? `process.env.${variable}` : JSON.stringify(this.secret)};
${isolatedEnv ? `if (!key) throw new Error("The signer key is unavailable.");` : ""}
const control = ${JSON.stringify(url.href)}, reserved = ${JSON.stringify(openCodeReceiptArgument)};
${canonicalJson.toString()}
function sign(value) {
  const raw = Buffer.from(JSON.stringify({ lease, ...value })).toString("base64url");
  return raw + "." + createHmac("sha256", key).update(raw).digest("hex");
}
async function publish(value) {
  const response = await fetch(control, { method: "POST", redirect: "error", signal: AbortSignal.timeout(4000),
    headers: { "content-type": "application/json" }, body: JSON.stringify({ receipt: sign(value) }) });
  const accepted = await response.json();
  if (!response.ok || accepted.ok !== true) throw new Error("The OpenCode probe control receipt was denied.");
}
export default async function () {
  await publish({ stage: "signer_ready", nativeSource: "plugin.initialize" });
  let task;
  return {
    async "tool.execute.before"(input, output) {
      ${this.rootOnly ? `if (!input.tool.startsWith(${JSON.stringify(nativePrefix)})) throw new Error("Native tools are disabled during command review.");` : ""}
      if (input.tool === "task") {
        if (task) throw new Error("This OpenCode turn already opened a probe.");
        await publish({ stage: "task_before", nativeSource: "tool.execute.before", rootSession: input.sessionID,
          taskCallId: input.callID, args: output.args });
        task = { sessionID: input.sessionID, callID: input.callID };
      } else if (input.tool.startsWith(${JSON.stringify(nativePrefix)})) {
        const { [reserved]: ignored, ...args } = output.args;
        const argsHash = createHash("sha256").update(canonicalJson(JSON.parse(JSON.stringify(args)))).digest("hex");
        output.args[reserved] = sign({ stage: "mcp", sessionID: input.sessionID, callID: input.callID, tool: input.tool, argsHash });
      }
    },
    event({ event }) {
      if (!task || task.registration || event.type !== "message.part.updated") return;
      const part = event.properties?.part, meta = part?.state?.metadata;
      if (part?.type !== "tool" || part.tool !== "task" || part.state.status !== "running" ||
          part.sessionID !== task.sessionID || part.callID !== task.callID || !meta?.sessionId || meta.parentSessionId !== part.sessionID) return;
      task.partId = part.id;
      task.registration = publish({ stage: "child_registered", nativeSource: event.type, nativeStatus: part.state.status,
        rootSession: part.sessionID, parentId: meta.parentSessionId, taskCallId: part.callID, partId: part.id, childId: meta.sessionId });
      void task.registration.catch(() => {});
    },
    async "tool.execute.after"(input, output) {
      if (input.tool !== "task") return;
      if (!task || input.sessionID !== task.sessionID || input.callID !== task.callID) throw new Error("The OpenCode task is outside the current probe.");
      await task.registration;
      await publish({ stage: "task_after", nativeSource: "tool.execute.after", rootSession: input.sessionID,
        taskCallId: input.callID, partId: task.partId, childId: output?.metadata?.sessionId });
    },
  };
}
`;
  }
}
