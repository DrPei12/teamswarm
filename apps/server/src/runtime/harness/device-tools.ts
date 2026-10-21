import { existsSync, realpathSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export function devicePaths() {
  return [
    ...new Set([
      ...(process.env.PATH ?? "").split(path.delimiter).filter(Boolean),
      ...(process.platform === "win32" && process.env.APPDATA
        ? [path.join(process.env.APPDATA, "npm")]
        : []),
      path.join(homedir(), ".local", "bin"),
      ...(process.platform !== "win32" ? ["/usr/local/bin", path.join(homedir(), ".npm-global", "bin")] : []),
      ...(process.platform === "darwin" ? ["/opt/homebrew/bin"] : []),
      path.join(homedir(), ".grok", "bin"),
    ]),
  ];
}
function isDeviceFile(file: string) {
  const resolved = canonicalPath(file);
  const modules = resolved.indexOf(`${path.sep}node_modules${path.sep}`);
  const root =
    modules >= 0 ? resolved.slice(0, modules) : path.dirname(resolved);
  try {
    assertGlobalPrefix(root, []);
    return true;
  } catch {
    return false;
  }
}

export function packageFor(
  entry: string,
  name: string,
): { root: string; version: string; bin: unknown } | null {
  let directory = path.dirname(entry);
  while (path.dirname(directory) !== directory) {
    try {
      const pkg = JSON.parse(
        readFileSync(path.join(directory, "package.json"), "utf8"),
      );
      if (pkg.name === name)
        return { root: directory, version: pkg.version, bin: pkg.bin };
    } catch {
      /* An executable need not be an npm package. */
    }
    directory = path.dirname(directory);
  }
  return null;
}
export function deviceEntry(id: string): string | undefined {
  // The npm bootstrap expands here using the device profile. Prefer that
  // executable before applying a separate GROK_HOME for account credentials.
  const grokBinary = path.join(homedir(), ".grok", "bin", process.platform === "win32" ? "grok.exe" : "grok");
  if (id === "grok" && existsSync(grokBinary) && isDeviceFile(grokBinary)) return realpathSync(grokBinary);
  const names: Record<string, string> = {
    codex: "codex",
    grok: "grok",
    "claude-code": "claude",
    pi: "pi",
    opencode: "opencode",
    "deepseek-harness": "dsh",
  };
  const entries: Record<string, string[]> = {
    codex: ["@openai/codex/bin/codex.js"],
    grok: ["@xai-official/grok/bin/grok-bootstrap.js"],
    "claude-code": [
      "@anthropic-ai/claude-code/bin/claude.exe",
      "@anthropic-ai/claude-code/cli.js",
    ],
    pi: ["@earendil-works/pi-coding-agent/dist/index.js"],
    "deepseek-harness": ["@deepseek-ai/dsh/lib/bin.js"],
    opencode: ["opencode-ai/bin/opencode.exe", "opencode-ai/bin/opencode"],
  };
  for (const directory of devicePaths()) {
    const executable = path.join(
      directory,
      `${names[id]}${process.platform === "win32" ? ".exe" : ""}`,
    );
    if (names[id] && existsSync(executable) && isDeviceFile(executable)) {
      const resolved = realpathSync(executable);
      if (id !== "pi") return resolved;
      const pkg = packageFor(resolved, "@earendil-works/pi-coding-agent");
      if (pkg && existsSync(path.join(pkg.root, "dist/index.js")))
        return path.join(pkg.root, "dist/index.js");
    }
    for (const root of [
      path.join(directory, "node_modules"),
      path.resolve(directory, "../lib/node_modules"),
    ])
      for (const suffix of entries[id] ?? []) {
        const entry = path.join(root, suffix);
        if (existsSync(entry) && isDeviceFile(entry))
          return realpathSync(entry);
      }
  }
}

export function installerEnvironment() {
  const allowed = new Set([
    "PATH",
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "TEMP",
    "TMP",
    "HOME",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "PROGRAMFILES",
    "PROGRAMFILES(X86)",
    "PROGRAMW6432",
    "HOMEDRIVE",
    "HOMEPATH",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NODE_EXTRA_CA_CERTS",
    "NPM_CONFIG_PREFIX",
    "NPM_CONFIG_USERCONFIG",
    "NPM_CONFIG_GLOBALCONFIG",
  ]);
  return {
    ...Object.fromEntries(
      Object.entries(process.env)
        .filter(([key]) => allowed.has(key.toUpperCase()))
        .map(([key, value]) => [
          process.platform === "win32" ? key.toUpperCase() : key,
          value,
        ]),
    ),
    NO_COLOR: "1",
  };
}

export function canonicalPath(value: string): string {
  let ancestor = path.resolve(value);
  const tail: string[] = [];
  while (!existsSync(ancestor) && path.dirname(ancestor) !== ancestor) {
    tail.unshift(path.basename(ancestor));
    ancestor = path.dirname(ancestor);
  }
  const resolved = path.join(realpathSync(ancestor), ...tail);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
export function assertGlobalPrefix(
  prefix: string,
  protectedDirectories: string[],
) {
  if (!path.isAbsolute(prefix))
    throw new Error(
      "The npm global directory must be an absolute device directory.",
    );
  const resolved = canonicalPath(prefix);
  const inside = (root: string) => {
    const canonical = canonicalPath(root);
    return resolved === canonical || resolved.startsWith(canonical + path.sep);
  };
  if (
    /[\\/]TeamSwarm(?:[\\/]|$)|[\\/]\.codex-local[\\/]/i.test(resolved) ||
    protectedDirectories.some(inside)
  )
    throw new Error(
      "The npm global directory points inside a project or TeamSwarm. Choose a device-wide npm prefix first.",
    );
  // A checkout used as npm's global prefix is still a project installation.
  let ancestor = resolved;
  while (
    path.dirname(ancestor) !== ancestor &&
    ancestor !== canonicalPath(homedir())
  ) {
    if (
      existsSync(path.join(ancestor, ".git")) ||
      existsSync(path.join(ancestor, "package.json"))
    )
      throw new Error(
        "The npm global directory points inside a project. Choose a device-wide npm prefix first.",
      );
    ancestor = path.dirname(ancestor);
  }
}

/** Use the device's Node/npm. A bundled private npm is not a device installer. */
export function deviceNpm() {
  for (const directory of devicePaths()) {
    const node = path.join(
      directory,
      process.platform === "win32" ? "node.exe" : "node",
    );
    if (
      !existsSync(node) ||
      !isDeviceFile(node) ||
      /[\\/]TeamSwarm[\\/]|[\\/]desktop-stage[\\/]|[\\/]\.cache[\\/]codex-runtimes[\\/]/i.test(
        node,
      )
    )
      continue;
    for (const cli of [
      path.join(directory, "node_modules/npm/bin/npm-cli.js"),
      path.resolve(directory, "../lib/node_modules/npm/bin/npm-cli.js"),
    ])
      if (existsSync(cli) && isDeviceFile(cli))
        return { node: realpathSync(node), cli: realpathSync(cli) };
  }
  return null;
}
