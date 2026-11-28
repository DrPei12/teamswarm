import { JsonRpcPeer, JsonRpcResponseError } from "./json-rpc-peer.js";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import type { ExecutionConfig, HarnessResult } from "../types.js";
import { grokPermissionOutcome } from "./grok-permissions.js";
import { productVersion } from "../../version.js";

export type GrokSpec = {
  entry: string;
  home: string;
  workspace: string;
  bridge: string;
  permissionUrl: string;
  instructions: string;
  input: string;
  config: ExecutionConfig;
  tools: { name: string }[];
  nativeCommands: boolean;
  resume: boolean;
};

export type GrokRetainedSession = {
  initialState?: Record<string, any>;
  onInitialize?: (state: Record<string, any>) => void;
  nextRequestId: () => number;
  onNativeSession: (sessionId: string) => void;
  onPromptTerminal: () => Promise<unknown> | void;
};

export function prepareGrok(spec: GrokSpec) {
  const tools =
    spec.config.access === "workspace-write"
      ? "read_file,grep,list_dir,write,search_replace,run_terminal_cmd"
      : "read_file,grep,list_dir" +
        (spec.nativeCommands ? ",run_terminal_cmd" : "");
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
        permissionMode:
          spec.config.permissions?.harness === "grok"
            ? spec.config.permissions.mode
            : "default",
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

  return { args, tools };
}

export function grokSession(
  child: ChildProcessWithoutNullStreams,
  spec: GrokSpec,
  tools: string,
  emit: (event: unknown) => void,
  onResult: (result: HarnessResult) => void,
  onDispatch?: () => void,
  retained?: GrokRetainedSession,
) {
  let sessionId = "",
    text = "",
    finished = false,
    cancelled = false,
    streaming = false;
  let dispatched = false;
  let settling: Promise<void> | undefined;
  let release: Promise<unknown> | undefined;
  let permissionFailure: unknown;
  const pendingPermissions = new Set<Promise<void>>();
  const rpc = new JsonRpcPeer(
    (value) => child.stdin.write(JSON.stringify(value) + "\n"),
    "Grok ACP",
    (method) => {
      if (method !== "session/prompt") return;
      streaming = false;
      if (retained) void revokeTurn();
    },
    retained?.nextRequestId,
  );
  const catalogs = new Map<string, string[] | undefined>();
  let catalogChanged: (() => void) | undefined;
  const allowedNativeTools = tools
    .split(",")
    .map((name) =>
      name === "run_terminal_cmd" ? "run_terminal_command" : name,
    );
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
  const permissionAbort = new AbortController();
  function revokeTurn() {
    permissionAbort.abort();
    if (!release) {
      release = Promise.resolve().then(() => retained?.onPromptTerminal());
      void release.catch(() => {});
    }
    return release;
  }
  async function answerPermission(message: any) {
    let outcome = grokPermissionOutcome(
      message.params,
      sessionId,
      spec.tools,
      spec.config.access,
      spec.nativeCommands,
    );
    if (cancelled || finished || !streaming) outcome = { outcome: "cancelled" };
    else if (
      outcome.outcome === "selected" &&
      spec.config.permissions?.harness === "grok"
    ) {
      const policy = spec.config.permissions;
      if (
        policy.mode === "dontAsk" ||
        (policy.mode === "plan" &&
          ["Bash", "Write", "SearchReplace"].includes(
            message.params?.toolCall?.rawInput?.variant,
          ))
      )
        outcome = { outcome: "cancelled" };
      else if (policy.mode !== "bypassPermissions") {
        try {
          const call = message.params.toolCall;
          const response = await fetch(spec.permissionUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              nativeId: String(call?.toolCallId ?? message.id),
              tool: call?.title ?? call?.rawInput?.variant ?? "Grok tool",
              input: call?.rawInput ?? {},
            }),
            signal: permissionAbort.signal,
          });
          if (
            !response.ok ||
            ((await response.json()) as any).decision !== "allow" ||
            cancelled ||
            finished
          )
            outcome = { outcome: "cancelled" };
        } catch {
          outcome = { outcome: "cancelled" };
        }
      }
    }
    if (cancelled || finished || !streaming || permissionAbort.signal.aborted) outcome = { outcome: "cancelled" };
    if (child.stdin.destroyed) {
      if (retained) throw new Error("Grok permission response could not be sent.");
      return;
    }
    const reply = JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { outcome } }) + "\n";
    if (retained)
      await new Promise<void>((resolve, reject) =>
        child.stdin.write(reply, error => error ? reject(error) : resolve()));
    else child.stdin.write(reply);
  }
  function call(
    method: string,
    params: unknown,
    timeout = 30000,
  ): Promise<any> {
    return rpc.call(method, params, timeout).finally(() => {
      if (method === "session/prompt") streaming = false;
    });
  }

  function receive(message: any) {
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
      if (message.method === "session/request_permission") {
        if (!retained) void answerPermission(message);
        else {
          const pending = answerPermission(message)
            .catch(error => { permissionFailure ??= error; })
            .finally(() => { pendingPermissions.delete(pending); });
          pendingPermissions.add(pending);
        }
      }
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
  }

  function failPending(message: string) {
    if (catalogChanged) {
      catalogs.delete(sessionId);
      catalogChanged();
    }
    rpc.close(message);
  }

  function finish(status: HarnessResult["status"], error?: string) {
    if (finished) return settling;
    finished = true;
    streaming = false;
    permissionAbort.abort();
    if (!retained) {
      failPending("Grok session ended.");
      onResult({ status, text, error });
      return;
    }
    settling = (async () => {
      const revoke = revokeTurn();
      if (status !== "completed") failPending("Grok session ended.");
      const close = status === "completed"
        ? call("session/close", { sessionId })
        : Promise.resolve();
      const [revoked, closed] = await Promise.allSettled([revoke, close]);
      await Promise.all(pendingPermissions);
      failPending("Grok session ended.");
      if (closed.status === "rejected") {
        onResult({ status: "unknown", text, error: `Grok session close was not confirmed: ${closed.reason instanceof Error ? closed.reason.message : String(closed.reason)}` });
      } else if (permissionFailure || revoked.status === "rejected") {
        onResult({ status: "unknown", text, error: "Grok turn authority did not finish settling." });
      } else {
        onResult({ status: cancelled ? "interrupted" : status, text, error });
      }
    })();
    return settling;
  }
  function cancel() {
    if (cancelled || finished && !retained) return;
    cancelled = true;
    permissionAbort.abort();
    if (retained) void revokeTurn();
    if (finished) return;
    if (!dispatched) { void finish("interrupted"); return; }
    if (sessionId && !child.stdin.destroyed)
      rpc.send({
        jsonrpc: "2.0",
        method: "session/cancel",
        params: { sessionId },
      });
  }
  function close() {
    permissionAbort.abort();
    if (retained) void revokeTurn();
    failPending("Grok process disconnected.");
  }

  async function start() {
    try {
      if (retained && (spec.config.access !== "read-only" || spec.nativeCommands))
        throw new Error("Retaining a Grok session requires a read-only tool profile.");
      const init = retained?.initialState ?? await call("initialize", {
        protocolVersion: 1,
        clientInfo: { name: "TeamSwarm", version: productVersion },
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
      });
      if (init.protocolVersion !== 1)
        throw new Error("Unsupported ACP protocol version.");
      if (retained && (init.agentCapabilities?.loadSession !== true || !init.agentCapabilities?.sessionCapabilities?.close ||
          init.agentCapabilities?.mcpCapabilities?.http !== true))
        throw new Error("Grok did not advertise session loading, close and HTTP MCP.");
      retained?.onInitialize?.(init);
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
        if (retained && created.sessionId !== undefined && created.sessionId !== sessionId)
          throw new Error("Grok returned a different native session on load.");
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
        await call("session/set_model", {
          sessionId,
          modelId: spec.config.model,
        });
        await waitForCatalog();
      }
      emit({ type: "grok.catalog", tools: catalogs.get(sessionId) });
      if (cancelled) await finish("interrupted");
      else {
        // session/load replays old updates. Only the new prompt belongs to this turn.
        retained?.onNativeSession(sessionId);
        onDispatch?.();
        streaming = true;
        dispatched = true;
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
        cancelled
          ? "interrupted"
          : dispatched && !(error instanceof JsonRpcResponseError)
            ? "unknown"
            : "failed",
        error instanceof Error ? error.message : "Grok request failed.",
      );
    }
  }
  return { receive, start, cancel, close };
}
