import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { HarnessManifest } from '@team/contracts/harness-catalog';
import type { ExecutionConfig, Harness, HarnessRequest, HarnessResult } from '../types.js';
import { HarnessTransportError } from '../types.js';
import { AcpSession } from './opencode-acp.js';
import { spawnOwned, confirmOwnedExit } from './owned-process.js';
import { childEnvironment, nativeEntry, nativeHome, toolBridge, terminateNative } from './native-support.js';
import { validateNativePermissions } from './permissions.js';
import { executionCompatibility } from '../model-routing.js';
import { CommandObservations } from './command-observations.js';
import { sessionStoreScope } from './session-scope.js';
import { redact } from '../redact.js';
import { inspectExecution, type PreflightInput } from './preflight.js';
import { prepareExecutionEnvironment } from './execution-environment.js';
import { packageFor } from './device-tools.js';
import { systemBootTime, rebootConfirmsTermination } from './native-recovery.js';
import { declaredPermissions } from "./admission.js";
import { NativeTranscript } from './native-transcript.js';

export interface AcpPackageOptions {
  classifyResult?: (result: HarnessResult) => HarnessResult;
  failureUpdate?: (update: Record<string, any>) => string | undefined;
  configureSession?: (request: HarnessRequest, call: (method: string, params: unknown) => Promise<any>, sessionId: string, description: any) => Promise<Record<string, unknown>>;
  prepare(input: { request: HarnessRequest; home: string; entry: string; env: NodeJS.ProcessEnv; bridge: string }): Promise<{
    args: string[]; env?: NodeJS.ProcessEnv; sessionParams?: Record<string, unknown>;
  }> | { args: string[]; env?: NodeJS.ProcessEnv; sessionParams?: Record<string, unknown> };
  validateConfig?(config: ExecutionConfig): void;
  allowsSharedWorkspace?(input: PreflightInput): boolean;
}
type OwnedAcp = { resourceId: string; child: ChildProcessWithoutNullStreams; observe: HarnessRequest["onEvent"]; released?: boolean };
type Active = OwnedAcp & { rpc: AcpSession; done: Promise<HarnessResult>; finish(result: HarnessResult): Promise<void>;
  revoke(): Promise<void>; stopping: boolean; turnId: string };

/** Shared process/ACP driver. Packages configure the native program, never execute its tools. */
export class AcpHarness implements Harness {
  readonly id: string;
  readonly capabilities: Harness['capabilities'];
  private active = new Map<string, Active>();
  private opening = new Set<string>();
  private unconfirmed = new Map<string, OwnedAcp>();
  constructor(readonly manifest: HarnessManifest, private options: AcpPackageOptions) {
    this.id = manifest.id;
    this.capabilities = { sessions: true, resume: manifest.session.resume, streaming: true, dynamicTools: true, interrupt: true, nativeChecks: true, dispatchTracking: true, customModel: true, customProvider: !manifest.models.nativeOnly, ...(manifest.models.preferredProtocol ? { protocol: manifest.models.preferredProtocol } : {}), isolation: String(manifest.description.isolation[process.platform] ?? manifest.description.isolation.default ?? 'Native permissions') };
  }
  permissionOptions() {
    return declaredPermissions(this.manifest) ?? { defaultId: "", options: [] };
  }
  get sessionScope() { return `${sessionStoreScope(nativeHome(this.id))}:acp:${this.manifest.packageVersion}`; }
  resources() { return [...this.active.values(), ...this.unconfirmed.values()]
    .flatMap(owner => owner.child.pid && !owner.released ? [{ id: owner.resourceId, pid: owner.child.pid, sessions: 1 }] : []); }
  private resourceEvent(owner: OwnedAcp, status: "acquired" | "released" | "unconfirmed") {
    if (owner.released || !owner.child.pid) return;
    owner.observe({ type: `resource.${status}`, data: { id: owner.resourceId, pid: owner.child.pid, scope: "attempt" } });
    if (status === "released") owner.released = true;
  }
  async reconcileResources() {
    for (const [id, owner] of this.unconfirmed) {
      if (await confirmOwnedExit(owner.child) && this.unconfirmed.get(id) === owner) {
        this.resourceEvent(owner, "released");
        this.unconfirmed.delete(id);
      }
    }
  }
  async inspect(): Promise<Record<string, unknown>> {
    try {
      const entry = nativeEntry(this.id), pkg = this.manifest.runtime && packageFor(entry, this.manifest.runtime.package);
      return { id: this.id, available: true, installed: true, entry, version: pkg?.version ?? null, testedVersion: !!pkg && this.manifest.runtime!.testedVersions.includes(pkg.version), capabilities: this.capabilities };
    } catch (error) { return { id: this.id, available: false, installed: false, error: (error as Error).message }; }
  }
  validateConfig(config: ExecutionConfig) {
    if (config.harness !== this.id) throw new Error('Harness identity mismatch.');
    const issues = executionCompatibility(config);
    if (issues.includes('missing_configuration')) throw new Error('Select a model and its connection for this Harness in Team capabilities.');
    if (issues.length) throw new Error(issues.join(', '));
    validateNativePermissions(config); nativeEntry(this.id); this.options.validateConfig?.(config);
  }
  async preflight(request: PreflightInput) {
    try {
      this.validateConfig(request.config);
      if (!request.isolatedWorkspace && !this.options.allowsSharedWorkspace?.(request)) throw new Error('native_workspace_required: assign an isolated member working directory.');
      const identity = inspectExecution(request, nativeEntry(this.id));
      const environment = prepareExecutionEnvironment(request.scratchDirectory, request.requirements);
      return { passed: true, identity, environment, modelRequests: 0, nativeRuntime: this.id, isolation: this.capabilities.isolation };
    } catch (error) { return { passed: false, error: (error as Error).message, modelRequests: 0 }; }
  }
  async execute(request: HarnessRequest): Promise<HarnessResult> {
    this.validateConfig(request.config);
    if (request.workspaceBoundary) throw new Error('This ACP package requires a private member workspace; shared write boundaries are unavailable.');
    if (request.sessionId && !this.manifest.session.resume) throw new Error('This Harness package does not support session continuation.');
    const id = request.sessionId ?? randomUUID();
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new Error('Invalid session identity.');
    if (this.active.has(id) || this.opening.has(id) || this.unconfirmed.has(id)) throw new Error('A turn is already active in this session.');
    const home = path.join(nativeHome(this.id), id), bindingFile = path.join(home, 'binding.json');
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const binding = JSON.stringify({ config: request.modelRoute?.sourceConfig ?? request.config, workspace: path.resolve(request.workspace), packageVersion: this.manifest.packageVersion, tools: request.tools });
    if (request.sessionId) {
      if (!existsSync(bindingFile) || readFileSync(bindingFile, 'utf8') !== binding) throw new Error('Session configuration changed; start a new native session.');
    } else writeFileSync(bindingFile, binding, { mode: 0o600 });
    this.opening.add(id);
    const bridge = await toolBridge(request).catch(error => { this.opening.delete(id); throw error; });
    let owner: OwnedAcp | undefined;
    let draining: Promise<void> | undefined;
    const revoke = () => draining ??= Promise.all([bridge.close(), request.modelRoute?.release?.()]).then(() => {});
    const turnId = randomUUID();
    try {
      const entry = nativeEntry(this.id), env = childEnvironment(request);
      const launch = await this.options.prepare({ request, home, entry, env, bridge: bridge.url });
      request.onSession(id, { harness: this.id, model: request.config.model, protocol: request.config.protocol, nativeCommands: true, nativePermissions: request.config.permissions ?? null, workspace: request.workspace,
        nativeSession: request.sessionId ? 'inherited' : 'unconfirmed' });
      request.onTurn(turnId);
      const child = await spawnOwned(/\.[cm]?js$/i.test(entry) ? process.execPath : entry, [...(/\.[cm]?js$/i.test(entry) ? [entry] : []), ...launch.args], { cwd: request.workspace, env: launch.env ?? env, windowsHide: true, detached: process.platform !== 'win32' });
      const group = owner = { resourceId: `${this.id}:${turnId}`, child, observe: request.onEvent };
      this.resourceEvent(group, "acquired");
      const receiptFile = path.join(home, `${turnId}.json`);
      const receipt = (result?: HarnessResult) => {
        writeFileSync(receiptFile + '.tmp', JSON.stringify({ sessionId: id, turnId, pid: child.pid, result, updatedAt: new Date().toISOString() }), { mode: 0o600 });
        renameSync(receiptFile + '.tmp', receiptFile);
      };
      receipt();
      const emit = (type: string, data: Record<string, unknown>) => request.onEvent({ type, data: redact(data, request.config.credentialEnv) });
      const observations = new CommandObservations(this.id, path.join(home, turnId, 'commands'), emit, 'acp');
      const transcript = new NativeTranscript(this.id, turnId, emit);
      let terminal: HarnessResult | undefined, settle!: (result: HarnessResult) => void;
      const done = new Promise<HarnessResult>(resolve => { settle = resolve; });
      let finishing = false, sessionSeen = false, nativeFailure: string | undefined;
      const finish = async (result: HarnessResult) => {
        if (finishing) return; finishing = true;
        result = this.options.classifyResult?.(result) ?? result;
        if (nativeFailure && result.status === 'completed')
          result = { ...result, status: 'failed', error: nativeFailure };
        terminal = result;
        let revoked = true;
        const drained = revoke().catch(() => { revoked = false; });
        rpc.close();
        let stopped = await confirmOwnedExit(child);
        if (!stopped) stopped = await terminateNative(child);
        if (!stopped) stopped = await confirmOwnedExit(child);
        if (!stopped) terminal = { ...result, status: 'unknown', error: 'Native process termination could not be confirmed.' };
        if (stopped && request.sessionId && !sessionSeen && result.status !== 'interrupted')
          emit('session.native_unavailable', { harness: this.id });
        await drained;
        if (!revoked) terminal = { ...terminal, status: 'unknown', error: 'Native execution leases could not finish draining.' };
        if (!stopped) this.unconfirmed.set(id, group);
        this.active.delete(id);
        this.resourceEvent(group, stopped ? "released" : "unconfirmed");
        try { observations.close(result.status === 'interrupted'); transcript.finish(terminal.status); receipt(terminal); }
        catch { terminal = { status: 'unknown', text: result.text, error: 'Native execution receipt could not be saved.' }; }
        settle(terminal);
      };
      const rpc = new AcpSession(child, request, bridge.url, path.join(home, 'native-session.json'), (event: any) => {
        if (event.type === 'acp.event')
          nativeFailure = this.options.failureUpdate?.(event.event) ?? nativeFailure;
        observations.observe(event);
        transcript.observe(event);
        emit('native.event', { harness: this.id, ...event });
        if (event.type === 'session') {
          sessionSeen = true;
          if (this.options.configureSession) request.onSession(id, { harness: this.id, model: event.model, effort: event.effort, nativeSessionId: event.id, nativeCommands: true, nativePermissions: request.config.permissions ?? null });
          emit('native.session', { id: event.id });
          emit('session.native', { harness: this.id, nativeSessionId: event.id });
        }
        if (event.event?.sessionUpdate === 'usage_update') {
          const used = event.event.used, capacity = event.event.size;
          if (Number.isFinite(used) && used >= 0 && Number.isFinite(capacity) && capacity > 0)
            emit('context.usage', { inputTokens: used, outputTokens: 0, contextWindowTokens: capacity });
        }
        if (event.event?.sessionUpdate === 'agent_message_chunk') emit('message.delta', { text: event.event.content?.text ?? '' });
      }, result => { void finish(result); }, { name: this.manifest.name, eventType: 'acp.event', prompt: `${request.instructions}\n\n${request.input}`, sessionParams: launch.sessionParams,
        configure: this.options.configureSession ? (call, sessionId, description) => this.options.configureSession!(request, call, sessionId, description) : undefined,
        denyNativePermissions: request.config.access === 'read-only' && !(this.id === 'antigravity' && request.modelRoute),
      });
      this.active.set(id, Object.assign(group, { rpc, done, finish, revoke, stopping: false, turnId }));
      child.stdin.on('error', () => {});
      child.stderr.resume();
      const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
      lines.on('line', line => {
        try { rpc.receive(JSON.parse(line)); }
        catch (error) { void finish({ status: 'unknown', text: '', error: `Native protocol failed: ${(error as Error).message}` }); }
      });
      child.on('error', () => { void finish({ status: 'failed', text: '', error: 'Native process could not start.' }); });
      child.on('exit', () => { if (!terminal) void finish({ status: this.active.get(id)?.stopping ? 'interrupted' : 'unknown', text: '', error: 'Native process ended before its terminal response.' }); });
      void rpc.start();
      return await done;
    } catch (error) {
      const drained = revoke().catch(() => false);
      if (owner) {
        if (!await confirmOwnedExit(owner.child) && !await terminateNative(owner.child)) {
          this.unconfirmed.set(id, owner);
          this.resourceEvent(owner, "unconfirmed");
          await drained;
          throw new HarnessTransportError(`Native startup failed and process termination could not be confirmed: ${(error as Error).message}`);
        }
        this.resourceEvent(owner, "released");
      }
      if (await drained === false) throw new HarnessTransportError("Native startup failed before the execution leases drained.");
      throw error;
    } finally { this.opening.delete(id); }
  }
  async interrupt(id: string, turnId: string) {
    const a = this.active.get(id); if (!a || a.turnId !== turnId) return;
    a.stopping = true; a.rpc.cancel();
    void a.revoke().catch(() => {});
    const ended = await Promise.race([a.done.then(() => true), new Promise<boolean>(resolve => { const timer = setTimeout(() => resolve(false), 3000); timer.unref(); })]);
    if (!ended && !await terminateNative(a.child)) await a.finish({ status: 'unknown', text: '', error: 'Native cancellation could not confirm process termination.' });
    await a.done;
  }
  async reconcile(sessionId: string, turnId: string): Promise<HarnessResult> {
    if (![sessionId, turnId].every(v => /^[a-zA-Z0-9_-]{1,128}$/.test(v))) throw new Error('Invalid execution reference.');
    if (this.active.has(sessionId) || this.opening.has(sessionId) || this.unconfirmed.has(sessionId)) return { status: 'unknown', text: '', error: 'Native execution is still active.' };
    const file = path.join(nativeHome(this.id), sessionId, `${turnId}.json`);
    if (!existsSync(file)) return { status: 'unknown', text: '', error: 'No durable native execution receipt.' };
    const receipt = JSON.parse(readFileSync(file, 'utf8'));
    if (receipt.sessionId !== sessionId || receipt.turnId !== turnId) throw new Error('Native receipt identity mismatch.');
    if (receipt.result && receipt.result.status !== 'unknown') return receipt.result;
    if (rebootConfirmsTermination(receipt.updatedAt, await systemBootTime())) return { status: 'interrupted', text: receipt.result?.text ?? '', error: 'The device restarted after this execution.' };
    return receipt.result ?? { status: 'unknown', text: '', error: 'Native execution ended without an observed terminal response.' };
  }
  async close() {
    await Promise.all([...this.active].map(([id, a]) => this.interrupt(id, a.turnId)));
    for (const [id, owner] of [...this.unconfirmed, ...this.active]) {
      if (await confirmOwnedExit(owner.child) || await terminateNative(owner.child)) {
        this.resourceEvent(owner, "released");
        this.unconfirmed.delete(id);
        this.active.delete(id);
      }
    }
  }
}
