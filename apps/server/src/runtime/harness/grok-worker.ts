import { JsonRpcPeer } from "./json-rpc-peer.js";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { terminateNative } from "./native-support.js";
import { grokPermissionOutcome } from "./grok-permissions.js";

// Grok owns its model loop, tools, connection credentials and transcripts.
// This bridge only translates the native ACP lifecycle to the existing adapter.
const spec = JSON.parse(readFileSync(process.argv[2], "utf8"));
const tools =
  spec.config.access === "workspace-write"
    ? "read_file,grep,list_dir,write,search_replace,run_terminal_cmd"
    : "read_file,grep,list_dir" + (spec.nativeCommands ? ",run_terminal_cmd" : "");
// ACP does not inherit top-level TUI/headless --tools or --permission-mode.
// Its native agent profile controls the actual model-visible tool registry.
const profilePath = path.join(spec.home, "agent-profile.md");
writeFileSync(
  profilePath,
  "---\n" +
    JSON.stringify({
      name: "teamswarm-member",
      description:
        "Execute one TeamSwarm responsibility with the assigned tools.",
      promptMode: "full",
      agentsMd: false,
      injectDefaultTools: false,
      permissionMode: spec.config.permissions?.harness === "grok" ? spec.config.permissions.mode : "default",
      tools: tools.split(","),
    }) +
    "\n---\n" +
    spec.instructions +
    "\n",
  { mode: 0o600 },
);
const args = [
  "agent",
  "--no-leader",
  "--agent-profile",
  profilePath,
  ...(spec.config.model ? ["--model", spec.config.model] : []),
  "stdio",
];
const js = /\.[cm]?js$/i.test(spec.entry);
const child = spawn(
  js ? process.execPath : spec.entry,
  js ? [spec.entry, ...args] : args,
  {
    cwd: spec.workspace,
    env: process.env,
    windowsHide: true,
    detached: process.platform !== "win32",
    shell: false,
    stdio: "pipe",
  },
);
let sessionId = "",
  text = "",
  finished = false,
  cancelled = false,
  streaming = false;
const rpc = new JsonRpcPeer(value => child.stdin.write(JSON.stringify(value) + "\n"), "Grok ACP", method => { if (method === "session/prompt") streaming = false; });
const catalogs = new Map<string, string[] | undefined>();
let catalogChanged: (() => void) | undefined;
const allowedNativeTools = tools
  .split(",")
  .map((name) => (name === "run_terminal_cmd" ? "run_terminal_command" : name));
// Grok's write_file feature is optional, so write can be absent even in a
// writable profile. Keep it in the allowlist without requiring it to start.
const requiredTools = allowedNativeTools.filter((name) => name !== "write");
const expectedTools = new Set([
  ...allowedNativeTools,
  "search_tool",
  "use_tool",
  ...spec.tools.map((tool: { name: string }) => `teamswarm__${tool.name}`),
]);
function verifyCatalog(names: string[] | undefined) {
  if (
    !names ||
    requiredTools.some((name) => !names.includes(name)) ||
    names.some((name) => !expectedTools.has(name))
  )
    throw new Error(
      "Grok did not apply the assigned native tool profile; execution was not authorized.",
    );
}
async function waitForCatalog() {
  // Grok sends this notification asynchronously after session/new's response.
  // Do not let the prompt race ahead of the actual model-visible registry.
  if (!catalogs.has(sessionId))
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        catalogChanged = undefined;
        reject(
          new Error(
            "Grok did not report its native tool profile; execution was not authorized.",
          ),
        );
      }, 10000);
      catalogChanged = () => {
        clearTimeout(timer);
        catalogChanged = undefined;
        resolve();
      };
    });
  verifyCatalog(catalogs.get(sessionId));
}
const emit = (value: unknown) =>
  process.stdout.write(JSON.stringify(value) + "\n");
const permissionAbort = new AbortController();
async function answerPermission(message: any) {
  let outcome = grokPermissionOutcome(message.params, sessionId, spec.tools, spec.config.access, spec.nativeCommands);
  if (cancelled || finished || !streaming) outcome = { outcome: "cancelled" };
  else if (outcome.outcome === "selected" && spec.config.permissions?.harness === "grok") {
    const policy = spec.config.permissions;
    if (policy.mode === "dontAsk" || policy.mode === "plan" && ["Bash", "Write", "SearchReplace"].includes(message.params?.toolCall?.rawInput?.variant)) outcome = { outcome: "cancelled" };
    else {
      try {
        const call = message.params.toolCall;
        const response = await fetch(spec.permissionUrl, { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ nativeId: String(call?.toolCallId ?? message.id), tool: call?.title ?? call?.rawInput?.variant ?? "Grok tool", input: call?.rawInput ?? {} }), signal: permissionAbort.signal });
        if (!response.ok || (await response.json() as any).decision !== "allow" || cancelled || finished) outcome = { outcome: "cancelled" };
      } catch { outcome = { outcome: "cancelled" }; }
    }
  }
  if (!child.stdin.destroyed) child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { outcome } }) + "\n");
}
function call(method: string, params: unknown, timeout = 30000): Promise<any> {
  return rpc.call(method, params, timeout).finally(() => { if (method === "session/prompt") streaming = false; });
}
createInterface({ input: child.stdout }).on("line", (line) => {
  let message: any;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (
    message.method === "session/update" &&
    message.params?.update?.sessionUpdate === "available_commands_update"
  ) {
    const rawCatalog = message.params.update._meta?.tools;
    const catalog =
      Array.isArray(rawCatalog) &&
      rawCatalog.every((name: unknown) => typeof name === "string")
        ? rawCatalog
        : undefined;
    catalogs.set(message.params.sessionId, catalog);
    if (message.params.sessionId === sessionId) catalogChanged?.();
    if (streaming && message.params.sessionId === sessionId) {
      try {
        verifyCatalog(catalog);
      } catch (error) {
        void finish("failed", (error as Error).message);
        return;
      }
    }
  }
  if (rpc.receive(message)) {
    return;
  } else if (message.id != null) {
    // Apply the same attempt access at ACP's approval boundary; never persist
    // an approval, including when a native tool requests one.
    if (message.method === "session/request_permission") void answerPermission(message);
    else
      child.stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32601, message: "Unsupported client operation" },
        }) + "\n",
      );
  } else if (
    message.method === "session/update" &&
    message.params?.sessionId === sessionId &&
    streaming &&
    !finished
  ) {
    const update = message.params?.update;
    // Progress before a tool belongs in the transcript, not concatenated with
    // the final answer. Keep only the answer segment after the last tool call.
    if (update?.sessionUpdate === "tool_call") text = "";
    if (
      update?.sessionUpdate === "agent_message_chunk" &&
      update.content?.type === "text"
    )
      text += update.content.text;
    emit({ type: "grok.event", event: update });
  }
});
child.stderr.resume(); // Native errors use the protocol. Never forward auth bytes.
child.stdin.on("error", () => {});
child.on("error", () => failPending("Grok could not start."));
child.on("exit", () =>
  failPending("Grok exited before completing the request."),
);
function failPending(message: string) {
  if (catalogChanged) {
    catalogs.delete(sessionId);
    catalogChanged();
  }
  rpc.close(message);
}
async function finish(status: string, error?: string) {
  if (finished) return;
  finished = true;
  permissionAbort.abort();
  failPending("Grok session ended.");
  const stopped = child.exitCode !== null || (await terminateNative(child));
  emit({
    type: "result",
    status: stopped ? status : "unknown",
    text,
    error: stopped ? error : "Grok process termination could not be confirmed.",
  });
  process.stdin.destroy();
}
createInterface({ input: process.stdin }).on("line", (line) => {
  if (line !== "abort" || finished) return;
  cancelled = true;
  permissionAbort.abort();
  if (sessionId)
    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/cancel",
        params: { sessionId },
      }) + "\n",
    );
  setTimeout(() => void finish("interrupted"), 3000).unref();
});
try {
  const init = await call("initialize", {
    protocolVersion: 1,
    clientInfo: { name: "TeamSwarm", version: "0.3.0" },
    clientCapabilities: {
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
    },
  });
  const identity = path.join(spec.home, "native-session.json");
  const params: any = {
    cwd: spec.workspace,
    _meta: { systemPromptOverride: spec.instructions },
    mcpServers: [
      { type: "http", name: "teamswarm", url: spec.bridge, headers: [] },
    ],
  };
  let created: any;
  if (spec.resume) {
    if (!init.agentCapabilities?.loadSession || !existsSync(identity))
      throw new Error(
        "Grok session history is unavailable; start a new session.",
      );
    sessionId = JSON.parse(readFileSync(identity, "utf8"));
    created = await call("session/load", { ...params, sessionId });
  } else {
    created = await call("session/new", params);
    sessionId = created.sessionId;
    if (typeof sessionId !== "string" || !sessionId)
      throw new Error("Grok returned no session identity.");
    writeFileSync(identity, JSON.stringify(sessionId), { mode: 0o600 });
  }
  emit({ type: "session", id: sessionId });
  await waitForCatalog();
  if (
    spec.config.model &&
    created.models?.currentModelId !== spec.config.model
  ) {
    catalogs.delete(sessionId);
    await call("session/set_model", { sessionId, modelId: spec.config.model });
    await waitForCatalog();
  }
  emit({ type: "grok.catalog", tools: catalogs.get(sessionId) });
  if (cancelled) await finish("interrupted");
  else {
    // session/load replays old updates. Only the new prompt belongs to this turn.
    streaming = true;
    const result = await call(
      "session/prompt",
      { sessionId, prompt: [{ type: "text", text: spec.input }] },
      24 * 60 * 60 * 1000,
    );
    await finish(
      cancelled || result.stopReason === "cancelled"
        ? "interrupted"
        : result.stopReason === "end_turn"
          ? "completed"
          : "failed",
      result.stopReason === "end_turn"
        ? undefined
        : `Grok stopped: ${result.stopReason ?? "unknown"}.`,
    );
  }
} catch (error) {
  await finish(
    cancelled ? "interrupted" : "failed",
    error instanceof Error ? error.message : "Grok request failed.",
  );
}
