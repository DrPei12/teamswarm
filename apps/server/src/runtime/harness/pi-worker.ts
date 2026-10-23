// Isolated native Pi SDK process. IPC carries observations; Pi owns the agent loop.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";
const spec = JSON.parse(readFileSync(process.argv[2], "utf8"));
const emit = (value: unknown) =>
  process.stdout.write(JSON.stringify(value) + "\n");
let session: any;
let stopping = false;
process.stdin.on("data", () => {
  stopping = true;
  void session?.abort();
});
try {
  const pi = await import(pathToFileURL(spec.entry).href);
  const runtime = await pi.ModelRuntime.create({
    authPath: path.join(spec.home, "auth.json"),
    modelsPath: null,
    modelsStorePath: path.join(spec.home, "models-cache.json"),
    allowModelNetwork: false,
  });
  runtime.registerProvider("teamswarm", {
    baseUrl: spec.config.baseUrl,
    api:
      spec.config.protocol === "responses"
        ? "openai-responses"
        : spec.config.protocol === "anthropic-messages"
          ? "anthropic-messages"
          : "openai-completions",
    apiKey: `$${spec.config.credentialEnv}`,
    models: [
      {
        id: spec.config.model,
        name: spec.config.model,
        reasoning: Boolean(spec.config.thinkingFormat || spec.config.effort),
        ...(spec.config.effort ? { thinkingLevelMap: { [spec.config.effort]: spec.config.effort } } : {}),
        ...((spec.config.thinkingFormat || spec.config.effort)
          ? {
              compat: {
                ...(spec.config.thinkingFormat ? { thinkingFormat: spec.config.thinkingFormat } : {}),
                ...(spec.config.effort ? { supportsReasoningEffort: true } : {}),
                supportsDeveloperRole: false,
              },
            }
          : {}),
        input: ["text"],
        contextWindow: spec.config.contextWindowTokens ?? 131072,
        maxTokens: spec.config.maxOutputTokens ?? 8192,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  });
  await runtime.setRuntimeApiKey(
    "teamswarm",
    process.env[spec.config.credentialEnv],
  );
  const resumePath = path.join(spec.home, "session-path.json");
  if (
    spec.resume &&
    (!existsSync(resumePath) ||
      !existsSync(JSON.parse(readFileSync(resumePath, "utf8"))))
  )
    throw new Error(
      "Native Pi history is unavailable; start a new session explicitly.",
    );
  const manager = existsSync(resumePath)
    ? pi.SessionManager.open(JSON.parse(readFileSync(resumePath, "utf8")))
    : pi.SessionManager.create(spec.workspace, spec.home);
  const resourceLoader = {
    getExtensions: () => ({
      extensions: [],
      errors: [],
      runtime: pi.createExtensionRuntime(),
    }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({
      agentsFiles: pi.loadProjectContextFiles({
        cwd: spec.workspace,
        agentDir: spec.home,
      }),
    }),
    getSystemPrompt: () => spec.instructions,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
  const customTools = spec.tools.map((tool: any) => ({
    name: tool.name,
    label: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
    execute: async (_id: string, args: unknown) => {
      const response = await fetch(spec.bridge, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: _id,
          method: "tools/call",
          params: { name: tool.name, arguments: args },
        }),
      });
      const data: any = await response.json();
      if (!response.ok || data.error || data.result?.isError)
        throw new Error(JSON.stringify(data.result ?? data.error));
      return data.result;
    },
  }));
  ({ session } = await pi.createAgentSession({
    cwd: spec.workspace,
    agentDir: spec.home,
    modelRuntime: runtime,
    model: runtime.getModel("teamswarm", spec.config.model),
    thinkingLevel: spec.config.effort ?? "off",
    resourceLoader,
    sessionManager: manager,
    settingsManager: pi.SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
    }),
    tools: [
      ...(spec.config.access === "read-only"
        ? ["read", "grep", "find", "ls"]
        : [
            "read",
            "grep",
            "find",
            "ls",
            "write",
            "edit",
            process.platform === "win32" ? "powershell" : "bash",
          ]),
      ...spec.tools.map((t: any) => t.name),
    ],
    customTools,
  }));
  session.subscribe((event: any) => {
    // Native tool arguments/results and final messages only; no internal runtime objects.
    if (
      ["message_end", "tool_execution_start", "tool_execution_end"].includes(
        event.type,
      )
    )
      emit({ type: "pi.event", event });
  });
  emit({ type: "session", id: manager.getSessionId() });
  if (!stopping) await session.prompt(spec.input);
  if (manager.getSessionFile())
    writeFileSync(resumePath, JSON.stringify(manager.getSessionFile()), {
      mode: 0o600,
    });
  const last = [...session.messages]
    .reverse()
    .find((m: any) => m.role === "assistant");
  const status =
    stopping || last?.stopReason === "aborted"
      ? "interrupted"
      : last?.stopReason === "stop"
        ? "completed"
        : last
          ? "failed"
          : "unknown";
  const error =
    status === "failed"
      ? (last.errorMessage ?? `Native Pi stopped with ${last.stopReason}.`)
      : status === "unknown"
        ? "No final native assistant message."
        : undefined;
  emit({
    type: "result",
    status,
    text: session.getLastAssistantText() ?? "",
    error,
  });
} catch (error) {
  emit({
    type: "result",
    status: "failed",
    text: "",
    error: error instanceof Error ? error.message : "Pi failed.",
  });
} finally {
  session?.dispose();
  process.stdin.destroy();
}
