import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";
import { homedir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { harnessManifest } from "@team/contracts/harness-catalog";
import type {
  HarnessRequest,
  HarnessResult,
  PermissionOptions,
} from "../types.js";
import { AcpHarness } from "./acp-harness.js";
import { JsonRpcPeer } from "./json-rpc-peer.js";
import { nativeEntry, nativeHome, terminateNative } from "./native-support.js";
import { usesTeamSwarmReview } from "../automatic-permission.js";
import { nativeAccess } from "../permission-options.js";
import { antigravityWireModel } from "../gemini-wire.js";
import { installerEnvironment } from "./device-tools.js";
import { spawnOwned, confirmOwnedExit } from "./owned-process.js";
import { antigravityAccounts } from "./antigravity-account.js";

type Option = { value: string; name: string };
type ConfigOption = {
  id: string;
  category?: string;
  currentValue: string;
  options?: Option[];
};
type Session = {
  models?: {
    currentModelId: string;
    availableModels: { modelId: string; name: string }[];
  };
  modes?: { availableModes: { id: string }[] };
  configOptions?: ConfigOption[];
};
const args = [
  "acp",
  "--disable-telemetry",
  "--include-default-customizations=false",
];
const applicationDirectory = (home: string) =>
  "teamswarm-" +
  createHash("sha256").update(path.resolve(home)).digest("hex").slice(0, 24);

export function antigravityModels(session: Session) {
  const native = session.models?.availableModels ?? [];
  const offered = session.configOptions?.find(
    (o) => o.category === "model",
  )?.options;
  const models =
    offered ?? native.map((m) => ({ value: m.modelId, name: m.name }));
  return models.map((model) => {
    const efforts = native.flatMap((m) => {
      const suffix = m.modelId.startsWith(model.value + "-")
        ? m.modelId.slice(model.value.length + 1)
        : "";
      return ["low", "medium", "high", "xhigh", "max"].includes(suffix)
        ? [suffix]
        : [];
    });
    return {
      model: model.value,
      name: model.name,
      provider: model.value.startsWith("gemini-")
        ? "Google"
        : model.value.startsWith("claude-")
          ? "Anthropic"
          : model.value.startsWith("gpt-")
            ? "OpenAI"
            : "Antigravity",
      isDefault:
        session.models?.currentModelId === model.value ||
        session.configOptions?.find((o) => o.category === "model")
          ?.currentValue === model.value,
      ...(efforts.length
        ? {
            reasoningEfforts: [...new Set(efforts)].map((reasoningEffort) => ({
              reasoningEffort,
            })),
          }
        : {}),
    };
  });
}

export function antigravityResult(result: HarnessResult): HarnessResult {
  // agy 1.5.4 uses end_turn for this native executor failure. Match the entire
  // reserved message so quoted errors inside an ordinary answer stay intact.
  return result.status === "completed" &&
    result.text.trim() === "⚠ Agent execution terminated due to error."
    ? {
        ...result,
        status: "failed",
        error:
          "Antigravity reported an execution failure. Check the native CLI for the cause.",
      }
    : result;
}

async function inspectNative() {
  const entry = nativeEntry("antigravity");
  const home = path.join(nativeHome("antigravity"), "catalog");
  mkdirSync(home, { recursive: true });
  const javascript = /\.[cm]?js$/i.test(entry);
  const child = await spawnOwned(
    javascript ? process.execPath : entry,
    [
      ...(javascript ? [entry] : []),
      ...args,
      "--app-data-dir",
      applicationDirectory(home),
    ],
    {
      cwd: home,
      env: installerEnvironment(),
      windowsHide: true,
      detached: process.platform !== "win32",
    },
  );
  const rpc = new JsonRpcPeer(
    (value) => child.stdin.write(JSON.stringify(value) + "\n"),
    "Antigravity",
  );
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  child.stderr.resume();
  child.stdin.on("error", () => rpc.close());
  child.on("error", () => rpc.close("Antigravity could not start."));
  child.on("exit", () => rpc.close());
  lines.on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (!rpc.receive(message) && message.id != null)
      rpc.send({
        jsonrpc: "2.0",
        id: message.id,
        error: {
          code: -32601,
          message: "Catalog inspection does not execute tools.",
        },
      });
  });
  try {
    const init = await rpc.call(
      "initialize",
      {
        protocolVersion: 1,
        clientInfo: { name: "TeamSwarm", version: "0.6.0" },
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
      },
      15000,
    );
    const session: Session = await rpc.call(
      "session/new",
      { cwd: home, mcpServers: [] },
      20000,
    );
    return {
      id: "antigravity",
      installed: true,
      available: true,
      entry,
      version:
        typeof init.agentInfo?.version === "string"
          ? init.agentInfo.version
          : null,
      authenticated: null,
      loginState: "unknown",
      modelState: "not_checked",
      models: antigravityModels(session),
      capabilities: { reasoningEffort: true },
    };
  } finally {
    rpc.close();
    lines.close();
    child.stdin.end();
    if (
      !(await confirmOwnedExit(child)) &&
      !(await terminateNative(child)) &&
      !(await confirmOwnedExit(child))
    )
      throw new Error(
        "Antigravity catalog process termination could not be confirmed.",
      );
  }
}

let cached:
  | {
      expires: number;
      pending: boolean;
      value: ReturnType<typeof inspectNative>;
    }
  | undefined;
export function antigravityInspection(refresh = false) {
  if (cached?.pending) return cached.value;
  if (refresh || !cached || cached.expires < Date.now()) {
    const value = inspectNative()
      .catch((error) => {
        cached = undefined;
        let installed = true;
        try {
          nativeEntry("antigravity");
        } catch {
          installed = false;
        }
        return {
          id: "antigravity",
          installed,
          available: false,
          authenticated: null,
          version: null,
          models: [],
          loginState: installed ? "unknown" : "not_installed",
          modelState: "not_checked",
          error: (error as Error).message,
          capabilities: { reasoningEffort: true },
          entry: "",
        };
      })
      .finally(() => {
        if (cached?.value === value) cached.pending = false;
      });
    cached = { expires: Date.now() + 30000, pending: true, value };
  }
  return cached.value;
}

export async function configureAntigravity(
  request: HarnessRequest,
  call: (method: string, params: unknown) => Promise<any>,
  sessionId: string,
  description: Session,
) {
  let current = description.configOptions ?? [];
  const select = async (id: string, value: string) => {
    const option = current.find((o) => o.id === id);
    if (!option?.options?.some((o) => o.value === value))
      throw new Error(
        `Antigravity does not offer ${value} for ${id}. Refresh its model directory.`,
      );
    const response = await call("session/set_config_option", {
      sessionId,
      configId: id,
      value,
    });
    if (Array.isArray(response.configOptions)) current = response.configOptions;
    if (current.find((o) => o.id === id)?.currentValue !== value)
      throw new Error(`Antigravity did not apply ${id}.`);
  };
  const shared = request.modelRoute?.sourceConfig;
  const nativeModel = shared ? antigravityWireModel : request.config.model;
  if (nativeModel) {
    const id = current.find((o) => o.category === "model")?.id;
    if (!id) throw new Error("Antigravity did not report a model selector.");
    await select(id, nativeModel);
  }
  if (request.config.effort) {
    const id = current.find((o) => o.category === "thought_level")?.id;
    if (!id)
      throw new Error(
        "This Antigravity model does not offer reasoning effort.",
      );
    await select(id, request.config.effort);
  }
  const mode = request.config.access === "read-only" ? "plan" : "default";
  await select("mode", mode);
  return {
    model:
      current.find((o) => o.category === "model")?.currentValue ??
      description.models?.currentModelId,
    effort: shared ? null :
      current.find((o) => o.category === "thought_level")?.currentValue ?? null,
    mode,
  };
}

export class AntigravityHarness extends AcpHarness {
  constructor() {
    super(harnessManifest("antigravity")!, {
      allowsSharedWorkspace(request) {
        if (request.config.access === "read-only") return true;
        if (Object.values(request.requirements).some(Boolean)) return false;
        if (request.hostWorkspaceWrite && nativeAccess(request.config) === "full-access") return true;
        return !!request.config.baseUrl && request.legacyWorkspaceWrite === true;
      },
      validateConfig(config) {
        if (usesTeamSwarmReview(config) && !config.baseUrl)
          throw new Error("Select a shared model before using automatic approval with Antigravity.");
      },
      prepare({ request, home }) {
        const profile = applicationDirectory(home);
        const automatic = usesTeamSwarmReview(request.config);
        const manual = (request.config.permissions?.mode === "default" || automatic) && request.config.access !== "read-only";
        const env: NodeJS.ProcessEnv = installerEnvironment();
        const shared = request.modelRoute;
        if (shared) {
          const base = new URL(request.config.baseUrl!);
          if (base.protocol !== "http:" || base.hostname !== "127.0.0.1" || !base.port)
            throw new Error("Antigravity requires a TeamSwarm model route.");
          env.GEMINI_API_KEY = shared.token;
          env.GOOGLE_GEMINI_BASE_URL = base.href;
        }
        if (shared || manual) {
          const settings = path.join(homedir(), ".gemini", profile);
          mkdirSync(settings, { recursive: true });
          // The native CLI expects a stable installation identity in each profile.
          try { writeFileSync(path.join(settings, "installation_id"), randomUUID(), { flag: "wx", mode: 0o600 }); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
          const settingsFile = path.join(settings, "settings.json");
          let previous: Record<string, unknown> = {};
          try { previous = JSON.parse(readFileSync(settingsFile, "utf8")); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
          writeFileSync(settingsFile, JSON.stringify({
            ...previous,
            ...(shared ? { modelProvider: "gemini" } : {}),
            toolPermission: "request-review",
            ...(manual ? {
              permissions: { ask: [...(automatic ? ["read_file(*)"] : []), "write_file(*)", "command(*)", "mcp(*)", "execute_url(*)", "download_url(*)"] },
            } : {}),
          }), { mode: 0o600 });
        }
        return {
          args: [
            ...args,
            "--app-data-dir",
            profile,
            ...(request.config.access !== "read-only" &&
            request.config.permissions?.mode === "bypassPermissions"
              ? ["--dangerously-skip-permissions"]
              : []),
          ],
          env,
        };
      },
      configureSession: configureAntigravity,
      classifyResult: antigravityResult,
      failureUpdate(update) {
        if (
          update.sessionUpdate !== "agent_message_chunk" ||
          update.content?.type !== "text"
        )
          return;
        return antigravityResult({
          status: "completed",
          text: update.content.text,
        }).error;
      },
    });
    // The native CLI compacts its own history; local estimates must not force
    // a replacement session merely because native capacity is unreported.
    this.capabilities.contextCompaction = true;
    this.capabilities.sharedModelResume = false;
  }
  override async execute(request: HarnessRequest): Promise<HarnessResult> {
    if (usesTeamSwarmReview(request.config) && !request.modelRoute)
      throw new Error("Antigravity automatic approval requires the TeamSwarm model gateway.");
    return super.execute(request);
  }
  override inspect() {
    return antigravityInspection();
  }
  override async close() {
    await antigravityAccounts.close();
    await super.close();
  }
  override permissionOptions(): PermissionOptions {
    return {
      defaultId: "manual",
      options: [
        { id: "manual", label: "Request approval", permissions: { harness: "antigravity", mode: "default" } },
        { id: "auto", label: "Automatic review", requiresWrite: true, permissions: { harness: "antigravity", mode: "teamswarmAuto" } },
        {
          id: "full-access",
          label: "Full access",
          requiresWrite: true,
          permissions: { harness: "antigravity", mode: "bypassPermissions" },
        },
      ],
    };
  }
}
