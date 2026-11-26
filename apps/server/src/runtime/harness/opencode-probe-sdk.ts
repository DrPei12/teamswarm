import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { applicationDataBase } from "../../../../../scripts/platform.cjs";

export const openCodeProbeSdkVersion = "1.18.35";
export const openCodeProbeSdkFiles = Object.freeze({
  "package.json": "4b184b9110eb9ca7f9489b71ee7064eda32461299b465a98425e16a705f44235",
  "package-lock.json": "fc7f87772e8ffa3dd484e0aa4abdc3a2ec195c1b9cc6b757b594450c42acc893",
});
const windowsX64Tree = { files: 3647, directories: 269, bytes: 55785228,
  sha256: "38ee9194909e0b86fb6a78120ecab3e9db6c349a0d0ca6acea95ead50c0b001d" };
const lockFileSizes = { "package.json": 980, "package-lock.json": 14755 };
const stagePrefix = ".stage-opencode-sdk-";

type LockedModule = { path: string; version: string; resolved: string; integrity: string };
type LockedEntry = Omit<LockedModule, "path"> & { optional?: boolean; os?: string[]; cpu?: string[] };

export function openCodeProbeSdkDirectory() {
  return path.join(applicationDataBase(), "TeamSwarm", "harness-sdk", "opencode", openCodeProbeSdkVersion,
    `${process.platform}-${process.arch}`);
}

export function assertOpenCodeProbeHost() {
  if (process.platform !== "win32" || process.arch !== "x64")
    throw new Error("OpenCode probe support is currently available on Windows x64.");
  if (process.env.OPENCODE_TEST_MANAGED_CONFIG_DIR)
    throw new Error("OpenCode probes require the standard system configuration directory.");
  const programData = process.env.ProgramData || "C:\\ProgramData";
  if (!/^[A-Za-z]:[\\/]/.test(programData))
    throw new Error("OpenCode probes require a local ProgramData directory.");
  const managed = path.resolve(programData, "opencode");
  let info;
  try { info = lstatSync(managed); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(managed).toLowerCase() !== managed.toLowerCase())
    throw new Error("The system OpenCode configuration directory cannot be verified.");
  for (const name of ["opencode.json", "opencode.jsonc"]) {
    try { lstatSync(path.join(managed, name)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    throw new Error("OpenCode probes are unavailable with a system-managed OpenCode configuration.");
  }
}

function sdkFile(directory: string, name: string) {
  const file = path.resolve(directory, name);
  if (!lstatSync(file).isFile() || realpathSync(file).toLowerCase() !== file.toLowerCase())
    throw new Error(`The OpenCode SDK file changed location · ${name}`);
  return readFileSync(file);
}

export function openCodeProbeSdkModules(directory: string): LockedModule[] {
  verifyLockFile("package.json", sdkFile(directory, "package.json"));
  const lock = sdkFile(directory, "package-lock.json");
  verifyLockFile("package-lock.json", lock);
  return lockedModules(lock);
}

function verifyLockFile(name: keyof typeof openCodeProbeSdkFiles, data: Buffer) {
  if (createHash("sha256").update(data).digest("hex") !== openCodeProbeSdkFiles[name])
    throw new Error(`The OpenCode SDK lock input changed · ${name}`);
}

function lockedModules(data: Buffer): LockedModule[] {
  const lock = JSON.parse(data.toString("utf8")) as { packages: Record<string, LockedEntry> };
  return Object.entries(lock.packages).flatMap(([name, entry]) => {
    if (!name || entry.optional && ((entry.os && !entry.os.includes(process.platform)) ||
        (entry.cpu && !entry.cpu.includes(process.arch)))) return [];
    return [{ path: name, version: entry.version, resolved: entry.resolved, integrity: entry.integrity }];
  });
}

function checkConfigEntries(entries: string[]) {
  const allowed = new Set(["package.json", "package-lock.json", "node_modules", ".gitignore"]);
  if (entries.some(name => !allowed.has(name)))
    throw new Error("The prepared OpenCode probe SDK directory contains extra configuration.");
}

function verifyModuleTree(directory: string) {
  const hash = createHash("sha256");
  let files = 0, bytes = 0;
  const visit = (absolute: string, relative: string) => {
    for (const name of readdirSync(absolute).sort()) {
      const file = path.join(absolute, name), key = path.posix.join(relative, name);
      const stat = lstatSync(file);
      if (stat.isSymbolicLink()) throw new Error(`The OpenCode SDK contains a linked dependency entry · ${key}`);
      if (stat.isDirectory()) {
        hash.update(JSON.stringify([key, "directory"]));
        visit(file, key);
      } else {
        if (!stat.isFile() || ++files > windowsX64Tree.files || (bytes += stat.size) > windowsX64Tree.bytes)
          throw new Error(`The OpenCode SDK contains an unexpected dependency entry · ${key}`);
        hash.update(JSON.stringify([key, "file", createHash("sha256").update(readFileSync(file)).digest("hex")]));
      }
    }
  };
  const modules = path.join(directory, "node_modules");
  if (!lstatSync(modules).isDirectory() || realpathSync(modules).toLowerCase() !== modules.toLowerCase())
    throw new Error("The OpenCode SDK dependency directory changed location.");
  visit(modules, "");
  if (files !== windowsX64Tree.files || bytes !== windowsX64Tree.bytes || hash.digest("hex") !== windowsX64Tree.sha256)
    throw new Error("The prepared OpenCode SDK dependency contents do not match the locked Windows x64 build.");
}

/** Read-only verifier for the prepared config root supplied to the native process. */
export function verifyOpenCodeProbeSdk(directory = openCodeProbeSdkDirectory()) {
  const expected = path.resolve(directory);
  if (realpathSync(expected).toLowerCase() !== expected.toLowerCase())
    throw new Error("The prepared OpenCode probe SDK directory changed location.");
  checkConfigEntries(readdirSync(expected));
  const modules = openCodeProbeSdkModules(expected);
  if (modules.length !== 27) throw new Error("The OpenCode probe dependency set does not match Windows x64.");
  verifyModuleTree(expected);
  return expected;
}

async function checkDirectory(directory: string) {
  if (!(await lstat(directory)).isDirectory() || (await realpath(directory)).toLowerCase() !== directory.toLowerCase())
    throw new Error("The OpenCode SDK directory changed location.");
}

async function readStageFile(file: string, acceptSize: (size: number) => boolean, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const expected = await lstat(file);
  if (!expected.isFile() || !acceptSize(expected.size))
    throw new Error(`The OpenCode SDK contains an unexpected file · ${path.basename(file)}`);
  const sameFile = (actual: typeof expected) => actual.isFile() && actual.dev === expected.dev && actual.ino === expected.ino &&
    actual.size === expected.size && actual.mtimeMs === expected.mtimeMs && actual.ctimeMs === expected.ctimeMs;
  const handle = await open(file, "r");
  try {
    if (!sameFile(await handle.stat())) throw new Error("An OpenCode SDK file changed before staging.");
    const data = Buffer.allocUnsafe(expected.size);
    for (let offset = 0; offset < data.length;) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(data, offset, data.length - offset, offset);
      if (!bytesRead) throw new Error("An OpenCode SDK file ended before staging finished.");
      offset += bytesRead;
    }
    if (!sameFile(await handle.stat())) throw new Error("An OpenCode SDK file changed during staging.");
    return data;
  } finally {
    await handle.close();
  }
}

async function assertNewStageDestination(directory: string) {
  try { await lstat(directory); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error("OpenCode SDK staging requires a new destination directory.");
}

async function stageModuleTree(source: string, destination: string, signal?: AbortSignal) {
  async function visit(relative: string) {
    signal?.throwIfAborted();
    const names = await readdir(path.join(source, relative), { withFileTypes: true });
    names.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    await mkdir(path.join(destination, relative), { mode: 0o700 });
    for (const entry of names) {
      const key = path.posix.join(relative, entry.name);
      const directory = entry.isDirectory();
      if (directory ? ++directories > windowsX64Tree.directories : !entry.isFile() || ++files > windowsX64Tree.files)
        throw new Error(`The OpenCode SDK contains an unexpected dependency entry · ${key}`);
      entries.push({ key, directory });
      if (directory) {
        if (!(await lstat(path.join(source, key))).isDirectory())
          throw new Error(`The OpenCode SDK dependency directory changed · ${key}`);
        await visit(key);
      }
    }
  }

  const entries: { key: string; directory: boolean; digest?: string }[] = [];
  let files = 0, directories = 0;
  await checkDirectory(source);
  await visit("");
  if (files !== windowsX64Tree.files || directories !== windowsX64Tree.directories)
    throw new Error("The prepared OpenCode SDK dependency tree is incomplete.");

  const tasks = entries.filter(entry => !entry.directory);
  let bytes = 0, next = 0, failed = false;
  const workers = Array.from({ length: 8 }, async () => {
    try {
      while (!failed && next < tasks.length) {
        const entry = tasks[next++];
        const data = await readStageFile(path.join(source, entry.key), size => (bytes += size) <= windowsX64Tree.bytes, signal);
        entry.digest = createHash("sha256").update(data).digest("hex");
        signal?.throwIfAborted();
        await writeFile(path.join(destination, entry.key), data, { flag: "wx", mode: 0o600, signal });
      }
    } catch (error) { failed = true; throw error; }
  });
  const failure = (await Promise.allSettled(workers)).find(result => result.status === "rejected");
  if (failure) throw failure.reason;
  const hash = createHash("sha256");
  for (const entry of entries)
    hash.update(JSON.stringify(entry.directory ? [entry.key, "directory"] : [entry.key, "file", entry.digest]));
  if (bytes !== windowsX64Tree.bytes || hash.digest("hex") !== windowsX64Tree.sha256)
    throw new Error("The prepared OpenCode SDK dependency contents do not match the locked Windows x64 build.");
}

/** Publish a private config copy only after validating the exact bytes written to it. */
export async function stageOpenCodeProbeSdk(source: string, destination: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const input = path.resolve(source), output = path.resolve(destination), parent = path.dirname(output);
  await checkDirectory(input);
  checkConfigEntries(await readdir(input));
  await checkDirectory(parent);
  await assertNewStageDestination(output);
  const stage = await mkdtemp(path.join(parent, stagePrefix));
  let installed = false;
  try {
    for (const name of ["package.json", "package-lock.json"] as const) {
      const data = await readStageFile(path.join(input, name), size => size === lockFileSizes[name], signal);
      verifyLockFile(name, data);
      if (name === "package-lock.json" && lockedModules(data).length !== 27)
        throw new Error("The OpenCode probe dependency set does not match Windows x64.");
      await writeFile(path.join(stage, name), data, { flag: "wx", mode: 0o600, signal });
    }
    await stageModuleTree(path.join(input, "node_modules"), path.join(stage, "node_modules"), signal);
    await checkDirectory(parent);
    await checkDirectory(stage);
    await assertNewStageDestination(output);
    signal?.throwIfAborted();
    await rename(stage, output);
    installed = true;
    return output;
  } finally {
    if (!installed) {
      await checkDirectory(stage);
      if (path.dirname(stage) !== parent || !path.basename(stage).startsWith(stagePrefix))
        throw new Error("The generated OpenCode SDK staging directory changed location.");
      await rm(stage, { recursive: true });
    }
  }
}
