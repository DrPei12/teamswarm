/** Native Cordis extension: observes canonical results and answers DSH's own approval requests. */
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
export const name = "teamswarm-native-observer";
export async function apply(ctx: any, config: { permissionUrl: string }) {
  const inputs = new Map<string, unknown>();
  let sequence = 0;
  const sdk = await import(pathToFileURL(createRequire(process.argv[1]).resolve("@deepseek-ai/dsh-llm")).href);
  // Use DSH's public stream interceptor. Yield each original chunk unchanged so
  // native reconstruction, tool execution and cancellation remain authoritative.
  ctx.on("llm/stream", (options: any, next: () => AsyncIterable<any>) => {
    if (!sdk.isAgentLoopRequest(options)) return next();
    const id = `${options.sessionId ?? "session"}:${++sequence}`;
    const notify = (type: string, text?: string) => process.stdout.write(JSON.stringify({
      jsonrpc: "2.0", method: "teamswarm.transcript", params: { id, type, ...(text ? { text } : {}) },
    }) + "\n");
    return (async function* () {
      notify("start");
      let pending = "", last = 0;
      const flush = () => { if (pending) { notify("text", pending); pending = ""; last = Date.now(); } };
      try {
        for await (const chunk of next()) {
          if (chunk.type === "text-delta") {
            pending += chunk.text;
            if (!last || Date.now() - last >= 40 || pending.length >= 256) flush();
          }
          yield chunk;
        }
      } finally { flush(); }
    })();
  }, { global: true });
  ctx.on("tools/pre-execute", async (exec: any, next: () => Promise<unknown>) => {
    if (exec.callId) inputs.set(exec.callId, exec.arguments);
    return next();
  });
  ctx.on("tools/result", (exec: any, result: any) => {
    if (["bash", "pwsh", "powershell"].includes(exec.name))
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "teamswarm.command.result", params: { callId: exec.callId, tool: exec.name, result } }) + "\n");
    inputs.delete(exec.callId);
  });
  ctx.on("approval/request", async (req: any) => {
    try {
      const response = await fetch(config.permissionUrl, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ nativeId: req.callId, tool: req.toolName, input: inputs.get(req.callId) ?? {}, reason: req.reason }), signal: req.signal });
      return response.ok && (await response.json() as any).decision === "allow" ? "allowed-once" : "rejected";
    } catch { return req.signal?.aborted ? "cancelled" : "unavailable"; }
  });
}
