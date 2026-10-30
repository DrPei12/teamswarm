/** Shared ACP framing/correlation. Native tool and permission semantics stay in each package. */
export class JsonRpcPeer {
  private next = 0;
  private ended: Error | undefined;
  private pending = new Map<number, { method: string; resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  constructor(private write: (message: unknown) => void, private name = 'ACP', private onResponse?: (method: string) => void) {}
  get pendingCount() { return this.pending.size; }
  send(message: unknown) { if (this.ended) throw this.ended; this.write(message); }
  call(method: string, params: unknown, timeout = 30000): Promise<any> {
    if (this.ended) return Promise.reject(this.ended);
    if (this.pending.size >= 256) return Promise.reject(new Error(`${this.name}: too many pending protocol requests.`));
    return new Promise((resolve, reject) => {
      const id = ++this.next;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${this.name} timeout: ${method}`)); }, timeout);
      this.pending.set(id, { method, resolve, reject, timer });
      try { this.send({ jsonrpc: '2.0', id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  /** True for all responses, including late duplicates. Notifications are left to the driver. */
  receive(message: any): boolean {
    if (message?.id == null || message.method) return false;
    const item = this.pending.get(message.id);
    if (item) {
      this.pending.delete(message.id); clearTimeout(item.timer);
      // Close a turn's event gate before another line in the same input chunk.
      this.onResponse?.(item.method);
      message.error ? item.reject(new Error(`${this.name}: ${message.error.message ?? 'Request failed'}`)) : item.resolve(message.result);
    }
    return true;
  }
  close(message = `${this.name} process ended.`) {
    if (this.ended) return;
    this.ended = new Error(message);
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(this.ended); }
    this.pending.clear();
  }
}
