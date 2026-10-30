import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
} from "node:fs";
import path from "node:path";
import type { AssistantMessage, Context, Message } from "@earendil-works/pi-ai";
import { wireCallId } from "./model-wire.js";

type Entry = { key: string; before: string; blocks: Record<string, any>[] };
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
function stable(value: any): any {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stable(value[key])]),
    );
  return value;
}
function visible(message: Message): unknown {
  if (message.role === "assistant")
    return [
      message.role,
      message.content.map((c) =>
        c.type === "text"
          ? ["text", c.text]
          : c.type === "thinking"
            ? ["thinking", c.thinking]
            : ["tool", wireCallId(c.id), c.name, stable(c.arguments)],
      ),
    ];
  if (message.role === "toolResult")
    return [
      message.role,
      wireCallId(message.toolCallId),
      stable(message.content),
    ];
  return [
    message.role,
    typeof message.content === "string"
      ? [{ type: "text", text: message.content }]
      : stable(message.content),
  ];
}

/** Opaque provider metadata follows the native history, addressed by tool identity
 * and request ancestry. Text and tool results are never duplicated in this file. */
export class ModelMetadata {
  private file?: string;
  private entries: Entry[] = [];
  private active = new Map<symbol, Set<Entry>>();
  constructor(directory?: string, scope?: unknown) {
    if (directory) {
      this.file = path.join(
        directory,
        "model-sessions",
        digest(scope) + ".json",
      );
      if (existsSync(this.file))
        this.entries = JSON.parse(readFileSync(this.file, "utf8"));
    }
  }
  restore(context: Context) {
    const available = new Map<string, Entry[]>();
    for (const entry of this.entries)
      available.set(entry.key, [...(available.get(entry.key) ?? []), entry]);
    const selected = new Set<Entry>(),
      ids = new Map<string, string>();
    let before = digest([]);
    for (const message of context.messages) {
      const value = visible(message),
        key = digest(value);
      if (message.role === "assistant") {
        const candidates = available.get(key) ?? [];
        const exact = candidates.filter((entry) => entry.before === before);
        const matches = exact.length ? exact : candidates;
        if (matches.length) {
          if (
            new Set(matches.map((entry) => JSON.stringify(entry.blocks))).size >
            1
          )
            throw new Error(
              "Model session history is ambiguous. Start a new session.",
            );
          const entry = matches[0];
          selected.add(entry);
          message.content.forEach((block, index) => {
            const metadata = entry.blocks[index];
            if (!metadata || metadata.type !== block.type) return;
            if (block.type === "toolCall" && metadata.id)
              ids.set(block.id, metadata.id);
            Object.assign(block, metadata);
          });
        }
      }
      if (message.role === "toolResult")
        message.toolCallId = ids.get(message.toolCallId) ?? message.toolCallId;
      before = digest([before, value]);
    }
    const handle = Symbol();
    this.active.set(handle, selected);
    return {
      record: (message: AssistantMessage) => this.record(message, before),
      release: () => this.active.delete(handle),
    };
  }
  private record(message: AssistantMessage, before: string) {
    const entry: Entry = {
      key: digest(visible(message)),
      before,
      blocks: message.content.map((c) =>
        c.type === "text"
          ? { type: c.type, textSignature: c.textSignature }
          : c.type === "thinking"
            ? {
                type: c.type,
                thinkingSignature: c.thinkingSignature,
                redacted: c.redacted,
              }
            : {
                type: c.type,
                id: c.id,
                thoughtSignature: c.thoughtSignature,
                namespace: c.namespace,
              },
      ),
    };
    const next = [...this.entries, entry];
    const serialized = JSON.stringify(next);
    if (Buffer.byteLength(serialized) > 16 * 1024 * 1024) {
      throw new Error(
        "Model session metadata exceeds 16 MiB. Start a new session.",
      );
    }
    this.entries = next;
    if (this.file) {
      mkdirSync(path.dirname(this.file), { recursive: true });
      const temporary = this.file + "." + randomUUID() + ".tmp";
      writeFileSync(temporary, serialized, { mode: 0o600, flag: "wx" });
      renameSync(temporary, this.file);
    }
  }
}
