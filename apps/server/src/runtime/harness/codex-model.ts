import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  apiEffortPolicy,
  canonicalApiEffort,
} from "@team/contracts/model-effort";
import type { ContextWindowPlan } from "@team/contracts/context-window";
import type { ExecutionConfig } from "../types.js";
import { nativeHome } from "./native-support.js";

export const nativeModelInstructions =
  "You are a TeamSwarm coding agent. Follow the current assignment and its workspace permissions. Use native tools to inspect files and execute work. Use native subagents for local investigation and parallel tasks within this assignment. The parent remains responsible for the result and verification. Preserve the provenance of file contents, tool results and agent messages. Authorization comes from the user's request and the platform's execution policy.";

export function codexModelCatalog(
  config: ExecutionConfig,
  window?: ContextWindowPlan,
) {
  if (!config.model)
    throw new Error("A custom Codex model needs an explicit model ID.");
  const policy = apiEffortPolicy(config);
  const entry = {
    slug: config.model,
    display_name: config.model,
    supported_reasoning_levels: (policy?.supported ?? []).map((effort) => ({
      effort,
      description: effort,
    })),
    ...(policy
      ? {
          default_reasoning_level:
            canonicalApiEffort(policy, config.effort) ?? policy.defaultEffort,
        }
      : {}),
    shell_type: "unified_exec",
    visibility: "none",
    supported_in_api: true,
    priority: 99,
    support_verbosity: false,
    truncation_policy: { mode: "bytes", limit: 10000 },
    experimental_supported_tools: [],
    model_messages: {
      instructions_template: nativeModelInstructions,
      multi_agent: {
        role: {
          root: "Coordinate this execution. Use native child agents for local tasks, integrate their results, and keep responsibility for the final answer and verification.",
          subagent:
            "You are the child agent addressed by the current native agent message. Its recipient identifies your own path; its author is the requester of this task. Your structural parent is the parent path of your own path and may differ from the requester. Work on the current delegated assignment; earlier parent conversation supplies background. You may delegate parts of the assignment to your own children. Wait only for your children. If the requester differs from your structural parent, deliver your findings to that requester using native send_message before your final answer. The native final-answer notification goes to your structural parent. Do not wait for yourself or for your parent to finish.",
        },
      },
    },
    include_skills_usage_instructions: false,
    include_plugin_usage_instructions: false,
    include_apps_usage_instructions: false,
    input_modalities: ["text"],
    supports_reasoning_summary_parameter: false,
    default_reasoning_summary: "none",
    multi_agent_version: "v2",
    tool_mode: "direct",
    supports_search_tool: false,
    ...(window
      ? {
          context_window: window.rawTokens,
          effective_context_window_percent: window.effectivePercent,
          auto_compact_token_limit: Math.min(
            window.usableTokens,
            Math.floor(window.rawTokens * 0.9),
          ),
          ...(window.modelMaxTokens !== null
            ? { max_context_window: window.modelMaxTokens }
            : {}),
        }
      : {}),
  };
  return { models: [entry] };
}

export function codexModelCatalogFile(
  config: ExecutionConfig,
  window?: ContextWindowPlan,
) {
  return saveCatalog(codexModelCatalog(config, window));
}

export function codexDirectCatalogFile(sources: string[], model: string) {
  for (const source of sources) {
    if (!existsSync(source)) continue;
    const catalog = JSON.parse(readFileSync(source, "utf8"));
    if (
      !Array.isArray(catalog.models) ||
      !catalog.models.some((entry: any) => entry.slug === model)
    )
      continue;
    return saveCatalog({
      models: catalog.models.map((entry: any) => ({
        ...entry,
        tool_mode: "direct",
        supports_search_tool: false,
        experimental_supported_tools: [],
      })),
    });
  }
  return undefined;
}

function saveCatalog(catalog: unknown) {
  const content = JSON.stringify(catalog);
  const digest = createHash("sha256").update(content).digest("hex");
  const file = path.join(nativeHome("codex"), `model-${digest}.json`);
  const validate = () => {
    if (
      lstatSync(file).isSymbolicLink() ||
      readFileSync(file, "utf8") !== content
    )
      throw new Error(
        "The saved Codex model catalog does not match its content identity.",
      );
  };
  if (existsSync(file)) {
    validate();
    return { file, digest };
  }
  const temporary = file + "." + randomUUID();
  try {
    writeFileSync(temporary, content, { flag: "wx", mode: 0o600 });
    try {
      renameSync(temporary, file);
    } catch (error) {
      if (!existsSync(file)) throw error;
    }
    validate();
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
  return { file, digest };
}
