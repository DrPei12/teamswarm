import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

type Call = { id: string; command: string; startedAt: string; tool: string };
const textOf = (value: any): string => typeof value === "string" ? value : Array.isArray(value)
  ? value.map(v => v?.text ?? v?.content?.text ?? "").filter(Boolean).join("\n") : "";
const integer = (value: unknown) => Number.isInteger(value) ? value as number : null;

/** Observes native results after execution. It never executes, schedules or rewrites a tool call. */
export class CommandObservations {
  private calls = new Map<string, Call>();
  private finished = new Set<string>();
  constructor(private harness: string, private directory: string, private emit: (type: string, data: Record<string, unknown>) => void, private protocol?: "acp") {}
  start(id: unknown, tool: string, input: any, startedAt = new Date().toISOString()) {
    if (typeof id !== "string" || !id || this.finished.has(id) || this.calls.has(id)) return;
    this.calls.set(id, { id, tool, startedAt, command: String(input?.command ?? input?.cmd ?? input?.script ?? "") });
  }
  finish(id: unknown, value: { output: string; exitCode?: number | null; outcome: "succeeded" | "failed" | "cancelled" | "unknown"; raw: unknown }) {
    if (typeof id !== "string" || this.finished.has(id)) return;
    const call = this.calls.get(id);
    if (!call) return; // replay, another session, or an unobserved start cannot become evidence
    const native = JSON.stringify(value.raw), name = createHash("sha256").update(id).digest("hex");
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const outputPath = path.join(this.directory, name + ".txt"), nativeResultPath = path.join(this.directory, name + ".json");
    writeFileSync(outputPath, value.output, { mode: 0o600 });
    writeFileSync(nativeResultPath, native, { mode: 0o600 });
    const exitCode = integer(value.exitCode);
    const outcome = exitCode !== null && exitCode !== 0 ? "failed" : value.outcome;
    this.emit("execution.item", {
      type: "commandExecution", ...call, harness: this.harness, nativeItemId: id,
      completedAt: new Date().toISOString(), exitCode, nativeOutcome: outcome,
      status: outcome === "cancelled" ? "interrupted" : outcome === "unknown" ? "unknown" : "completed",
      aggregatedOutput: value.output.slice(0, 65536), outputBytes: Buffer.byteLength(value.output),
      outputTruncated: value.output.length > 65536, outputPath, nativeResultPath,
      nativeResultSha256: createHash("sha256").update(native).digest("hex"),
    });
    this.finished.add(id); this.calls.delete(id);
  }
  observe(event: any) {
    if (this.harness === "pi") {
      const e = event.type === "pi.event" ? event.event : null;
      if (!e || !["bash", "powershell"].includes(e.toolName)) return;
      if (e.type === "tool_execution_start") this.start(e.toolCallId, e.toolName, e.args);
      if (e.type === "tool_execution_end") {
        const r = e.result ?? {}, code = integer(r.structuredContent?.exit_code);
        this.finish(e.toolCallId, { output: r.structuredContent?.output ?? textOf(r.content), exitCode: code,
          outcome: e.isError || r.isError || code !== null && code !== 0 ? "failed" : code === 0 ? "succeeded" : "unknown", raw: e });
      }
    } else if (this.harness === "claude-code") {
      for (const b of event.message?.content ?? []) {
        if (event.type === "assistant" && b.type === "tool_use" && b.name === "Bash") this.start(b.id, b.name, b.input);
        if (event.type === "user" && b.type === "tool_result") {
          const r = event.tool_use_result ?? {};
          this.finish(b.tool_use_id, { output: [r.stdout, r.stderr].some(v => typeof v === "string") ? [r.stdout, r.stderr].filter(Boolean).join("\n") : textOf(b.content),
            exitCode: integer(r.exitCode ?? r.exit_code), outcome: r.interrupted ? "cancelled" : r.backgroundTaskId ? "unknown" : b.is_error ? "failed" : "succeeded", raw: event });
        }
      }
    } else if (this.harness === "deepseek-harness") {
      const e = event.method === "session.event" ? event.params?.event : null;
      if (e?.type === "tool/call" && ["bash", "pwsh", "powershell"].includes(e.data?.name)) {
        let input = {}; try { input = JSON.parse(e.data.arguments); } catch {}
        this.start(e.data.callId, e.data.name, input);
      }
      if (event.method === "teamswarm.command.result") {
        const p = event.params, r = p.result, v = r.value ?? {}, code = integer(v.exitCode);
        this.finish(p.callId, { output: [v.stdout?.text, v.stderr?.text].some(v => typeof v === "string") ? [v.stdout?.text, v.stderr?.text].filter(Boolean).join("\n") : textOf(r.content),
          exitCode: code, outcome: v.aborted ? "cancelled" : r.isError || v.timedOut || v.sandbox?.denied || v.sandbox?.runnerFailed || code !== null && code !== 0 ? "failed" : code === 0 ? "succeeded" : "unknown", raw: p });
      }
    } else if (this.protocol === "acp" || ["grok", "opencode"].includes(this.harness)) {
      const e = ["acp.event", "grok.event", "opencode.event"].includes(event.type) ? event.event : null;
      if (!e || !["tool_call", "tool_call_update"].includes(e.sessionUpdate)) return;
      if (e.sessionUpdate === "tool_call" && (e.kind === "execute" || e._meta?.["x.ai/tool"]?.kind === "execute" || e.rawInput?.variant === "Bash")) this.start(e.toolCallId, e.title ?? "command", e.rawInput);
      // ACP can announce a pending call before its arguments arrive. Keep the
      // original identity and start time, then merge the native input updates.
      const call = this.calls.get(e.toolCallId);
      const command = e.rawInput?.command ?? e.rawInput?.cmd ?? e.rawInput?.script;
      if (call && typeof command === "string" && command) call.command = command;
      if (["completed", "failed"].includes(e.status)) {
        const r = e.rawOutput ?? {}, code = integer(r.exitCode ?? r.exit_code ?? r.metadata?.exit ?? r.exit);
        this.finish(e.toolCallId, { output: textOf(e.content) || textOf(r.output) || (typeof r === "string" ? r : ""), exitCode: code,
          outcome: e.status === "failed" || r.isError || r.timed_out || r.signal || code !== null && code !== 0 ? "failed" : code === 0 ? "succeeded" : "unknown", raw: e });
      }
    }
  }
  close(cancelled: boolean) {
    for (const call of [...this.calls.values()]) this.finish(call.id, { output: "", outcome: cancelled ? "cancelled" : "unknown", raw: { reason: "native turn ended without a command completion", cancelled } });
  }
}

export function successfulCommand(event: any) {
  return event?.type === "commandExecution" && event.status === "completed" &&
    (event.exitCode === 0 || event.exitCode == null && event.nativeOutcome === "succeeded") &&
    !["failed", "cancelled", "unknown"].includes(event.nativeOutcome);
}
export function finishedCommand(event: any) {
  return event?.type === "commandExecution" && event.status === "completed" &&
    (Number.isInteger(event.exitCode) || ["succeeded", "failed"].includes(event.nativeOutcome));
}
