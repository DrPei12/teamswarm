import { spawn } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  renameSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {
  deviceEntry,
  deviceNpm,
  packageFor,
  installerEnvironment,
  assertGlobalPrefix,
  canonicalPath,
} from "./device-tools.js";
import { codexCommand } from "./codex.js";
import { nativeEntry, terminateNative } from "./native-support.js";
import { badRequest, conflict } from "../../errors.js";

const repository = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../..",
);
const catalog = JSON.parse(
  readFileSync(path.join(repository, "config/harnesses.json"), "utf8"),
) as Record<string, { package: string; version: string }>;
const websites: Record<string, string> = {
  grok: "https://github.com/xai-org/grok-build/releases",
  codex: "https://github.com/openai/codex/releases",
  "claude-code": "https://github.com/anthropics/claude-code/releases",
  pi: "https://github.com/earendil-works/pi-mono/releases",
  opencode: "https://github.com/anomalyco/opencode/releases",
  "deepseek-harness": "https://github.com/deepseek-ai/DeepSeek-Harness",
};
export function versionFrom(text: string) {
  return text.match(/\b\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?\b/)?.[0] ?? null;
}
export function newerVersion(latest: string, current: string) {
  const a = latest.split("-")[0].split(".").map(Number),
    b = current.split("-")[0].split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  const next = latest.split("-").slice(1).join("-");
  const previous = current.split("-").slice(1).join("-");
  if (!next || !previous) return !!previous && !next;
  const left = next.split("."),
    right = previous.split(".");
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    if (left[i] === right[i]) continue;
    if (left[i] === undefined) return false;
    if (right[i] === undefined) return true;
    const numericLeft = /^\d+$/.test(left[i]);
    const numericRight = /^\d+$/.test(right[i]);
    if (numericLeft && numericRight) return Number(left[i]) > Number(right[i]);
    if (numericLeft !== numericRight) return !numericLeft;
    return left[i] > right[i];
  }
  return false;
}
export class UnconfirmedStop extends Error {}
export async function runCommand(
  command: string,
  args: string[],
  timeout = 15000,
) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: homedir(),
      windowsHide: true,
      detached: process.platform !== "win32",
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      env: installerEnvironment(),
    });
    child.stdin.end();
    let output = "",
      ended = false,
      terminating = false;
    const finish = (error?: Error) => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      error ? reject(error) : resolve(output);
    };
    const timer = setTimeout(() => {
      terminating = true;
      void terminateNative(child).then((confirmed) =>
        finish(
          confirmed
            ? new Error(
                "The command timed out. Check your network and try again.",
              )
            : new UnconfirmedStop(
                "The installer could not be stopped. Check the device's npm processes before installing again.",
              ),
        ),
      );
    }, timeout);
    child.stdout.on("data", (value) => {
      output = (output + value).slice(-32000);
    });
    child.stderr.resume();
    child.once("error", () =>
      finish(
        new Error(
          "The installer could not start. Check that Node.js and npm are installed.",
        ),
      ),
    );
    child.once("close", (code) => {
      if (!terminating)
        finish(
          code === 0
            ? undefined
            : new Error(
                "Installation or version check failed. Check your network and global npm directory permissions.",
              ),
        );
    });
  });
}
type Job = {
  id: string;
  harness: string;
  state: "installing" | "complete" | "failed";
  version: string;
  pid: number;
  prefix: string;
  error?: string;
  uncertain?: boolean;
  completedAt?: number;
};
function readJob(file: string): Job | null {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}
function writeJob(file: string, job: Job) {
  const temp = file + "." + process.pid + ".tmp";
  writeFileSync(temp, JSON.stringify(job));
  renameSync(temp, file);
}
function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
export class HarnessManagement {
  private latest = new Map<string, { version: string; checkedAt: number }>();
  constructor(
    private stateDirectory: string,
    private protectedDirectories: () => string[] = () => [],
    private run = runCommand,
    private request = fetch,
  ) {}
  private definition(id: string) {
    if (!Object.hasOwn(catalog, id))
      throw badRequest("unknown_harness", "Unknown harness.");
    return catalog[id];
  }
  private entry(id: string) {
    try {
      return id === "codex"
        ? codexCommand()
        : { command: nativeEntry(id), args: [] };
    } catch {
      return null;
    }
  }
  async status(id: string, checkUpdates = true, forceUpdate = false) {
    const definition = this.definition(id),
      entry = this.entry(id),
      device = deviceEntry(id);
    const selected = entry ? entry.args[0] || entry.command : null;
    let version: string | null = null;
    if (selected) {
      if (id === "pi")
        version = packageFor(selected, definition.package)?.version ?? null;
      else {
        const js = /\.[cm]?js$/.test(selected);
        try {
          version = versionFrom(
            await this.run(js ? process.execPath : selected, [
              ...(js ? [selected] : []),
              "--version",
            ]),
          );
        } catch {}
      }
    }
    let latest = this.latest.get(id),
      updateError: string | null = null;
    if (
      checkUpdates &&
      (forceUpdate || !latest || Date.now() - latest.checkedAt > 6 * 3600000)
    ) {
      try {
        const response = await this.request(
          "https://registry.npmjs.org/" +
            encodeURIComponent(definition.package) +
            "/latest",
          { signal: AbortSignal.timeout(8000) },
        );
        if (!response.ok) throw new Error();
        const result = (await response.json()) as { version?: string };
        if (
          !result.version ||
          !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(result.version)
        )
          throw new Error();
        latest = { version: result.version, checkedAt: Date.now() };
        this.latest.set(id, latest);
      } catch {
        updateError = "Couldn’t check for updates. Try again later.";
      }
    }
    const job = readJob(path.join(this.stateDirectory, id + ".json"));
    if (job?.state === "installing" && !alive(job.pid)) {
      job.state = "failed";
      job.uncertain = true;
      job.error =
        "Installation was interrupted. Check the device's npm processes before trying again.";
    }
    return {
      id,
      installed: !!entry,
      version,
      latestVersion: latest?.version ?? null,
      updateAvailable:
        !updateError && version && latest
          ? newerVersion(latest.version, version)
          : null,
      updateError,
      checkedAt: latest ? new Date(latest.checkedAt).toISOString() : null,
      releaseUrl: websites[id],
      package: definition.package,
      installVersion: latest?.version ?? definition.version,
      canInstall:
        (!device || (job?.state === "failed" && !job.uncertain)) &&
        !!deviceNpm() &&
        !process.env["TEAM_" + id.replaceAll("-", "_").toUpperCase() + "_BIN"],
      scope:
        selected && device && canonicalPath(selected) === canonicalPath(device)
          ? "device"
          : entry
            ? "configured"
            : null,
      job: job
        ? { state: job.state, version: job.version, error: job.error }
        : null,
      restartRequired:
        id === "codex" &&
        job?.state === "complete" &&
        (job.completedAt ?? 0) > Date.now() - process.uptime() * 1000,
    };
  }
  async install(id: string) {
    const definition = this.definition(id);
    const previousJob = readJob(path.join(this.stateDirectory, id + ".json"));
    if (
      deviceEntry(id) &&
      !(previousJob?.state === "failed" && !previousJob.uncertain)
    )
      throw conflict(
        "already_installed",
        "This harness is already installed. Use its own updater to update it.",
      );
    const npm = deviceNpm();
    if (!npm)
      throw badRequest(
        "npm_missing",
        "Install Node.js and npm on this device, then try again.",
      );
    if (process.env["TEAM_" + id.replaceAll("-", "_").toUpperCase() + "_BIN"])
      throw badRequest(
        "custom_entry",
        "Check the configured harness location before installing.",
      );
    const prefix = (
      await this.run(npm.node, [npm.cli, "prefix", "--global"])
    ).trim();
    try {
      assertGlobalPrefix(prefix, [
        repository,
        this.stateDirectory,
        ...this.protectedDirectories(),
      ]);
    } catch (error) {
      throw badRequest("private_prefix", (error as Error).message);
    }
    mkdirSync(this.stateDirectory, { recursive: true });
    const lock = path.join(this.stateDirectory, "device-install.lock");
    const previous = readJob(lock);
    if (previous) {
      const result = readJob(
        path.join(this.stateDirectory, previous.harness + ".json"),
      );
      if (
        !alive(previous.pid) &&
        result &&
        result.id === previous.id &&
        result.state !== "installing" &&
        !result.uncertain
      )
        unlinkSync(lock);
    }
    const job: Job = {
      id: randomUUID(),
      harness: id,
      state: "installing",
      version: this.latest.get(id)?.version ?? definition.version,
      prefix,
      pid: process.pid,
    };
    try {
      writeFileSync(lock, JSON.stringify(job), { flag: "wx" });
    } catch {
      throw conflict(
        "installer_busy",
        "Another device installation is in progress. Wait for it to finish.",
      );
    }
    const jobFile = path.join(this.stateDirectory, id + ".json");
    writeJob(jobFile, job);
    try {
      const worker = spawn(
        process.execPath,
        [
          fileURLToPath(import.meta.url),
          "--install-worker",
          this.stateDirectory,
          id,
          job.id,
        ],
        {
          cwd: homedir(),
          detached: true,
          windowsHide: true,
          stdio: "ignore",
          env: installerEnvironment(),
        },
      );
      await new Promise<void>((resolve, reject) => {
        worker.once("spawn", resolve);
        worker.once("error", reject);
      });
      worker.unref();
    } catch {
      job.state = "failed";
      job.error =
        "The installer could not start. Check that Node.js and npm are installed.";
      writeJob(jobFile, job);
      unlinkSync(lock);
      throw badRequest("installer_failed", job.error);
    }
    return { state: job.state, version: job.version };
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) &&
  process.argv[2] === "--install-worker"
) {
  const [, , , directory, id, requestId] = process.argv;
  const lock = path.join(directory, "device-install.lock"),
    file = path.join(directory, id + ".json");
  const job = readJob(lock);
  if (
    !job ||
    job.id !== requestId ||
    job.harness !== id ||
    !Object.hasOwn(catalog, id)
  )
    throw new Error("Invalid installation request.");
  job.pid = process.pid;
  writeJob(lock, job);
  writeJob(file, job);
  try {
    const npm = deviceNpm();
    if (!npm)
      throw new Error(
        "Install Node.js and npm on this device, then try again.",
      );
    assertGlobalPrefix(job.prefix, [repository, directory]);
    await runCommand(
      npm.node,
      [
        npm.cli,
        "install",
        "--global",
        "--prefix",
        job.prefix,
        "--no-audit",
        "--no-fund",
        "--registry=https://registry.npmjs.org",
        catalog[id].package + "@" + job.version,
      ],
      300000,
    );
    const entry = deviceEntry(id);
    if (!entry)
      throw new Error(
        "Installation finished, but the command is not on PATH. Restart TeamSwarm after adding the global npm directory to PATH.",
      );
    if (id === "pi") {
      await runCommand(
        npm.node,
        [
          "--input-type=module",
          "-e",
          "import {pathToFileURL} from 'node:url'; const sdk=await import(pathToFileURL(process.argv[1]).href); if(typeof sdk.ModelRuntime?.create !== 'function' || typeof sdk.createAgentSession !== 'function') process.exit(1);",
          entry,
        ],
        30000,
      );
    } else {
      const js = /\.[cm]?js$/.test(entry);
      const version = versionFrom(
        await runCommand(
          js ? npm.node : entry,
          [...(js ? [entry] : []), "--version"],
          30000,
        ),
      );
      if (!version)
        throw new Error(
          "The installed command did not report its version. Try installing again.",
        );
    }
    job.state = "complete";
    job.completedAt = Date.now();
  } catch (error) {
    job.state = "failed";
    job.error = (error as Error).message;
    job.uncertain = error instanceof UnconfirmedStop;
  } finally {
    writeJob(file, job);
    if (!job.uncertain && readJob(lock)?.id === job.id) unlinkSync(lock);
  }
}
