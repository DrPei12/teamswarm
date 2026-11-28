import { harnessManifest } from "@team/contracts/harness-catalog";
import { createServer, type RequestListener } from "node:http";
import { productVersion } from "../../version.js";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { HarnessRequest, NativeToolScope } from "../types.js";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { deviceEntry } from "./device-tools.js";
import { stopProcessGroup } from "./owned-process.js";

/** Terminate only a process tree launched by this adapter, and wait for OS confirmation. */
export async function terminateNative(
  child: ChildProcessWithoutNullStreams,
): Promise<boolean> {
  // An exited root does not prove that its descendants have exited.
  if (child.exitCode !== null || child.signalCode !== null) return false;
  if (!child.pid) return false;
  if (process.platform === "win32") {
    return new Promise((resolve) => {
      let settled = false;
      const killer = spawn(
        "taskkill.exe",
        ["/PID", String(child.pid), "/T", "/F"],
        { windowsHide: true, stdio: "ignore" },
      );
      const finish = (confirmed: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (!confirmed) {
          // Restricted Windows accounts can fail taskkill even for a child.
          // Close its input and use our owned process handle as a root-only
          // fallback. This does not prove descendants stopped, so return false.
          child.stdin.end();
          try {
            child.kill();
          } catch {
            /* Keep unconfirmed ownership. */
          }
        }
        resolve(confirmed);
      };
      const timer = setTimeout(() => {
        killer.kill();
        finish(false);
      }, 5000);
      killer.once("error", () => finish(false));
      killer.once("exit", (code) => finish(code === 0));
    });
  }
  return stopProcessGroup(child.pid);
}

const repository = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../..",
);
export function nativeHome(id: string): string {
  const root = path.resolve(
    process.env.TEAM_HARNESS_HOME ??
      path.join(repository, ".local/harness-state"),
    id,
  );
  mkdirSync(root, { recursive: true, mode: 0o700 });
  return root;
}

/** Resolve installed native software. Never run an npx download during a task. */
export function nativeEntry(id: string): string {
  const entries = harnessManifest(id)?.runtime?.entries ?? [];
  const configured =
    process.env[`TEAM_${id.replaceAll("-", "_").toUpperCase()}_BIN`];
  if (configured) {
    if (
      !path.isAbsolute(configured) ||
      !existsSync(configured) ||
      /\.(cmd|bat|ps1)$/i.test(configured)
    )
      throw new Error(
        `Invalid native entry for ${id}: use an absolute executable or JavaScript file.`,
      );
    return configured;
  }
  const globalEntry = deviceEntry(id);
  if (globalEntry) return globalEntry;
  const roots = [
    path.resolve(
      process.env.TEAM_NATIVE_TOOLS_DIR ??
        path.join(repository, ".local/harness-tools"),
      "node_modules",
    ),
    ...(process.env.LOCALAPPDATA
      ? [
          path.join(
            process.env.LOCALAPPDATA,
            "TeamSwarm",
            "harness-tools",
            "node_modules",
          ),
        ]
      : []),
    ...(process.env.PATH ?? "")
      .split(path.delimiter)
      .map((p) => path.join(p, "node_modules")),
  ];
  for (const root of roots)
    for (const name of entries) {
      const file = path.join(root, name);
      if (existsSync(file)) return file;
    }
  throw new Error(
    `${id} is not installed. Set TEAM_${id.replaceAll("-", "_").toUpperCase()}_BIN or TEAM_NATIVE_TOOLS_DIR.`,
  );
}

export function nativeEnvironment(): NodeJS.ProcessEnv {
  const codexPublic = new Set(["CODEX_HOME", "CODEX_CA_CERTIFICATE", "CODEX_PROXY_URL", "CODEX_SANDBOX_NETWORK_DISABLED"]);
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([k]) =>
        (!k.toUpperCase().startsWith("CODEX_") || codexPublic.has(k.toUpperCase())) &&
        !/KEY|PASSWORD|SECRET|TOKEN|^ANTHROPIC_|^OPENAI_|^DEEPSEEK_|^CLAUDE_|^OPENCODE_|^PI_|^DSH_|^GROK_|^XAI_/i.test(
          k,
        ),
    ).map(([key, value]) => [process.platform === "win32" ? key.toUpperCase() : key, value]),
  );
}

export function childEnvironment(request: HarnessRequest): NodeJS.ProcessEnv {
  const env = nativeEnvironment();
  const name = request.config.credentialEnv;
  if (name) {
    if (request.modelRoute) { env[name] = request.modelRoute.token; return env; }
    if (!process.env[name])
      throw new Error(`Credential environment variable ${name} is not set.`);
    env[name] = process.env[name];
  }
  return env;
}

export const openCodeProbeModelTokenEnv = "TEAMSWARM_OPENCODE_MODEL_TOKEN";

export function prepareOpenCodeProbeProcess(directory: string, token: string, bridge: string) {
  const cwd = path.join(directory, "project");
  const home = path.join(directory, "home");
  const temp = path.join(directory, "temp");
  const config = path.join(directory, "config");
  const configDir = path.join(config, "opencode");
  const appData = path.join(directory, "appdata");
  const localAppData = path.join(directory, "localappdata");
  for (const dir of [cwd, home, temp, config, appData, localAppData])
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  const userNpm = path.join(directory, "offline.npmrc");
  const globalNpm = path.join(directory, "offline-global.npmrc");
  writeFileSync(userNpm, "offline=true\nignore-scripts=true\naudit=false\nfund=false\n", { mode: 0o600, flag: "wx" });
  writeFileSync(globalNpm, "", { mode: 0o600, flag: "wx" });
  const volume = path.parse(home).root;
  const loopback = new URL(bridge).origin;
  const env: NodeJS.ProcessEnv = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|PROGRAMFILES|PROGRAMFILES\(X86\)|LANG|LC_ALL)$/i.test(key))
      .map(([key, value]) => [key.toUpperCase(), value])),
    PROGRAMDATA: process.env.ProgramData || "C:\\ProgramData",
    HOME: home, USERPROFILE: home, HOMEDRIVE: volume.slice(0, -1), HOMEPATH: home.slice(volume.length - 1),
    APPDATA: appData, LOCALAPPDATA: localAppData, TEMP: temp, TMP: temp, TMPDIR: temp,
    XDG_CONFIG_HOME: config, XDG_DATA_HOME: path.join(directory, "data"),
    XDG_STATE_HOME: path.join(directory, "state"), XDG_CACHE_HOME: path.join(directory, "cache"),
    HTTP_PROXY: loopback, HTTPS_PROXY: loopback, ALL_PROXY: loopback, NO_PROXY: "127.0.0.1,localhost",
    NPM_CONFIG_OFFLINE: "true", NPM_CONFIG_IGNORE_SCRIPTS: "true", NPM_CONFIG_AUDIT: "false", NPM_CONFIG_FUND: "false",
    NPM_CONFIG_CACHE: path.join(directory, "npm-cache"), NPM_CONFIG_USERCONFIG: userNpm, NPM_CONFIG_GLOBALCONFIG: globalNpm,
    OPENCODE_CONFIG_DIR: configDir, OPENCODE_DISABLE_PROJECT_CONFIG: "true", OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
    OPENCODE_DISABLE_MODELS_FETCH: "true", OPENCODE_DISABLE_EXTERNAL_SKILLS: "true", OPENCODE_DISABLE_LSP_DOWNLOAD: "true",
    OPENCODE_DISABLE_CLAUDE_CODE: "true", OPENCODE_DISABLE_AUTOUPDATE: "true", OPENCODE_DISABLE_SHARE: "true",
    OPENCODE_DISABLE_FFF: "true", OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: "true",
    [openCodeProbeModelTokenEnv]: token,
  };
  return { cwd, configDir, env };
}

function openToolListener() {
  const routes = new Map<string, RequestListener>();
  const server = createServer((req, res) => {
    const route = routes.get(req.url ?? "");
    if (route) route(req, res);
    else { res.writeHead(403); res.end(); }
  });
  const origin = new Promise<string>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") reject(new Error("MCP bind failed."));
      else resolve(`http://127.0.0.1:${address.port}`);
    });
  });
  let closing: Promise<void> | undefined;
  const close = () => closing ??= new Promise<void>(resolve => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
  return { routes, server, origin, close };
}
// ACP exposes Team tools under this MCP server prefix. These calls inspect
// existing Team state through an attempt-bound bridge.
export const teamReadTools = new Set([
  "team_state", "team_directory", "team_directory_detail", "team_context_index", "team_context_read",
  "team_project_context", "team_read_work", "team_read_exchange", "team_read_artifact", "team_read_artifacts",
  "team_read_file", "team_list_files", "team_pending_permissions",
]);

const toolListeners = new Map<string, ReturnType<typeof openToolListener>>();

function nativeToolCallId(scope: string, message: any): string {
  const metadata = message.params?._meta;
  const codex = metadata?.callId;
  const claude = metadata?.["claudecode/toolUseId"];
  const identity =
    typeof codex === "string"
      ? [metadata.sessionId, metadata.threadId, metadata["x-codex-turn-metadata"]?.turn_id, codex]
      : typeof claude === "string"
        ? [claude]
        : typeof message.id === "string"
          ? [message.id]
          : undefined;
  return identity
    ? createHash("sha256")
        .update(JSON.stringify([scope, ...identity]))
        .digest("hex")
    : randomUUID();
}

export type ToolCaller = {
  threadId?: string;
  turnId?: string;
  sessionId?: string;
  parentThreadId?: string;
  toolUseId?: string;
  tool?: string;
};
export type ToolLease = { close: () => Promise<void>; generation: number };
type SignedToolBinding = {
  acceptControl: (receipt: unknown) => void;
  verifyTool: (name: string, args: unknown, signal: AbortSignal) => {
    scope: NativeToolScope & { signal?: AbortSignal };
    input: Record<string, unknown>;
    callId: string;
  };
};

/** A native session retains its endpoint; request callbacks belong to one drained lease. */
export async function toolEndpoint(harness: string) {
  const listener = toolListeners.get(harness) ?? openToolListener();
  toolListeners.set(harness, listener);
  const toolPath = `/mcp/${randomUUID()}`;
  const permissionPath = `/permission/${randomUUID()}`;
  const denied: RequestListener = (_req, res) => {
    res.writeHead(403);
    res.end();
  };
  listener.routes.set(toolPath, denied);
  listener.routes.set(permissionPath, denied);
  let active: ToolLease | undefined;
  let generation = 0,
    disposed = false;
  let disposing: Promise<void> | undefined;
  const bind = (
    request: HarnessRequest,
    authorize?: (caller: ToolCaller, signal: AbortSignal) => boolean | undefined | (NativeToolScope & { signal?: AbortSignal }) |
      Promise<boolean | undefined | (NativeToolScope & { signal?: AbortSignal })>,
    signed?: SignedToolBinding,
  ): ToolLease => {
    if (disposed || active)
      throw new Error("The tool endpoint is closed or still leased.");
    if (request.config.harness !== harness)
      throw new Error("The tool endpoint belongs to another Harness.");
    const currentGeneration = ++generation;
    const controllers = new Set<AbortController>();
    const pending = new Set<Promise<void>>();
    let closed = false;
    let closing: Promise<void> | undefined;
    const handle: RequestListener = (req, res) => {
      const send = (status: number, body?: unknown) => {
        if (res.destroyed || res.writableEnded) return;
        res.writeHead(status, { "content-type": "application/json" });
        res.end(body === undefined ? undefined : JSON.stringify(body));
      };
      if (
        closed ||
        (req.headers.origin &&
          !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(
            req.headers.origin,
          ))
      )
        return send(403);
      if (req.method !== "POST") return send(405);
      const controller = new AbortController();
      controllers.add(controller);
      const disconnected = () => {
        if (!res.writableEnded) controller.abort();
      };
      const abortBody = () => {
        if (!req.complete) req.destroy();
      };
      res.once("close", disconnected);
      controller.signal.addEventListener("abort", abortBody, { once: true });
      const operation = (async () => {
        let bytes = 0;
        const chunks: Buffer[] = [];
        try {
          for await (const chunk of req) {
            bytes += chunk.length;
            if (bytes > 1024 * 1024) return send(413);
            chunks.push(chunk);
          }
          const message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (controller.signal.aborted || closed) return send(403);
          if (req.url === permissionPath) {
            if (signed) {
              try { signed.acceptControl(message?.receipt); }
              catch { return send(403, { error: "The native actor receipt was rejected." }); }
              return send(200, { ok: true });
            }
            if (
              typeof message.nativeId !== "string" ||
              typeof message.tool !== "string"
            )
              return send(400);
            let cancel!: () => void;
            const cancelled = new Promise<"deny">((resolve) => {
              cancel = () => resolve("deny");
            });
            controller.signal.addEventListener("abort", cancel, { once: true });
            try {
              const decision = await Promise.race([
                request.onPermission?.(message, controller.signal) ?? "deny",
                cancelled,
              ]);
              return send(200, {
                decision: controller.signal.aborted ? "deny" : decision,
              });
            } finally {
              controller.signal.removeEventListener("abort", cancel);
            }
          }
          if (message.id === undefined) return send(202);
          const reply = (result: unknown) =>
            send(200, { jsonrpc: "2.0", id: message.id, result });
          if (message.method === "initialize")
            return reply({
              protocolVersion: "2025-03-26",
              capabilities: { tools: {} },
              serverInfo: { name: "teamswarm", version: productVersion },
            });
          if (message.method === "ping") return reply({});
          if (message.method === "tools/list")
            return reply({
              tools: request.tools.map((tool) =>
                teamReadTools.has(tool.name)
                  ? { ...tool, annotations: { readOnlyHint: true } }
                  : tool,
              ),
            });
          if (message.method === "tools/call") {
            const { name, arguments: args } = message.params ?? {};
            if (!request.tools.some((t) => t.name === name))
              throw new Error("Unknown tool.");
            try {
              const meta = message.params?._meta,
                turn = meta?.["x-codex-turn-metadata"];
              const signedCall = signed?.verifyTool(name, args, controller.signal);
              const verified = signedCall?.scope ?? (authorize ? await authorize({
                  threadId: meta?.threadId,
                  sessionId: meta?.sessionId,
                  turnId: turn?.turn_id,
                  parentThreadId: turn?.parent_thread_id,
                  toolUseId: meta?.["claudecode/toolUseId"],
                  tool: name,
                }, controller.signal) : true);
              if (!verified)
                throw new Error(
                  "The native tool call does not belong to this execution.",
                );
              const scopedSignal = typeof verified === "object" && verified.signal;
              const signal = scopedSignal ? AbortSignal.any([controller.signal, scopedSignal]) : controller.signal;
              const actor = typeof verified === "object" ? JSON.stringify([verified.sessionId, verified.threadId, verified.turnId]) : "";
              signal.throwIfAborted();
              const value = await request.onTool(
                name,
                signedCall?.input ?? args ?? {},
                signedCall?.callId ?? nativeToolCallId(`${toolPath}:${currentGeneration}${actor}`, message),
                signal,
                typeof verified === "object" ? verified : authorize && harness === "codex" ? {
                  sessionId: meta?.sessionId, threadId: meta?.threadId,
                  turnId: turn?.turn_id, parentThreadId: turn?.parent_thread_id,
                } : undefined,
              );
              if (scopedSignal) scopedSignal.throwIfAborted();
              return reply({
                content: [{ type: "text", text: JSON.stringify(value) }],
              });
            } catch (error) {
              return reply({
                isError: true,
                content: [
                  {
                    type: "text",
                    text:
                      error instanceof Error ? error.message : "Tool failed.",
                  },
                ],
              });
            }
          }
          return send(200, {
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32601, message: "Unknown method" },
          });
        } catch {
          send(400, { error: "Invalid request" });
        }
      })().finally(() => {
        controllers.delete(controller);
        pending.delete(operation);
        res.removeListener("close", disconnected);
        controller.signal.removeEventListener("abort", abortBody);
      });
      pending.add(operation);
    };
    listener.routes.set(toolPath, handle);
    listener.routes.set(permissionPath, handle);
    const close = () => {
      if (closing) return closing;
      closed = true;
      if (!disposed) {
        listener.routes.set(toolPath, denied);
        listener.routes.set(permissionPath, denied);
      }
      for (const controller of controllers) controller.abort();
      closing = (async () => {
        await Promise.all(pending);
        if (active === lease) active = undefined;
      })();
      return closing;
    };
    const lease = { close, generation: currentGeneration };
    active = lease;
    return lease;
  };
  const close = () => {
    if (disposing) return disposing;
    disposed = true;
    listener.routes.delete(toolPath);
    listener.routes.delete(permissionPath);
    const last = listener.routes.size === 0;
    if (last && toolListeners.get(harness) === listener)
      toolListeners.delete(harness);
    disposing = (async () => {
      await active?.close();
      if (last) await listener.close();
    })();
    return disposing;
  };
  try {
    const origin = await listener.origin;
    return {
      url: origin + toolPath,
      permissionUrl: origin + permissionPath,
      bind,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

export async function toolBridge(request: HarnessRequest) {
  const endpoint = await toolEndpoint(request.config.harness);
  endpoint.bind(request);
  return {
    url: endpoint.url,
    permissionUrl: endpoint.permissionUrl,
    close: endpoint.close,
  };
}
