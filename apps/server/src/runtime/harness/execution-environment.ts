import { mkdirSync, realpathSync, writeFileSync, linkSync, symlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { ExecutionRequirements, PreparedExecutionEnvironment } from "../types.js";

function directoryPath(directory: string) {
  try { return realpathSync.native(directory); }
  catch (error) {
    // MXC can deny the final-path handle query on an otherwise writable
    // directory. Node's traversal still resolves its actual filesystem links.
    if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    return realpathSync(directory);
  }
}
/** Prepare only the platform-owned scratch grant, before entering the native sandbox. */
export function prepareExecutionEnvironment(directory: string, requirements: ExecutionRequirements): PreparedExecutionEnvironment {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const scratch = directoryPath(directory);
  let linkFixtures: string | undefined;
  if (requirements.fileLinks) {
    linkFixtures = path.join(scratch, "links-" + randomUUID());
    for (const child of ["hardlink", "junction", "outside"])
      mkdirSync(path.join(linkFixtures, child), { recursive: true });
    const peer = path.join(linkFixtures, "hardlink", "peer.md");
    writeFileSync(peer, "peer\n", { flag: "wx" });
    linkSync(peer, path.join(linkFixtures, "hardlink", "alias.md"));
    symlinkSync(directoryPath(path.join(linkFixtures, "outside")),
      path.join(linkFixtures, "junction", "linked"), process.platform === "win32" ? "junction" : "dir");
  }
  const launcher = path.join(scratch, "run-check-" + randomUUID() + ".cjs");
  // No shell interpolation. The child retains the caller's native sandbox;
  // this launcher normalizes temporary storage, not execution permissions.
  writeFileSync(launcher, `const {spawnSync}=require('node:child_process');
const [command,...args]=process.argv.slice(2);
if(!command){console.error('Usage: run-check.cjs <executable> [arguments]');process.exit(2)}
const env={...process.env,TEMP:${JSON.stringify(scratch)},TMP:${JSON.stringify(scratch)},TMPDIR:${JSON.stringify(scratch)},POWERSHELL_TELEMETRY_OPTOUT:'1',DOTNET_CLI_TELEMETRY_OPTOUT:'1'};
${linkFixtures ? `env.TEAMSWARM_LINK_FIXTURES=${JSON.stringify(linkFixtures)};` : "delete env.TEAMSWARM_LINK_FIXTURES;"}
const result=spawnSync(command,args,{env,stdio:'inherit',windowsHide:true,shell:false});
if(result.error)console.error(result.error.message);
process.exit(Number.isInteger(result.status)?result.status:1);
`, { mode: 0o600 });
  return { directory: scratch, commandPrefix: [process.execPath, launcher], ...(linkFixtures ? { linkFixtures } : {}) };
}
