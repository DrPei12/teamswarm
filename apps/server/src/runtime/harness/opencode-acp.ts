import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { HarnessRequest, HarnessResult } from "../types.js";
import { JsonRpcPeer } from "./json-rpc-peer.js";

/** ACP transport; the native Harness keeps its own tools and agent loop. */
export class AcpSession {
  private rpc: JsonRpcPeer;
  private session = "";
  private streaming = false;
  private dispatched = false;
  private text = "";
  private cancelled = false;
  private controller = new AbortController();
  private get name() { return this.options.name ?? 'OpenCode'; }
  constructor(private child: ChildProcessWithoutNullStreams, private request: HarnessRequest, private bridge: string,
    private sessionFile: string, private emit: (event: unknown) => void, private finish: (result: HarnessResult) => void,
    private options: { name?: string; eventType?: string; prompt?: string; sessionParams?: Record<string, unknown> } = {}) {
      this.rpc = new JsonRpcPeer(value => this.send(value), options.name ?? "OpenCode ACP", method => { if (method === "session/prompt") this.streaming = false; });
    }
  private send(value: unknown) { if (!this.child.stdin.destroyed) this.child.stdin.write(JSON.stringify(value) + "\n"); }
  private call(method: string, params: unknown, timeout = 30000): Promise<any> {
    return this.rpc.call(method, params, timeout);
  }
  receive(message: any) {
    if (this.rpc.receive(message)) return;
    if (message.method === "session/update" && message.params?.sessionId === this.session && this.streaming) {
      const e = message.params.update;
      if (e.sessionUpdate === "agent_message_chunk" && e.content?.type === "text") this.text += e.content.text;
      if (e.sessionUpdate === "tool_call") this.text = "";
      this.emit({ type: this.options.eventType ?? "opencode.event", event: e });
    } else if (message.id != null && message.method === "session/request_permission") {
      void this.permission(message);
    } else if (message.id != null) this.send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Client filesystem and terminal execution are disabled; use the native runtime." } });
  }
  private async permission(message: any) {
    const p = message.params, option = p?.options?.find((v: any) => v.kind === "allow_once");
    let allowed = false;
    if (option && p.sessionId === this.session && this.streaming && !this.cancelled) {
      try { allowed = await this.request.onPermission?.({ nativeId: String(p.toolCall?.toolCallId ?? message.id), tool: p.toolCall?.title ?? `${this.name} tool`, input: p.toolCall?.rawInput ?? {}, reason: p.toolCall?.title }, this.controller.signal) === "allow"; } catch {}
    }
    this.send({ jsonrpc: "2.0", id: message.id, result: { outcome: allowed && !this.cancelled ? { outcome: "selected", optionId: option.optionId } : { outcome: "cancelled" } } });
  }
  async start() {
    try {
      const init = await this.call("initialize", { protocolVersion: 1, clientInfo: { name: "TeamSwarm", version: "1" }, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
      if (init.protocolVersion !== 1) throw new Error("Unsupported ACP protocol version.");
      const params = { ...this.options.sessionParams, cwd: this.request.workspace, mcpServers: [{ type: "http", name: "teamswarm", url: this.bridge, headers: [] }] };
      if (this.request.sessionId) {
        if (!init.agentCapabilities?.loadSession || !existsSync(this.sessionFile)) throw new Error(`${this.name} session history is unavailable.`);
        this.session = JSON.parse(readFileSync(this.sessionFile, "utf8"));
        await this.call("session/load", { ...params, sessionId: this.session });
      } else {
        const created = await this.call("session/new", params);
        if (typeof created.sessionId !== "string" || !created.sessionId) throw new Error(`${this.name} returned no session identity.`);
        this.session = created.sessionId; writeFileSync(this.sessionFile, JSON.stringify(this.session), { mode: 0o600 });
      }
      this.emit({ type: "session", id: this.session });
      if (this.cancelled) return;
      this.streaming = true;
      this.dispatched = true;
      const result = await this.call("session/prompt", { sessionId: this.session, prompt: [{ type: "text", text: this.options.prompt ?? this.request.input }] }, 24 * 60 * 60 * 1000);
      this.streaming = false;
      this.finish({ status: this.cancelled || result.stopReason === "cancelled" ? "interrupted" : result.stopReason === "end_turn" ? "completed" : "failed", text: this.text,
        ...(result.stopReason === "end_turn" ? {} : { error: result.stopReason === "max_tokens" ? `${this.name} reached the model output limit before completing the turn.` : `${this.name} stopped: ${result.stopReason ?? "unknown"}.` }) });
    } catch (error) { this.finish({ status: this.cancelled ? "interrupted" : this.dispatched ? "unknown" : "failed", text: this.text, error: (error as Error).message }); }
  }
  cancel() { this.cancelled = true; this.controller.abort(); if (this.session) this.send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: this.session } }); }
  close() { this.controller.abort(); this.rpc.close(); }
}
export { AcpSession as OpenCodeAcp };
