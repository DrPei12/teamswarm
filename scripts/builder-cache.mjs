import { mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import path from "node:path";

// electron-builder unpacks each tool beside its final location and renames it
// into place. Some user profiles refuse that rename (for example an encrypted
// %LOCALAPPDATA% on Windows), which surfaces as "EXDEV: cross-device link not
// permitted" while the installer is being built.
export function canRenameInside(directory) {
  let probe;
  try {
    mkdirSync(directory, { recursive: true });
    probe = mkdtempSync(path.join(directory, "rename-check-"));
    renameSync(probe, `${probe}.moved`);
    probe = `${probe}.moved`;
    return true;
  } catch {
    return false;
  } finally {
    if (probe) rmSync(probe, { recursive: true, force: true });
  }
}

// Returns the cache directory to hand to electron-builder, or undefined to keep
// its own default. An explicit ELECTRON_BUILDER_CACHE is always respected.
export function builderCache({ configured, standard, fallback, usable = canRenameInside }) {
  if (configured?.trim()) return configured.trim();
  if (usable(standard)) return undefined;
  if (!usable(fallback)) throw new Error(`Neither ${standard} nor ${fallback} can hold the packaging tools. Set ELECTRON_BUILDER_CACHE to a writable folder.`);
  return fallback;
}
