import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
import type { AssistantMessage, Context, Message } from "@earendil-works/pi-ai";
import { wireCallId } from "./model-wire.js";

type Entry = {
  key: string;
  before: string;
  observation?: string;
  blocks: Record<string, any>[];
};
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
  private initialized = false;
  private active = new Map<symbol, Set<Entry>>();
  constructor(directory?: string, scope?: unknown) {
    if (directory) {
      this.file = path.join(
        directory,
        "model-sessions",
        digest(scope) + ".json",
      );
      if (existsSync(this.file)) {
        this.entries = JSON.parse(readFileSync(this.file, "utf8"));
        this.initialized = true;
      }
    }
  }
  fork(
    directory: string | undefined,
    scope: unknown,
    context: Context,
  ): ModelMetadata {
    const child = new ModelMetadata(directory, scope);
    if (!child.initialized) child.save([...this.apply(context).selected]);
    return child;
  }
  private apply(context: Context) {
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
        let matches = exact.length ? exact : candidates;
        const signatures = [
          "textSignature",
          "thinkingSignature",
          "thoughtSignature",
          "namespace",
        ];
        if (
          matches.length &&
          message.content.some((block) =>
            signatures.some((field) => (block as any)[field] !== undefined),
          )
        ) {
          matches = matches.filter((entry) =>
            message.content.every((block, index) =>
              signatures.every(
                (field) =>
                  (block as any)[field] === undefined ||
                  entry.blocks[index]?.[field] === undefined ||
                  JSON.stringify((block as any)[field]) ===
                    JSON.stringify(entry.blocks[index][field]),
              ),
            ),
          );
          if (!matches.length)
            throw new Error(
              "Native history conflicts with saved model metadata.",
            );
          const score = (entry: Entry) =>
            message.content.reduce(
              (total, block, index) =>
                total +
                signatures.filter(
                  (field) =>
                    (block as any)[field] !== undefined &&
                    entry.blocks[index]?.[field] !== undefined,
                ).length,
              0,
            );
          const highest = Math.max(...matches.map(score));
          matches = matches.filter((entry) => score(entry) === highest);
        }
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
            Object.assign(
              block,
              Object.fromEntries(
                Object.entries(metadata).filter(
                  ([, value]) => value !== undefined,
                ),
              ),
            );
          });
        }
      }
      if (message.role === "toolResult")
        message.toolCallId = ids.get(message.toolCallId) ?? message.toolCallId;
      before = digest([before, value]);
    }
    return { selected, before };
  }
  restore(context: Context) {
    const { selected, before } = this.apply(context);
    const handle = Symbol();
    const observation = randomUUID();
    this.active.set(handle, selected);
    return {
      record: (message: AssistantMessage) =>
        this.record(message, before, observation),
      release: () => this.active.delete(handle),
    };
  }
  private record(
    message: AssistantMessage,
    before: string,
    observation: string,
  ) {
    const entry: Entry = {
      key: digest(visible(message)),
      before,
      observation,
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
    const next = [
      ...this.entries.filter(
        (old) => old.observation !== observation || old.key !== entry.key,
      ),
      entry,
    ];
    this.save(next);
  }
  private save(next: Entry[]) {
    const serialized = JSON.stringify(next);
    if (Buffer.byteLength(serialized) > 16 * 1024 * 1024) {
      throw new Error(
        "Model session metadata exceeds 16 MiB. Start a new session.",
      );
    }
    if (this.file) {
      mkdirSync(path.dirname(this.file), { recursive: true });
      const temporary = this.file + "." + randomUUID() + ".tmp";
      try {
        writeFileSync(temporary, serialized, { mode: 0o600, flag: "wx" });
        renameSync(temporary, this.file);
      } finally {
        if (existsSync(temporary)) unlinkSync(temporary);
      }
    }
    this.entries = next;
    this.initialized = true;
  }
}

/** Each native thread owns its journal; forks capture only the history actually supplied. */
export class ModelMetadataTree {
  private root: ModelMetadata;
  private threads = new Map<string, ModelMetadata>();
  constructor(
    private directory?: string,
    private config?: unknown,
    private rootId?: string,
    private workspace?: string,
  ) {
    this.root = new ModelMetadata(directory, this.scope(rootId));
    if (rootId) this.threads.set(rootId, this.root);
  }
  private scope(id?: string) {
    return [this.config, id, this.workspace];
  }
  restore(
    context: Context,
    identity: { nativeThreadId?: string; parentThreadId?: string } = {},
  ) {
    const id = identity.nativeThreadId;
    if (!id || !this.rootId || id === this.rootId)
      return this.root.restore(context);
    let journal = this.threads.get(id);
    if (!journal) {
      const parentId = identity.parentThreadId ?? this.rootId;
      let parent = this.threads.get(parentId);
      if (!parent) {
        parent = new ModelMetadata(this.directory, this.scope(parentId));
      }
      journal = parent.fork(this.directory, this.scope(id), context);
      this.threads.set(id, journal);
    }
    return journal.restore(context);
  }
}
