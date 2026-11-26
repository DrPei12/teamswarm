import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import type { HarnessRequest } from "../types.js";
import { confirmOwnedExit, ownedWindowsExitEvidence, requestOwnedJobStop, sampleWindowsProcesses } from "./owned-process.js";
import { terminateNative, type toolEndpoint, type ToolCaller } from "./native-support.js";

export async function terminateRetainedProcess(child: ChildProcessWithoutNullStreams): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return confirmOwnedExit(child);
  const controlled = requestOwnedJobStop(child);
  if (!controlled) {
    if (process.platform !== "win32") return terminateNative(child);
    // A numeric-PID tree walk cannot establish ownership of a stopped supervisor's descendants.
    child.kill();
    return false;
  }
  const exited = await new Promise<boolean>(resolve => {
    const finish = (exited: boolean) => { clearTimeout(timer); child.off("close", closed); resolve(exited); };
    const closed = () => finish(true);
    const timer = setTimeout(() => finish(false), 6500);
    child.once("close", closed);
  });
  return exited && await confirmOwnedExit(child);
}

export class RetainedProcess {
  readonly lines;
  readonly exited: Promise<boolean>;
  idleSince: number | undefined;
  lastResultIndex = -1;
  initialization?: Record<string, any>;
  nextRpcId = 0;
  readonly retiredToolUses = new Set<string>();
  private stopping?: Promise<boolean>;
  private releaseReason?: string;
  private reportedRelease = false;
  private reportedUnconfirmed = false;
  closed = false;

  constructor(
    readonly child: ChildProcessWithoutNullStreams,
    readonly endpoint: Awaited<ReturnType<typeof toolEndpoint>> | undefined,
    readonly binding: string,
    private observe: HarnessRequest["onEvent"],
    private confirmExit = confirmOwnedExit,
    readonly id = randomUUID(),
  ) {
    this.lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    child.stderr.resume();
    child.stdin.on("error", () => {});
    child.on("error", () => {});
    this.exited = new Promise(resolve => {
      let drain: ReturnType<typeof setTimeout> | undefined;
      child.once("exit", () => {
        drain = setTimeout(() => {
          child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
        }, 2000);
      });
      child.once("close", () => {
        clearTimeout(drain);
        this.closed = true;
        this.lines.close();
        void Promise.allSettled([endpoint?.close(), this.confirmExit(child)]).then(async results => {
          const confirmed = results[1].status === "fulfilled" && results[1].value;
          try {
            await this.reportExit(confirmed);
          } finally { resolve(this.reportedRelease); }
        }).catch(() => resolve(false));
      });
    });
  }

  get available() { return !this.closed && !this.stopping && !this.child.killed && this.child.exitCode === null && this.child.signalCode === null && this.child.stdin.writable; }

  async sampleTurnProcesses() {
    if (process.platform !== "win32" || !this.child.pid) return;
    try {
      const root = this.child.pid;
      const sample = await sampleWindowsProcesses(root);
      if (!sample.processes.some(p => p.pid === root)) return;
      const children = sample.processes.filter(p => p.pid !== root);
      return {
        primary: children.filter(p => p.parentPid === root).map(p => `${p.pid}:${p.identity}`),
        descendants: children.map(p => `${p.pid}:${p.identity}`),
      };
    } catch { return; }
  }

  async auditTurnEnd(before: Awaited<ReturnType<RetainedProcess["sampleTurnProcesses"]>>): Promise<"clear" | "residual" | "unavailable"> {
    if (process.platform !== "win32" || !before) return "unavailable";
    const known = new Set(before.descendants);
    for (let check = 0; check < 2; check++) {
      const current = await this.sampleTurnProcesses();
      if (!current?.primary.length || before.primary.length && !current.primary.some(identity => before.primary.includes(identity)))
        return "unavailable";
      // A verified supervisor has one commanded target; anything else not in
      // the initial sample must settle or forces retirement of the entire Job.
      if (!before.primary.length && current.primary.length === 1) known.add(current.primary[0]);
      if (current.descendants.every(identity => known.has(identity))) return "clear";
      if (!check) await new Promise(resolve => setTimeout(resolve, 1500));
    }
    return "residual";
  }

  observeFromAttempt(observe: HarnessRequest["onEvent"]) {
    if (!this.closed) this.observe = observe;
  }

  private async reportExit(confirmed: boolean) {
    const evidence = confirmed ? await ownedWindowsExitEvidence(this.child) : undefined;
    if (this.reportedRelease || !confirmed && this.reportedUnconfirmed) return;
    this.observe({ type: confirmed ? "resource.released" : "resource.unconfirmed",
      data: { id: this.id, pid: this.child.pid, scope: "harness", reason: this.releaseReason ?? "process_exit",
        ...(evidence ? { exitEvidence: evidence } : {}) } });
    if (confirmed) this.reportedRelease = true;
    else this.reportedUnconfirmed = true;
  }

  async reconcileExit() {
    if (!this.closed) return false;
    await this.exited;
    if (!this.reportedRelease && await this.confirmExit(this.child)) await this.reportExit(true);
    return this.reportedRelease;
  }

  close(reason = "shutdown", force = false): Promise<boolean> {
    if (this.closed) return this.reconcileExit();
    this.releaseReason ??= reason;
    return this.stopping ??= (async () => {
      const stop = () => { void terminateRetainedProcess(this.child).catch(() => {}); };
      if (force) stop();
      this.child.stdin.end();
      const timer = force ? undefined : setTimeout(stop, 3000);
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        const exited = await Promise.race([this.exited, new Promise<false>(resolve => {
          deadline = setTimeout(() => resolve(false), 10000);
        })]);
        if (!exited) await this.reportExit(false);
        return exited;
      } finally { clearTimeout(timer); clearTimeout(deadline); }
    })();
  }
}

/** HTTP MCP and native stdout may deliver the same call in either order. */
export class ToolUseGate {
  private readonly observed = new Map<string, string>();
  private readonly waiting = new Map<string, Set<() => void>>();

  retireInto(retired: Set<string>) {
    for (const id of this.observed.keys()) retired.add(id);
  }

  observe(id: unknown, tool: unknown, retired: ReadonlySet<string>) {
    if (typeof id !== "string" || typeof tool !== "string" || !tool.startsWith("mcp__teamswarm__")) return;
    if (retired.has(id)) return;
    this.observed.set(id, tool.slice("mcp__teamswarm__".length));
    for (const wake of this.waiting.get(id) ?? []) wake();
  }

  authorize(caller: ToolCaller, signal: AbortSignal): boolean | Promise<boolean> {
    const { toolUseId, tool } = caller;
    if (typeof toolUseId !== "string" || typeof tool !== "string" || toolUseId.length > 128 || signal.aborted) return false;
    if (this.observed.has(toolUseId)) return this.observed.get(toolUseId) === tool;
    if (this.waiting.size >= 32) return false;
    return new Promise(resolve => {
      const waiters = this.waiting.get(toolUseId) ?? new Set<() => void>();
      if (waiters.size >= 4) { resolve(false); return; }
      const wake = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", wake);
        waiters.delete(wake);
        if (!waiters.size) this.waiting.delete(toolUseId);
        resolve(!signal.aborted && this.observed.get(toolUseId) === tool);
      };
      const timer = setTimeout(wake, 2000);
      waiters.add(wake);
      this.waiting.set(toolUseId, waiters);
      signal.addEventListener("abort", wake, { once: true });
    });
  }
}
