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

export interface AcpPackageOptions {
  prepare(input: { request: HarnessRequest; home: string; entry: string; env: NodeJS.ProcessEnv; bridge: string }): Promise<{
    args: string[]; env?: NodeJS.ProcessEnv; sessionParams?: Record<string, unknown>;
  }> | { args: string[]; env?: NodeJS.ProcessEnv; sessionParams?: Record<string, unknown> };
  validateConfig?(config: ExecutionConfig): void;
}
type Active = { child: ChildProcessWithoutNullStreams; rpc: AcpSession; done: Promise<HarnessResult>; finish(result: HarnessResult): Promise<void>; stopping: boolean; turnId: string };

/** Shared process/ACP driver. Packages configure the native program, never execute its tools. */
export class AcpHarness implements Harness {
  readonly id: string;
  readonly capabilities: Harness['capabilities'];
  private active = new Map<string, Active>();
  private opening = new Set<string>();
  private unconfirmed = new Map<string, ChildProcessWithoutNullStreams>();
  constructor(readonly manifest: HarnessManifest, private options: AcpPackageOptions) {
    this.id = manifest.id;
    this.capabilities = { sessions: true, resume: manifest.session.resume, streaming: true, dynamicTools: true, interrupt: true, nativeChecks: true, dispatchTracking: true, customModel: true, customProvider: true, protocol: manifest.models.preferredProtocol, isolation: String(manifest.description.isolation[process.platform] ?? manifest.description.isolation.default ?? 'Native permissions') };
  }
  get sessionScope() { return `${sessionStoreScope(nativeHome(this.id))}:acp:${this.manifest.packageVersion}`; }
  resources() { return [...[...this.active].map(([id, a]) => [id, a.child] as const), ...this.unconfirmed].flatMap(([id, child]) => child.pid ? [{ id: `${this.id}:${id}`, pid: child.pid, sessions: 1 }] : []); }
  async inspect() {
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
      if (!request.isolatedWorkspace) throw new Error('native_workspace_required: assign an isolated member working directory.');
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
    let spawned: ChildProcessWithoutNullStreams | undefined;
    const turnId = randomUUID();
    try {
      const entry = nativeEntry(this.id), env = childEnvironment(request);
      const launch = await this.options.prepare({ request, home, entry, env, bridge: bridge.url });
      request.onSession(id, { harness: this.id, model: request.config.model, protocol: request.config.protocol, nativeCommands: true, nativePermissions: request.config.permissions ?? null, workspace: request.workspace });
      request.onTurn(turnId); request.onDispatch?.();
      const child = spawned = await spawnOwned(/\.[cm]?js$/i.test(entry) ? process.execPath : entry, [...(/\.[cm]?js$/i.test(entry) ? [entry] : []), ...launch.args], { cwd: request.workspace, env: launch.env ?? env, windowsHide: true, detached: process.platform !== 'win32' });
      const receiptFile = path.join(home, `${turnId}.json`);
      const receipt = (result?: HarnessResult) => {
        writeFileSync(receiptFile + '.tmp', JSON.stringify({ sessionId: id, turnId, pid: child.pid, result, updatedAt: new Date().toISOString() }), { mode: 0o600 });
        renameSync(receiptFile + '.tmp', receiptFile);
      };
      receipt();
      const emit = (type: string, data: Record<string, unknown>) => request.onEvent({ type, data: redact(data, request.config.credentialEnv) });
      const observations = new CommandObservations(this.id, path.join(home, turnId, 'commands'), emit, 'acp');
      let terminal: HarnessResult | undefined, settle!: (result: HarnessResult) => void;
      const done = new Promise<HarnessResult>(resolve => { settle = resolve; });
      let finishing = false;
      const finish = async (result: HarnessResult) => {
        if (finishing) return; finishing = true;
        terminal = result;
        rpc.close();
        let stopped = await confirmOwnedExit(child);
        if (!stopped) stopped = await terminateNative(child);
        if (!stopped) terminal = { ...result, status: 'unknown', error: 'Native process termination could not be confirmed.' };
        try { observations.close(result.status === 'interrupted'); receipt(terminal); }
        catch { terminal = { status: 'unknown', text: result.text, error: 'Native execution receipt could not be saved.' }; }
        await bridge.close();
        if (stopped) this.active.delete(id);
        settle(terminal);
      };
      const rpc = new AcpSession(child, request, bridge.url, path.join(home, 'native-session.json'), (event: any) => {
        observations.observe(event);
        emit('native.event', { harness: this.id, ...event });
        if (event.type === 'session') emit('native.session', { id: event.id });
        if (event.event?.sessionUpdate === 'agent_message_chunk') emit('message.delta', { text: event.event.content?.text ?? '' });
      }, result => { void finish(result); }, { name: this.manifest.name, eventType: 'acp.event', prompt: `${request.instructions}\n\n${request.input}`, sessionParams: launch.sessionParams });
      this.active.set(id, { child, rpc, done, finish, stopping: false, turnId });
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
      if (spawned && !await confirmOwnedExit(spawned) && !await terminateNative(spawned)) {
        this.unconfirmed.set(id, spawned);
        await bridge.close();
        throw new HarnessTransportError(`Native startup failed and process termination could not be confirmed: ${(error as Error).message}`);
      }
      await bridge.close(); throw error;
    } finally { this.opening.delete(id); }
  }
  async interrupt(id: string, turnId: string) {
    const a = this.active.get(id); if (!a || a.turnId !== turnId) return;
    a.stopping = true; a.rpc.cancel();
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
    for (const [id, child] of [...this.unconfirmed, ...[...this.active].map(([id, a]) => [id, a.child] as const)]) {
      if (await confirmOwnedExit(child) || await terminateNative(child)) { this.unconfirmed.delete(id); this.active.delete(id); }
    }
  }
}
