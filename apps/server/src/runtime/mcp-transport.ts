import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Agent, request } from "node:http";
import { Readable } from "node:stream";
import { badRequest, conflict } from "../errors.js";
import { productVersion } from "../version.js";
import { hash } from "./store.js";

export type McpToolContract = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  digest: string;
};

const maximumBodyBytes = 256 * 1024;
const maximumResultBytes = 48 * 1024;
const localAgent = new Agent({ keepAlive: false });

function localResponse(endpoint: URL, method: string, headers: Headers, signal: AbortSignal, body?: BodyInit | null) {
  if (body != null && typeof body !== "string") throw conflict("mcp_request", "Unsupported MCP request body.");
  return new Promise<Response>((resolve, reject) => {
    const sent = request(endpoint, { method, headers: Object.fromEntries(headers), signal, agent: localAgent }, incoming => {
      try {
        const status = incoming.statusCode ?? 500;
        if (status < 200 || status > 599) throw conflict("mcp_response", "The MCP endpoint returned an invalid HTTP status.");
        if (status >= 300 && status < 400) throw conflict("mcp_redirect", "The MCP endpoint returned a redirect.");
        const responseHeaders = new Headers();
        for (const [key, value] of Object.entries(incoming.headers))
          if (typeof value === "string") responseHeaders.set(key, value);
        const bodyless = status === 204 || status === 205;
        if (bodyless) incoming.resume();
        const stream = bodyless ? null : Readable.toWeb(incoming) as ReadableStream<Uint8Array>;
        resolve(new Response(stream, { status, headers: responseHeaders }));
      } catch (error) {
        incoming.destroy();
        reject(error);
      }
    });
    sent.once("upgrade", (_response, socket) => {
      socket.destroy();
      reject(conflict("mcp_response", "The MCP endpoint requested an unsupported HTTP upgrade."));
    });
    sent.once("error", reject);
    sent.end(body ?? undefined);
  });
}

export async function mcpRequest<T>(signal: AbortSignal, operation: (signal: AbortSignal) => Promise<T>) {
  signal.throwIfAborted();
  const request = new AbortController();
  const cancel = () => request.abort(signal.reason);
  signal.addEventListener("abort", cancel, { once: true });
  try { return await operation(request.signal); }
  finally { signal.removeEventListener("abort", cancel); }
}

export function localMcpUrl(value: string) {
  let endpoint: URL;
  try { endpoint = new URL(value); }
  catch { throw badRequest("mcp_endpoint", "Enter a local MCP URL."); }
  if (endpoint.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(endpoint.hostname) ||
      endpoint.username || endpoint.password || endpoint.hash || endpoint.search)
    throw badRequest("mcp_endpoint", "Use a loopback HTTP endpoint at 127.0.0.1 or [::1].");
  return endpoint;
}

export async function listMcpTools(client: Client, signal: AbortSignal): Promise<McpToolContract[]> {
  const tools = new Map<string, McpToolContract>();
  const visited = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await mcpRequest(signal, signal => client.listTools(cursor ? { cursor } : {}, { signal }));
    for (const tool of page.tools) {
      if (!tool.annotations?.readOnlyHint || tool.execution?.taskSupport === "required") continue;
      const { name, inputSchema, outputSchema } = tool;
      if (!/^[A-Za-z0-9_.-]{1,128}$/.test(name) || tools.has(name) || tools.size >= 64 ||
          Buffer.byteLength(JSON.stringify(inputSchema)) > 24000)
        throw conflict("mcp_tool_catalog", "The service returned an unsupported or duplicate tool contract.");
      const canonicalize = (value: unknown): unknown => Array.isArray(value) ? value.map(canonicalize) :
        value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
          .map(([key, nested]) => [key, canonicalize(nested)])) : value;
      const digest = hash(JSON.stringify(canonicalize({ name, description: tool.description, inputSchema, outputSchema })));
      tools.set(name, { name, description: (tool.description ?? "").slice(0, 1200), inputSchema, digest });
    }
    cursor = page.nextCursor;
    if (cursor && (visited.has(cursor) || visited.size >= 15))
      throw conflict("mcp_tool_catalog", "The service returned an incomplete tool catalog.");
    if (cursor) visited.add(cursor);
  } while (cursor);
  return [...tools.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function withMcpClient<T>(url: string, action: (client: Client, signal: AbortSignal) => Promise<T>, signal?: AbortSignal) {
  const endpoint = localMcpUrl(url);
  const deadline = AbortSignal.timeout(20000);
  const live = signal ? AbortSignal.any([signal, deadline]) : deadline;
  live.throwIfAborted();
  const client = new Client({ name: "TeamSwarm", version: productVersion });
  const transport = new StreamableHTTPClientTransport(endpoint, {
    fetch: async (target, init) => {
      if (String(target) !== endpoint.href) throw conflict("mcp_endpoint", "The service endpoint changed.");
      const method = init?.method ?? "GET";
      const headers = new Headers(init?.headers);
      if (method === "GET" && !headers.has("last-event-id")) return new Response(null, { status: 405 });
      const control = method === "DELETE" || typeof init?.body === "string" && init.body.includes('"method":"notifications/cancelled"');
      const limit = control ? AbortSignal.timeout(2000) : live;
      const response = await localResponse(endpoint, method, headers,
        init?.signal ? AbortSignal.any([init.signal, limit]) : limit, init?.body);
      if (!response.body) return response;
      let received = 0;
      return new Response(response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, stream) {
          received += chunk.byteLength;
          if (received > maximumBodyBytes) throw conflict("mcp_response_size", "The MCP response exceeds the size limit.");
          stream.enqueue(chunk);
        },
      })), { status: response.status, statusText: response.statusText, headers: response.headers });
    },
  });
  const send = transport.send.bind(transport);
  const cancellations = new Set<Promise<void>>();
  let initialized = false;
  transport.send = (message, options) => {
    const cancel = "method" in message && message.method === "notifications/cancelled";
    if (cancel && !initialized) return Promise.resolve();
    const pending = send(message, options);
    if (cancel) {
      cancellations.add(pending);
      const settled = () => cancellations.delete(pending);
      void pending.then(settled, settled);
    }
    return pending;
  };
  try {
    await mcpRequest(live, signal => client.connect(transport, { signal }));
    initialized = true;
    return await action(client, live);
  } finally {
    await Promise.allSettled(cancellations);
    if (transport.sessionId) await transport.terminateSession().catch(() => undefined);
    await client.close();
  }
}

export function projectMcpResult(result: Awaited<ReturnType<Client["callTool"]>>) {
  if (result.isError) throw conflict("mcp_tool_failed", "The MCP service reported a tool error.");
  const value = {
    content: Array.isArray(result.content) ? result.content.filter(item => item.type === "text").map(item => item.text) : [],
    ...(result.structuredContent ? { structuredContent: result.structuredContent } : {}),
  };
  if (!value.content.length && !value.structuredContent) throw conflict("mcp_result_format", "The MCP tool returned no text or structured data.");
  if (Buffer.byteLength(JSON.stringify(value)) > maximumResultBytes)
    throw conflict("mcp_response_size", "The MCP tool result exceeds the size limit.");
  return value;
}
