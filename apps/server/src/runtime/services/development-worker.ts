import { createServer } from "node:http";
import { createServer as createSocketServer, type Socket } from "node:net";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";
import { appendFileSync } from "node:fs";
import { createProxyServer } from "http-proxy-3";
import type {
  DevelopmentPreview,
  PreviewReadiness,
  ServiceExecutionPolicy,
} from "@team/contracts/services";
import { DevelopmentWorkingCopy } from "./development-project.js";

let copy: DevelopmentWorkingCopy | undefined,
  child: ChildProcessWithoutNullStreams | undefined;
let revision = 0,
  port = 0,
  backendPort = 0,
  paused = true,
  closing = false;
let command: string[] = [],
  stderr = "";
const sockets = new Set<Socket>();
const proxy = createProxyServer({
  ws: true,
  changeOrigin: true,
  proxyTimeout: 120000,
});
proxy.on("error", (_error, _req, response) => {
  if ("writeHead" in response && !response.headersSent) response.writeHead(502);
  response.end();
});
proxy.on("proxyRes", (response) => {
  response.headers["cache-control"] = "no-store";
  response.headers["x-teamswarm-preview-version"] = String(revision);
});
const allowed = (host: string | undefined, origin?: string) =>
  [`127.0.0.1:${port}`, `localhost:${port}`].includes(host ?? "") &&
  (!origin ||
    [`http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(origin));
const server = createServer((req, res) => {
  if (!allowed(req.headers.host, req.headers.origin)) {
    res.writeHead(403);
    res.end();
    return;
  }
  if (paused) {
    res.writeHead(503, { "retry-after": "1", "cache-control": "no-store" });
    res.end("Preview is switching working copies.");
    return;
  }
  proxy.web(req, res, { target: `http://127.0.0.1:${backendPort}` });
});
server.on("connection", (socket) => {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
});
server.on("upgrade", (req, socket, head) => {
  if (paused || !allowed(req.headers.host, req.headers.origin)) {
    socket.destroy();
    return;
  }
  proxy.ws(req, socket, head, { target: `http://127.0.0.1:${backendPort}` });
});
function pause() {
  paused = true;
  for (const socket of sockets) socket.destroy();
}

async function availablePort() {
  const listener = createSocketServer();
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const address = listener.address();
  if (!address || typeof address === "string")
    throw new Error("No development port available.");
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  return address.port;
}

async function ready(probe: PreviewReadiness, reopening = false) {
  if (
    !probe ||
    !probe.path.startsWith("/") ||
    probe.path.startsWith("//") ||
    !probe.contains ||
    probe.contains.length > 500
  )
    throw new Error("Provide a local readiness path and expected page text.");
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline && !closing) {
    if (!child || child.exitCode !== null || child.signalCode !== null)
      throw new Error(`Development server exited. ${stderr.slice(-1200)}`);
    try {
      const response = await fetch(
        `http://127.0.0.1:${backendPort}${probe.path}`,
        { redirect: "manual", signal: AbortSignal.timeout(10000) },
      );
      const body = await response.text();
      if (response.ok && (reopening || body.includes(probe.contains))) return;
    } catch {
      /* A real compile can outlast one readiness request. */
    }
    await new Promise((resolve) => setTimeout(resolve, 180));
  }
  throw new Error(
    `The development server did not return the receiving working copy's expected page text. ${stderr.slice(-1500)}`,
  );
}

async function close() {
  closing = true;
  pause();
  await copy?.close();
  proxy.close();
  server.close();
  child?.kill();
}
function fatal(error: Error) {
  process.stderr.write(error.message + "\n");
  void close().finally(() => process.exit(1));
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
let operations = Promise.resolve();
input.on("line", (line) => {
  operations = operations.then(async () => {
    let message: {
      id: number;
      method: string;
      params: {
        directory: string;
        runtimeDirectory: string;
        revision: number;
        development: DevelopmentPreview;
        ready?: PreviewReadiness;
        execution: ServiceExecutionPolicy;
        reopening?: boolean;
      };
    };
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    try {
      const p = message.params;
      if (message.method === "initialize") {
        revision = p.revision;
        copy = new DevelopmentWorkingCopy(
          p.runtimeDirectory,
          p.development,
          fatal,
        );
        const project = await copy.switchTo(p.directory);
        backendPort = await availablePort();
        const flags =
          p.development.framework === "vite"
            ? [
                ".",
                ...project.args,
                "--host",
                "127.0.0.1",
                "--port",
                String(backendPort),
                "--strictPort",
              ]
            : [
                "dev",
                ".",
                ...project.args,
                "--hostname",
                "127.0.0.1",
                "--port",
                String(backendPort),
              ];
        command = [process.execPath, project.entry, ...flags];
        if (p.execution?.boundary !== "device-account")
          throw new Error(
            "The native adapter has no verified project-service execution policy.",
          );
        child = spawn(command[0], command.slice(1), {
          cwd: p.runtimeDirectory,
          env: {
            ...process.env,
            NEXT_TELEMETRY_DISABLED: "1",
            BROWSER: "none",
            NO_COLOR: "1",
          },
          windowsHide: true,
          stdio: "pipe",
        });
        child.stdin.on("error", () => {});
        const log = (chunk: Buffer) => {
          stderr = (stderr + chunk.toString()).slice(-6000);
          appendFileSync(
            path.join(p.runtimeDirectory, "..", "development.log"),
            chunk,
            { mode: 0o600 },
          );
        };
        child.stdout.on("data", log);
        child.stderr.on("data", log);
        child.once("error", fatal);
        child.once("close", () => {
          if (!closing)
            fatal(
              new Error(`Development server exited. ${stderr.slice(-1200)}`),
            );
        });
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", resolve);
        });
        const address = server.address();
        if (!address || typeof address === "string")
          throw new Error("Preview could not listen.");
        port = address.port;
        await ready(p.development.ready, p.reopening);
        paused = false;
      } else if (message.method === "root/check") {
        if (!copy) throw new Error("Preview is not running.");
        const { inspectDevelopmentProject } =
          await import("./development-project.js");
        const project = await inspectDevelopmentProject(
          p.directory,
          p.development,
        );
        if (project.identity !== copy.identity)
          throw new Error(
            "Development dependencies or startup configuration changed. Start a new preview for this working copy.",
          );
      } else if (message.method === "root/set") {
        if (!copy || !p.ready)
          throw new Error(
            "A receiving page check is required for development previews.",
          );
        pause();
        await copy.switchTo(p.directory);
        revision = p.revision;
        await ready(p.ready);
        paused = false;
      } else if (message.method === "stop") {
        await close();
        process.stdout.write(
          JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }) + "\n",
          () => process.exit(0),
        );
        return;
      } else throw new Error("Unknown development preview operation.");
      process.stdout.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            port,
            pid: process.pid,
            backendPid: child?.pid,
            revision,
            nativeCommand: command,
          },
        }) + "\n",
      );
    } catch (error) {
      process.stdout.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32603, message: (error as Error).message },
        }) + "\n",
      );
    }
  });
});
input.on("close", () => {
  void close().finally(() => process.exit(0));
});
