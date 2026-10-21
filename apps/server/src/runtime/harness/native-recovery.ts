import { execFile } from "node:child_process";
import path from "node:path";
import { readFileSync } from "node:fs";

let bootTime: Promise<string | null> | undefined;

/** A missing root PID does not prove its descendants stopped. A later OS boot does. */
export async function systemBootTime(): Promise<string | null> {
  if (process.platform === "linux") {
    try {
      const seconds = readFileSync("/proc/stat", "utf8").match(/^btime (\d+)$/m)?.[1];
      return seconds ? new Date(Number(seconds) * 1000).toISOString() : null;
    } catch { return null; }
  }
  if (process.platform === "darwin") {
    return new Promise((resolve) => {
      execFile("/usr/sbin/sysctl", ["-n", "kern.boottime"], { encoding: "utf8", timeout: 5000 }, (error, stdout) => {
        const seconds = stdout?.match(/sec\s*=\s*(\d+)/)?.[1];
        resolve(!error && seconds ? new Date(Number(seconds) * 1000).toISOString() : null);
      });
    });
  }
  if (process.platform !== "win32") return null;
  // This process cannot survive a reboot; one successful observation remains valid.
  bootTime ??= new Promise<string | null>((resolve) => {
    execFile(
      path.join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32/WindowsPowerShell/v1.0/powershell.exe",
      ),
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "(Get-CimInstance Win32_OperatingSystem -ErrorAction Stop).LastBootUpTime.ToUniversalTime().ToString('o')",
      ],
      { windowsHide: true, timeout: 15000, maxBuffer: 4096, encoding: "utf8" },
      (error, stdout) => {
        const value = stdout?.trim();
        resolve(
          !error && value && Number.isFinite(Date.parse(value)) ? value : null,
        );
      },
    );
  });
  const value = await bootTime;
  if (value === null) bootTime = undefined;
  return value;
}

export function rebootConfirmsTermination(
  receiptUpdatedAt: unknown,
  bootedAt: string | null,
  observedAt = new Date().toISOString(),
): boolean {
  if (typeof receiptUpdatedAt !== "string" || !bootedAt) return false;
  const receipt = Date.parse(receiptUpdatedAt);
  const boot = Date.parse(bootedAt);
  const observed = Date.parse(observedAt);
  // Leave close/ambiguous clock boundaries held; never infer successful completion.
  return (
    Number.isFinite(receipt) &&
    Number.isFinite(boot) &&
    Number.isFinite(observed) &&
    receipt < boot - 60_000 &&
    boot <= observed &&
    receipt <= observed
  );
}
