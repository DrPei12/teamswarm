import { createHash, randomBytes } from "node:crypto";
import { execFile, spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import { accessSync, constants, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { freemem, homedir, totalmem } from "node:os";
import path from "node:path";
import type { Duplex } from "node:stream";
import { promisify } from "node:util";
import type { ProcessSample } from "./owned-process.js";

const execute = promisify(execFile);
const repository = path.resolve(import.meta.dirname, "../../../../..");
const cookieKey = "TEAMSWARM_OWNED_GROUP";
const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
let prepared: Promise<string | undefined> | undefined;

function executable(file: string) {
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o022)) return false;
    accessSync(file, constants.X_OK);
    return true;
  } catch { return false; }
}

async function resolveSupervisor() {
  const packaged = path.join(repository, "runtime", "owned-process-darwin");
  if (executable(packaged)) return packaged;
  const source = path.join(repository, "apps/server/src/runtime/harness/owned-process-darwin.c");
  const bytes = readFileSync(source);
  const root = process.env.TEAMSWARM_SUPERVISOR_DIR && path.isAbsolute(process.env.TEAMSWARM_SUPERVISOR_DIR)
    ? process.env.TEAMSWARM_SUPERVISOR_DIR : path.join(homedir(), "Library", "Application Support", "TeamSwarm", "process-supervisor");
  const directory = path.join(root, `darwin-${process.arch}-${hash(bytes)}`);
  const binary = path.join(directory, "owned-process-darwin");
  const verified = () => {
    try {
      return !lstatSync(directory).isSymbolicLink() && executable(binary) &&
        readFileSync(path.join(directory, "sha256"), "utf8") === hash(readFileSync(binary));
    } catch { return false; }
  };
  if (verified()) return binary;
  const sdk = await execute("/usr/bin/xcode-select", ["-p"], { timeout: 3000 });
  if (!path.isAbsolute(sdk.stdout.trim())) return;
  const compiler = (await execute("/usr/bin/xcrun", ["--find", "clang"], { timeout: 5000 })).stdout.trim();
  if (!path.isAbsolute(compiler)) return;
  mkdirSync(root, { recursive: true, mode: 0o700 });
  if (lstatSync(root).isSymbolicLink()) throw Error("The process supervisor cache must not be a link.");
  const staging = mkdtempSync(path.join(root, ".darwin-"));
  try {
    const input = path.join(staging, "owned-process.c");
    const output = path.join(staging, "owned-process-darwin");
    writeFileSync(input, bytes, { mode: 0o600 });
    await execute(compiler, ["-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", input, "-o", output], { timeout: 30000 });
    writeFileSync(path.join(staging, "sha256"), hash(readFileSync(output)), { mode: 0o600 });
    try { renameSync(staging, directory); }
    catch (error) { if (!verified()) throw error; }
    if (!verified()) throw Error("The macOS process supervisor failed cache verification.");
    return binary;
  } finally { rmSync(staging, { recursive: true, force: true }); }
}

export async function darwinSupervisor({ required = false }: { required?: boolean } = {}) {
  if (process.platform !== "darwin") return;
  // Source startup can degrade on machines without a toolchain. Release checks
  // must exercise the same loader without hiding the reason native mode failed.
  try {
    let binary = await (prepared ??= resolveSupervisor());
    if (binary && !executable(binary)) binary = await (prepared = resolveSupervisor());
    if (!binary && required) throw Error("The macOS compiler path could not be resolved.");
    return binary;
  } catch (error) {
    if (required) throw error;
  }
}

const fallback = String.raw`
IFS= read -r start <&3
if [ "$start" != G ]; then printf 'N\n' >&4; exit 125; fi
if ! command -v "$1" >/dev/null 2>&1; then printf 'N missing\n' >&4; exit 125; fi
if [ -d "$1" ] || { [ -f "$1" ] && [ ! -x "$1" ]; }; then printf 'N denied\n' >&4; exit 125; fi
printf 'R\n' >&4
anchor=$$
# Keep this process group anchored while signalling it, even after the target exits.
"$@" <&0 3<&- 4>&- &
target=$!
trap ':' TERM HUP
(
  trap - TERM HUP
  IFS= read -r command <&3
  kill -TERM -- "-$anchor" 2>/dev/null
) </dev/null 4>&- &
wait "$target"
status=$?
kill -TERM -- "-$anchor" 2>/dev/null
sleep 1
# The shell still anchors this group. Unknown detached descendants prevent a tree-empty receipt.
rows=$(/bin/ps -axo pid=,pgid=)
while read -r pid group; do
  if [ "$group" = "$anchor" ] && [ "$pid" != "$anchor" ] && kill -0 "$pid" 2>/dev/null; then
    kill -KILL -- "-$anchor" 2>/dev/null
  fi
done <<ROWS
$rows
ROWS
exit "$status"
`;

export type DarwinProcessBinding = { rootPid: number; rootIdentity: string; cookie: string };
export type DarwinOwned = {
  child: ChildProcessWithoutNullStreams;
  evidence: Promise<boolean>;
  control: Duplex;
  exited: Promise<void>;
  binding?: DarwinProcessBinding;
};

/** Called only for journaled owners after the previous service has released its runtime lock. */
export async function reclaimDarwinOrphan(value: unknown): Promise<boolean> {
  if (!value || typeof value !== "object") return false;
  const { rootPid, rootIdentity, cookie } = value as Partial<DarwinProcessBinding>;
  if (!Number.isSafeInteger(rootPid) || rootPid! <= 1 || typeof rootIdentity !== "string" ||
      typeof cookie !== "string" || !/^[0-9a-f]{64}$/.test(cookie)) return false;
  const created = /^darwin:(\d{1,12}\.\d{6})$/.exec(rootIdentity)?.[1];
  if (!created) return false;
  const binary = await darwinSupervisor();
  if (!binary) return false;
  try {
    const output = await execute(binary, ["sweep", String(rootPid), created, cookie], { timeout: 7000, maxBuffer: 1024 });
    return output.stdout.trim() === "owned-group-empty";
  } catch { return false; }
}

const spawnError = (code: string, command: string) => Object.assign(new Error(`Unable to start the supervised command: ${code}`), { code, syscall: "spawn", path: command });

export async function spawnDarwinOwned(command: string, args: string[], options: SpawnOptionsWithoutStdio, register: (owned: DarwinOwned) => void,
    resolve = darwinSupervisor) {
  const native = await resolve();
  const token = randomBytes(32).toString("hex");
  const env = { ...(options.env ?? process.env) };
  delete env[cookieKey];
  if (!native) env[cookieKey] = token;
  const parameters = native ? ["run", String(process.pid), token, command, ...args] : ["-c", fallback, "teamswarm-process-supervisor", command, ...args];
  const child = spawn(native ?? "/bin/sh", parameters, { ...options, env, detached: true,
    stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"] }) as ChildProcessWithoutNullStreams;
  const control = child.stdio[3] as Duplex, proof = child.stdio[4] as Duplex;
  let startResult: (error?: Error) => void = () => {};
  let exitResult: (confirmed: boolean) => void = () => {};
  const ready = new Promise<void>((resolve, reject) => { startResult = error => error ? reject(error) : resolve(); });
  const evidence = new Promise<boolean>(resolve => { exitResult = resolve; });
  const exited = new Promise<void>(resolve => child.once("close", () => resolve()));
  const owned: DarwinOwned = { child, control, evidence, exited };
  let text = "", launched = false, terminated = false, confirmed = false, invalid = false;
  proof.setEncoding("utf8");
  proof.on("data", (chunk: string) => {
    if (invalid) return;
    text += chunk;
    if (text.length > 128) { invalid = true; return; }
    for (let end = text.indexOf("\n"); end !== -1; end = text.indexOf("\n")) {
      const line = text.slice(0, end);
      text = text.slice(end + 1);
      const started = /^R (\d{1,10}) (\d{1,12}\.\d{6})$/.exec(line);
      if ((line === "R" || !!started) && !launched && !terminated) {
        if (native && started && Number(started[1]) > 1)
          owned.binding = { rootPid: Number(started[1]), rootIdentity: "darwin:" + started[2], cookie: token };
        launched = true; startResult();
      } else if (/^N(?: \d+| missing| denied)?$/.test(line) && !launched && !terminated) {
        terminated = true; confirmed = true;
        const reason = line.slice(2);
        startResult(spawnError(reason === "2" || reason === "missing" ? "ENOENT" :
          reason === "13" || reason === "denied" ? "EACCES" : "PROCESS_SUPERVISOR", command));
      } else if ((line === "E" || line === "U") && launched && !terminated) {
        terminated = true; confirmed = !!native && line === "E";
      } else invalid = true;
    }
  });
  const stop = () => { if (!control.writableEnded && !control.destroyed) control.end("S\n"); };
  const errorBeforeClose = (error: Error) => { startResult(error); stop(); };
  child.on("error", errorBeforeClose);
  for (const pipe of [child.stdin, child.stdout, child.stderr, control, proof]) pipe.on("error", errorBeforeClose);
  child.once("close", () => {
    startResult(spawnError("PROCESS_SUPERVISOR", command));
    exitResult(confirmed && terminated && !invalid && text.length === 0);
  });
  register(owned);
  child.once("spawn", () => { if (!control.destroyed && !control.writableEnded) control.write("G\n"); });
  try { await ready; }
  catch (error) { stop(); child.stdout.resume(); child.stderr.resume(); await exited; throw error; }
  return child;
}

export function parseDarwinVmStat(text: string, total: number) {
  const size = /page size of (\d+) bytes/i.exec(text)?.[1];
  const pages = (key: string) => text.split(/\r?\n/).find(line => line.startsWith(key + ":"))?.match(/:\s*(\d+)\./)?.[1];
  const free = pages("Pages free"), inactive = pages("Pages inactive");
  if (!size || free === undefined || inactive === undefined) return;
  const bytes = (Number(free) + Number(inactive)) * Number(size);
  if (!Number.isSafeInteger(bytes) || bytes < 0) return;
  return Math.min(bytes, total);
}

export function darwinPressure(level: string | number): ProcessSample["memoryPressure"] {
  switch (String(level).trim()) {
    case "1": return "normal";
    case "2": return "warning";
    case "4": return "critical";
    default: return undefined;
  }
}

export async function sampleDarwinProcesses(pid: number): Promise<ProcessSample> {
  const binary = await darwinSupervisor();
  if (binary) {
    try {
      const result = await execute(binary, ["sample", String(pid)], { timeout: 5000, maxBuffer: 1024 * 1024 });
      const sample = JSON.parse(result.stdout) as ProcessSample;
      if (!Array.isArray(sample.processes) || !Number.isSafeInteger(sample.totalPhysical) || sample.totalPhysical <= 0 ||
          !Number.isSafeInteger(sample.availablePhysical) || sample.availablePhysical < 0 || sample.availablePhysical > sample.totalPhysical)
        throw Error("Invalid macOS supervisor sample.");
      return sample;
    } catch { /* The OS fallback reports reduced sampling coverage. */ }
  }
  const env = { ...process.env, LC_ALL: "C" };
  const [vm, pressure, ps] = await Promise.allSettled([
    execute("/usr/bin/vm_stat", [], { env, timeout: 3000 }),
    execute("/usr/sbin/sysctl", ["-n", "kern.memorystatus_vm_pressure_level"], { env, timeout: 3000 }),
    execute("/bin/ps", ["-axo", "pid="], { env, timeout: 3000 }),
  ]);
  const total = totalmem();
  return { totalPhysical: total, availablePhysical: (vm.status === "fulfilled" ? parseDarwinVmStat(vm.value.stdout, total) : undefined) ?? freemem(),
    ...(pressure.status === "fulfilled" ? { memoryPressure: darwinPressure(pressure.value.stdout) } : {}),
    ...(ps.status === "fulfilled" ? { systemProcessCount: ps.value.stdout.trim().split(/\s+/).filter(s => /^\d+$/.test(s)).length } : {}),
    supervision: binary ? "native" : "degraded", processCoverage: "unavailable", processes: [] };
}
