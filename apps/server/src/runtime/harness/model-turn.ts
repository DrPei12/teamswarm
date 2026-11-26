import type { NativeModelTurnProtocol } from "../types.js";

const marker = /^\[teamswarm-turn:([a-f0-9-]{36})\]\n/;

export function tagModelTurn(input: string, turnId: string): string {
  return `[teamswarm-turn:${turnId}]\n${input}`;
}

export function isGrokReminder(value: unknown): boolean {
  return typeof value === "string" && value.startsWith("<system-reminder>\n") && value.endsWith("\n</system-reminder>");
}

/** Messages tool results use the user role. Only a user text message can start a turn. */
export function consumeModelTurn(input: unknown, turnId: string, protocol: NativeModelTurnProtocol) {
  if (!Array.isArray(input)) return undefined;
  let latest: string | undefined;
  const boundaries = new Map<number, string>();
  const strip = (value: string, index: number): string => {
    let prefix = "";
    if (protocol === "grok-chat-completions") {
      if (isGrokReminder(value)) return value;
      prefix = "<user_query>\n";
      if (!value.startsWith(prefix) || !value.endsWith("\n</user_query>")) {
        latest = undefined;
        return value;
      }
    }
    const found = marker.exec(value.slice(prefix.length));
    latest = found?.[1];
    if (latest) boundaries.set(index, latest);
    return found ? prefix + value.slice(prefix.length + found[0].length) : value;
  };
  for (const [index, message] of input.entries()) {
    if (message?.role !== "user") continue;
    if (typeof message.content === "string") {
      message.content = strip(message.content, index);
      continue;
    }
    if (!Array.isArray(message.content)) { latest = undefined; continue; }
    const firstText = message.content.find((block: any) => block?.type === "text" && typeof block.text === "string");
    if (firstText) firstText.text = strip(firstText.text, index);
    else if (protocol !== "messages" || !message.content.length ||
        !message.content.every((block: any) => block?.type === "tool_result")) latest = undefined;
  }
  return latest === turnId ? boundaries : undefined;
}

