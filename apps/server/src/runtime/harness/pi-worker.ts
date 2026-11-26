import {
  readFileSync,
  writeFileSync,
  existsSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline";
import path from "node:path";
import type { HarnessResult, NativeCompactionPreparation, PiChildSubmission } from "../types.js";
import { piChildLifetimeMs, piChildMaxPaths, piChildOutputTokens, piChildTools, piDelegateTool } from "./pi-subspace-contract.js";
import type { PiTurnCheckpoint } from "./pi-daemon.js";

type RequestCheckpoint = (boundary: PiTurnCheckpoint, signal: AbortSignal) => Promise<string | undefined>;
type ProbeSpec = { rootActor: string; toolUrl: string; modelUrl: string };
type SubspaceSpec = ProbeSpec & { sessionId: string };
type ProbeReceipt = { path: string; sha256: string; offset: number; end: number; truncated: boolean };
const maxProbeReads = 4, maxProbeRequests = 5, maxProbeReadChars = 2000;

const emit = (value: unknown) =>
  process.stdout.write(JSON.stringify(value) + "\n");

async function loadPi(entry: string, home: string) {
  const pi = await import(pathToFileURL(entry).href);
  const runtime = await pi.ModelRuntime.create({
    authPath: path.join(home, "auth.json"),
    modelsPath: null,
    modelsStorePath: path.join(home, "models-cache.json"),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  return { pi, runtime };
}

function emptyResources(pi: any, instructions: string) {
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: pi.createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => instructions,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

function controlModelFetch(session: any, turn: AbortSignal, actor: { id: string; route: URL } | undefined,
    beforeForward?: (signal: AbortSignal, init?: RequestInit) => Promise<void>, cacheRetention?: "none") {
  const agent = session.agent;
  const stream = agent.streamFunction;
  agent.streamFunction = (model: unknown, context: unknown, options: { fetch?: typeof fetch } = {}) => {
    const transport = options.fetch ?? globalThis.fetch;
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const original = input instanceof Request ? input : undefined;
      const requestSignal = init?.signal ?? original?.signal;
      const current = requestSignal ? AbortSignal.any([turn, requestSignal]) : turn;
      current.throwIfAborted();
      let request = init;
      if (actor) {
        const url = new URL(original?.url ?? String(input));
        const base = actor.route.pathname.replace(/\/$/, "");
        if (url.origin !== actor.route.origin || (url.pathname !== base && !url.pathname.startsWith(base + "/")))
          throw new Error("The Pi model request left its assigned route.");
        const headers = new Headers(init?.headers ?? original?.headers);
        headers.set("x-teamswarm-pi-actor", actor.id);
        request = { ...init, headers, redirect: "error" };
      }
      await beforeForward?.(current, init);
      current.throwIfAborted();
      return transport(input, { ...request, signal: current });
    };
    return stream.call(agent, model, context, { ...options, fetch, ...(cacheRetention ? { cacheRetention } : {}) });
  };
}

async function piProbeTool(spec: { workspace: string; home: string; config: { model: string }; probe: ProbeSpec },
    pi: any, runtime: any, provider: string, nativeSessionId: string, route: URL,
    turnSignal: AbortSignal, requestCheckpoint: RequestCheckpoint) {
  const { WorkspaceAccess } = await import("../workspace-access.js");
  let used = false;
  return {
    name: "team_pi_probe",
    label: "Independent file probe",
    description: "Answer one scoped question with an independent read-only Pi child. Supply 1–4 exact project paths. Returns a summary and the read receipts.",
    parameters: { type: "object", properties: {
      question: { type: "string", minLength: 1, maxLength: 1000 },
      paths: { type: "array", minItems: 1, maxItems: 4, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 2000 } },
    }, required: ["question", "paths"], additionalProperties: false },
    execute: async (_callId: string, args: { question: string; paths: string[] }, parentSignal?: AbortSignal) => {
      turnSignal.throwIfAborted();
      parentSignal?.throwIfAborted();
      if (used) throw new Error("This Pi turn already used its independent probe.");
      const question = typeof args?.question === "string" ? args.question.trim() : "";
      if (!question || question.length > 1000 || !Array.isArray(args?.paths) || !args.paths.length || args.paths.length > 4 ||
          args.paths.some(file => typeof file !== "string" || file.length > 2000))
        throw new Error("Supply a question of up to 1,000 characters and 1–4 exact project paths.");
      const paths = args.paths.map(file => WorkspaceAccess.relative(file));
      if (new Set(paths).size !== paths.length) throw new Error("Supply distinct project paths.");
      used = true;
      const allowed = new Set(paths);
      const controller = new AbortController();
      const lifetime = AbortSignal.any([turnSignal, ...(parentSignal ? [parentSignal] : []), AbortSignal.timeout(25000)]);
      const current = AbortSignal.any([lifetime, controller.signal]);
      const manager = pi.SessionManager.inMemory(spec.workspace);
      const probeId: string = manager.getSessionId();
      const files: ProbeReceipt[] = [];
      let child: any;
      let unsubscribe: (() => void) | undefined;
      let stopping: Promise<void> | undefined;
      let approved = false;
      let status: "failed" | "completed" = "failed";
      let result: { summary: string; files: ProbeReceipt[] };
      let stopReason: string | undefined;
      let reads = 0, requests = 0;
      const abortChild = () => {
        if (child && !stopping) {
          const pending: Promise<void> = child.abort();
          stopping = pending;
          void pending.catch(() => {});
        }
      };
      current.addEventListener("abort", abortChild, { once: true });
      try {
        approved = await requestCheckpoint({ stage: "probe_open", nativeSessionId, probeId, paths }, current) === "authorized";
        current.throwIfAborted();
        if (!approved) throw new Error("The Pi probe was not authorized.");
        const scopedRead = {
          name: "team_read_file",
          label: "Read a scoped file",
          description: "Read only an exact assigned project path. Offsets count UTF-16 characters.",
          parameters: { type: "object", properties: { path: { type: "string", enum: paths },
            offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: maxProbeReadChars },
          }, required: ["path"], additionalProperties: false },
          execute: async (callId: string, input: { path: string; offset?: number; limit?: number }, toolSignal?: AbortSignal) => {
            const signal = toolSignal ? AbortSignal.any([current, toolSignal]) : current;
            signal.throwIfAborted();
            if (++reads > maxProbeReads) throw new Error("The Pi probe used its file read budget.");
            const file = typeof input?.path === "string" ? WorkspaceAccess.relative(input.path) : "";
            if (!allowed.has(file)) throw new Error("The requested file is outside the probe scope.");
            const offset = input.offset ?? 0, limit = input.limit ?? maxProbeReadChars;
            if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > maxProbeReadChars)
              throw new Error("Use a valid character offset and read at most 2,000 characters.");
            const response = await fetch(spec.probe.toolUrl, { signal, method: "POST", redirect: "error",
              headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: callId,
                method: "tools/call", params: { name: "team_read_file", arguments: { path: file, offset, limit },
                  _meta: { sessionId: spec.probe.rootActor, threadId: probeId } },
              }),
            });
            const data: any = await response.json();
            signal.throwIfAborted();
            const item = data.result?.content?.[0];
            if (!response.ok || data.id !== callId || data.error || data.result?.isError || item?.type !== "text")
              throw new Error("The Pi probe file read was denied.");
            const read = JSON.parse(item.text);
            if (read?.exists !== true || read.path !== file || read.offset !== offset || typeof read.text !== "string" ||
                read.text.length > limit || typeof read.truncated !== "boolean" || !/^[a-f0-9]{64}$/.test(read.sha256 ?? ""))
              throw new Error("The Pi probe did not receive a verified file range.");
            files.push({ path: file, sha256: read.sha256, offset, end: offset + read.text.length, truncated: read.truncated });
            return { content: [{ type: "text", text: read.text }], details: null };
          },
        };
        const model = runtime.getModel(provider, spec.config.model);
        ({ session: child } = await pi.createAgentSession({
          cwd: spec.workspace, agentDir: spec.home, modelRuntime: runtime,
          model: { ...model, contextWindow: Math.min(model.contextWindow, 8192), maxTokens: Math.min(model.maxTokens, 512) },
          thinkingLevel: "off", sessionManager: manager,
          settingsManager: pi.SettingsManager.inMemory({ compaction: { enabled: false },
            retry: { enabled: false, provider: { maxRetries: 0 } }, cacheWarming: "off" }),
          resourceLoader: emptyResources(pi, "Answer the question from the exact assigned project files. Return a short summary and do not reproduce file contents."),
          tools: [scopedRead.name], customTools: [scopedRead],
        }));
        current.throwIfAborted();
        controlModelFetch(child, current, { id: probeId, route }, async (_signal, init) => {
          if (++requests > maxProbeRequests || typeof init?.body === "string" && Buffer.byteLength(init.body) > 49152) {
            controller.abort();
            throw new Error("The Pi probe used its model request budget.");
          }
        }, "none");
        unsubscribe = child.subscribe((event: any) => {
          if (event.type === "message_end" && event.message?.role === "assistant") stopReason = event.message.stopReason;
        });
        await child.prompt(JSON.stringify({ question, paths }));
        current.throwIfAborted();
        const summary: string = (child.getLastAssistantText() ?? "").trim().slice(0, 1000);
        if (stopReason !== "stop" || !summary || !files.length)
          throw new Error("The Pi probe did not return a summary with file evidence.");
        result = { summary, files };
        status = "completed";
      } finally {
        current.removeEventListener("abort", abortChild);
        controller.abort();
        try {
          await stopping;
        } finally {
          try { unsubscribe?.(); child?.dispose(); }
          finally {
            const closed = await requestCheckpoint({ stage: "probe_close", nativeSessionId, probeId,
              status: lifetime.aborted ? "interrupted" : status }, AbortSignal.timeout(2000));
            if (approved && closed !== "authorized" && !lifetime.aborted)
              throw new Error("The Pi probe closed without confirmation.");
          }
        }
      }
      lifetime.throwIfAborted();
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: null };
    },
  };
}

function piDelegationTool(spec: { workspace: string; home: string; config: { model: string }; subspaces: SubspaceSpec },
    pi: any, runtime: any, provider: string, nativeSessionId: string, route: URL,
    turnSignal: AbortSignal, requestCheckpoint: RequestCheckpoint) {
  return {
    name: piDelegateTool.name, label: "Assign Pi child work", description: piDelegateTool.description,
    parameters: piDelegateTool.inputSchema,
    execute: async (_callId: string, args: { task: string; paths: string[] }, parentSignal?: AbortSignal) => {
      const lifetime = AbortSignal.any([turnSignal, ...(parentSignal ? [parentSignal] : []), AbortSignal.timeout(piChildLifetimeMs)]);
      lifetime.throwIfAborted();
      const task = typeof args?.task === "string" ? args.task.trim() : "";
      if (!task || task.length > 8000 || !Array.isArray(args?.paths) || !args.paths.length || args.paths.length > piChildMaxPaths)
        throw new Error("Supply a task and exact assigned project files.");
      const manager = pi.SessionManager.inMemory(spec.workspace);
      const childId: string = manager.getSessionId();
      const identity = { nativeSessionId, childId };
      let child: any;
      let unsubscribe: (() => void) | undefined;
      let stopping: Promise<void> | undefined;
      let stopReason: string | undefined;
      let summary = "";
      let status: "completed" | "failed" | "interrupted" = "failed";
      let result: { status: string; submission?: PiChildSubmission; error?: string } | undefined;
      const abort = () => {
        if (!child || stopping) return;
        const pending: Promise<void> = child.abort();
        stopping = pending;
        void pending.catch(() => {});
      };
      lifetime.addEventListener("abort", abort, { once: true });
      try {
        const opened = await requestCheckpoint({ stage: "subspace_open", ...identity, paths: args.paths },
          AbortSignal.any([lifetime, AbortSignal.timeout(15000)]));
        lifetime.throwIfAborted();
        const grant = opened && JSON.parse(opened) as { lease?: string; paths?: string[]; error?: string };
        if (!grant || !grant.lease || !grant.paths?.length)
          throw new Error(grant && grant.error || "The isolated file assignment was not authorized.");
        const customTools = piChildTools(grant.paths).map(tool => ({
          name: tool.name, label: tool.name, description: tool.description, parameters: tool.inputSchema,
          execute: async (callId: string, input: unknown, toolSignal?: AbortSignal) => {
            const signal = toolSignal ? AbortSignal.any([lifetime, toolSignal]) : lifetime;
            signal.throwIfAborted();
            const response = await fetch(spec.subspaces.toolUrl, {
              method: "POST", signal, redirect: "error", headers: { "content-type": "application/json" },
              body: JSON.stringify({ jsonrpc: "2.0", id: callId, method: "tools/call",
                params: { name: tool.name, arguments: input, _meta: { sessionId: spec.subspaces.sessionId, threadId: grant.lease } } }),
            });
            const data: any = await response.json();
            signal.throwIfAborted();
            if (!response.ok || data.id !== callId || data.error || !data.result)
              throw new Error("The Pi child did not receive an authorized tool result.");
            if (data.result.isError) throw new Error(data.result.content?.[0]?.text ?? "The child tool operation failed.");
            return data.result;
          },
        }));
        const model = runtime.getModel(provider, spec.config.model);
        ({ session: child } = await pi.createAgentSession({
          cwd: spec.workspace, agentDir: spec.home, modelRuntime: runtime,
          model: { ...model, maxTokens: Math.min(model.maxTokens, piChildOutputTokens) },
          thinkingLevel: "off", sessionManager: manager,
          settingsManager: pi.SettingsManager.inMemory({ compaction: { enabled: false },
            retry: { enabled: false, provider: { maxRetries: 0 } }, cacheWarming: "off" }),
          resourceLoader: emptyResources(pi, "Implement this task in the exact assigned files using the Team file tools. Read existing files before editing. Submit the changed files with team_subspace_submit, then summarize the result and end the turn. No commands or other project paths are available."),
          noTools: "builtin", tools: customTools.map(tool => tool.name), customTools,
        }));
        lifetime.throwIfAborted();
        controlModelFetch(child, lifetime, { id: grant.lease, route }, undefined, "none");
        unsubscribe = child.subscribe((event: any) => {
          if (event.type === "message_end" && event.message?.role === "assistant") stopReason = event.message.stopReason;
        });
        await child.prompt(JSON.stringify({ task, paths: grant.paths }), { expandPromptTemplates: false });
        lifetime.throwIfAborted();
        summary = (child.getLastAssistantText() ?? "").trim().slice(0, 4000);
        if (stopReason !== "stop" || !summary) throw new Error("The Pi child did not finish with a result summary.");
        status = "completed";
      } finally {
        lifetime.removeEventListener("abort", abort);
        await stopping;
        unsubscribe?.();
        child?.dispose();
        const closed = await requestCheckpoint({ stage: "subspace_close", ...identity,
          status: lifetime.aborted ? "interrupted" : status }, AbortSignal.timeout(5000));
        if (closed) result = JSON.parse(closed);
      }
      lifetime.throwIfAborted();
      if (result?.status !== "completed" || !result.submission?.files.length)
        throw new Error(result?.error ?? "The Pi child did not close with a nonempty submitted file set.");
      return { content: [{ type: "text", text: JSON.stringify({ ...result.submission, childId, summary }) }], details: null };
    },
  };
}

async function executePi(
  spec: any,
  pi: any,
  runtime: any,
  provider: string,
  apiKey: string | undefined,
  signal: AbortSignal,
  emit: (event: unknown) => void,
  shared: boolean,
  requestCheckpoint?: RequestCheckpoint,
) {
  let session: any;
  let unsubscribe: (() => void) | undefined;
  let result: HarnessResult & { type: "result" };
  let lastAssistant: any;
  let prepared: (NativeCompactionPreparation & { checkpointId: string }) | undefined;
  let checkpointActive = false;
  const abort = () => {
    void session?.abort().catch(() => {});
  };
  try {
    if (!apiKey) throw new Error("The Pi model credential is unavailable.");
    runtime.registerProvider(provider, {
      baseUrl: spec.config.baseUrl,
      api:
        spec.config.protocol === "responses"
          ? "openai-responses"
          : spec.config.protocol === "anthropic-messages"
            ? "anthropic-messages"
            : "openai-completions",
      apiKey: "runtime",
      models: [
        {
          id: spec.config.model,
          name: spec.config.model,
          reasoning: Boolean(spec.config.thinkingFormat || spec.config.effort),
          ...(spec.config.effort
            ? { thinkingLevelMap: { [spec.config.effort]: spec.config.effort } }
            : {}),
          ...(spec.config.thinkingFormat || spec.config.effort
            ? {
                compat: {
                  ...(spec.config.thinkingFormat
                    ? { thinkingFormat: spec.config.thinkingFormat }
                    : {}),
                  ...(spec.config.effort
                    ? { supportsReasoningEffort: true }
                    : {}),
                  supportsDeveloperRole: false,
                },
              }
            : {}),
          input: ["text"],
          contextWindow:
            spec.contextWindow?.rawTokens ??
            spec.config.contextWindowTokens ??
            131072,
          maxTokens: spec.config.maxOutputTokens ?? 8192,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      ],
    });
    await runtime.setRuntimeApiKey(provider, apiKey);
    const resumePath = path.join(spec.home, "session-path.json");
    if (
      spec.resume &&
      (!existsSync(resumePath) ||
        !existsSync(JSON.parse(readFileSync(resumePath, "utf8"))))
    )
      throw new Error(
        "Native Pi history is unavailable; start a new session explicitly.",
      );
    const manager = existsSync(resumePath)
      ? pi.SessionManager.open(JSON.parse(readFileSync(resumePath, "utf8")))
      : pi.SessionManager.create(spec.workspace, spec.home);
    const probe: ProbeSpec | undefined = spec.probe;
    const probeRoute = probe ? new URL(probe.modelUrl) : undefined;
    if (probe && (!requestCheckpoint || !probe.rootActor))
      throw new Error("The Pi probe route is unavailable.");
    const subspaces: SubspaceSpec | undefined = spec.subspaces;
    const subspaceRoute = subspaces ? new URL(subspaces.modelUrl) : undefined;
    if (subspaces && (!requestCheckpoint || !subspaces.rootActor || !subspaces.sessionId || probe || spec.nativeCommands ||
        spec.config.access !== "read-only" || spec.config.protocol !== "chat-completions"))
      throw new Error("The isolated Pi route is unavailable.");
    const compactionCheckpoint = spec.memoryCheckpoint ? requestCheckpoint : undefined;
    const extensionPath = "<inline:teamswarm-compaction>";
    const compactionExtension = compactionCheckpoint ? {
      path: extensionPath,
      resolvedPath: extensionPath,
      sourceInfo: { path: extensionPath, source: "inline", scope: "temporary", origin: "top-level" },
      handlers: new Map([["session_before_compact", [async (event: any) => {
        prepared = undefined;
        const leaf = event.branchEntries.at(-1)?.id;
        const boundary = { parentId: leaf === manager.getLeafId() ? leaf : "", nativeSessionId: manager.getSessionId(), reason: event.reason };
        const current = AbortSignal.any([signal, event.signal]);
        const checkpointId = await compactionCheckpoint({ ...boundary, stage: "prepare" }, current);
        if (!checkpointId || current.aborted) return { cancel: true };
        prepared = { ...boundary, checkpointId };
        checkpointActive = true;
      }]], ["session_compact", [async () => {
        const entry = manager.getLeafEntry();
        const nativeSessionId = manager.getSessionId();
        await compactionCheckpoint({ stage: "resume", nativeSessionId,
          parentId: entry?.parentId ?? "", reason: prepared?.reason ?? "manual",
          checkpointId: prepared?.checkpointId ?? "", nativeBoundaryId: entry?.type === "compaction" ? entry.id : "" }, signal);
      }]]]),
      tools: new Map(), messageRenderers: new Map(), commands: new Map(), flags: new Map(), shortcuts: new Map(),
    } : undefined;
    const resourceLoader = {
      ...emptyResources(pi, spec.instructions + (probe ?
        "\nUse team_pi_probe for a bounded independent read-only question about exact project paths. The result contains a summary and read receipts." : "")),
      getExtensions: () => ({
        extensions: compactionExtension ? [compactionExtension] : [],
        errors: [],
        runtime: pi.createExtensionRuntime(),
      }),
      getAgentsFiles: () => ({
        agentsFiles: subspaces ? [] : pi.loadProjectContextFiles({
          cwd: spec.workspace,
          agentDir: spec.home,
        }),
      }),
    };
    const customTools = spec.tools.filter((tool: any) => tool.name !== piDelegateTool.name).map((tool: any) => ({
      name: tool.name,
      label: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
      execute: async (_id: string, args: unknown) => {
        signal.throwIfAborted();
        const response = await fetch(spec.bridge, {
          signal,
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: _id,
            method: "tools/call",
            params: { name: tool.name, arguments: args },
          }),
        });
        const data: any = await response.json();
        if (!response.ok || data.error || data.result?.isError)
          throw new Error(JSON.stringify(data.result ?? data.error));
        return data.result;
      },
    }));
    if (probe && probeRoute && requestCheckpoint)
      customTools.push(await piProbeTool({ ...spec, probe }, pi, runtime, provider, manager.getSessionId(), probeRoute, signal, requestCheckpoint));
    if (subspaces && subspaceRoute && requestCheckpoint)
      customTools.push(piDelegationTool({ ...spec, subspaces }, pi, runtime, provider, manager.getSessionId(), subspaceRoute, signal, requestCheckpoint));
    ({ session } = await pi.createAgentSession({
      cwd: spec.workspace,
      agentDir: spec.home,
      modelRuntime: runtime,
      model: runtime.getModel(provider, spec.config.model),
      thinkingLevel: spec.config.effort ?? "off",
      resourceLoader,
      sessionManager: manager,
      settingsManager: pi.SettingsManager.inMemory({
        compaction: {
          enabled: true,
          ...(spec.contextWindow?.overrideNative
            ? {
                reserveTokens:
                  spec.contextWindow.rawTokens -
                  spec.contextWindow.usableTokens,
                keepRecentTokens: spec.compactionKeepRecent,
              }
            : {}),
        },
        retry: { enabled: false },
      }),
      ...(subspaces ? { noTools: "builtin" } : {}),
      tools: [
        ...(subspaces ? [] : spec.config.permissions?.harness === "pi"
          ? spec.config.permissions.tools.filter(
              (tool: string) =>
                (!["bash", "powershell"].includes(tool) ||
                  spec.nativeCommands) &&
                (!["write", "edit"].includes(tool) ||
                  spec.config.access === "workspace-write"),
            )
          : spec.config.access === "read-only"
            ? ["read", "grep", "find", "ls"]
            : [
                "read",
                "grep",
                "find",
                "ls",
                "write",
                "edit",
                process.platform === "win32" ? "powershell" : "bash",
              ]),
        ...(!subspaces && spec.nativeCommands &&
        spec.config.access === "read-only" &&
        !spec.config.permissions
          ? [process.platform === "win32" ? "powershell" : "bash"]
          : []),
        ...customTools.map((t: { name: string }) => t.name),
      ],
      customTools,
    }));
    const directCheckpoint = spec.checkedModelFetch ? compactionCheckpoint : undefined;
    const rootScoped = subspaces ?? probe;
    const rootRoute = subspaceRoute ?? probeRoute;
    if (directCheckpoint || rootRoute)
      controlModelFetch(session, signal, rootScoped && rootRoute ? { id: rootScoped.rootActor, route: rootRoute } : undefined,
        directCheckpoint && (async current => {
          if (checkpointActive && !await directCheckpoint({ stage: "model", nativeSessionId: manager.getSessionId() }, current))
            throw new DOMException("Pi model request was cancelled.", "AbortError");
        }));
    let messageSequence = 0;
    unsubscribe = session.subscribe((event: any) => {
      if (event.type === "message_end" && event.message?.role === "assistant")
        lastAssistant = event.message;
      if (event.type === "message_start" && event.message?.role === "assistant")
        messageSequence++;
      if (
        event.type === "message_update" &&
        event.assistantMessageEvent?.type === "text_delta"
      )
        emit({
          type: "pi.message.delta",
          sequence: messageSequence,
          delta: event.assistantMessageEvent.delta,
        });
      const compacted = event.type === "compaction_end" && !event.aborted ? event.result : undefined;
      const entry = compacted && manager.getLeafEntry();
      const checkpoint = entry?.type === "compaction" && prepared?.parentId === entry.parentId ? prepared : undefined;
      const boundary = entry?.type === "compaction" && entry.firstKeptEntryId === compacted.firstKeptEntryId ? {
        nativeBoundaryId: entry.id, nativeSessionId: manager.getSessionId(),
        trigger: event.reason, tokensBefore: compacted.tokensBefore, estimatedTokensAfter: compacted.estimatedTokensAfter,
        ...(checkpoint ? { memoryCheckpointId: checkpoint.checkpointId, nativeParentId: checkpoint.parentId } : {}),
      } : undefined;
      if (event.type === "compaction_end") prepared = undefined;
      if (
        [
          "message_end",
          "tool_execution_start",
          "tool_execution_end",
          "compaction_end",
        ].includes(event.type)
      )
        emit({ type: "pi.event", event, sequence: messageSequence, ...(boundary ? { boundary } : {}) });
    });
    const nativeFile = manager.getSessionFile();
    if (nativeFile) {
      const pending = resumePath + ".pending-" + randomUUID();
      try {
        writeFileSync(pending, JSON.stringify(nativeFile), {
          mode: 0o600,
          flag: "wx",
        });
        renameSync(pending, resumePath);
      } finally {
        if (existsSync(pending)) unlinkSync(pending);
      }
    }
    if (nativeFile && existsSync(nativeFile))
      emit({ type: "session", id: manager.getSessionId() });
    if (requestCheckpoint) emit({ type: "pi.session.identity", id: manager.getSessionId() });
    signal.addEventListener("abort", abort, { once: true });
    if (!signal.aborted) await session.prompt(spec.input);
    if (!spec.resume && nativeFile && existsSync(nativeFile))
      emit({ type: "session", id: manager.getSessionId() });
    const last = lastAssistant;
    const status =
      signal.aborted || last?.stopReason === "aborted"
        ? "interrupted"
        : last?.stopReason === "stop"
          ? "completed"
          : last
            ? "failed"
            : "unknown";
    const error =
      status === "failed"
        ? (last.errorMessage ?? `Native Pi stopped with ${last.stopReason}.`)
        : status === "unknown"
          ? "No final native assistant message."
          : undefined;
    result = {
      type: "result",
      status,
      text: last ? (session.getLastAssistantText() ?? "") : "",
      error,
    };
  } catch (error) {
    result = {
      type: "result",
      status: signal.aborted ? "interrupted" : "failed",
      text: "",
      error: error instanceof Error ? error.message : "Pi failed.",
    };
  } finally {
    signal.removeEventListener("abort", abort);
    unsubscribe?.();
    session?.dispose();
    if (shared) {
      await runtime.removeRuntimeApiKey(provider);
      runtime.unregisterProvider(provider);
    }
  }
  return result;
}

if (process.argv[2] === "--daemon") {
  const { pi, runtime } = await loadPi(process.argv[3], process.argv[4]);
  const active = new Map<
    string,
    { controller: AbortController; done: Promise<unknown>; checkpoints: Map<string, (id?: string) => void> }
  >();
  const lines = createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    const turnId = message.turnId;
    if (typeof turnId !== "string" || !/^[a-f0-9-]{36}$/.test(turnId)) return;
    if (message.type === "abort") {
      active.get(turnId)?.controller.abort();
      return;
    }
    if (message.type === "checkpoint.checked") {
      active.get(turnId)?.checkpoints.get(message.requestId)?.(message.checkpointId);
      return;
    }
    if (message.type !== "run" || active.has(turnId)) return;
    const controller = new AbortController();
    const send = (event: unknown) => emit({ turnId, event });
    const checkpoints = new Map<string, (id?: string) => void>();
    const requestCheckpoint: RequestCheckpoint = (boundary, signal) => {
      if (signal.aborted) return Promise.resolve(undefined);
      return new Promise(resolve => {
        const requestId = randomUUID();
        const settle = (id?: string) => {
          checkpoints.delete(requestId);
          signal.removeEventListener("abort", cancel);
          resolve(id);
        };
        const cancel = () => settle();
        checkpoints.set(requestId, settle);
        signal.addEventListener("abort", cancel, { once: true });
        send({ type: "pi.turn.checkpoint", requestId, boundary });
      });
    };
    const done = executePi(
      message.spec,
      pi,
      runtime,
      "teamswarm_" + turnId.replaceAll("-", "_"),
      message.apiKey,
      controller.signal,
      send,
      true,
      message.spec.memoryCheckpoint || message.spec.probe || message.spec.subspaces ? requestCheckpoint : undefined,
    )
      .then(send)
      .catch((error) =>
        send({
          type: "result",
          status: "unknown",
          text: "",
          error: error instanceof Error ? error.message : "Pi disposal failed.",
        }),
      )
      .finally(() => {
        controller.abort();
        active.delete(turnId);
      });
    active.set(turnId, { controller, done, checkpoints });
  });
  await new Promise<void>((resolve) => lines.once("close", resolve));
  for (const turn of active.values()) turn.controller.abort();
  await Promise.allSettled([...active.values()].map((turn) => turn.done));
} else {
  const spec = JSON.parse(readFileSync(process.argv[2], "utf8"));
  const controller = new AbortController();
  process.stdin.on("data", () => controller.abort());
  try {
    const { pi, runtime } = await loadPi(spec.entry, spec.home);
    emit(
      await executePi(
        spec,
        pi,
        runtime,
        "teamswarm",
        process.env[spec.config.credentialEnv],
        controller.signal,
        emit,
        false,
      ),
    );
  } catch (error) {
    emit({
      type: "result",
      status: "failed",
      text: "",
      error: error instanceof Error ? error.message : "Pi failed.",
    });
  } finally {
    process.stdin.destroy();
  }
}
