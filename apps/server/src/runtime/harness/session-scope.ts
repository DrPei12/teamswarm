import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/** A recreated native cache must not inherit the deleted cache's session IDs. */
export function sessionStoreScope(directory: string, owned = true): string {
  const absolute = path.resolve(directory);
  let generation = "external";
  if (owned) {
    mkdirSync(absolute, { recursive: true, mode: 0o700 });
    const marker = path.join(absolute, ".teamswarm-session-store");
    try {
      writeFileSync(marker, randomUUID(), { flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    generation = readFileSync(marker, "utf8");
    if (!/^[a-f0-9-]{36}$/.test(generation))
      throw new Error("Invalid native session store identity.");
  }
  return createHash("sha256")
    .update(process.platform === "win32" ? absolute.toLowerCase() : absolute)
    .update("\0" + generation)
    .digest("hex");
}
