import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { z } from "zod";
import type { HarnessRequest, PreparedExecutionEnvironment } from "../types.js";
import { JsonRpcPeer } from "./json-rpc-peer.js";
import { nativeEnvironment, terminateNative } from "./native-support.js";
import { confirmOwnedExit, ownedWindowsExitEvidence, requestOwnedJobStop, spawnOwned } from "./owned-process.js";

const permissionProfile = "teamswarm-review";
const schema = z.object({
  argv: z.array(z.string().max(4096)).min(1).max(64),
  timeoutMs: z.number().int().min(100).max(120000).optional(),
}).strict().refine(input => input.argv[0].length > 0, "Supply an executable.");

export const codexReviewCommandTool = {
  name: "team_review_command",
  description: "Run an executable and its arguments from the frozen review workspace. Project files are read-only. Temporary files and test services use the granted scratch space and loopback. Read team_review_evidence for the command evidence ID.",
  inputSchema: z.toJSONSchema(schema),
};

function toml(value: unknown): string {
  if (value && typeof value === "object" && !Array.isArray(value))
    return "{" + Object.entries(value).map(([key, entry]) => JSON.stringify(key) + "=" + toml(entry)).join(",") + "}";
  return JSON.stringify(value);
}

type Runner = { child: ChildProcessWithoutNullStreams; peer: JsonRpcPeer };
type Command = { exitCode: number; output: string; evidenceEventId?: string };

export class CodexReviewCommands {
  private id = randomUUID();
  private child?: ChildProcessWithoutNullStreams;
  private release?: Promise<void>;
  private opening?: Promise<Runner>;
  private closing?: Promise<void>;
  private active?: Promise<Command>;
  private results = new Map<string, { parameters: string; result: Promise<Command> }>();
  constructor(
    private cli: { command: string; args: string[] },
    private configuration: Record<string, unknown>,
    private request: HarnessRequest,
    private environment: PreparedExecutionEnvironment,
    private verifySandbox: (sandbox: Record<string, unknown>, directory: string) => boolean,
  ) {}

  private getRunner(signal: AbortSignal) {
    return this.opening ??= this.open(signal);
  }

  private async open(signal: AbortSignal): Promise<Runner> {
    const home = path.join(path.dirname(this.environment.directory), "command-state", path.basename(this.environment.directory));
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const settings = { ...this.configuration, "features.plugins": false, "features.apps": false,
      default_permissions: permissionProfile, ...(process.platform === "win32" ? { "windows.sandbox": "mxc" } : {}) };
    this.request.onEvent({ type: "review.command_runner_started", data: { id: this.id,
      ...(process.platform === "win32" ? { ownership: "windows-attempt-job" } : {}) } });
    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.child = await spawnOwned(this.cli.command, [
        ...this.cli.args, ...Object.entries(settings).flatMap(([key, value]) => ["-c", key + "=" + toml(value)]),
        "app-server", "--listen", "stdio://",
      ], { cwd: this.request.workspace, windowsHide: true, env: { ...nativeEnvironment(), CODEX_HOME: home } }, { beforeStart: () => {
        signal.throwIfAborted();
        if (this.closing) throw new Error("The review command lease is closed.");
        this.request.assertReviewCommand!();
      } });
    } catch (error) {
      this.request.onEvent({ type: "review.command_runner_released", data: { id: this.id,
        ...(process.platform === "win32" ? { exitEvidence: "windows-job-not-started" } : {}) } });
      throw error;
    }
    const peer = new JsonRpcPeer(value => child.stdin.write(JSON.stringify(value) + "\n"), "Codex review commands");
    const lines = createInterface({ input: child.stdout });
    child.stderr.resume();
    child.stdin.on("error", error => peer.close(error.message));
    child.on("error", error => peer.close(error.message));
    child.once("close", () => { lines.close(); peer.close(); });
    lines.on("line", line => {
      try { peer.receive(JSON.parse(line)); } catch { peer.close("Invalid Codex command protocol response."); }
    });
    try {
      await peer.call("initialize", { clientInfo: { name: "teamswarm-review-commands", version: "1" }, capabilities: { experimentalApi: true } });
      peer.send({ jsonrpc: "2.0", method: "initialized", params: {} });
      const started = await peer.call("thread/start", { cwd: this.request.workspace, permissions: permissionProfile, approvalPolicy: "never", ephemeral: true,
        model: "review-no-model", modelProvider: "teamswarm", config: { "model_providers.teamswarm": { name: "Review commands",
          base_url: "http://127.0.0.1:1", wire_api: "responses", requires_openai_auth: false } } });
      if (!this.verifySandbox(started.sandbox, this.environment.directory))
        throw new Error("Native Codex did not grant the review command sandbox.");
      return { child, peer };
    } catch (error) {
      await this.releaseChild(child);
      throw error;
    }
  }

  private releaseChild(child: ChildProcessWithoutNullStreams) {
    return this.release ??= (async () => {
      child.stdin.end();
      await this.requireExit(child);
      const exitEvidence = await ownedWindowsExitEvidence(child);
      this.request.onEvent({ type: "review.command_runner_released", data: { id: this.id, pid: child.pid, ...(exitEvidence ? { exitEvidence } : {}) } });
    })();
  }

  private async requireExit(child: ChildProcessWithoutNullStreams) {
    const waitForExit = async (limit = 1500) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      await new Promise<void>(resolve => {
        const finish = () => { clearTimeout(timer); child.removeListener("exit", finish); resolve(); };
        const timer = setTimeout(finish, limit);
        child.once("exit", finish);
      });
    };
    await waitForExit();
    if (child.exitCode === null && child.signalCode === null) {
      if (process.platform === "win32") {
        if (requestOwnedJobStop(child)) await waitForExit(5000);
        if (child.exitCode === null && child.signalCode === null) child.kill();
      } else await terminateNative(child);
      await waitForExit();
    }
    if (!await confirmOwnedExit(child)) throw new Error("Codex review command process termination is unconfirmed.");
  }

  call(callId: string, input: unknown, signal: AbortSignal) {
    if (this.closing || signal.aborted) throw new Error("The review command lease is closed.");
    if (typeof callId !== "string" || !callId) throw new Error("A native command call ID is required.");
    const options = schema.parse(input);
    const parameters = JSON.stringify(options);
    const prior = this.results.get(callId);
    if (prior) {
      if (prior.parameters !== parameters) throw new Error("This native command call ID already has different arguments.");
      return prior.result;
    }
    if (this.active) throw new Error("Wait for the active review command to finish.");
    if (this.results.size >= 128) throw new Error("The review command limit for this attempt has been reached.");
    const operation = this.execute(callId, options, signal).finally(() => { this.active = undefined; });
    this.results.set(callId, { parameters, result: operation });
    this.active = operation;
    return operation;
  }

  private async execute(callId: string, input: z.infer<typeof schema>, signal: AbortSignal) {
    this.request.assertReviewCommand!();
    const { peer } = await this.getRunner(signal);
    if (signal.aborted || this.closing) throw new Error("The review command lease is closed.");
    this.request.assertReviewCommand!();
    const timeoutMs = input.timeoutMs ?? 30000;
    const processId = randomUUID();
    const startedAt = new Date().toISOString(), deadline = performance.now() + timeoutMs;
    const command = input.argv.map(arg => JSON.stringify(arg)).join(" ");
    let expired = false;
    const stop = () => {
      void peer.call("command/exec/terminate", { processId }, 3000).catch(() => this.close()).catch(() => {});
    };
    signal.addEventListener("abort", stop, { once: true });
    const timer = setTimeout(() => { expired = true; stop(); }, timeoutMs);
    try {
      const result = await peer.call("command/exec", {
        processId, command: input.argv, cwd: this.request.workspace,
        env: { TEMP: this.environment.directory, TMP: this.environment.directory, TMPDIR: this.environment.directory,
          POWERSHELL_TELEMETRY_OPTOUT: "1", DOTNET_CLI_TELEMETRY_OPTOUT: "1", TEAMSWARM_LINK_FIXTURES: this.environment.linkFixtures ?? null },
        permissionProfile, timeoutMs: timeoutMs + 2000, outputBytesCap: 32768,
      }, timeoutMs + 6000);
      if (signal.aborted || this.closing) throw new Error("The review command lease is closed.");
      if (expired || performance.now() >= deadline) throw new Error("The review command timed out.");
      if (!Number.isInteger(result.exitCode)) throw new Error("Codex did not return a review command exit status.");
      this.request.assertReviewCommand!();
      const output = [result.stdout, result.stderr].filter(part => typeof part === "string" && part).join("\n");
      const data = {
        type: "commandExecution", id: callId, command, startedAt, cwd: this.request.workspace,
        status: "completed", exitCode: result.exitCode, output, reviewCommandLane: true,
      };
      const evidenceEventId = this.request.recordReviewCommand?.(data);
      if (!evidenceEventId) this.request.onEvent({ type: "execution.item", data });
      this.request.onEvent({ type: "transcript.item", data: {
        id: callId, kind: "command", title: command, text: command, status: "completed", exitCode: result.exitCode, output,
      } });
      return { exitCode: result.exitCode as number, output, ...(evidenceEventId ? { evidenceEventId } : {}) };
    } catch (error) {
      await this.close();
      throw error;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
    }
  }

  close(): Promise<void> {
    return this.closing ??= (async () => {
      if (this.child) return this.releaseChild(this.child);
      const runner = this.opening && await this.opening.catch(async error => {
        if (this.release) await this.release;
        else if (this.child) throw error;
        return undefined;
      });
      if (!runner) return;
      await this.releaseChild(runner.child);
    })();
  }
}
