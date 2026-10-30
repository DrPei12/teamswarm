import { harnessManifest } from "@team/contracts/harness-catalog";
import { createServer } from "node:http";
import { productVersion } from "../../version.js";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { HarnessRequest } from "../types.js";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { deviceEntry } from "./device-tools.js";

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
  try {
    process.kill(-child.pid, "SIGKILL");
    // Signal delivery is not proof that the process group is gone.
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        process.kill(-child.pid, 0);
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ESRCH";
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return false;
  } catch {
    return false;
  }
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

export function childEnvironment(request: HarnessRequest): NodeJS.ProcessEnv {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([k]) =>
        !/KEY|PASSWORD|SECRET|TOKEN|^ANTHROPIC_|^OPENAI_|^DEEPSEEK_|^CLAUDE_|^OPENCODE_|^PI_|^DSH_|^GROK_|^XAI_/i.test(
          k,
        ),
    ),
  );
  const name = request.config.credentialEnv;
  if (name) {
    if (request.modelRoute) { env[name] = request.modelRoute.token; return env; }
    if (!process.env[name])
      throw new Error(`Credential environment variable ${name} is not set.`);
    env[name] = process.env[name];
  }
  return env;
}

/** Per-attempt capability endpoint. The model never supplies Team/Attempt identity. */
export async function toolBridge(request: HarnessRequest) {
  const token = randomUUID();
  const permissionToken = randomUUID();
  const pendingPermissions = new Set<AbortController>();
  const server = createServer(async (req, res) => {
    const send = (status: number, body?: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(body === undefined ? undefined : JSON.stringify(body));
    };
    if (
      ![`/mcp/${token}`, `/permission/${permissionToken}`].includes(req.url ?? "") ||
      (req.headers.origin &&
        !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(
          req.headers.origin,
        ))
    )
      return send(403);
    if (req.method !== "POST") return send(405);
    let bytes = 0;
    const chunks: Buffer[] = [];
    try {
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 1024 * 1024) return send(413);
        chunks.push(chunk);
      }
      const message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (req.url === `/permission/${permissionToken}`) {
        if (typeof message.nativeId !== "string" || typeof message.tool !== "string") return send(400);
        const controller = new AbortController();
        pendingPermissions.add(controller);
        const abort = () => controller.abort();
        res.once("close", abort);
        try {
          const decision = await request.onPermission?.(message, controller.signal) ?? "deny";
          return send(200, { decision });
        } finally { res.removeListener("close", abort); pendingPermissions.delete(controller); }
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
        return reply({ tools: request.tools });
      if (message.method === "tools/call") {
        const { name, arguments: args } = message.params ?? {};
        if (!request.tools.some((t) => t.name === name))
          throw new Error("Unknown tool.");
        try {
          const value = await request.onTool(name, args ?? {}, randomUUID());
          return reply({
            content: [{ type: "text", text: JSON.stringify(value) }],
          });
        } catch (error) {
          return reply({
            isError: true,
            content: [
              {
                type: "text",
                text: error instanceof Error ? error.message : "Tool failed.",
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
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("MCP bind failed.");
  return {
    url: `http://127.0.0.1:${address.port}/mcp/${token}`,
    permissionUrl: `http://127.0.0.1:${address.port}/permission/${permissionToken}`,
    close: async () => {
      for (const controller of pendingPermissions) controller.abort();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
