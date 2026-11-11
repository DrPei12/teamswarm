import { lstatSync, renameSync } from "node:fs";
import { conflict } from "../errors.js";

const exists = (file: string) => {
  try { lstatSync(file); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
};

/** Commit a new, unpublished directory. Windows scanners can briefly hold a
 * freshly written child; retry only those transient failures, without replacing
 * a destination or changing filesystem permissions. Normal commits never wait. */
export function commitPreparedDirectory(source: string, target: string, options: {
  platform?: string; rename?: typeof renameSync; wait?: (milliseconds: number) => void;
} = {}) {
  const rename = options.rename ?? renameSync;
  const wait = options.wait ?? (milliseconds => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds));
  const delays = [10, 25, 50, 100, 200];
  for (let attempt = 0; ; attempt++) {
    if (exists(target)) throw conflict("workspace_exists", "The working directory already exists; existing files are never overwritten.");
    try { rename(source, target); return; }
    catch (error) {
      if ((options.platform ?? process.platform) !== "win32" || attempt >= delays.length ||
          !["EPERM", "EACCES", "EBUSY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      wait(delays[attempt]);
    }
  }
}
