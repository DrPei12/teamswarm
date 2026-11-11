import type { TranscriptItem } from "@team/contracts/product";

const text = (content: any): string => typeof content === "string" ? content
  : Array.isArray(content) ? content.filter(b => b?.type === "text").map(b => b.text ?? "").join("\n") : "";
const name = (value: string) => value.replace(/^mcp__teamswarm__|^teamswarm__/, "");
const command = (value: string) => ["bash", "pwsh", "powershell", "run_terminal_command", "run_terminal_cmd"].includes(value.toLowerCase());
const preview = (value: string) => Buffer.from(value).subarray(0, 65536).toString("utf8");

/** Translate public native text and tool lifecycle facts without replacing the
 * native loop or exposing provider reasoning/replay state. */
export class NativeTranscript {
  private message = "";
  private sequence = 0;
  private tools = new Map<string, { title: string; kind: TranscriptItem["kind"] }>();
  private acpCommands = new Set<string>();
  private acp = false;
  constructor(private harness: string, private turn: string,
    private emit: (type: string, data: Record<string, unknown>) => void) {}
  private delta(id: string, delta: string) {
    if (delta) this.emit("transcript.delta", { id, kind: "message", delta });
  }
  private complete(id: string, content: any, hasTools: boolean) {
    const value = text(content);
    if (!value) return;
    const phase = hasTools ? "commentary" : "final";
    if (Buffer.byteLength(value) > 65536) {
      this.emit("transcript.item", { id, kind: "message", text: "", replaceText: true, phase, status: "running" });
      for (let offset = 0; offset < value.length; offset += 16000) this.delta(id, value.slice(offset, offset + 16000));
      this.emit("transcript.item", { id, kind: "message", text: "", phase, status: "completed" });
    } else this.emit("transcript.item", { id, kind: "message", text: value, phase, status: "completed" });
  }
  private tool(id: string, title: string, input: unknown) {
    title = name(title);
    if (!id || command(title)) return; // Canonical command observations own shell activity.
    const kind = /^(write|edit|searchreplace|team_write_file|team_edit_file)$/i.test(title) ? "file" : "tool";
    this.tools.set(id, { title, kind });
    this.emit("transcript.item", { id: `${this.turn}:tool:${id}`, kind, title,
      text: preview(typeof input === "string" ? input : JSON.stringify(input ?? {})), status: "running" });
  }
  private result(id: string, content: any, failed: boolean) {
    const call = this.tools.get(id);
    if (!call) return;
    const output = text(content) || JSON.stringify(content ?? "");
    this.emit("transcript.item", { id: `${this.turn}:tool:${id}`, ...call,
      output: preview(output), truncated: Buffer.byteLength(output) > 65536,
      status: failed ? "failed" : "completed" });
  }
  finish(status: "completed" | "failed" | "interrupted" | "unknown") {
    if (!this.acp || !this.message) return;
    this.emit("transcript.item", { id: this.message, kind: "message", text: "", phase: "final", status: status === "unknown" ? "running" : status });
    this.message = "";
  }
  observe(event: any) {
    if (event.type === "acp.event" || this.harness === "opencode") {
      this.acp = true;
      if (event.type !== "opencode.event" && event.type !== "acp.event") return;
      const e = event.event;
      if (e?.sessionUpdate === "agent_message_chunk" && e.content?.type === "text") {
        this.message ||= `${this.turn}:opencode:${this.sequence++}`;
        this.delta(this.message, e.content.text);
      }
      if (e?.sessionUpdate === "tool_call") {
        // Text preceding an actual tool call is public progress, not the final reply.
        if (this.message) {
          this.emit("transcript.item", { id: this.message, kind: "message", text: "", phase: "commentary", status: "completed" });
          this.message = "";
        }
        if (e.kind === "execute" || command(e.title ?? "") || e.rawInput?.variant === "Bash") {
          this.acpCommands.add(e.toolCallId);
        } else if (typeof e.toolCallId === "string" && !this.tools.has(e.toolCallId)) {
          this.tool(e.toolCallId, e.title ?? "Tool activity", e.rawInput ?? {});
        }
      }
      if (["tool_call", "tool_call_update"].includes(e?.sessionUpdate) && !this.acpCommands.has(e.toolCallId)) {
        const call = this.tools.get(e.toolCallId);
        if (!call) return;
        if (e.rawInput != null)
          this.emit("transcript.item", { id: `${this.turn}:tool:${e.toolCallId}`, ...call, text: preview(JSON.stringify(e.rawInput)), status: "running" });
        if (["completed", "failed"].includes(e.status)) {
          const content = e.rawOutput ?? e.content ?? "";
          const output = Array.isArray(content)
            ? content.map(b => b?.type === "content" ? text(b.content) : text(b)).filter(Boolean).join("\n")
            : content;
          this.result(e.toolCallId, output, e.status === "failed");
        }
      }
      return; // Never project agent_thought_chunk or other internal native events.
    }
    if (this.harness === "deepseek-harness") {
      if (event.method === "teamswarm.transcript") {
        const p = event.params;
        this.message = `${this.turn}:dsh:${p.id}`;
        if (p.type === "text") this.delta(this.message, p.text);
      }
      if (event.method !== "session.event") return;
      const fact = event.params?.event, d = fact?.data;
      if (fact?.type === "assistant/message") {
        this.complete(this.message || `${this.turn}:dsh:${d.message.id}`, d.message.content,
          d.message.content?.some((b: any) => b.type === "tool-call"));
        this.message = "";
      }
      if (fact?.type === "tool/call") this.tool(d.callId, d.name, d.arguments);
      if (fact?.type === "tool/result") this.result(d.message.toolCallId, d.message.content, !!d.message.isError);
    }
    if (this.harness === "claude-code") {
      if (event.type === "stream_event") {
        const e = event.event;
        if (e?.type === "message_start") this.message = `${this.turn}:claude:${e.message.id}`;
        if (e?.type === "content_block_delta" && e.delta?.type === "text_delta")
          this.delta(this.message || `${this.turn}:claude:${this.sequence}`, e.delta.text);
      }
      if (event.type === "assistant") {
        const content = event.message?.content ?? [];
        const id = `${this.turn}:claude:${event.message?.id ?? this.sequence++}`;
        this.complete(id, content, content.some((b: any) => b.type === "tool_use"));
        for (const b of content) if (b.type === "tool_use") this.tool(b.id, b.name, b.input);
      }
      if (event.type === "user") for (const b of event.message?.content ?? [])
        if (b.type === "tool_result") this.result(b.tool_use_id, b.content, !!b.is_error);
    }
    if (this.harness === "pi") {
      if (event.type === "pi.message.delta") this.delta(`${this.turn}:pi:${event.sequence}`, event.delta);
      const e = event.event;
      if (event.type !== "pi.event") return;
      if (e?.type === "message_end" && e.message?.role === "assistant")
        this.complete(`${this.turn}:pi:${event.sequence}`, e.message.content, e.message.content?.some((b: any) => b.type === "toolCall"));
      if (e?.type === "tool_execution_start") this.tool(e.toolCallId, e.toolName, e.args);
      if (e?.type === "tool_execution_end") this.result(e.toolCallId, e.result?.content ?? e.result, !!e.isError);
    }
  }
}
