/** Native Cordis extension: observes canonical results and answers DSH's own approval requests. */
export const name = "teamswarm-native-observer";
export function apply(ctx: any, config: { permissionUrl: string }) {
  const inputs = new Map<string, unknown>();
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
