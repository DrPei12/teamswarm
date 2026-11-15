import type { AssistantMessageEvent } from "@earendil-works/pi-ai";

type Part = {
  text?: string;
  inlineData?: { mimeType: string; data: string };
  functionCall?: { id?: string; name: string; args?: Record<string, unknown> };
  functionResponse?: { id?: string; name: string; response: Record<string, unknown> };
};
type Content = { role: "user" | "model"; parts: Part[] };
export const antigravityWireModel = "gemini-3.8-flash";

/** Translate Gemini-native tool history into the gateway's existing chat decoder. */
export function geminiRequest(body: {
  contents?: Content[]; systemInstruction?: { parts: Part[] };
  tools?: { functionDeclarations?: { name: string; description?: string; parameters?: unknown; parametersJsonSchema?: unknown }[] }[];
  generationConfig?: { maxOutputTokens?: number; temperature?: number };
  toolConfig?: { functionCallingConfig?: { mode?: string; allowedFunctionNames?: string[] } };
}, model: string, streaming: boolean) {
  const messages: Record<string, unknown>[] = [];
  const pending: { id: string; name: string; nativeId?: string }[] = [];
  let sequence = 0;
  if (body.systemInstruction?.parts?.length)
    messages.push({ role: "system", content: body.systemInstruction.parts.map(part => part.text ?? "").join("\n") });
  for (const turn of body.contents ?? []) {
    const content: Record<string, unknown>[] = [];
    const calls: Record<string, unknown>[] = [];
    const flush = () => {
      if (content.length || calls.length) messages.push({
        role: turn.role === "model" ? "assistant" : "user",
        content: content.splice(0), ...(calls.length ? { tool_calls: calls.splice(0) } : {}),
      });
    };
    for (const part of turn.parts) {
      if (part.functionCall) {
        const call = part.functionCall;
        const id = call.id ?? "agy_" + ++sequence;
        pending.push({ id, name: call.name, nativeId: call.id });
        calls.push({ id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) } });
      } else if (part.functionResponse) {
        flush();
        const reply = part.functionResponse;
        const index = pending.findIndex(call => reply.id ? call.nativeId === reply.id : call.name === reply.name);
        if (index < 0) throw new Error("Antigravity returned a tool result without its original call.");
        const [call] = pending.splice(index, 1);
        messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(reply.response) });
      } else if (part.inlineData) {
        content.push({ type: "image_url", image_url: { url: `data:${part.inlineData.mimeType};base64,${part.inlineData.data}` } });
      } else if (typeof part.text === "string") content.push({ type: "text", text: part.text });
      else throw new Error("This Antigravity input type is unavailable on shared model connections.");
    }
    flush();
  }
  const tools = (body.tools ?? []).flatMap(group => (group.functionDeclarations ?? []).map(declaration => ({
    type: "function", function: {
      name: declaration.name, description: declaration.description,
      parameters: declaration.parametersJsonSchema ?? declaration.parameters,
    },
  })));
  const choice = body.toolConfig?.functionCallingConfig;
  const allowed = choice?.allowedFunctionNames;
  return {
    model, messages, stream: streaming,
    ...(tools.length ? { tools: allowed?.length ? tools.filter(tool => allowed.includes(tool.function.name)) : tools } : {}),
    ...(choice?.mode === "NONE" ? { tool_choice: "none" } : choice?.mode === "ANY" ? { tool_choice: "required" } : {}),
    max_tokens: body.generationConfig?.maxOutputTokens, temperature: body.generationConfig?.temperature,
  };
}

export function geminiEvent(event: AssistantMessageEvent): Record<string, unknown> | undefined {
  if (event.type === "text_delta")
    return { candidates: [{ index: 0, content: { role: "model", parts: [{ text: event.delta }] } }] };
  if (event.type === "toolcall_end")
    return { candidates: [{ index: 0, content: { role: "model", parts: [{
      functionCall: { id: event.toolCall.id, name: event.toolCall.name, args: event.toolCall.arguments },
    }] } }] };
  if (event.type === "done") {
    const { usage, stopReason } = event.message;
    return {
      candidates: [{ index: 0, finishReason: stopReason === "length" ? "MAX_TOKENS" : "STOP" }],
      usageMetadata: {
        promptTokenCount: usage.input + usage.cacheRead, cachedContentTokenCount: usage.cacheRead,
        candidatesTokenCount: usage.output, totalTokenCount: usage.totalTokens,
      },
    };
  }
}
