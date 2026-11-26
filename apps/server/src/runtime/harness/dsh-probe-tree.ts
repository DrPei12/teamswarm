import type { HarnessRequest, NativeExecutionNode, NativeToolScope } from "../types.js";

export class DshProbeTree {
  private active = false;
  private rootSignal = new AbortController();
  private nodes = new Map<string, NativeExecutionNode>();
  private signals = new Map<string, AbortController>();
  private waiters = new Map<string, Set<() => void>>();

  constructor(private root: string, private turn: string, private publish: HarnessRequest["onEvent"]) {}

  begin() {
    if (this.active || this.rootSignal.signal.aborted) return false;
    this.active = true;
    return true;
  }

  end() {
    this.active = false;
    this.rootSignal.abort();
    for (const signal of this.signals.values()) signal.abort();
    for (const waiters of this.waiters.values()) for (const wake of waiters) wake();
  }

  settled() {
    return [...this.nodes.values()].every(node => node.runtimeClosed && ["completed", "failed", "interrupted"].includes(node.status));
  }

  processExited(interrupted: boolean) {
    for (const node of this.nodes.values()) {
      if (node.runtimeClosed && !["pending", "running"].includes(node.status)) continue;
      node.runtimeClosed = true;
      if (["pending", "running"].includes(node.status)) node.status = interrupted ? "interrupted" : "unknown";
      this.changed(node);
    }
  }

  private changed(node: NativeExecutionNode) {
    this.publish({ type: "execution.node", data: { ...node } });
    for (const wake of this.waiters.get(node.threadId) ?? []) wake();
  }

  observe(packet: any) {
    const data = packet.params;
    if (packet.method === "session.event" && data?.sessionId === this.root && data.event?.type === "turn/end") {
      this.end();
      return false;
    }
    if (packet.method === "subagent.started") {
      if (!this.active || data?.parentSessionId !== this.root || typeof data.childSessionId !== "string" ||
          !/^[a-f0-9-]{36}$/i.test(data.childSessionId) || data.childSessionId === this.root || this.nodes.has(data.childSessionId)) return true;
      const node: NativeExecutionNode = { threadId: data.childSessionId, parentThreadId: this.root, status: "pending" };
      this.nodes.set(node.threadId, node);
      this.signals.set(node.threadId, new AbortController());
      this.changed(node);
      return true;
    }
    if (packet.method === "session.event" && data?.sessionId !== this.root) {
      const child = this.nodes.get(data?.sessionId);
      const event = data?.event;
      if (child && this.active && child.status === "pending" && event?.type === "turn/start" && Number.isSafeInteger(event.data?.turn)) {
        child.turnId = `${child.threadId}:${event.data.turn}`;
        child.status = "running";
        this.changed(child);
      }
      if (child && event?.type === "turn/end") this.signals.get(child.threadId)?.abort();
      return true;
    }
    if (packet.method === "subagent.finished" && data?.parentSessionId === this.root) {
      const child = this.nodes.get(data.childSessionId);
      if (child && ["pending", "running"].includes(child.status)) {
        this.signals.get(child.threadId)?.abort();
        child.status = data.status === "ok" && data.stopReason === "completed" ? "completed" :
          data.stopReason === "aborted" ? "interrupted" : "failed";
        this.changed(child);
      }
      return true;
    }
    if (packet.method === "teamswarm.probe.disposed" && data?.parent === this.root) {
      const child = this.nodes.get(data.id);
      if (child && !child.runtimeClosed) {
        this.signals.get(child.threadId)?.abort();
        child.runtimeClosed = true;
        this.changed(child);
      }
      return true;
    }
    return packet.method === "session.status" && data?.sessionId !== this.root;
  }

  async resolve(id: string, signal: AbortSignal): Promise<(NativeToolScope & { signal?: AbortSignal }) | undefined> {
    if (!this.active || signal.aborted) return;
    if (id === this.root) return { sessionId: this.root, threadId: this.root, turnId: this.turn, signal: this.rootSignal.signal };
    if (!/^[a-f0-9-]{36}$/i.test(id)) return;
    const current = () => this.nodes.get(id);
    if (!current() || current()!.status === "pending") await new Promise<void>(resolve => {
      const entries = this.waiters.get(id) ?? new Set<() => void>();
      this.waiters.set(id, entries);
      const finish = () => {
        if (this.active && !signal.aborted && !limit.aborted && (!current() || current()!.status === "pending" && !current()!.runtimeClosed)) return;
        entries.delete(finish);
        if (!entries.size) this.waiters.delete(id);
        signal.removeEventListener("abort", finish);
        limit.removeEventListener("abort", finish);
        resolve();
      };
      const limit = AbortSignal.timeout(1200);
      entries.add(finish);
      signal.addEventListener("abort", finish, { once: true });
      limit.addEventListener("abort", finish, { once: true });
      finish();
    });
    const child = current();
    const active = this.signals.get(id)?.signal;
    if (!this.active || signal.aborted || !active || active.aborted || child?.status !== "running" || !child.turnId) return;
    return { sessionId: this.root, threadId: child.threadId, turnId: child.turnId, parentThreadId: this.root, signal: active };
  }
}
