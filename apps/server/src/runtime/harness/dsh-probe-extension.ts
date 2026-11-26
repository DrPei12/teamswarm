import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

export const name = "teamswarm-scoped-probes";
export const inject = ["tools"];

export async function apply(ctx: any, config: { url: string; root: string }) {
  const { defineTool } = await import(pathToFileURL(createRequire(process.argv[1]).resolve("@deepseek-ai/dsh-tools")).href);
  const header = (exec: any) => exec.agent?.session?.header;
  const tool = "teamswarm_probe_read";
  ctx.tools.guard((exec: any) => {
    const source = header(exec);
    if (source?.parentSession || exec.name === tool) {
      if (source?.parentSession !== config.root || exec.name !== tool)
        return "The tool is outside this probe's file-reading scope.";
    }
  });
  const lifetimes = new Map<string, Set<string>>();
  const released = (source: any, side: string) => {
    if (source?.parentSession !== config.root || typeof source.id !== "string") return;
    const states = lifetimes.get(source.id) ?? new Set<string>();
    states.add(side);
    if (states.size < 2) lifetimes.set(source.id, states);
    else {
      lifetimes.delete(source.id);
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "teamswarm.probe.disposed",
        params: { id: source.id, parent: source.parentSession } }) + "\n");
    }
  };
  ctx.on("agent/disposed", ({ agent }: any) => released(agent?.session?.header, "agent"), { global: true });
  ctx.on("session/disposed", (session: any) => released(session?.header, "session"), { global: true });
  ctx.tools.register(defineTool({
    name: tool,
    description: "Read a UTF-8 text file in this project. Use a relative path and optional character offset and limit.",
    parameters: { path: { type: "string", required: true }, offset: { type: "number" }, limit: { type: "number" } },
    output: { schema: { type: "string" }, render(_args: unknown, value: string) { return [{ type: "text", text: value }]; } },
    async execute(args: unknown, exec: any) {
      const source = header(exec);
      const response = await fetch(config.url, {
        method: "POST", headers: { "content-type": "application/json" }, signal: exec.signal,
        body: JSON.stringify({ jsonrpc: "2.0", id: exec.callId, method: "tools/call", params: {
          name: "team_read_file", arguments: args,
          _meta: { threadId: source?.id, sessionId: source?.parentSession },
        } }),
      });
      const reply: any = await response.json();
      const text = reply.result?.content?.[0]?.text;
      if (!response.ok || reply.result?.isError || typeof text !== "string")
        throw new Error(typeof text === "string" ? text : "The probe could not read the file.");
      return text;
    },
  }));
}
