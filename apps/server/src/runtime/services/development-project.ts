import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import {
  lstat,
  readdir,
  readFile,
  realpath,
  mkdir,
  open,
  rename,
  unlink,
  symlink,
  rmdir,
} from "node:fs/promises";
import path from "node:path";
import { watch, type FSWatcher } from "chokidar";
import type { DevelopmentPreview } from "@team/contracts/services";
import { windowsRenameBlocked, windowsRenameDelays } from "../prepared-directory.js";

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
  const manifest = await readFile(path.join(directory, "package.json"));
  if (hash(manifest) !== files.get("package.json"))
    throw new Error("Development startup configuration changed. Reopen the preview to load it.");
  const pkg = JSON.parse(manifest.toString("utf8"));
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
  private pending = new Map<string, boolean>();
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

  private async write(source: string, relative: string, expectedCritical?: string) {
    let bytes: Buffer;
    try {
      bytes = await readFile(path.join(source, relative));
    } catch (error) {
      if (!critical.test(relative) && ["ENOENT", "EISDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return null;
      throw error;
    }
    const digest = hash(bytes);
    if (critical.test(relative) && digest !== expectedCritical)
      throw new Error("Development startup configuration changed. Reopen the preview to load it.");
    const destination = path.join(this.directory, relative);
    const previous = await readFile(destination).catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    if (previous && hash(previous) === digest) return digest;
    await mkdir(path.dirname(destination), { recursive: true });
    const temporary = path.join(path.dirname(destination), ".teamswarm-preview-" + randomUUID());
    const staged = await open(temporary, "wx");
    try {
      try { await staged.writeFile(bytes); }
      finally { await staged.close(); }
      for (let attempt = 0; ; attempt++) {
        try {
          await rename(temporary, destination);
          return digest;
        } catch (error) {
          if (!windowsRenameBlocked(error) || attempt >= windowsRenameDelays.length) throw error;
          await delay(windowsRenameDelays[attempt]);
        }
      }
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    }
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

  private async synchronize(source: string, files: Map<string, string>, inspected: Map<string, string>) {
    for (const file of new Set([...inspected.keys(), ...files.keys()])) {
      if (critical.test(file) && inspected.get(file) !== files.get(file))
        throw new Error("Development startup configuration changed. Reopen the preview to load it.");
    }
    for (const file of this.files.keys())
      if (!files.has(file)) {
        await this.remove(file);
        this.files.delete(file);
      }
    for (const [file, digest] of files) {
      const destination = path.join(this.directory, file);
      if (this.files.get(file) === digest) {
        const mirror = await readFile(destination).catch(error => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
          throw error;
        });
        if (mirror && hash(mirror) === digest) continue;
      }
      const observed = await this.write(source, file, inspected.get(file));
      if (observed) this.files.set(file, observed);
      else if (this.files.has(file)) {
        await this.remove(file);
        this.files.delete(file);
      }
    }
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
    this.timer = undefined;
    this.pending.clear();
    await this.watcher?.close();
    await this.queue;
    await mkdir(this.directory, { recursive: true });
    if (!this.identity)
      await linkDependencies(
        inspected.modules,
        path.join(this.directory, "node_modules"),
      );
    await this.synchronize(source, inspected.files, inspected.files);
    this.identity = inspected.identity;
    this.source = source;
    const generation = this.generation;
    this.watcher = watch(source, {
      ignoreInitial: true,
      followSymlinks: false,
      ignored: (file) => excludedSource(path.relative(source, file)),
      awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
    });
    const failure = (error: unknown) => {
      if (!this.closed && generation === this.generation)
        this.fatal(error instanceof Error ? error : new Error(String(error)));
    };
    this.watcher.on("error", failure);
    const enqueue = (file: string, stable: boolean) => {
      if (this.closed || generation !== this.generation) return;
      const relative = path.relative(source, file).split(path.sep).join("/");
      if (!relative || relative === ".." || relative.startsWith("../") || path.isAbsolute(relative) || excludedSource(relative)) return;
      this.pending.set(relative, this.pending.get(relative) === true || stable);
      if (this.switching || this.timer) return;
      this.timer = setTimeout(() => {
        this.timer = undefined;
        const changes = [...this.pending];
        this.pending.clear();
        this.queue = this.queue
          .then(async () => {
            if (this.closed || generation !== this.generation) return;
            for (const [relative, stable] of changes) {
              let stat;
              try {
                stat = await lstat(path.join(source, relative));
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT")
                  throw error;
              }
              if (critical.test(relative) && !stat?.isFile())
                throw new Error(
                  "Development startup configuration changed. Reopen the preview to load it.",
                );
              if (stat?.isSymbolicLink())
                throw new Error(
                  "Linked source cannot enter the preview working copy.",
                );
              if (stat?.isDirectory()) {
                if (this.files.has(relative)) {
                  await this.remove(relative);
                  this.files.delete(relative);
                }
                continue;
              }
              if (stat?.isFile()) {
                if (!stable) continue;
                for (const file of [...this.files.keys()].filter(
                  (file) =>
                    file.startsWith(relative + "/") ||
                    relative.startsWith(file + "/"),
                )) {
                  await this.remove(file);
                  this.files.delete(file);
                }
                const digest = await this.write(source, relative, this.files.get(relative));
                if (digest) {
                  this.files.set(relative, digest);
                  continue;
                }
              }
              for (const file of [...this.files.keys()].filter(
                (file) =>
                  file === relative || file.startsWith(relative + "/"),
              )) {
                await this.remove(file);
                this.files.delete(file);
              }
            }
          })
          .catch(failure);
      }, 120);
    };
    this.watcher.on("all", (_event, file) => enqueue(file, true));
    // A rapid file-to-directory replacement can arrive as a native rename
    // without a normalized unlink/addDir. Recheck its type, but let the stable
    // normalized event authorize copying regular file contents.
    this.watcher.on("raw", (event, name, details) => {
      const watchedPath = details && typeof details === "object" && "watchedPath" in details
        ? details.watchedPath : undefined;
      if (event === "rename" && typeof name === "string" &&
          typeof watchedPath === "string" && path.resolve(watchedPath) === path.resolve(source))
        enqueue(path.resolve(source, name), false);
    });
    await new Promise<void>((resolve, reject) => {
      this.watcher!.once("ready", resolve);
      this.watcher!.once("error", reject);
    });
    // Reconcile edits made while the initial watcher was attaching.
    do {
      this.pending.clear();
      await this.synchronize(source, await projectFiles(source), inspected.files);
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
