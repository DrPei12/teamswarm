import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const observed = new Map<number, string>();
/** A PID is reusable. The operating system's process creation identity is not. */
export function processIdentity(pid: number): string | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (pid === process.pid && observed.has(pid)) return observed.get(pid)!;
  try {
    let identity: string;
    if (process.platform === "win32") {
      identity = execFileSync(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe"),
        ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`],
        { windowsHide: true, encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "ignore"] }).trim();
      if (!/^\d+$/.test(identity)) return null;
      identity = "windows:" + identity;
    } else if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      identity = "linux:" + readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() + ":" + stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    } else if (process.platform === "darwin") {
      const start = execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart="],
        { encoding: "utf8", timeout: 5000, env: { ...process.env, LC_ALL: "C" }, stdio: ["ignore", "pipe", "ignore"] }).trim();
      const boot = execFileSync("/usr/sbin/sysctl", ["-n", "kern.boottime"],
        { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).trim();
      if (!Number.isFinite(Date.parse(start)) || !/sec\s*=\s*\d+/.test(boot)) return null;
      identity = "darwin:" + boot + ":" + start;
    } else return null;
    if (pid === process.pid) observed.set(pid, identity);
    return identity;
  } catch { return null; }
}

/** Share same-process ownership across separately loaded copies of the runtime. */
const key = Symbol.for("teamswarm.runtime.lock-owners");
const globals = globalThis as typeof globalThis & { [key]?: Set<string> };
export const ownedRuntimeLocks = globals[key] ??= new Set<string>();

export function processStartedAfterFile(identity: string | null, modifiedAt: number): boolean {
  if (!identity?.startsWith("windows:")) return false;
  const startedAt = Number(BigInt(identity.slice(8)) / 10_000n - 62_135_596_800_000n);
  // Legacy locks have no creation identity. Only a clearly newer process is
  // positive evidence of PID reuse; unavailable/ambiguous evidence stays held.
  return Number.isFinite(modifiedAt) && startedAt > modifiedAt + 1000;
}
