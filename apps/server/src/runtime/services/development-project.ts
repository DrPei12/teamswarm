import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import {
  lstat,
  readdir,
  readFile,
  realpath,
  mkdir,
  copyFile,
  rename,
  unlink,
  symlink,
  rmdir,
} from "node:fs/promises";
import path from "node:path";
import { watch, type FSWatcher } from "chokidar";
import type { DevelopmentPreview } from "@team/contracts/services";

const generated = new Set([
  "node_modules",
  ".git",
  ".next",
  ".vite",
  "dist",
  "build",
  "coverage",
  ".teamswarm",
  ".codex",
  ".claude",
]);
const critical =
  /^(?:package\.json|(?:package-lock|npm-shrinkwrap)\.json|(?:pnpm-lock|yarn)\.(?:yaml|lock)|(?:vite|next|postcss|tailwind)\.config\.[^/]+|(?:tsconfig|jsconfig)\.json|\.env(?:\.[^/]+)?|\.npmrc)$/;
const hash = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");
export const excludedSource = (relative: string) =>
  relative
    .split(/[\\/]/)
    .some((part) => generated.has(part) || part.startsWith(".teamswarm-"));

async function linkDependencies(source: string, destination: string) {
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    if (entry.name.startsWith("@") && entry.isDirectory())
      await linkDependencies(
        path.join(source, entry.name),
        path.join(destination, entry.name),
      );
    else if (entry.isDirectory() || entry.isSymbolicLink())
      await symlink(
        await realpath(path.join(source, entry.name)),
        path.join(destination, entry.name),
        process.platform === "win32" ? "junction" : "dir",
      );
  }
}

export async function projectFiles(
  root: string,
  prefix = "",
): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const entry of await readdir(path.join(root, prefix), {
    withFileTypes: true,
  })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (excludedSource(relative)) continue;
    if (entry.isSymbolicLink())
      throw new Error(`Linked project source is not supported: ${relative}`);
    if (entry.isDirectory()) {
      for (const pair of await projectFiles(root, relative)) files.set(...pair);
    } else if (entry.isFile())
      files.set(relative, hash(await readFile(path.join(root, relative))));
  }
  return files;
}

export async function inspectDevelopmentProject(
  directory: string,
  spec: DevelopmentPreview,
) {
  const files = await projectFiles(directory);
  const pkg = JSON.parse(
    await readFile(path.join(directory, "package.json"), "utf8"),
  );
  const script = pkg.scripts?.[spec.script];
  // A declared framework command is the launch surface. Shell chains and lifecycle
  // hooks would make ownership and argument forwarding ambiguous.
  if (typeof script !== "string" || !/^[\w.-]+$/.test(spec.script))
    throw new Error("Choose an existing development script.");
  const command = script.trim().split(/\s+/);
  const allowed =
    spec.framework === "vite"
      ? /^--(?:force|clearScreen=false)$/
      : /^--(?:webpack|turbopack|turbo)$/;
  const head = spec.framework === "vite" ? ["vite"] : ["next", "dev"];
  if (
    head.some((part, index) => command[index] !== part) ||
    command.slice(head.length).some((part) => !allowed.test(part))
  )
    throw new Error(
      "Use a plain vite or next dev script. Ports and host are managed by TeamSwarm.",
    );
  if (pkg.scripts?.[`pre${spec.script}`] || pkg.scripts?.[`post${spec.script}`])
    throw new Error(
      "Development lifecycle scripts need a separate assigned command before preview startup.",
    );
  const require = createRequire(path.join(directory, "package.json"));
  const packageFile = require.resolve(`${spec.framework}/package.json`);
  const installed = JSON.parse(await readFile(packageFile, "utf8"));
  const entry = path.resolve(
    path.dirname(packageFile),
    typeof installed.bin === "string"
      ? installed.bin
      : installed.bin[spec.framework],
  );
  const modules = await realpath(path.join(directory, "node_modules"));
  const identity = hash(
    JSON.stringify({
      framework: spec.framework,
      version: installed.version,
      script,
      modules,
      critical: [...files]
        .filter(([file]) => critical.test(file))
        .sort(([a], [b]) => a.localeCompare(b)),
    }),
  );
  return {
    files,
    identity,
    modules,
    entry,
    args: command.slice(head.length),
    version: String(installed.version),
  };
}

/** One stable working view, fed by one current source. Framework caches remain in the view. */
export class DevelopmentWorkingCopy {
  private source = "";
  private files = new Map<string, string>();
  private watcher?: FSWatcher;
  private pending = new Set<string>();
  private timer?: NodeJS.Timeout;
  private queue: Promise<void> = Promise.resolve();
  private generation = 0;
  private closed = false;
  private switching = false;
  identity = "";
  constructor(
    readonly directory: string,
    private spec: DevelopmentPreview,
    private fatal: (error: Error) => void,
  ) {}

  private async write(source: string, relative: string) {
    const destination = path.join(this.directory, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    // Only the service's own copied files are replaced; source workspaces are read-only here.
    const temporary = `${destination}.teamswarm-copy`;
    await copyFile(path.join(source, relative), temporary);
    await rename(temporary, destination);
  }

  private async remove(relative: string) {
    const file = path.join(this.directory, relative);
    try {
      await unlink(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    for (
      let parent = path.dirname(file);
      parent !== this.directory;
      parent = path.dirname(parent)
    ) {
      try {
        await rmdir(parent);
      } catch (error) {
        if (
          !["ENOENT", "ENOTEMPTY", "EEXIST"].includes(
            (error as NodeJS.ErrnoException).code ?? "",
          )
        )
          throw error;
        break;
      }
    }
  }

  private async synchronize(source: string, files: Map<string, string>) {
    for (const file of this.files.keys())
      if (!files.has(file)) await this.remove(file);
    for (const [file, digest] of files)
      if (this.files.get(file) !== digest) await this.write(source, file);
    this.files = files;
  }

  async switchTo(source: string) {
    const inspected = await inspectDevelopmentProject(source, this.spec);
    if (this.identity && inspected.identity !== this.identity)
      throw new Error(
        "Development dependencies or startup configuration changed. Start a new preview for this working copy.",
      );
    this.switching = true;
    this.generation++;
    clearTimeout(this.timer);
    this.pending.clear();
    await this.watcher?.close();
    await this.queue;
    await mkdir(this.directory, { recursive: true });
    if (!this.identity)
      await linkDependencies(
        inspected.modules,
        path.join(this.directory, "node_modules"),
      );
    await this.synchronize(source, inspected.files);
    this.identity = inspected.identity;
    this.source = source;
    const generation = this.generation;
    this.watcher = watch(source, {
      ignoreInitial: true,
      followSymlinks: false,
      ignored: (file) => excludedSource(path.relative(source, file)),
      awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
    });
    this.watcher.on("error", (error) =>
      this.fatal(error instanceof Error ? error : new Error(String(error))),
    );
    this.watcher.on("all", (_event, file) => {
      if (this.closed || generation !== this.generation) return;
      this.pending.add(path.relative(source, file).split(path.sep).join("/"));
      if (this.switching) return;
      clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        const changes = [...this.pending];
        this.pending.clear();
        this.queue = this.queue
          .then(async () => {
            if (this.closed || generation !== this.generation) return;
            for (const relative of changes) {
              if (!relative || excludedSource(relative)) continue;
              let stat;
              try {
                stat = await lstat(path.join(source, relative));
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT")
                  throw error;
              }
              if (critical.test(relative))
                throw new Error(
                  "Development startup configuration changed. Reopen the preview to load it.",
                );
              if (stat?.isSymbolicLink())
                throw new Error(
                  "Linked source cannot enter the preview working copy.",
                );
              if (stat?.isDirectory()) continue;
              if (stat?.isFile()) {
                for (const file of [...this.files.keys()].filter(
                  (file) =>
                    file.startsWith(relative + "/") ||
                    relative.startsWith(file + "/"),
                )) {
                  await this.remove(file);
                  this.files.delete(file);
                }
                await this.write(source, relative);
                this.files.set(
                  relative,
                  hash(await readFile(path.join(source, relative))),
                );
              } else {
                for (const file of [...this.files.keys()].filter(
                  (file) =>
                    file === relative || file.startsWith(relative + "/"),
                )) {
                  await this.remove(file);
                  this.files.delete(file);
                }
              }
            }
          })
          .catch((error) =>
            this.fatal(
              error instanceof Error ? error : new Error(String(error)),
            ),
          );
      }, 120);
    });
    await new Promise<void>((resolve, reject) => {
      this.watcher!.once("ready", resolve);
      this.watcher!.once("error", reject);
    });
    // Reconcile edits made while the initial watcher was attaching.
    do {
      this.pending.clear();
      await this.synchronize(source, await projectFiles(source));
    } while (this.pending.size && !this.closed);
    this.switching = false;
    return inspected;
  }

  async close() {
    this.closed = true;
    this.generation++;
    clearTimeout(this.timer);
    await this.watcher?.close();
    await this.queue;
  }
}
