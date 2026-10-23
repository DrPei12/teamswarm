import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  renameSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createInterface } from "node:readline";
import type {
  Harness,
  HarnessRequest,
  HarnessResult,
  ExecutionConfig,
} from "../types.js";
import { redact } from "../redact.js";
import { sessionStoreScope } from "./session-scope.js";
import { NativeUsage } from "./native-usage.js";
import { grokModelConfig, isolateGrokEnvironment } from "./grok-config.js";
import { accountHome, subscriptionEnvironment, subscriptionInspection, subscriptionAccounts, subscriptionScope, claudeSubscriptionFlags } from "./subscriptions.js";
import { rebootConfirmsTermination, systemBootTime } from "./native-recovery.js";
import {
  childEnvironment,
  nativeEntry,
  nativeHome,
  toolBridge,
  terminateNative,
} from "./native-support.js";

type NativeId = "claude-code" | "grok" | "pi" | "opencode" | "deepseek-harness";
type Active = {
  child: ChildProcessWithoutNullStreams;
  done: Promise<HarnessResult>;
  stopping: boolean;
  termination?: Promise<boolean>;
};

/** Native loops stay in their own executable/SDK. No model-loop emulation here. */
export class NativeHarness implements Harness {
  readonly capabilities;
  get sessionScope(): string {
    return sessionStoreScope(nativeHome(this.id)) + (this.id === "claude-code" || this.id === "grok" ? ":" + subscriptionScope(this.id) : "") + (this.id === "grok" ? ":acp-profile-v1" : "");
  }
  private active = new Map<string, Active>();
  constructor(readonly id: NativeId) {
    this.capabilities = {
      dispatchTracking: true,
      sessions: true,
      resume: id !== "deepseek-harness",
      streaming: true,
      dynamicTools: true,
      interrupt: true,
      usage: true,
      customModel: true,
      customProvider: true,
      nativeChecks: false,
      reasoningEffort: false,
      protocol:
        id === "pi" || id === "opencode" || id === "grok"
          ? "chat-completions"
          : "anthropic-messages",
      isolation:
        id === "pi"
          ? "tool selection; native file tools are not an OS sandbox"
          : "native permissions; no cross-user isolation",
      cancellation:
        id === "pi" || id === "claude-code"
          ? "native interrupt; OS process-tree termination fallback"
          : "native shutdown or OS process-tree termination; uncertain execution remains recovery_required",
    };
  }
  async inspect() {
    if (this.id === "claude-code" || this.id === "grok") {
      const result = await subscriptionInspection(this.id);
      return { ...result, capabilities: { ...this.capabilities, ...result.capabilities } };
    }
    try {
      return {
        available: true,
        id: this.id,
        entry: nativeEntry(this.id),
        capabilities: this.capabilities,
      };
    } catch (error) {
      return { available: false, id: this.id, error: (error as Error).message };
    }
  }
  validateConfig(config: ExecutionConfig) {
    const entry = nativeEntry(this.id);
    if (config.contextWindowTokens != null && !["pi", "opencode"].includes(this.id))
      throw new Error("An explicit context window requires Pi or OpenCode.");
    if (config.maxOutputTokens != null && !["pi", "opencode"].includes(this.id))
      throw new Error("An explicit output token budget requires Pi or OpenCode.");
    if (this.id === "grok" && path.basename(entry) === "grok-bootstrap.js") throw new Error("Finish the device installation check, then refresh the account status.");
    if ((this.id === "claude-code" || this.id === "grok") && !config.baseUrl && !config.credentialEnv) {
      if (config.protocol && config.protocol !== (this.id === "claude-code" ? "anthropic-messages" : "chat-completions")) throw new Error("Subscription access uses the harness's native protocol.");
      if (config.thinkingFormat) throw new Error("A custom thinking format is not supported for subscription access.");
      if (config.effort && this.id === "grok") throw new Error("Use the Grok subscription's default effort.");
      return;
    }
    if (!config.model || !config.baseUrl || !config.credentialEnv)
      throw new Error(
        `${this.id} requires an explicit model, baseUrl and credentialEnv.`,
      );
    if (
      config.protocol &&
      ["claude-code", "deepseek-harness"].includes(this.id) &&
      config.protocol !== "anthropic-messages"
    )
      throw new Error(`${this.id} requires Anthropic Messages.`);
    if (config.effort != null && !(this.id === "pi" && (!config.protocol || config.protocol === "chat-completions") && ["minimal", "low", "medium", "high", "xhigh", "max"].includes(config.effort)))
      throw new Error(
        `${this.id} does not yet support an explicit reasoning effort; use null.`,
      );
    if (
      config.thinkingFormat &&
      (this.id !== "pi" ||
        (config.protocol && config.protocol !== "chat-completions"))
    )
      throw new Error(
        "The configured thinking format requires Pi Chat Completions.",
      );
  }
  async execute(request: HarnessRequest): Promise<HarnessResult> {
    const c = request.config;
    this.validateConfig(c);
    const subscription = (this.id === "claude-code" || this.id === "grok") && !c.baseUrl && !c.credentialEnv;
    if (!subscription && (!c.model || !c.baseUrl || !c.credentialEnv))
      throw new Error(
        `${this.id} requires an explicit model, baseUrl and credentialEnv.`,
      );
    const entry = nativeEntry(this.id);
    const id = request.sessionId ?? randomUUID();
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id))
      throw new Error("Invalid native session reference.");
    if (this.active.has(id)) throw new Error("Native session is busy.");
    if (request.sessionId && this.id === "deepseek-harness")
      throw new Error(
        "DeepSeek SDK resume has not been verified; use a new attempt.",
      );
    const home = path.join(nativeHome(this.id), id);
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const binding = JSON.stringify({
      workspace: path.resolve(request.workspace),
      config: c,
      ...(subscription ? { accountScope: subscriptionScope(this.id as "claude-code" | "grok") } : {}),
    });
    const bindingPath = path.join(home, "binding.json");
    if (
      existsSync(bindingPath) &&
      readFileSync(bindingPath, "utf8") !== binding
    )
      throw new Error("Session configuration or workspace changed.");
    if (request.sessionId && !existsSync(bindingPath))
      throw new Error("Native session history is unavailable.");
    writeFileSync(bindingPath, binding, { mode: 0o600 });
    const env = subscription ? subscriptionEnvironment(this.id as "claude-code" | "grok") : childEnvironment(request);
    const bridge = await toolBridge(request);
    let command = /\.[cm]?js$/.test(entry) ? process.execPath : entry;
    let args = command === process.execPath ? [entry] : [];
    let stdin = "";
    const spec = {
      entry,
      home,
      workspace: request.workspace,
      config: c,
      instructions: request.instructions,
      input: request.input,
      tools: request.tools,
      bridge: bridge.url,
      resume: Boolean(request.sessionId),
    };
    try {
      if (this.id === "pi" || this.id === "grok") {
        if (this.id === "grok" && !subscription) {
          isolateGrokEnvironment(env);
          env.GROK_HOME = home;
          writeFileSync(path.join(home, "config.toml"), grokModelConfig(c), { mode: 0o600 });
        }
        const configPath = path.join(home, "request.json");
        writeFileSync(configPath, JSON.stringify(spec), { mode: 0o600 });
        command = process.execPath;
        const compiled = fileURLToPath(
          new URL(this.id === "grok" ? "./grok-worker.js" : "./pi-worker.js", import.meta.url),
        );
        args = [
          existsSync(compiled)
            ? compiled
            : fileURLToPath(new URL(this.id === "grok" ? "./grok-worker.ts" : "./pi-worker.ts", import.meta.url)),
          configPath,
        ];
      } else if (this.id === "claude-code") {
        env.CLAUDE_CONFIG_DIR = subscription ? accountHome("claude-code") : home;
        if (!subscription) {
          env.ANTHROPIC_API_KEY = env[c.credentialEnv!];
          env.ANTHROPIC_BASE_URL = c.baseUrl!;
        }
        env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
        env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = "8192";
        const mcp = JSON.stringify({
          mcpServers: { teamswarm: { type: "http", url: bridge.url } },
        });
        const nativeTools =
          c.access === "read-only"
            ? "Read,Glob,Grep"
            : "Read,Glob,Grep,Write,Edit,Bash";
        args.push(
          ...(subscription ? claudeSubscriptionFlags : ["--bare"]),
          "--restricted",
          "--print",
          "--verbose",
          "--output-format",
          "stream-json",
          ...(c.model ? ["--model", c.model] : []),
          ...(subscription && c.effort ? ["--effort", c.effort] : []),
          "--permission-mode",
          "dontAsk",
          "--tools",
          nativeTools,
          "--allowedTools",
          nativeTools + ",mcp__teamswarm__*",
          "--mcp-config",
          mcp,
          "--strict-mcp-config",
          "--system-prompt",
          request.instructions,
          "--input-format",
          "stream-json",
          ...(request.sessionId ? ["--resume", id] : ["--session-id", id]),
        );
        stdin =
          JSON.stringify({
            type: "user",
            message: { role: "user", content: request.input },
          }) + "\n";
      } else if (this.id === "opencode") {
        env.XDG_CONFIG_HOME = path.join(home, "config");
        env.XDG_DATA_HOME = path.join(home, "data");
        env.XDG_STATE_HOME = path.join(home, "state");
        env.OPENCODE_DISABLE_PROJECT_CONFIG = "true";
        env.OPENCODE_DISABLE_DEFAULT_PLUGINS = "true";
        env.OPENCODE_DISABLE_MODELS_FETCH = "true";
        env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          share: "disabled",
          autoupdate: false,
          provider: {
            teamswarm: {
              npm:
                c.protocol === "responses"
                  ? "@ai-sdk/openai"
                  : c.protocol === "anthropic-messages"
                    ? "@ai-sdk/anthropic"
                    : "@ai-sdk/openai-compatible",
              name: c.provider ?? "TeamSwarm",
              options: {
                baseURL:
                  c.protocol === "anthropic-messages" &&
                  !/\/v1\/?$/.test(c.baseUrl!)
                    ? c.baseUrl!.replace(/\/$/, "") + "/v1"
                    : c.baseUrl,
                apiKey: `{env:${c.credentialEnv}}`,
              },
              models: {
                [c.model!]: {
                  name: c.model,
                  limit: { context: c.contextWindowTokens ?? 131072, output: c.maxOutputTokens ?? 8192 },
                },
              },
            },
          },
          permission: {
            "*": "deny",
            read: "allow",
            glob: "allow",
            grep: "allow",
            list: "allow",
            edit: c.access === "read-only" ? "deny" : "allow",
            bash: c.access === "read-only" ? "deny" : "allow",
            "teamswarm_*": "allow",
            external_directory: "deny",
          },
          mcp: {
            teamswarm: { type: "remote", url: bridge.url, enabled: true },
          },
          agent: {
            teamswarm: {
              mode: "primary",
              prompt: request.instructions,
              steps: 64,
            },
          },
        });
        const nativeSessionPath = path.join(home, "native-session.json");
        args.push(
          "run",
          "--pure",
          "--format",
          "json",
          "--model",
          `teamswarm/${c.model}`,
          "--agent",
          "teamswarm",
          ...(request.sessionId
            ? ["--session", JSON.parse(readFileSync(nativeSessionPath, "utf8"))]
            : []),
        );
        stdin = request.input;
      } else {
        env.DSH_HOME = home;
        env.DEEPSEEK_API_KEY = env[c.credentialEnv!];
        env.DEEPSEEK_BASE_URL = c.baseUrl!;
        env.DSH_PRIMARY_RUNTIME = "";
        env.DSH_PERMISSION_MODE = c.access;
        env.DSH_MAX_TOKENS_AS_SUCCESS = "false";
        // JSON is a YAML subset. No raw credential is written into the native patch.
        const patch = [
          {
            id: "llm-deepseek",
            config: {
              baseURL: c.baseUrl,
              apiKeyEnv: "DEEPSEEK_API_KEY",
              thinking: "disabled",
              maxTokens: 8192,
              models: [{ id: c.model, contextWindow: 131072, maxTokens: 8192 }],
              retryPolicy: { mode: "normal", maxRetries: 0 },
            },
          },
          ...[
            "tool-subagent",
            "tool-subagent-fork",
            "tool-subagent-control",
            "tool-subagent-list-agents",
            "tool-web",
            "workflow-ptc",
            "tool-workflow",
            "tool-plugin-manager",
            ...(process.env.TEAM_DSH_DISABLE_SHELL === "1"
              ? ["tool-bash", "tool-pwsh", "tool-jobs"]
              : []),
          ].map((id) => ({ id, disabled: true })),
          {
            id: "system-prompt",
            config: {
              personaPrefix:
                request.instructions +
                (process.env.TEAM_DSH_DISABLE_SHELL === "1"
                  ? "\nThis deployment disables general shell tools. Use native file tools for your owned source files and Team tools for collaboration and submission. Do not emulate shell execution through another tool. Submit code for the independent reviewer to execute checks. Never remove shared directories or other members' files."
                  : ""),
              personaSuffix: "Your working directory is {{cwd}}.",
            },
          },
          {
            insert: [
              {
                id: "teamswarm-mcp",
                name: "@deepseek-ai/dsh-mcp-client",
                config: {
                  serverName: "teamswarm",
                  transport: "streamable-http",
                  url: bridge.url,
                  failOnStartupError: true,
                  reconnect: { enabled: false },
                },
              },
            ],
          },
        ];
        const patchPath = path.join(home, "teamswarm.patch.json");
        writeFileSync(patchPath, JSON.stringify(patch), { mode: 0o600 });
        args.push("--profile", "sdk", "--patch", patchPath);
      }
    } catch (error) {
      await bridge.close();
      throw error;
    }
    const turnId = randomUUID();
    // Commit both adapter identities before spawning a process that can execute
    // input immediately (including CLI arguments and worker specification files).
    try {
      request.onSession(id, {
        model: c.model,
        provider: c.provider,
        harness: this.id,
        protocol: c.protocol ?? this.capabilities.protocol,
        configured: true,
        ...(this.id === "deepseek-harness" && process.env.TEAM_DSH_DISABLE_SHELL === "1" ? { shellTools: "disabled" } : {}),
        turnIdentity: "adapter control token; native identifiers are separate events",
      });
      request.onTurn(turnId);
      request.onDispatch?.();
    } catch (error) {
      await bridge.close();
      throw error;
    }
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(command, args, {
        cwd: request.workspace,
        env,
        windowsHide: true,
        stdio: "pipe",
        detached: process.platform !== "win32",
      });
    } catch (error) {
      await bridge.close();
      throw error;
    }
    const receiptPath = path.join(home, `${turnId}.json`);
    const receipt = (result?: HarnessResult) => {
      writeFileSync(
        receiptPath + ".tmp",
        JSON.stringify({
          sessionId: id,
          turnId,
          pid: child.pid,
          result,
          updatedAt: new Date().toISOString(),
        }),
        { mode: 0o600 },
      );
      renameSync(receiptPath + ".tmp", receiptPath);
    };
    let observationFailure: string | undefined;
    let text = "";
    let terminal: HarnessResult | undefined;
    let stderr = "";
    let nativeSession: string | undefined;
    let grokSegment = 0, grokKind = "";
    let dshRunning = false;
    let shutdownAcknowledged = false;
    const usageTotal = new NativeUsage();
    const done = new Promise<HarnessResult>((resolve) => {
      const lines = createInterface({
        input: child.stdout,
        crlfDelay: Infinity,
      });
      const emit = (type: string, data: Record<string, unknown>) => {
        if (observationFailure) return;
        try {
          request.onEvent({ type, data: redact(data, c.credentialEnv) });
        } catch {
          observationFailure = "Runtime could not persist native observations.";
          child.stdin.end();
          const active = this.active.get(id);
          if (active) {
            active.stopping = true;
            active.termination ??= terminateNative(child);
          }
        }
      };
      const usage = (u: any, replace = false) => {
        const observation = usageTotal.observe(u, replace);
        if (observation) emit("usage", observation);
      };
      lines.on("line", (line) => {
        let event: any;
        try {
          event = JSON.parse(line);
        } catch {
          emit("native.stdout", { harness: this.id, text: line });
          return;
        }
        try {
          event = redact(event, c.credentialEnv);
          emit("native.event", { harness: this.id, event });
          if (this.id === "pi" || this.id === "grok") {
            if (event.type === "session") nativeSession = event.id;
            if (event.type === "grok.event") {
              const update = event.event;
              if (["agent_message_chunk", "agent_thought_chunk"].includes(update?.sessionUpdate) && update.content?.type === "text") {
                const kind = update.sessionUpdate === "agent_message_chunk" ? "message" : "reasoning";
                if (grokKind !== kind) { grokSegment++; grokKind = kind; }
                emit("transcript.delta", { id: `${turnId}:grok:${grokSegment}`, kind, delta: update.content.text });
              } else if (["tool_call", "tool_call_update"].includes(update?.sessionUpdate)) {
                grokKind = "";
                const output = (update.content ?? []).filter((item: any) => item.type === "content" && item.content?.type === "text").map((item: any) => item.content.text).join("\n").slice(0, 65536);
                emit("transcript.item", { id: `${turnId}:grok-tool:${update.toolCallId}`, kind: update.kind === "execute" ? "command" : update.kind === "edit" ? "file" : "tool", text: update.title || "", status: update.status === "completed" ? "completed" : update.status === "failed" ? "failed" : "running", ...(output ? { output } : {}) });
              }
            }
            if (
              event.type === "pi.event" &&
              event.event.type === "message_end"
            ) {
              const message = event.event.message;
              if (message.role === "assistant") {
                usage(message.usage ?? {});
                emit("model.observed", {
                  model: message.model,
                  provider: message.provider,
                });
              }
            }
            if (event.type === "result") terminal = event;
          } else if (this.id === "claude-code") {
            if (event.type === "system" && event.subtype === "init") {
              nativeSession = event.session_id;
              emit("model.observed", { model: event.model });
            }
            if (event.type === "assistant") {
              text += (event.message?.content ?? [])
                .filter((b: any) => b.type === "text")
                .map((b: any) => b.text)
                .join("");
            }
            if (event.type === "result") {
              usage(event.usage ?? {}, true);
              terminal = {
                status: this.active.get(id)?.stopping
                  ? "interrupted"
                  : event.is_error
                    ? "failed"
                    : "completed",
                text: event.result ?? text,
                error: event.is_error
                  ? JSON.stringify(event.errors ?? event.result)
                  : undefined,
              };
              child.stdin.end();
            }
          } else if (this.id === "opencode") {
            if (event.sessionID) {
              nativeSession = event.sessionID;
              writeFileSync(
                path.join(home, "native-session.json"),
                JSON.stringify(nativeSession),
                { mode: 0o600 },
              );
            }
            if (event.type === "text") text += event.part?.text ?? "";
            if (event.type === "error")
              terminal = {
                status: "failed",
                text,
                error: JSON.stringify(event.error),
              };
            if (event.type === "step_finish") {
              usage(event.part?.tokens ?? {});
              if (["stop", "end_turn"].includes(event.part?.reason))
                terminal = { status: "completed", text };
            }
          } else {
            if (event.id === 99 && !event.error && event.result)
              shutdownAcknowledged = true;
            if (event.id === 1) {
              if (event.error) {
                terminal = {
                  status: "failed",
                  text,
                  error: JSON.stringify(event.error),
                };
                child.stdin.end();
              } else
                child.stdin.write(
                  JSON.stringify({
                    jsonrpc: "2.0",
                    id: 2,
                    method: "session/prompt",
                    params: {
                      sessionId: id,
                      contentBlocks: [{ type: "text", text: request.input }],
                    },
                  }) + "\n",
                );
            }
            if (event.id === 2 && event.error) {
              terminal = {
                status: "failed",
                text,
                error: JSON.stringify(event.error),
              };
              child.stdin.end();
            }
            if (
              event.method === "session.status" &&
              event.params?.sessionId === id
            ) {
              if (event.params.status === "running") dshRunning = true;
              if (event.params.status === "idle" && dshRunning) {
                terminal ??= {
                  status: "unknown",
                  text,
                  error:
                    "DeepSeek became idle without a confirmed successful end event.",
                };
                child.stdin.write(
                  JSON.stringify({
                    jsonrpc: "2.0",
                    id: 3,
                    method: "shutdown",
                  }) + "\n",
                );
              }
            }
            if (event.method === "session.event") {
              const fact = event.params.event;
              if (event.params.sessionId !== id) return;
              if (fact.type === "assistant/message") {
                text = (fact.data?.message?.content ?? [])
                  .filter((b: any) => b.type === "text")
                  .map((b: any) => b.text)
                  .join("");
                usage(fact.data?.usage);
              }
              if (fact.type === "request/context")
                emit("model.observed", {
                  model: fact.data.model,
                  provider: fact.data.provider,
                });
              // Raw facts are retained; only an explicit native turn end can establish success.
              if (fact.type === "turn/end") {
                const reason = fact.data?.reason;
                terminal = {
                  status:
                    reason?.kind === "completed"
                      ? "completed"
                      : reason?.kind === "aborted"
                        ? "interrupted"
                        : "failed",
                  text,
                  error:
                    reason?.kind === "completed"
                      ? undefined
                      : JSON.stringify(reason),
                };
              }
            }
          }
          if (nativeSession) {
            emit("session.native", { nativeSessionId: nativeSession });
            nativeSession = undefined;
          }
        } catch {
          observationFailure =
            "Native event could not be interpreted or persisted.";
          child.stdin.end();
          const active = this.active.get(id);
          if (active) {
            active.stopping = true;
            active.termination ??= terminateNative(child);
          }
        }
      });
      child.stderr.on("data", (chunk) => {
        emit("native.stderr", { harness: this.id, text: String(chunk) });
        stderr = (stderr + redact(String(chunk), c.credentialEnv)).slice(-8000);
      });
      child.stdin.on("error", () => {});
      child.on("error", (error) => {
        terminal = { status: "failed", text, error: error.message };
      });
      let settled = false;
      let drainTimer: ReturnType<typeof setTimeout> | undefined;
      const finish = async (code: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(drainTimer);
        lines.close();
        await Promise.all(
          [child.stdin, child.stdout, child.stderr].map((stream) => {
            stream.destroy();
            return stream.closed
              ? Promise.resolve()
              : new Promise<void>((resolve) => stream.once("close", resolve));
          }),
        );
        const active = this.active.get(id);
        const stopping = active?.stopping;
        const terminated = active?.termination
          ? await active.termination
          : false;
        this.active.delete(id);
        await bridge.close();
        let result: HarnessResult = observationFailure
          ? { status: "unknown", text, error: observationFailure }
          : stopping && shutdownAcknowledged && code === 0
            ? {
                status: "interrupted",
                text,
                error: "Native SDK acknowledged shutdown and exited cleanly.",
              }
            : stopping && terminated
              ? {
                  status: "interrupted",
                  text,
                  error: "OS confirmed termination of the native process tree.",
                }
              : (terminal ?? {
                  status: "unknown",
                  text,
                  error: `Native process exited (${code}) without a completion receipt. ${stderr}`,
                });
        try {
          receipt(result);
        } catch {
          result = {
            status: "unknown",
            text,
            error:
              "Native terminal state could not be persisted. Reconciliation is required.",
          };
        }
        resolve(result);
      };
      child.once("close", (code) => {
        void finish(code);
      });
      child.once("exit", () => {
        if (settled) return;
        // Descendants may outlive the root while retaining inherited stdio. Stop
        // waiting locally, but never release runtime ownership on that evidence.
        drainTimer = setTimeout(() => {
          observationFailure =
            "Native root exited but inherited output pipes remained open; descendant execution is unknown.";
          child.stdin.destroy();
          child.stdout.destroy();
          child.stderr.destroy();
          void finish(child.exitCode);
        }, 2000);
      });
    });
    this.active.set(id, { child, done, stopping: false });
    try {
      receipt();
    } catch {
      observationFailure =
        "Runtime could not persist native execution identity.";
      child.stdin.end();
      const active = this.active.get(id)!;
      active.stopping = true;
      active.termination ??= terminateNative(child);
      return done;
    }
    if (this.id === "deepseek-harness")
      child.stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            cwd: request.workspace,
            provider: "deepseek-official",
            model: c.model,
            reasoningEffort:
              c.effort === "none" || !c.effort ? "off" : c.effort,
            maxTokens: 8192,
          },
        }) + "\n",
      );
    else if (this.id === "claude-code") child.stdin.write(stdin);
    else if (this.id !== "pi" && this.id !== "grok") child.stdin.end(stdin);
    return done;
  }
  async interrupt(sessionId: string, _turnId: string) {
    const active = this.active.get(sessionId);
    if (!active)
      throw new Error(
        "Native session is not active; reconcile before retrying.",
      );
    active.stopping = true;
    if (this.id === "pi" || this.id === "grok") active.child.stdin.write("abort\n");
    else if (this.id === "claude-code")
      active.child.stdin.write(
        JSON.stringify({
          type: "control_request",
          request_id: randomUUID(),
          request: { subtype: "interrupt" },
        }) + "\n",
      );
    else if (this.id === "deepseek-harness")
      active.child.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id: 99, method: "shutdown" }) + "\n",
      );
    else active.termination ??= terminateNative(active.child);
    const timer = setTimeout(() => {
      if (this.active.get(sessionId) === active)
        active.termination ??= terminateNative(active.child);
    }, 5000);
    void active.done.finally(() => clearTimeout(timer));
  }
  async reconcile(sessionId: string, turnId: string): Promise<HarnessResult> {
    if (
      !/^[a-zA-Z0-9_-]{1,100}$/.test(sessionId) ||
      !/^[a-zA-Z0-9_-]{1,100}$/.test(turnId)
    )
      throw new Error("Invalid execution reference.");
    if (this.active.has(sessionId))
      return {
        status: "unknown",
        text: "",
        error: "Native execution is still active.",
      };
    const file = path.join(nativeHome(this.id), sessionId, `${turnId}.json`);
    if (!existsSync(file))
      return {
        status: "unknown",
        text: "",
        error:
          "No durable native terminal receipt. Inspect the original native process before retrying.",
      };
    const value = JSON.parse(readFileSync(file, "utf8"));
    if (value.sessionId !== sessionId || value.turnId !== turnId)
      throw new Error("Native receipt identity does not match this execution.");
    if (!value.result || value.result.status === "unknown") {
      const bootedAt = await systemBootTime();
      if (rebootConfirmsTermination(value.updatedAt, bootedAt))
        return {
          status: "interrupted",
          text: value.result?.text ?? "",
          error: `OS boot at ${bootedAt} is later than the native receipt at ${value.updatedAt}; the previous process tree has ended. The original receipt is preserved and no successful completion is inferred.`,
        };
    }
    return (
      value.result ?? {
        status: "unknown",
        text: "",
        error:
          "Service lost observation before native termination; execution ownership remains held.",
      }
    );
  }
  async close() {
    if (this.id === "claude-code" || this.id === "grok") await subscriptionAccounts.close(this.id);
    for (const active of this.active.values()) {
      active.stopping = true;
      active.termination ??= terminateNative(active.child);
    }
    await Promise.allSettled([...this.active.values()].map((a) => a.done));
  }
}
