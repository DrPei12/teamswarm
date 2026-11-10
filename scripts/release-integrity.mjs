import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

// Windows starts a program at the integrity level of its file when that is
// lower than the caller's. NSIS builds the uninstaller by running a helper it
// has just written to the release folder, so a folder that inherits a Low
// label makes that helper run without write access to its own output and the
// build stops with "process failed 2".
export function lowIntegrityLabel(sddl) {
  return /\(ML;[^)]*;;;(LW|S-1-16-4096)\)/.test(sddl);
}

const icacls = () => path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "icacls.exe");

function describe(directory) {
  const scratch = mkdtempSync(path.join(tmpdir(), "teamswarm-label-"));
  try {
    const file = path.join(scratch, "label.txt");
    const saved = spawnSync(icacls(), [directory, "/save", file], { windowsHide: true });
    return saved.status === 0 ? readFileSync(file, "utf16le") : "";
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function relabel(directory) {
  return spawnSync(icacls(), [directory, "/setintegritylevel", "(OI)(CI)M"], { windowsHide: true }).status === 0;
}

// Returns true when the folder had to be relabelled so that programs built
// into it run at the caller's own level.
export function keepCallerIntegrity(directory, { platform = process.platform, inspect = describe, apply = relabel } = {}) {
  if (platform !== "win32" || !lowIntegrityLabel(inspect(directory))) return false;
  if (!apply(directory))
    throw new Error(`Programs started from ${directory} run with reduced rights, so the installer cannot be built there. Remove the Low integrity label from that folder and build again.`);
  return true;
}
