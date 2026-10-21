import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { dataDirectory } from "./platform.cjs";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dev = process.argv.includes("--dev");
const dataDir = dataDirectory();
process.env.TEAM_HARNESS_HOME ??= path.join(dataDir, "harnesses");
mkdirSync(dataDir, { recursive: true });
const credentialFile = path.join(dataDir, "control.json");
const token = existsSync(credentialFile)
  ? JSON.parse(readFileSync(credentialFile, "utf8")).token
  : randomBytes(32).toString("hex");
if (!existsSync(credentialFile))
  writeFileSync(credentialFile, JSON.stringify({ token }), { mode: 0o600 });
const { createApp } = await import("../apps/server/dist/app.js");
const { loadHarnesses } =
  await import("../apps/server/dist/runtime/harness/registry.js");
const { loadCredentialFiles } =
  await import("../apps/server/dist/runtime/credentials.js");
const { loadProductCredentials } =
  await import("../apps/server/dist/product-credentials.js");
loadCredentialFiles();
const credentialStatus = await loadProductCredentials(dataDir);
if (credentialStatus.unavailable.length)
  console.warn("Some saved API keys are unavailable. Unlock the system keyring, re-enter the affected keys in settings, or provide their environment references.");
const port = Number(process.env.TEAM_API_PORT ?? (dev ? 4318 : 4317));
const service = createApp({
  dataDir,
  controlToken: token,
  apiPort: port,
  webDistDir: path.join(root, "teamswarm/dist"),
  harnesses: await loadHarnesses(),
});
const server = service.app.listen(port, "127.0.0.1", () => {
  const address = server.address();
  const actualPort =
    typeof address === "object" && address ? address.port : port;
  const webPort = dev ? 4317 : actualPort;
  writeFileSync(
    path.join(dataDir, "connection.json"),
    JSON.stringify({
      port: actualPort,
      webPort,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      credentialStore: process.platform === "win32" ? "windows-dpapi"
        : process.env.TEAMSWARM_DESKTOP_CREDENTIALS === "1" && process.send && process.connected ? "desktop-keyring" : "environment",
    }),
  );
  process.send?.({ type: "ready", port: actualPort, token });
  console.log(`TeamSwarm is running at http://127.0.0.1:${webPort}`);
  if (!process.argv.includes("--no-open")) {
    const url = `http://127.0.0.1:${webPort}/#connect=${token}`;
    const command = process.platform === "win32" ? "powershell.exe" : process.platform === "darwin" ? "/usr/bin/open" : "xdg-open";
    const args = process.platform === "win32"
      ? ["-NoProfile", "-NonInteractive", "-Command", `Start-Process -FilePath '${url}' -WindowStyle Hidden`]
      : [url];
    const child = spawn(command, args, { windowsHide: true, stdio: "ignore" });
    child.once("error", () => console.error("Could not open a browser. Run npm start in a desktop session, or use the desktop application."));
    child.unref();
  }
});
server.on("error", (error) => {
  console.error(error.message);
  void service.close().finally(() => process.exit(1));
});
let vite;
if (dev) {
  const frontendRequire = createRequire(
    path.join(root, "teamswarm/package.json"),
  );
  const viteEntry = path.join(
    path.dirname(frontendRequire.resolve("vite/package.json")),
    "bin/vite.js",
  );
  vite = spawn(
    process.execPath,
    [viteEntry, "--host", "127.0.0.1", "--port", "4317", "--strictPort"],
    {
      cwd: path.join(root, "teamswarm"),
      env: { ...process.env, TEAM_API_PORT: String(port) },
      windowsHide: true,
      stdio: "inherit",
    },
  );
  vite.on("exit", () => void close());
}
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  vite?.kill();
  server.close();
  await service.close();
  server.closeAllConnections();
  process.exit(0);
}
process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());

process.on("message", (message) => {
  if (message?.type === "shutdown") void close();
});
if (process.send) process.once("disconnect", () => void close());
