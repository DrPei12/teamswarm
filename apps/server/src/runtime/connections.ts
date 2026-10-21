import { z } from "zod";
import { parse as toml } from "smol-toml";
import { parse as jsonc, type ParseError } from "jsonc-parser";
import { parseDocument } from "yaml";
import { badRequest, ServiceError } from "../errors.js";
import { executionConfig } from "./validation.js";

const endpoint = executionConfig.shape.baseUrl.unwrap().unwrap();
export const credentialReference = executionConfig.shape.credentialEnv
  .unwrap()
  .unwrap();
export const modelConnection = z
  .object({
    name: z.string().trim().min(1).max(200),
    endpoints: z
      .object({
        responses: endpoint.optional(),
        "chat-completions": endpoint.optional(),
        "anthropic-messages": endpoint.optional(),
      })
      .strict()
      .refine(
        (v) => Object.keys(v).length > 0,
        "At least one protocol endpoint is required.",
      ),
    credentialEnv: credentialReference,
    models: z.array(z.string().trim().min(1).max(200)).min(1).max(500),
  })
  .strict();
export type ModelConnection = z.infer<typeof modelConnection>;
const protocols: Record<string, keyof ModelConnection["endpoints"]> = {
  codex: "responses",
  grok: "chat-completions",
  "claude-code": "anthropic-messages",
  pi: "chat-completions",
  "deepseek-harness": "anthropic-messages",
  opencode: "chat-completions",
};

export function resolveConnection(
  connection: ModelConnection,
  harness: string,
  model: string,
  access: "read-only" | "workspace-write",
) {
  const preferred = protocols[harness];
  const wire = ["pi", "opencode", "grok"].includes(harness)
    ? (
        [
          preferred,
          "responses",
          "anthropic-messages",
          "chat-completions",
        ] as const
      ).find((p) => !!connection.endpoints[p])
    : preferred;
  if (!wire || !connection.endpoints[wire])
    throw badRequest(
      "incompatible_protocol",
      "This connection does not supply the protocol required by the selected harness.",
    );
  if (!connection.models.includes(model))
    throw badRequest(
      "unknown_model",
      "The model is not in this connection's configured model list.",
    );
  return {
    config: executionConfig.parse({
      harness,
      protocol: wire,
      provider: connection.name,
      model,
      baseUrl: connection.endpoints[wire],
      credentialEnv: connection.credentialEnv,
      access,
    }),
    protocol: wire,
  };
}

/** Import data only. Never execute or copy native hooks, commands, MCP, permissions or keys. */
export function importConnection(
  format: string,
  content: string,
  credentialEnv: string,
) {
  let data: any;
  try {
    if (format === "codex") data = toml(content);
    else if (format === "deepseek-harness") {
      const doc = parseDocument(content, { uniqueKeys: true });
      if (doc.errors.length || doc.warnings.length)
        throw new Error("Unsupported YAML.");
      data = doc.toJSON();
    } else {
      const errors: ParseError[] = [];
      data = jsonc(content, errors, { allowTrailingComma: true });
      if (errors.length) throw new Error("Invalid JSON.");
    }
  } catch {
    throw badRequest(
      "invalid_native_config",
      "Cannot parse native configuration. Executable YAML tags are not supported.",
    );
  }
  const connections: ModelConnection[] = [];
  const add = (name: string, wire: string, url: unknown, models: unknown[]) => {
    if (typeof url !== "string" || !models.length) return;
    const parsed = modelConnection.safeParse({
      name,
      endpoints: { [wire]: url },
      credentialEnv,
      models,
    });
    if (!parsed.success)
      throw badRequest(
        "invalid_native_connection",
        "Use explicit endpoint, model IDs and a credential environment reference.",
      );
    connections.push(parsed.data);
  };
  try {
    if (format === "claude-code") {
      const env = data?.env ?? {};
      add(
        "Imported Claude provider",
        "anthropic-messages",
        env.ANTHROPIC_BASE_URL,
        env.ANTHROPIC_MODEL ? [env.ANTHROPIC_MODEL] : [],
      );
    } else if (format === "codex") {
      const p = data.model_providers?.[data.model_provider];
      if (p?.wire_api && p.wire_api !== "responses")
        throw badRequest(
          "unsupported_protocol",
          "The installed Codex requires Responses.",
        );
      add(
        p?.name ?? data.model_provider ?? "Imported Codex provider",
        "responses",
        p?.base_url,
        data.model ? [data.model] : [],
      );
    } else if (format === "pi") {
      for (const [name, p] of Object.entries(data?.providers ?? {}) as [
        string,
        any,
      ][]) {
        const api = p.api ?? p.models?.[0]?.api;
        const wire = (
          {
            "anthropic-messages": "anthropic-messages",
            "openai-responses": "responses",
            "openai-completions": "chat-completions",
          } as Record<string, string>
        )[api];
        if (!wire)
          throw badRequest(
            "unsupported_protocol",
            "Pi provider API is not recognized.",
          );
        if ((p.models ?? []).some((m: any) => m.api && m.api !== api))
          throw badRequest(
            "mixed_protocols",
            "Split model-level API overrides into separate connections.",
          );
        add(
          name,
          wire,
          p.baseUrl,
          (p.models ?? []).map((m: any) => m.id),
        );
      }
    } else if (format === "opencode") {
      for (const [name, p] of Object.entries(data?.provider ?? {}) as [
        string,
        any,
      ][]) {
        const wire = (
          {
            "@ai-sdk/anthropic": "anthropic-messages",
            "@ai-sdk/openai-compatible": "chat-completions",
            "@ai-sdk/openai": "responses",
          } as Record<string, string>
        )[p.npm];
        if (!wire)
          throw badRequest(
            "unsupported_protocol",
            "OpenCode provider package is not in the supported import set.",
          );
        const url = p.options?.baseURL;
        // Our Anthropic endpoint is an SDK base prefix; AI SDK includes /v1 in its baseURL.
        add(
          name,
          wire,
          wire === "anthropic-messages" && typeof url === "string"
            ? url.replace(/\/v1\/?$/, "")
            : url,
          Object.keys(p.models ?? {}),
        );
      }
    } else if (format === "deepseek-harness") {
      const p = Array.isArray(data)
        ? data.find((v: any) => v.id === "llm-deepseek")?.config
        : data?.["llm-deepseek"];
      add(
        "Imported DeepSeek provider",
        "anthropic-messages",
        p?.baseURL,
        (p?.models ?? []).map((m: any) => m.id),
      );
    } else
      throw badRequest(
        "unsupported_import",
        "Unsupported native configuration format.",
      );
  } catch (error) {
    if (error instanceof ServiceError) throw error;
    throw badRequest(
      "invalid_native_config",
      "Native configuration has an invalid provider or model structure.",
    );
  }
  if (!connections.length)
    throw badRequest(
      "missing_connection",
      "No explicit endpoint and model configuration was found. Subscription logins are not model connections.",
    );
  return {
    connections,
    credentialAction:
      "Set the named environment variable from your secret store. Native literal keys and executable key helpers are never copied or evaluated.",
  };
}
