import { mkdirSync } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";
import { createHash } from "node:crypto";
import { harnessManifest } from "@team/contracts/harness-catalog";
import type {
  HarnessRequest,
  HarnessResult,
  PermissionOptions,
} from "../types.js";
import { AcpHarness } from "./acp-harness.js";
import { JsonRpcPeer } from "./json-rpc-peer.js";
import { nativeEntry, nativeHome, terminateNative } from "./native-support.js";
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
  if (request.config.model) {
    const id = current.find((o) => o.category === "model")?.id;
    if (!id) throw new Error("Antigravity did not report a model selector.");
    await select(id, request.config.model);
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
    effort:
      current.find((o) => o.category === "thought_level")?.currentValue ?? null,
    mode,
  };
}

export class AntigravityHarness extends AcpHarness {
  constructor() {
    super(harnessManifest("antigravity")!, {
      prepare({ request, home }) {
        return {
          args: [
            ...args,
            "--app-data-dir",
            applicationDirectory(home),
            ...(request.config.access !== "read-only" &&
            request.config.permissions?.mode === "bypassPermissions"
              ? ["--dangerously-skip-permissions"]
              : []),
          ],
          env: installerEnvironment(),
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
  }
  override inspect() {
    return antigravityInspection();
  }
  override async close() {
    await antigravityAccounts.close();
    await super.close();
  }
  permissionOptions(): PermissionOptions {
    return {
      defaultId: "",
      options: [
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
