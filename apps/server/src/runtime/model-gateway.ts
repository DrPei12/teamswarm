import {
  createServer,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type {
  Model,
  AssistantMessage,
  StreamOptions,
} from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { stream as responses } from "@earendil-works/pi-ai/api/openai-responses";
import { stream as completions } from "@earendil-works/pi-ai/api/openai-completions";
import { stream as anthropic } from "@earendil-works/pi-ai/api/anthropic-messages";
import type { ConnectionProtocol } from "@team/contracts/allocation";
import type { ExecutionConfig, Harness, HarnessRequest } from "./types.js";
import { ChatGPTAccounts } from "./model-auth.js";
import {
  decodeRequest,
  encodeResponse,
  WireStream,
  chatGPTPayload,
  requestOptions,
} from "./model-wire.js";
import {
  harnessProtocol,
  needsModelRoute,
  modelRouteIssues,
} from "./model-routing.js";
import { ModelMetadata } from "./model-metadata.js";
export { harnessProtocol, needsModelRoute } from "./model-routing.js";

const apis = {
  responses: "openai-responses",
  "chat-completions": "openai-completions",
  "anthropic-messages": "anthropic-messages",
} as const;
async function errorBody(response: Response) {
  let size = 0;
  const parts: Uint8Array[] = [];
  if (response.body)
    for await (const part of response.body) {
      size += part.byteLength;
      if (size > 512 * 1024)
        throw new Error("Model error response exceeds 512 KiB.");
      parts.push(part);
    }
  const text = Buffer.concat(parts).toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    return { detail: text };
  }
}
function nativeConfig(
  c: ExecutionConfig,
  baseUrl = "http://127.0.0.1:1/v1",
): ExecutionConfig {
  return {
    ...c,
    chatgptAccountId: undefined,
    protocol: harnessProtocol(c.harness, c.protocol),
    baseUrl,
    credentialEnv: "TEAMSWARM_ROUTE_KEY",
    effort: null,
    thinkingFormat: null,
    maxOutputTokens: ["pi", "opencode"].includes(c.harness)
      ? c.maxOutputTokens
      : null,
    contextWindowTokens: ["pi", "opencode"].includes(c.harness)
      ? c.contextWindowTokens
      : null,
  };
}
type Route = {
  config: ExecutionConfig;
  token: string;
  controllers: Set<AbortController>;
  active: number;
  metadata: ModelMetadata;
  sessionId?: string;
};
function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error("Model request cancelled."));
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    operation
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

/** One loopback listener per service. Each attempt gets a revocable route, not a proxy process. */
export class ModelGateway {
  readonly accounts: ChatGPTAccounts;
  private server?: Server;
  private opening?: Promise<string>;
  private routes = new Map<string, Route>();
  private active = 0;
  private closed = false;
  constructor(private readonly directory: string) {
    this.accounts = new ChatGPTAccounts(directory);
  }
  state() {
    return { routes: this.routes.size, requests: this.active };
  }
  async disconnect(accountId: string) {
    for (const [id, route] of this.routes)
      if (route.config.chatgptAccountId === accountId) {
        this.routes.delete(id);
        for (const controller of route.controllers) controller.abort();
      }
    return this.accounts.signOut(accountId);
  }
  private open() {
    if (this.closed) throw new Error("Model connection service is closing.");
    return (this.opening ??= new Promise<string>((resolve, reject) => {
      const server = (this.server = createServer((req, res) => {
        void this.handle(req, res);
      }));
      server.headersTimeout = 15000;
      server.requestTimeout = 30000;
      server.on("error", reject);
      server.listen(0, "127.0.0.1", () =>
        resolve(
          `http://127.0.0.1:${(server.address() as { port: number }).port}`,
        ),
      );
    }));
  }
  async lease(config: ExecutionConfig) {
    const base = await this.open(),
      id = randomUUID();
    if (this.closed) throw new Error("Model connection service is closing.");
    const route: Route = {
      config: structuredClone(config),
      token: randomBytes(32).toString("base64url"),
      controllers: new Set(),
      active: 0,
      metadata: new ModelMetadata(),
    };
    this.routes.set(id, route);
    return {
      config: nativeConfig(config, `${base}/${id}/v1`),
      token: route.token,
      session: (sessionId: string, workspace: string) => {
        if (route.sessionId !== sessionId) {
          route.metadata = new ModelMetadata(this.directory, [
            config,
            sessionId,
            workspace,
          ]);
          route.sessionId = sessionId;
        }
      },
      release: () => {
        this.routes.delete(id);
        for (const controller of route.controllers) controller.abort();
      },
    };
  }
  private async key(config: ExecutionConfig) {
    if (config.chatgptAccountId)
      return this.accounts.accessToken(config.chatgptAccountId);
    const key = config.credentialEnv && process.env[config.credentialEnv];
    if (!key)
      throw new Error("The model connection credential is unavailable.");
    return key;
  }
  private async handle(req: IncomingMessage, res: ServerResponse) {
    let route: Route | undefined,
      controller: AbortController | undefined,
      acquired = false,
      releaseMetadata: (() => void) | undefined;
    const sendError = (
      status: number,
      message: string,
      code = "model_connection_error",
      upstream?: { status: number; body: unknown; requestId: string | null },
    ) => {
      if (res.destroyed) return;
      const body = {
        type: "error",
        error: { type: code, code, message },
        ...(upstream ? { upstream } : {}),
      };
      if (upstream?.requestId && !res.headersSent)
        res.setHeader("x-request-id", upstream.requestId);
      if (res.headersSent) {
        res.write(`event: error\ndata: ${JSON.stringify(body)}\n\n`);
        res.end();
      } else {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      }
    };
    try {
      const match =
        /^\/([a-f0-9-]+)\/v1\/(messages(?:\/count_tokens)?|chat\/completions|responses)(?:\?.*)?$/.exec(
          req.url ?? "",
        );
      route = match ? this.routes.get(match[1]) : undefined;
      const auth = String(
        req.headers["x-api-key"] ??
          req.headers.authorization?.replace(/^Bearer /i, "") ??
          "",
      );
      if (
        !route ||
        req.headers.origin ||
        Buffer.byteLength(auth) !== Buffer.byteLength(route.token) ||
        !timingSafeEqual(Buffer.from(auth), Buffer.from(route.token))
      ) {
        sendError(403, "Model route unavailable.");
        return;
      }
      if (req.method !== "POST") {
        sendError(405, "Use POST.");
        return;
      }
      if (this.active >= 32 || route.active >= 8) {
        res.setHeader("retry-after", "1");
        sendError(
          429,
          "Model connection is busy. Retry shortly.",
          "rate_limit_error",
        );
        return;
      }
      this.active++;
      route.active++;
      acquired = true;
      controller = new AbortController();
      route.controllers.add(controller);
      const signal = AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(600000),
      ]);
      res.once("close", () => controller!.abort());
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 8 * 1024 * 1024) {
          sendError(413, "Model input exceeds 8 MiB.");
          return;
        }
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const c = route.config;
      if (body.model !== c.model) {
        sendError(
          400,
          "The request model differs from this member's assigned model.",
        );
        return;
      }
      const wire: ConnectionProtocol = match![2].startsWith("messages")
        ? "anthropic-messages"
        : match![2] === "responses"
          ? "responses"
          : "chat-completions";
      const source = c.chatgptAccountId ? "responses" : c.protocol!;
      if (match![2] === "messages/count_tokens") {
        // Claude uses this optional endpoint for context budgeting. Do not invent token counts.
        sendError(
          501,
          "Token counting is unavailable for this model connection.",
          "not_supported_error",
        );
        return;
      }
      const apiKey = await abortable(this.key(c), signal);
      const baseUrl = c.chatgptAccountId
        ? "https://api.openai.com/v1"
        : c.baseUrl!.replace(/\/$/, "");
      let outputBytes = 0;
      const write = (chunk: string | Uint8Array) => {
        outputBytes += Buffer.byteLength(chunk);
        if (signal.aborted || res.destroyed)
          throw new Error("Model request cancelled.");
        if (outputBytes > 16 * 1024 * 1024 || res.writableLength > 1024 * 1024)
          throw new Error("Model output exceeded the connection buffer limit.");
        res.write(chunk);
      };
      if (source === wire && (!c.chatgptAccountId || body.stream === true)) {
        const suffix =
          wire === "responses"
            ? "/responses"
            : wire === "chat-completions"
              ? "/chat/completions"
              : "/messages";
        const url =
          baseUrl +
          (wire === "anthropic-messages" && !baseUrl.endsWith("/v1")
            ? "/v1"
            : "") +
          suffix;
        const payload = {
          ...body,
          model: c.model,
          ...(c.chatgptAccountId ? { store: false, stream: true } : {}),
          ...(source === "responses" && c.effort
            ? { reasoning: { ...body.reasoning, effort: c.effort } }
            : {}),
          ...(c.maxOutputTokens
            ? source === "responses"
              ? { max_output_tokens: c.maxOutputTokens }
              : { max_tokens: c.maxOutputTokens }
            : {}),
        };
        if (c.chatgptAccountId) {
          chatGPTPayload(payload);
        }
        const upstream = await fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(source === "anthropic-messages"
              ? { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
              : { authorization: "Bearer " + apiKey }),
          },
          body: JSON.stringify(payload),
          signal,
          redirect: "error",
        });
        if (!upstream.ok) {
          const data = await errorBody(upstream);
          sendError(
            upstream.status,
            String(
              data.error?.message ??
                data.detail ??
                `Model request failed (${upstream.status}).`,
            ).replaceAll(apiKey, "[redacted]"),
            data.error?.code ?? "upstream_error",
            {
              status: upstream.status,
              body: JSON.parse(
                JSON.stringify(data).replaceAll(apiKey, "[redacted]"),
              ),
              requestId: upstream.headers.get("x-request-id"),
            },
          );
          return;
        }
        res.writeHead(upstream.status, {
          "content-type":
            upstream.headers.get("content-type") ?? "text/event-stream",
          "cache-control": "no-store",
        });
        for await (const chunk of upstream.body!) write(chunk);
        res.end();
        return;
      }
      const model: Model<any> = {
        id: c.model!,
        name: c.model!,
        api: apis[source],
        provider: c.chatgptAccountId ? "openai" : "teamswarm",
        baseUrl:
          source === "anthropic-messages"
            ? baseUrl.replace(/\/v1$/, "")
            : baseUrl,
        reasoning: !!c.effort || source === "responses",
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: c.contextWindowTokens ?? 128000,
        maxTokens: c.maxOutputTokens ?? 32768,
      };
      const decoded = decodeRequest(wire, body, model);
      const journal = route.metadata.restore(decoded);
      releaseMetadata = journal.release;
      const context = normalizeContext(decoded);
      const options: StreamOptions & Record<string, any> = {
        apiKey,
        signal,
        maxRetries: 0,
        timeoutMs: 600000,
        maxTokens:
          c.maxOutputTokens ??
          body.max_tokens ??
          body.max_output_tokens ??
          32768,
        temperature: body.temperature,
        ...(c.effort ? { reasoningEffort: c.effort } : {}),
        onPayload: (payload: any) => {
          if (source === "responses") {
            payload.store = false;
            payload.stream = true;
            delete payload.previous_response_id;
            payload.include = [
              ...new Set([
                ...(payload.include ?? []),
                "reasoning.encrypted_content",
              ]),
            ];
            if (!c.effort && payload.reasoning) {
              delete payload.reasoning.effort;
              if (!Object.keys(payload.reasoning).length)
                delete payload.reasoning;
            }
          }
          const choice = body.tool_choice;
          if (choice) {
            const name = choice.name ?? choice.function?.name;
            payload.tool_choice =
              source === "anthropic-messages"
                ? name
                  ? { type: "tool", name }
                  : {
                      type:
                        choice === "required" || choice.type === "any"
                          ? "any"
                          : choice === "none" || choice.type === "none"
                            ? "none"
                            : "auto",
                    }
                : name
                  ? source === "responses"
                    ? { type: "function", name }
                    : { type: "function", function: { name } }
                  : choice === "required" || choice.type === "any"
                    ? "required"
                    : choice === "none" || choice.type === "none"
                      ? "none"
                      : "auto";
          }
          requestOptions(source, body, payload);
          return c.chatgptAccountId ? chatGPTPayload(payload) : payload;
        },
      };
      let upstreamStatus = 502,
        upstreamCode = "upstream_error";
      let upstreamFailure:
        { status: number; body: unknown; requestId: string | null } | undefined;
      let upstreamId: string | null = null;
      options.fetch = async (input: any, init: any) => {
        const response = await fetch(input, { ...init, redirect: "error" });
        upstreamStatus = response.status;
        upstreamId = response.headers.get("x-request-id");
        if (!response.ok) {
          const data = await errorBody(response);
          upstreamCode = data.error?.code ?? upstreamCode;
          upstreamFailure = {
            status: response.status,
            body: JSON.parse(
              JSON.stringify(data).replaceAll(apiKey, "[redacted]"),
            ),
            requestId: upstreamId,
          };
          return new Response(JSON.stringify(data), {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          });
        }
        let bytes = 0;
        return new Response(
          response.body?.pipeThrough(
            new TransformStream({
              transform(chunk, output) {
                bytes += chunk.byteLength;
                if (bytes > 16 * 1024 * 1024)
                  throw new Error("Model response exceeds 16 MiB.");
                output.enqueue(chunk);
              },
            }),
          ),
          {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          },
        );
      };
      const stream =
        source === "responses"
          ? responses(model, context, options)
          : source === "chat-completions"
            ? completions(model, context, options)
            : anthropic(model, context, options);
      const custom = new Set<string>(
        (body.tools ?? [])
          .filter((t: any) => t.type === "custom")
          .map((t: any) => t.name),
      );
      const encoder = new WireStream(wire, write, custom);
      let final: AssistantMessage | undefined;
      for await (const event of stream) {
        if (event.type === "error") {
          const detail = (
            event.error.errorMessage ?? `Model stream failed. ${upstreamCode}`
          ).replaceAll(apiKey, "[redacted]");
          const code =
            detail.match(
              /\b(subscription_sharing_[a-z_]+|chatpass_v2_[a-z_]+)\b/,
            )?.[1] ?? upstreamCode;
          sendError(
            upstreamStatus >= 400 ? upstreamStatus : 502,
            detail,
            code,
            upstreamFailure ??
              (upstreamId
                ? {
                    status: upstreamStatus,
                    body: { message: detail },
                    requestId: upstreamId,
                  }
                : undefined),
          );
          return;
        }
        if (event.type === "done") journal.record(event.message);
        if (body.stream) {
          if (!res.headersSent)
            res.writeHead(200, {
              "content-type": "text/event-stream",
              "cache-control": "no-store",
            });
          encoder.eventFor(event);
        }
        if (event.type === "done") final = event.message;
      }
      if (!final) throw new Error("The model stream ended before completion.");
      if (!body.stream) {
        res.writeHead(200, {
          "content-type": "application/json",
          "cache-control": "no-store",
        });
        write(JSON.stringify(encodeResponse(wire, final, undefined, custom)));
      }
      res.end();
    } catch (error) {
      sendError(
        400,
        error instanceof Error ? error.message : "Model connection failed.",
      );
    } finally {
      releaseMetadata?.();
      if (controller) {
        controller.abort();
        route?.controllers.delete(controller);
      }
      if (acquired) {
        this.active--;
        route!.active--;
      }
    }
  }
  wrap(harness: Harness): Harness {
    const gateway = this;
    // Delegate optional hooks with their original receiver; retain native process ownership.
    return new Proxy(harness, {
      get(target, key) {
        if (key === "validateConfig")
          return (c: ExecutionConfig) => {
            const issues = modelRouteIssues(c);
            if (issues?.length)
              throw new Error(
                `Incompatible model connection: ${issues.join(", ")}.`,
              );
            return target.validateConfig?.(
              needsModelRoute(c) ? nativeConfig(c) : c,
            );
          };
        if (key === "preflight" && target.preflight)
          return (r: Parameters<NonNullable<Harness["preflight"]>>[0]) => {
            // Preflight validates the source credential; native protocol validation runs separately.
            if (needsModelRoute(r.config)) {
              target.validateConfig?.(nativeConfig(r.config));
              if (
                r.config.chatgptAccountId &&
                !gateway.accounts
                  .list()
                  .some(
                    (a) => a.id === r.config.chatgptAccountId && a.connected,
                  )
              )
                throw new Error("Continue with ChatGPT in model connections.");
            }
            return target.preflight!({
              ...r,
              modelCredentialPresent:
                needsModelRoute(r.config) &&
                (!!r.config.chatgptAccountId ||
                  !!(
                    r.config.credentialEnv &&
                    process.env[r.config.credentialEnv]
                  )),
              config: needsModelRoute(r.config)
                ? nativeConfig(r.config)
                : r.config,
            });
          };
        if (key === "execute")
          return async (request: HarnessRequest) => {
            if (!needsModelRoute(request.config))
              return target.execute(request);
            const lease = await gateway.lease(request.config);
            if (request.sessionId)
              lease.session(request.sessionId, request.workspace);
            const config = ["claude-code", "deepseek-harness"].includes(
              target.id,
            )
              ? {
                  ...lease.config,
                  baseUrl: lease.config.baseUrl!.replace(/\/v1$/, ""),
                }
              : lease.config;
            const redact = (data: unknown) =>
              JSON.parse(
                JSON.stringify(data).replaceAll(lease.token, "[redacted]"),
              );
            try {
              return redact(
                await target.execute({
                  ...request,
                  config,
                  modelRoute: {
                    token: lease.token,
                    sourceConfig: request.config,
                  },
                  onEvent: (event) => request.onEvent(redact(event)),
                  onSession: (id, actual) => {
                    lease.session(id, request.workspace);
                    request.onSession(id, actual ? redact(actual) : actual);
                  },
                }),
              );
            } finally {
              lease.release();
            }
          };
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }
  async close() {
    this.closed = true;
    for (const route of this.routes.values())
      for (const controller of route.controllers) controller.abort();
    this.routes.clear();
    await this.accounts.close();
    await this.opening?.catch(() => {});
    if (this.server) {
      this.server.closeAllConnections();
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    }
  }
}
