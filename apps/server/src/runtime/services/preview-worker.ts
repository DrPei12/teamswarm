import { createServer, type ServerResponse } from "node:http";
import { createInterface } from "node:readline";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { WorkspaceAccess } from "../workspace-access.js";

const types: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};
let root = "",
  revision = 0,
  port = 0;

function previewRoot(directory: string) {
  if (!path.isAbsolute(directory) || lstatSync(directory).isSymbolicLink())
    throw new Error("Invalid preview directory.");
  const resolved = realpathSync(directory);
  if (!lstatSync(path.join(resolved, "index.html")).isFile())
    throw new Error("Choose a directory containing index.html.");
  return resolved;
}

function fileInRoot(base: string, requested: string) {
  const relative = WorkspaceAccess.relative(requested);
  if (relative.split("/").some((segment) => segment.startsWith(".")))
    throw new Error("Private path.");
  let current = base;
  for (const segment of relative.split("/")) {
    current = path.join(current, segment);
    if (lstatSync(current).isSymbolicLink()) throw new Error("Linked path.");
  }
  const stat = lstatSync(current);
  if (
    !stat.isFile() ||
    stat.size > 20 * 1024 * 1024 ||
    !types[path.extname(current).toLowerCase()]
  )
    throw new Error("Unsupported preview file.");
  return current;
}

function error(res: ServerResponse, status: number) {
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(status === 404 ? "File not found." : "Preview unavailable.");
}

const server = createServer((req, res) => {
  if (
    !root ||
    !["GET", "HEAD"].includes(req.method ?? "") ||
    ![`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host ?? "")
  )
    return error(res, 403);
  if (
    req.headers.origin &&
    ![`http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(
      req.headers.origin,
    )
  )
    return error(res, 403);
  const activeRoot = root,
    activeRevision = revision;
  try {
    let requested = decodeURIComponent((req.url ?? "/").split("?")[0]).replace(
      /^\//,
      "",
    );
    if (!requested || requested.endsWith("/")) requested += "index.html";
    const file = fileInRoot(activeRoot, requested);
    const bytes = readFileSync(file);
    res.writeHead(200, {
      "content-type": types[path.extname(file).toLowerCase()],
      "content-length": bytes.length,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "x-teamswarm-preview-version": String(activeRevision),
    });
    res.end(req.method === "HEAD" ? undefined : bytes);
  } catch {
    error(res, 404);
  }
});

const send = (id: number, result: unknown) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
let operations = Promise.resolve();
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  operations = operations.then(async () => {
    let message: {
      id: number;
      method: string;
      params: { directory: string; revision: number };
    };
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    try {
      if (message.method === "initialize") {
        root = previewRoot(message.params.directory);
        revision = message.params.revision;
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", resolve);
        });
        const address = server.address();
        if (!address || typeof address === "string")
          throw new Error("Preview could not listen.");
        port = address.port;
        send(message.id, { port, pid: process.pid, revision });
      } else if (message.method === "root/set") {
        const next = previewRoot(message.params.directory);
        server.closeAllConnections();
        root = next;
        revision = message.params.revision;
        send(message.id, { port, pid: process.pid, revision });
      } else if (message.method === "stop") {
        root = "";
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        send(message.id, {});
        input.close();
        process.stdin.destroy();
      } else throw new Error("Unknown preview operation.");
    } catch (cause) {
      process.stdout.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32603, message: (cause as Error).message },
        }) + "\n",
      );
    }
  });
});
input.on("close", () => {
  server.closeAllConnections();
  server.close();
});
