import { randomUUID, createHash } from "node:crypto";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Message,
  Model,
  ToolCall,
} from "@earendil-works/pi-ai";
import type { ConnectionProtocol } from "@team/contracts/allocation";

type Obj = Record<string, any>;
/** The public ChatGPT plan route accepts stateless streaming Responses requests. */
export function chatGPTPayload(payload: Obj): Obj {
  payload.store = false;
  payload.stream = true;
  for (const field of [
    "previous_response_id",
    "background",
    "conversation",
    "max_output_tokens",
    "max_tool_calls",
    "metadata",
    "moderation",
    "multi_agent",
    "prompt",
    "prompt_cache_retention",
    "prompt_cache_options",
    "safety_identifier",
    "temperature",
    "top_logprobs",
    "top_p",
    "truncation",
    "user",
  ])
    delete payload[field];
  payload.input =
    typeof payload.input === "string"
      ? [{ role: "user", content: payload.input }]
      : (payload.input ?? []).map((item: Obj) =>
          item.role === "system" ? { ...item, role: "developer" } : item,
        );
  payload.include = [
    ...new Set([...(payload.include ?? []), "reasoning.encrypted_content"]),
  ];
  const tools = (payload.tools ?? []).filter((tool: Obj) =>
    ["function", "custom"].includes(tool.type),
  );
  if (tools.length) {
    payload.input.unshift({
      type: "additional_tools",
      role: "developer",
      tools,
    });
    payload.tools = payload.tools.filter(
      (tool: Obj) => !["function", "custom"].includes(tool.type),
    );
    if (!payload.tools.length) delete payload.tools;
  }
  return payload;
}

/** Map request-level controls alongside the shared message/tool representation. */
export function requestOptions(
  source: ConnectionProtocol,
  body: Obj,
  payload: Obj,
) {
  const format =
    body.text?.format ?? body.output_config?.format ?? body.response_format;
  if (format && format.type !== "text") {
    const schema = format.json_schema ?? format;
    if (format.type === "json_object") {
      if (source === "anthropic-messages")
        throw new Error(
          "This model protocol does not support JSON object mode. Use a JSON schema.",
        );
      if (source === "responses")
        payload.text = { ...payload.text, format: { type: "json_object" } };
      else payload.response_format = { type: "json_object" };
    } else if (format.type === "json_schema") {
      const value = {
        type: "json_schema",
        name: schema.name ?? "response",
        schema: schema.schema,
        strict: schema.strict ?? true,
      };
      if (source === "responses")
        payload.text = { ...payload.text, format: value };
      else if (source === "anthropic-messages")
        payload.output_config = {
          ...payload.output_config,
          format: { type: "json_schema", schema: value.schema },
        };
      else
        payload.response_format = {
          type: "json_schema",
          json_schema: {
            name: value.name,
            schema: value.schema,
            strict: value.strict,
          },
        };
    } else throw new Error(`Unsupported response format: ${format.type}.`);
  }
  const stop = body.stop_sequences ?? body.stop;
  if (stop && (!Array.isArray(stop) || stop.length)) {
    if (source === "responses")
      throw new Error("This model protocol does not support stop sequences.");
    payload[source === "anthropic-messages" ? "stop_sequences" : "stop"] = stop;
  }
  if (body.top_p != null) payload.top_p = body.top_p;
}
export const zeroUsage = () => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});
const pack = (value: unknown) =>
  "tsw_" + Buffer.from(JSON.stringify(value)).toString("base64url");
const unpack = (value: string) =>
  value?.startsWith("tsw_")
    ? JSON.parse(Buffer.from(value.slice(4), "base64url").toString())
    : null;
export const wireCallId = (id: string) =>
  /^[-a-zA-Z0-9_]{1,64}$/.test(id)
    ? id
    : "tsc_" + createHash("sha256").update(id).digest("base64url");
const callId = wireCallId;
const originalId = (id: string) => id;
const text = (value: unknown) =>
  typeof value === "string" ? value : JSON.stringify(value);
function content(value: any): any[] {
  if (typeof value === "string") return [{ type: "text", text: value }];
  return (value ?? []).map((c: Obj) => {
    if (["text", "input_text", "output_text"].includes(c.type))
      return { type: "text", text: String(c.text ?? "") };
    const data =
      c.source?.type === "base64"
        ? `data:${c.source.media_type};base64,${c.source.data}`
        : (c.image_url?.url ?? c.image_url);
    if (
      ["image", "image_url", "input_image"].includes(c.type) &&
      typeof data === "string"
    ) {
      const m = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([a-zA-Z0-9+/=]+)$/.exec(
        data,
      );
      if (m) return { type: "image", mimeType: m[1], data: m[2] };
    }
    throw new Error(
      `Unsupported model input block: ${c.type}. Use text or embedded images.`,
    );
  });
}
function assistant(model: Model<any>, blocks: any[]): AssistantMessage {
  return {
    role: "assistant",
    content: blocks,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: zeroUsage(),
    stopReason: blocks.some((c) => c.type === "toolCall") ? "toolUse" : "stop",
    timestamp: Date.now(),
  };
}

/** Convert a complete native request, preserving tool call/result identities and opaque reasoning. */
export function decodeRequest(
  wire: ConnectionProtocol,
  body: Obj,
  model: Model<any>,
): Context {
  const messages: Message[] = [],
    tools: any[] = [];
  const addTool = (t: Obj) => {
    if (t.type && !["function", "custom"].includes(t.type))
      throw new Error(`Unsupported server tool: ${t.type}.`);
    if (t.type === "custom") {
      tools.push({
        name: t.name,
        description:
          (t.description ?? "") +
          "\nReturn the complete raw tool input in the input string.\n" +
          (t.format?.grammar?.definition ?? ""),
        parameters: {
          type: "object",
          properties: { input: { type: "string" } },
          required: ["input"],
          additionalProperties: false,
        },
      });
      return;
    }
    const f = t.function ?? t;
    if (typeof f.name !== "string") throw new Error("A tool name is required.");
    tools.push({
      name: f.name,
      description: f.description ?? "",
      parameters: f.input_schema ??
        f.parameters ?? { type: "object", properties: {} },
    });
  };
  for (const t of body.tools ?? []) addTool(t);
  const result = (id: string, value: any, error = false) =>
    messages.push({
      role: "toolResult",
      toolCallId: originalId(id),
      toolName: "",
      content: content(value),
      isError: error,
      timestamp: Date.now(),
    });
  let system =
    wire === "anthropic-messages"
      ? content(body.system ?? "")
          .map((c) => c.text)
          .join("\n")
      : (body.instructions ?? "");
  if (wire === "responses") {
    for (const m of typeof body.input === "string"
      ? [{ role: "user", content: body.input }]
      : (body.input ?? [])) {
      if (
        m.type === "function_call_output" ||
        m.type === "custom_tool_call_output"
      )
        result(m.call_id, m.output);
      else if (m.type === "custom_tool_call")
        messages.push(
          assistant(model, [
            {
              type: "toolCall",
              id: originalId(m.call_id),
              name: m.name,
              arguments: { input: m.input },
            },
          ]),
        );
      else if (m.type === "function_call")
        messages.push(
          assistant(model, [
            {
              type: "toolCall",
              id: originalId(m.call_id),
              name: m.name,
              arguments: JSON.parse(m.arguments),
            },
          ]),
        );
      else if (m.type === "reasoning")
        messages.push(
          assistant(model, [
            {
              type: "thinking",
              thinking: (m.summary ?? []).map((v: Obj) => v.text).join("\n"),
              thinkingSignature:
                unpack(m.encrypted_content)?.signature ?? JSON.stringify(m),
              redacted: unpack(m.encrypted_content)?.redacted,
            },
          ]),
        );
      else if (["system", "developer"].includes(m.role))
        system +=
          "\n" +
          content(m.content)
            .map((c) => c.text)
            .join("\n");
      else if (m.role === "assistant")
        messages.push(assistant(model, content(m.content)));
      else if (m.role === "user")
        messages.push({
          role: "user",
          content: content(m.content),
          timestamp: Date.now(),
        });
      else throw new Error(`Unsupported Responses input: ${m.type ?? m.role}.`);
    }
  } else
    for (const m of body.messages ?? []) {
      if (["system", "developer"].includes(m.role)) {
        system +=
          "\n" +
          content(m.content)
            .map((c) => c.text)
            .join("\n");
        continue;
      }
      if (m.role === "tool") {
        result(m.tool_call_id, m.content);
        continue;
      }
      if (m.role === "assistant") {
        const blocks: any[] = [];
        for (const c of typeof m.content === "string"
          ? [{ type: "text", text: m.content }]
          : (m.content ?? [])) {
          if (c.type === "tool_use")
            blocks.push({
              type: "toolCall",
              id: originalId(c.id),
              name: c.name,
              arguments: c.input,
            });
          else if (c.type === "thinking" || c.type === "redacted_thinking")
            blocks.push({
              type: "thinking",
              thinking: c.thinking ?? "",
              thinkingSignature:
                unpack(c.signature ?? c.data)?.signature ??
                c.signature ??
                c.data,
              redacted: c.type === "redacted_thinking",
            });
          else blocks.push(...content([c]));
        }
        for (const t of m.tool_calls ?? [])
          blocks.push({
            type: "toolCall",
            id: originalId(t.id),
            name: t.function.name,
            arguments: JSON.parse(t.function.arguments),
          });
        if (m.reasoning_content)
          blocks.unshift({
            type: "thinking",
            thinking: m.reasoning_content,
            thinkingSignature: unpack(m.reasoning_signature)?.signature,
          });
        messages.push(assistant(model, blocks));
      } else if (m.role === "user") {
        let blocks: any[] = [];
        const flush = () => {
          if (blocks.length) {
            messages.push({
              role: "user",
              content: blocks,
              timestamp: Date.now(),
            });
            blocks = [];
          }
        };
        for (const c of typeof m.content === "string"
          ? [{ type: "text", text: m.content }]
          : (m.content ?? [])) {
          if (c.type === "tool_result") {
            flush();
            result(c.tool_use_id, c.content ?? "", c.is_error);
          } else blocks.push(...content([c]));
        }
        flush();
      } else throw new Error(`Unsupported message role: ${m.role}.`);
    }
  const calls = new Map<string, string>();
  if (wire === "responses")
    for (let i = 1; i < messages.length;) {
      const previous = messages[i - 1],
        current = messages[i];
      if (previous.role === "assistant" && current.role === "assistant") {
        previous.content.push(...current.content);
        messages.splice(i, 1);
      } else i++;
    }
  for (const m of messages) {
    if (m.role === "assistant")
      for (const c of m.content)
        if (c.type === "toolCall") calls.set(c.id, c.name);
    if (m.role === "toolResult") m.toolName = calls.get(m.toolCallId) ?? "tool";
  }
  return { systemPrompt: system, messages, tools };
}

const usage = (m: AssistantMessage) => ({
  input_tokens: m.usage.input + m.usage.cacheRead,
  output_tokens: m.usage.output,
});
const anthropicBlock = (c: AssistantMessage["content"][number]): Obj =>
  c.type === "toolCall"
    ? { type: "tool_use", id: callId(c.id), name: c.name, input: c.arguments }
    : c.type === "thinking"
      ? c.redacted
        ? {
            type: "redacted_thinking",
            data: pack({ signature: c.thinkingSignature, redacted: true }),
          }
        : {
            type: "thinking",
            thinking: c.thinking,
            signature: pack({ signature: c.thinkingSignature }),
          }
      : { type: "text", text: c.text };
const responseBlock = (
  c: AssistantMessage["content"][number],
  i: number,
  id: string,
  custom = new Set<string>(),
): Obj =>
  c.type === "toolCall"
    ? custom.has(c.name)
      ? {
          type: "custom_tool_call",
          id: "ctc_" + id + i,
          call_id: callId(c.id),
          name: c.name,
          input: String(c.arguments.input ?? ""),
          status: "completed",
        }
      : {
          type: "function_call",
          id: "fc_" + id + i,
          call_id: callId(c.id),
          name: c.name,
          arguments: JSON.stringify(c.arguments),
          status: "completed",
        }
    : c.type === "thinking"
      ? {
          type: "reasoning",
          id: "rs_" + id + i,
          summary: c.thinking
            ? [{ type: "summary_text", text: c.thinking }]
            : [],
          encrypted_content: pack({
            signature: c.thinkingSignature,
            redacted: c.redacted,
          }),
        }
      : {
          type: "message",
          id: "msg_" + id + i,
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: c.text, annotations: [] }],
        };

export function encodeResponse(
  wire: ConnectionProtocol,
  m: AssistantMessage,
  id = randomUUID().replaceAll("-", ""),
  custom = new Set<string>(),
): Obj {
  if (wire === "anthropic-messages")
    return {
      id: "msg_" + id,
      type: "message",
      role: "assistant",
      model: m.model,
      content: m.content.map(anthropicBlock),
      stop_reason:
        m.stopReason === "toolUse"
          ? "tool_use"
          : m.stopReason === "length"
            ? "max_tokens"
            : "end_turn",
      stop_sequence: null,
      usage: usage(m),
    };
  if (wire === "responses")
    return {
      id: "resp_" + id,
      object: "response",
      created_at: Math.floor(Date.now() / 1000),
      model: m.model,
      status: m.stopReason === "length" ? "incomplete" : "completed",
      output: m.content.map((c, i) => responseBlock(c, i, id, custom)),
      usage: { ...usage(m), total_tokens: m.usage.totalTokens },
      ...(m.stopReason === "length"
        ? { incomplete_details: { reason: "max_output_tokens" } }
        : {}),
    };
  return {
    id: "chatcmpl_" + id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: m.model,
    choices: [
      {
        index: 0,
        finish_reason:
          m.stopReason === "toolUse"
            ? "tool_calls"
            : m.stopReason === "length"
              ? "length"
              : "stop",
        message: {
          role: "assistant",
          content: m.content
            .filter((c) => c.type === "text")
            .map((c) => c.text)
            .join(""),
          ...(m.content.some((c) => c.type === "thinking")
            ? {
                reasoning_content: m.content
                  .filter((c) => c.type === "thinking")
                  .map((c) => c.thinking)
                  .join(""),
              }
            : {}),
          tool_calls: m.content
            .filter((c): c is ToolCall => c.type === "toolCall")
            .map((c) => ({
              id: callId(c.id),
              type: "function",
              function: {
                name: c.name,
                arguments: JSON.stringify(c.arguments),
              },
            })),
        },
      },
    ],
    usage: {
      prompt_tokens: m.usage.input + m.usage.cacheRead,
      completion_tokens: m.usage.output,
      total_tokens: m.usage.totalTokens,
    },
  };
}

/** Framing only: execution and tool results remain in the calling Harness. */
export class WireStream {
  readonly id = randomUUID().replaceAll("-", "");
  private sequence = 0;
  private toolIndex = new Map<number, number>();
  constructor(
    readonly wire: ConnectionProtocol,
    readonly send: (data: string) => void,
    readonly custom = new Set<string>(),
  ) {}
  private event(type: string, data: Obj) {
    this.send(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  }
  eventFor(e: AssistantMessageEvent) {
    if (e.type === "error")
      throw new Error(e.error.errorMessage ?? "Model stream failed.");
    const m = e.type === "done" ? e.message : e.partial;
    const i = "contentIndex" in e ? e.contentIndex : 0;
    if (this.wire === "anthropic-messages") {
      if (e.type === "start")
        this.event("message_start", {
          message: {
            ...encodeResponse(this.wire, m, this.id),
            content: [],
            stop_reason: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        });
      else if (e.type.endsWith("_start")) {
        const block = anthropicBlock(m.content[i]);
        if (block.type === "tool_use") block.input = {};
        else if (block.type === "thinking") {
          block.thinking = "";
          block.signature = "";
        } else if (block.type === "text") block.text = "";
        this.event("content_block_start", { index: i, content_block: block });
      } else if (e.type.endsWith("_delta"))
        this.event("content_block_delta", {
          index: i,
          delta:
            e.type === "text_delta"
              ? { type: "text_delta", text: e.delta }
              : e.type === "thinking_delta"
                ? { type: "thinking_delta", thinking: e.delta }
                : { type: "input_json_delta", partial_json: (e as any).delta },
        });
      else if (e.type.endsWith("_end")) {
        const c = m.content[i];
        if (c.type === "thinking" && !c.redacted)
          this.event("content_block_delta", {
            index: i,
            delta: {
              type: "signature_delta",
              signature: pack({ signature: c.thinkingSignature }),
            },
          });
        this.event("content_block_stop", { index: i });
      } else if (e.type === "done") {
        this.event("message_delta", {
          delta: {
            stop_reason: encodeResponse(this.wire, m).stop_reason,
            stop_sequence: null,
          },
          usage: usage(m),
        });
        this.event("message_stop", {});
      }
    } else if (this.wire === "chat-completions") {
      let delta: Obj = {},
        finish: string | null = null;
      if (e.type === "start") delta.role = "assistant";
      else if (e.type === "text_delta") delta.content = e.delta;
      else if (e.type === "thinking_delta") delta.reasoning_content = e.delta;
      else if (e.type === "toolcall_start") {
        this.toolIndex.set(i, this.toolIndex.size);
        const c = m.content[i] as ToolCall;
        delta.tool_calls = [
          {
            index: this.toolIndex.get(i),
            id: callId(c.id),
            type: "function",
            function: { name: c.name, arguments: "" },
          },
        ];
      } else if (e.type === "toolcall_delta")
        delta.tool_calls = [
          { index: this.toolIndex.get(i), function: { arguments: e.delta } },
        ];
      else if (e.type === "done")
        finish = encodeResponse(this.wire, m).choices[0].finish_reason;
      else return;
      this.send(
        `data: ${JSON.stringify({ id: "chatcmpl_" + this.id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: m.model, choices: [{ index: 0, delta, finish_reason: finish }], ...(e.type === "done" ? { usage: encodeResponse(this.wire, m).usage } : {}) })}\n\n`,
      );
      if (e.type === "done") this.send("data: [DONE]\n\n");
    } else {
      const emit = (type: string, data: Obj) =>
        this.event(type, { sequence_number: this.sequence++, ...data });
      const item = m.content[i]
        ? responseBlock(m.content[i], i, this.id, this.custom)
        : null;
      if (e.type === "start")
        emit("response.created", {
          response: {
            ...encodeResponse(this.wire, m, this.id),
            status: "in_progress",
            output: [],
          },
        });
      else if (e.type.endsWith("_start")) {
        const empty = {
          ...item,
          status: "in_progress",
          ...(item?.type === "custom_tool_call"
            ? { input: "" }
            : item?.type === "function_call"
              ? { arguments: "" }
              : item?.type === "message"
                ? { content: [] }
                : { summary: [], encrypted_content: undefined }),
        };
        emit("response.output_item.added", { output_index: i, item: empty });
        if (e.type === "text_start")
          emit("response.content_part.added", {
            output_index: i,
            item_id: item!.id,
            content_index: 0,
            part: { type: "output_text", text: "", annotations: [] },
          });
      } else if (e.type === "text_delta")
        emit("response.output_text.delta", {
          output_index: i,
          item_id: item!.id,
          content_index: 0,
          delta: e.delta,
        });
      else if (e.type === "toolcall_delta" && item?.type !== "custom_tool_call")
        emit("response.function_call_arguments.delta", {
          output_index: i,
          item_id: item!.id,
          delta: e.delta,
        });
      else if (e.type === "thinking_delta")
        emit("response.reasoning_summary_text.delta", {
          output_index: i,
          item_id: item!.id,
          summary_index: 0,
          delta: e.delta,
        });
      else if (e.type.endsWith("_end")) {
        if (e.type === "text_end") {
          emit("response.output_text.done", {
            output_index: i,
            item_id: item!.id,
            content_index: 0,
            text: e.content,
          });
          emit("response.content_part.done", {
            output_index: i,
            item_id: item!.id,
            content_index: 0,
            part: item!.content[0],
          });
        }
        if (e.type === "toolcall_end" && item?.type === "custom_tool_call") {
          emit("response.custom_tool_call_input.delta", {
            output_index: i,
            item_id: item.id,
            delta: item.input,
          });
          emit("response.custom_tool_call_input.done", {
            output_index: i,
            item_id: item.id,
            input: item.input,
          });
        } else if (e.type === "toolcall_end")
          emit("response.function_call_arguments.done", {
            output_index: i,
            item_id: item!.id,
            arguments: item!.arguments,
          });
        emit("response.output_item.done", { output_index: i, item });
      } else if (e.type === "done")
        emit(
          m.stopReason === "length"
            ? "response.incomplete"
            : "response.completed",
          { response: encodeResponse(this.wire, m, this.id, this.custom) },
        );
    }
  }
}
