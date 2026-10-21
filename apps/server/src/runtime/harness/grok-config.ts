import { stringify } from "smol-toml";
import type { ExecutionConfig } from "../types.js";

/** Apply the same native isolation to subscription and user-supplied API access. */
export function isolateGrokEnvironment(env: NodeJS.ProcessEnv) {
  env.GROK_DISABLE_AUTOUPDATER = "1";
  for (const feature of [
    "MEMORY",
    "SUBAGENTS",
    "GOAL",
    "CRASH_HANDLER",
    "TITLE_REFRESH",
    "TURN_SUMMARY",
  ])
    env[`GROK_${feature}`] = "0";
  for (const source of ["CURSOR", "CLAUDE", "CODEX"])
    for (const feature of [
      "SKILLS",
      "RULES",
      "AGENTS",
      "MCPS",
      "HOOKS",
      "SESSIONS",
    ])
      env[`GROK_${source}_${feature}_ENABLED`] = "0";
}

/** Native Grok configuration; model IDs and credentials belong to the connection. */
export function grokModelConfig(config: ExecutionConfig): string {
  if (!config.model || !config.baseUrl || !config.credentialEnv)
    throw new Error(
      "Grok API access requires a model, endpoint and credential reference.",
    );
  const backend = {
    "chat-completions": "chat_completions",
    responses: "responses",
    "anthropic-messages": "messages",
  }[config.protocol ?? "chat-completions"];
  if (!backend) throw new Error("Unsupported Grok API protocol.");
  const base = config.baseUrl.replace(/\/$/, "");
  return stringify({
    models: { default: config.model },
    model: {
      [config.model]: {
        model: config.model,
        base_url:
          backend === "messages" && !base.endsWith("/v1") ? `${base}/v1` : base,
        api_backend: backend,
        env_key: config.credentialEnv,
      },
    },
  });
}
