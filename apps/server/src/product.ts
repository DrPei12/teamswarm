import express, { Router } from "express";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { z } from "zod";
import type {
  Workspace,
  Team,
  Chat,
  Message,
  Definition,
  Member,
  Connection,
  Delivery,
  Attachment,
  Draft,
  Skill,
  Plugin,
} from "@team/contracts/product";
import type {
  Attempt,
  Run,
  Work,
  ProjectDocument,
  ProjectNode,
  RuntimeSettings,
  ArtifactVersion,
  HostDelivery,
  TeamExchange,
  Member as RuntimeMember,
} from "@team/contracts/runtime";
import { saveProductCredential } from "./product-credentials.js";
import { stageAttachment } from "./attachments.js";
import { CodexHarness } from "./runtime/harness/codex.js";
import type { TeamRuntime } from "./runtime/engine.js";
import { definitionInput } from "./runtime/project-history.js";
import { insightInput } from "./runtime/collaboration-records.js";
import { parse, key, executionConfig } from "./runtime/validation.js";
import { badRequest, conflict, notFound } from "./errors.js";
import {
  communicationExchanges,
  memberConversation,
  transcriptItems,
} from "./member-conversation.js";

type Preferences = {
  name: string;
  theme: Workspace["theme"];
  language: Workspace["language"];
  teams: Record<string, Partial<Team>>;
  chats: Record<string, Partial<Chat>>;
  positions: Record<string, { x?: number; y?: number }>;
  drafts: Record<string, Draft>;
  skills: Skill[];
  plugins: Plugin[];
  readDeliveries: string[];
  legacyDefinitions: Definition[];
};
const freshPreferences = (): Preferences => ({
  name: "TeamSwarm",
  theme: "light",
  language: "en",
  teams: {},
  chats: {},
  positions: {},
  drafts: {},
  skills: [],
  plugins: [],
  readDeliveries: [],
  legacyDefinitions: [],
});
const active = new Set([
  "queued",
  "waiting",
  "running",
  "stopping",
  "recovery_required",
]);
export const harnessLabels: Record<string, string> = {
  codex: "Codex",
  "claude-code": "Claude Code",
  grok: "Grok",
  pi: "pi",
  "deepseek-harness": "DeepSeek Harness",
  opencode: "OpenCode",
};
const fileInput = z
  .object({
    id: z.string().uuid(),
    name: z.string().min(1).max(255),
    size: z
      .number()
      .int()
      .min(0)
      .max(25 * 1024 * 1024),
    type: z.string().max(200),
  })
  .strict();
const referenceInput = z
  .object({ id: key, kind: z.string().max(40), label: z.string().max(200) })
  .strict();
const draftInput = z
  .object({
    text: z.string().max(100000),
    files: z.array(fileInput).max(50),
    skillId: key.optional(),
    references: z.array(referenceInput).max(50).optional(),
  })
  .strict();
const skillInput = z
  .object({
    id: key,
    teamId: key,
    name: z.string().min(1).max(80),
    instructions: z.string().min(1).max(40000),
  })
  .strict();
const pluginInput = z
  .object({
    id: key,
    name: z.string().min(1).max(80),
    command: z.string().regex(/^\/?[a-zA-Z0-9_-]+$/),
    description: z.string().max(40000),
  })
  .strict();

/** Product-specific presentation state, attachments and read models share the durable service. */
function readableSummary(value: string) {
  return value.replace(/```[\s\S]*?```/g, " ").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/[*#`>]/g, "").replace(/\s+/g, " ").trim().slice(0, 180);
}
function readableTitle(value: string) {
  const summary = readableSummary(value);
  const sentence = summary.match(/^.*?(?:[。！？]|\.(?=\s|$))/u)?.[0] ?? summary;
  return sentence.length > 64 ? `${sentence.slice(0, 61).trimEnd()}…` : sentence;
}

export class ProductStore {
  constructor(readonly runtime: TeamRuntime) {
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS product_state(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS product_imports(id TEXT PRIMARY KEY,content TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS product_files(id TEXT PRIMARY KEY,data TEXT NOT NULL,sha256 TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS product_message_details(message_id TEXT PRIMARY KEY REFERENCES messages(id),data TEXT NOT NULL);`);
    this.db
      .prepare("INSERT OR IGNORE INTO product_state VALUES(1,0,?)")
      .run(JSON.stringify(freshPreferences()));
    mkdirSync(this.fileDirectory, { recursive: true });
  }
  get db() {
    return this.runtime.store.db;
  }
  get fileDirectory() {
    return path.join(this.runtime.store.teams.dataDir, "attachments");
  }
  read() {
    const row = this.db
      .prepare("SELECT revision,data FROM product_state WHERE id=1")
      .get()!;
    return {
      revision: Number(row.revision),
      preferences: JSON.parse(String(row.data)) as Preferences,
    };
  }
  write(prefs: Preferences) {
    this.db
      .prepare("UPDATE product_state SET revision=revision+1,data=? WHERE id=1")
      .run(JSON.stringify(prefs));
  }
  update(change: (prefs: Preferences) => void) {
    return this.runtime.store.transaction(() => {
      const { preferences } = this.read();
      change(preferences);
      this.write(preferences);
      return this.read().revision;
    });
  }
  file(id: string): Attachment {
    const row = this.db
      .prepare("SELECT data FROM product_files WHERE id=?")
      .get(id);
    if (!row) throw notFound();
    return JSON.parse(String(row.data));
  }
  upload(file: Attachment, bytes: Buffer) {
    if (file.size !== bytes.length)
      throw badRequest("file_size", "The uploaded file size does not match.");
    const digest = createHash("sha256").update(bytes).digest("hex");
    const previous = this.db
      .prepare("SELECT sha256,data FROM product_files WHERE id=?")
      .get(file.id);
    if (
      previous &&
      (previous.sha256 !== digest || previous.data !== JSON.stringify(file))
    )
      throw conflict(
        "file_conflict",
        "This file identifier already has different contents or metadata.",
      );
    const target = path.join(this.fileDirectory, file.id);
    if (existsSync(target)) {
      if (
        createHash("sha256").update(readFileSync(target)).digest("hex") !==
        digest
      )
        throw conflict(
          "file_conflict",
          "This upload has different contents. Select the file again.",
        );
    } else writeFileSync(target, bytes, { flag: "wx" });
    this.db
      .prepare("INSERT OR IGNORE INTO product_files VALUES(?,?,?)")
      .run(file.id, JSON.stringify(file), digest);
    return file;
  }
  configureDefault(teamId: string) {
    const workspace = path.join(
      process.env.TEAM_PROJECTS_DIR ?? `${this.runtime.store.teams.dataDir}-projects`,
      teamId,
    );
    mkdirSync(workspace, { recursive: true });
    return this.runtime.store.configure(
      teamId,
      {
        workspace,
        config: {
          harness: "codex",
          model: null,
          provider: null,
          baseUrl: null,
          credentialEnv: null,
          effort: null,
          access: "workspace-write",
        },
        maxConcurrent: 2,
        maxWorksPerRun: 20,
        timeoutSeconds: 600,
      },
      0,
    );
  }
  private snapshotCache?: { stamp: string; value: Workspace; tag: string };
  private stamp() {
    return JSON.stringify([
      this.db.prepare("SELECT total_changes() AS n").get(),
      this.db.prepare("PRAGMA data_version").get(),
    ]);
  }
  snapshot(): Workspace {
    const stamp = this.stamp();
    if (this.snapshotCache?.stamp === stamp) return this.snapshotCache.value;
    const value = this.buildSnapshot();
    this.snapshotCache = { stamp: this.stamp(), value, tag: '"' + createHash("sha256").update(JSON.stringify(value)).digest("hex") + '"' };
    return value;
  }
  messagePage(conversationId: string, before?: string): Chat {
    const chat = this.buildSnapshot({ conversationId, before }).chats[0];
    if (!chat) throw notFound("Conversation or history cursor was not found.");
    return chat;
  }
  snapshotTag(): string {
    this.snapshot();
    return this.snapshotCache!.tag;
  }
  private buildSnapshot(page?: { conversationId: string; before?: string }): Workspace {
    const { revision, preferences: p } = this.read();
    const workspace: Workspace = {
      version: 1,
      name: p.name,
      theme: p.theme,
      language: p.language,
      teams: [],
      chats: [],
      skills: p.skills,
      plugins: p.plugins,
      drafts: p.drafts,
      definitions: [...p.legacyDefinitions],
      members: [],
      connections: [],
      deliveries: [],
      updates: [],
      service: { revision, migrated: true },
      executions: {},
      projectNodes: [],
      projectBranches: [],
      projectDocuments: [],
      outputs: [],
      insights: [],
    };
    for (const team of this.runtime.store.teams.listTeams()) {
      const state = this.runtime.state(team.id);
      workspace.outputs!.push(...state.outputs);
      workspace.insights!.push(...state.insights);
      const settings = state.settings;
      const prefs = p.teams[team.id] ?? {};
      const mainChatId = this.runtime.history.mainConversation(team.id);
      const attempts = this.runtime.store.list<Attempt>("attempts", team.id);
      const hostDeliveries = this.runtime.store.list<HostDelivery>(
        "deliveries",
        team.id,
      );
      const lastEvent = Number(
        this.db
          .prepare(
            "SELECT MAX(sequence) AS seq FROM runtime_events WHERE team_id=?",
          )
          .get(team.id)?.seq ?? 0,
      );
      const events = this.runtime.store.events(
        team.id,
        Math.max(0, lastEvent - 200),
        200,
      );
      workspace.executions![team.id] = {
        settings,
        works: state.works,
        runs: state.runs,
        attempts,
        latestEvent: events.at(-1)?.sequence ?? 0,
      };
      const hostId = state.members.find((m) => m.kind === "host")?.id;
      const hostMember = state.members.find((m) => m.kind === "host");
      const activeBranch = prefs.lastChatId
        ? this.runtime.history.forConversation(team.id, prefs.lastChatId).id
        : this.runtime.history.ensure(team.id).id;
      const hostAllocation = hostMember ? this.runtime.catalog.memberExecution(team.id, activeBranch, hostMember) : null;
      const hostConfig = hostAllocation?.config ?? settings?.config;
      const latestUsage = attempts
        .filter(
          (a) =>
            a.usage &&
            a.memberId === hostId &&
            (!prefs.lastChatId ||
              state.runs.find(
                (r) =>
                  r.id === state.works.find((w) => w.id === a.workId)?.runId,
              )?.conversationId === prefs.lastChatId),
        )
        .at(-1)?.usage;
      const last = latestUsage?.last as Record<string, unknown> | undefined;
      const used = Number(
        last?.totalTokens ??
          last?.inputTokens ??
          latestUsage?.inputTokens ??
          latestUsage?.input_tokens,
      );
      const limit = Number(
        latestUsage?.contextWindow ?? latestUsage?.modelContextWindow,
      );
      workspace.teams.push({
        ...prefs,
        mainChatId,
        id: team.id,
        name: team.name,
        color: prefs.color ?? "#7774cf",
        configured: !!settings,
        runtime: {
          harness:
            harnessLabels[hostConfig?.harness ?? ""] ??
            hostConfig?.harness ??
            "Codex",
          model: hostAllocation?.selectionCurrent === false && !hostAllocation.selectionRetained ? "Reselect resource" : hostConfig?.model ?? "Default model",
          effort: hostConfig?.effort ?? "Default",
        },
        ...(Number.isFinite(used) && limit > 0
          ? { context: { used, limit } }
          : {}),
      });
      const conversations = this.runtime.store.teams.getTeamDetail(
        team.id,
      )!.conversations;
      for (const conversation of conversations) {
        if (page && conversation.id !== page.conversationId) continue;
        const detail = this.runtime.store.teams.getConversationDetail(
          team.id,
          conversation.id,
          { limit: 50, before: page?.before },
        );
        if (!detail) throw notFound("Conversation or history cursor was not found.");
        const branch = this.runtime.history.forConversation(
          team.id,
          conversation.id,
        );
        const chatPrefs = p.chats[conversation.id] ?? {};
        const messages: Message[] = detail.messages.map((m) => {
          const row = this.db
            .prepare(
              "SELECT data FROM product_message_details WHERE message_id=?",
            )
            .get(m.id);
          const meta = row ? JSON.parse(String(row.data)) : {};
          const attempt = m.clientRequestId?.startsWith("runtime:")
            ? attempts.find((a) => a.id === m.clientRequestId!.slice(8))
            : undefined;
          const runId = state.works.find(
            (w) => w.id === attempt?.workId,
          )?.runId;
          const available = state.artifacts
            .filter(
              (a) =>
                runId &&
                a.path !== "@result" &&
                a.createdAt <= m.createdAt &&
                state.works.find((w) => w.id === a.workId)?.runId === runId,
            )
            .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
          const artifacts = [
            ...new Map(
              available.map((a) => [a.path, { id: a.id, name: a.path }]),
            ).values(),
          ];

          return {
            id: meta.legacyId ?? m.id,
            recordId: m.id,
            text: m.content,
            role: m.role === "assistant" ? "host" : "user",
            files: meta.files ?? [],
            skill: meta.skill,
            references: meta.references,
            createdAt: Date.parse(m.createdAt),
            receiptId: m.clientRequestId,
            artifacts,
            activity: attempt
              ? transcriptItems(this.runtime, attempt).filter(
                  (i) => i.kind !== "message" || i.phase === "commentary",
                )
              : undefined,
          };
        });
        for (const work of (page ? [] : state.works).filter(
          (w) =>
            active.has(w.status) &&
            w.kind !== "host-followup" &&
            w.kind !== "collaboration" &&
            state.members.find((m) => m.id === w.memberId)?.kind === "host" &&
            state.runs.find((r) => r.id === w.runId)?.conversationId ===
              conversation.id,
        )) {
          const attempt = attempts.find((a) => a.id === work.attemptId);
          if (!attempt) continue;
          const deltas = this.db
            .prepare(
              "SELECT data FROM runtime_events WHERE attempt_id=? AND type='message.delta' ORDER BY sequence",
            )
            .all(attempt.id);
          const items = transcriptItems(this.runtime, attempt);
          const text = items.length
            ? items
                .filter((i) => i.kind === "message" && i.phase !== "commentary")
                .map((i) => i.text)
                .join("\n\n")
            : deltas
                .map((e) => String(JSON.parse(String(e.data)).delta ?? ""))
                .join("");
          const activity = items.filter(
            (i) => i.kind !== "message" || i.phase === "commentary",
          );
          if (text || activity.length)
            messages.push({
              id: `stream:${attempt.id}`,
              text,
              files: [],
              role: "host",
              createdAt: Date.parse(attempt.startedAt),
              pending: true,
              activity,
            });
        }
        workspace.chats.push({
          ...chatPrefs,
          id: conversation.id,
          teamId: team.id,
          title: conversation.title,
          starred: chatPrefs.starred ?? false,
          createdAt: Date.parse(conversation.createdAt),
          messages,
          historyBefore: detail.historyBefore,
          branchId: branch.id,
        });
      }
      const branchList = this.runtime.history.branches(team.id);
      workspace.projectBranches!.push(...branchList);
      let cursor = 0;
      const nodes: ProjectNode[] = [];
      for (;;) {
        const page = this.runtime.history.timeline(team.id, cursor, 500);
        nodes.push(...page.nodes);
        if (page.nodes.length < 500) break;
        cursor = page.nextCursor;
      }
      workspace.projectNodes!.push(...nodes);
      for (const chat of workspace.chats.filter((c) => c.teamId === team.id)) {
        const fork = nodes.find(
          (n) => n.branchId === chat.branchId && n.kind === "fork",
        );
        if (!fork) continue;
        const base = nodes.find((n) => n.id === fork.parentNodeId);
        if (base?.source.conversationId)
          chat.parent = {
            chatId: base.source.conversationId,
            messageId: base.source.messageIds?.at(-1) ?? "",
          };
        chat.inheritedDefinitions = Object.values(fork.documents).map((id) => {
          const d = this.runtime.history.document(team.id, id);
          return {
            id: d.id,
            teamId: team.id,
            chatId: chat.id,
            messageId: "",
            kind: d.kind === "design" ? "understanding" : d.kind,
            title: d.title,
            text: d.content,
            createdAt: Date.parse(d.createdAt),
            revision: 1,
            author: "user" as const,
          };
        });
      }
      const seenDocs = new Set<string>();
      for (const node of nodes) {
        for (const revisionId of Object.values(node.documents)) {
          if (seenDocs.has(revisionId)) continue;
          seenDocs.add(revisionId);
          const d = this.runtime.history.document(team.id, revisionId);
          workspace.projectDocuments!.push(d);
          const chatId =
            node.source.conversationId ??
            workspace.chats.find((c) => c.branchId === node.branchId)?.id ??
            "";
          workspace.definitions.push({
            id: d.id,
            teamId: team.id,
            chatId,
            messageId: node.source.messageIds?.[0] ?? "",
            kind: d.kind === "design" ? "understanding" : d.kind,
            title: d.title,
            text: d.content,
            createdAt: Date.parse(d.createdAt),
            revision:
              nodes.filter(
                (n) =>
                  n.documents[d.key] &&
                  Date.parse(n.createdAt) <= Date.parse(node.createdAt),
              ).length || 1,
            author: node.source.actor === "user" ? "user" : "host",
          });
        }
        if (node.kind === "delivery") {
          // A pending Host receipt and its history node describe the same delivery.
          if (hostDeliveries.some((d) => d.workId === node.source.workId))
            continue;
          const run = state.runs.find(
            (r) =>
              r.id ===
              state.works.find((w) => w.id === node.source.workId)?.runId,
          );
          const chat = workspace.chats.find(
            (c) => c.id === (node.source.conversationId ?? run?.conversationId),
          );
          const message = chat?.messages
            .filter(
              (m) =>
                m.role === "host" && m.createdAt <= Date.parse(node.createdAt),
            )
            .at(-1);
          const artifacts = node.artifactIds.map((id) =>
            this.runtime.store.get<ArtifactVersion>("artifacts", team.id, id),
          );
          workspace.deliveries.push({
            id: node.id,
            outcome: true,
            branchId: node.branchId,
            teamId: team.id,
            chatId: chat?.id ?? "",
            messageId: message?.id ?? "",
            title:
              artifacts
                .filter((a) => a.path !== "@result")
                .map((a) => a.path)
                .join(", ") || readableTitle(message?.text ?? artifacts.find(a => a.path === "@result")?.content ?? node.title),
            summary: readableSummary(message?.text ?? node.title),
            content:
              artifacts
                .filter((a) => a.path !== "@result")
                .map((a) => `### ${a.path}\n\n${a.content}`)
                .join("\n\n") ||
              artifacts.find(a => a.path === "@result")?.content || message?.text ||
              node.title,
            artifactIds: artifacts
              .filter((a) => a.path !== "@result")
              .map((a) => ({ id: a.id, name: a.path })),
            createdAt: Date.parse(node.createdAt),
            read: p.readDeliveries.includes(node.id),
            version: 1,
          });
        }
      }
      for (const delivery of hostDeliveries) {
        const work = state.works.find((w) => w.id === delivery.workId);
        const node = nodes.find(
          (n) => n.kind === "delivery" && n.source.workId === delivery.workId,
        );
        const chat = workspace.chats.find(
          (c) => c.id === delivery.conversationId,
        );
        const message = chat?.messages.find(
          (m) => m.receiptId === `runtime:${delivery.attemptId}`,
        );
        const artifacts = (node?.artifactIds ?? [])
          .map((id) =>
            this.runtime.store.get<ArtifactVersion>("artifacts", team.id, id),
          )
          .filter((a) => a.path !== "@result");
        workspace.deliveries.push({
          id: delivery.id,
          outcome: !!node,
          branchId: delivery.branchId,
          teamId: team.id,
          chatId: delivery.conversationId,
          messageId: message?.id ?? "",
          title:
            artifacts.map((a) => a.path).join(", ") ||
            (node ? readableTitle(delivery.content) : "") ||
            (p.language === "zh-CN" ? "团队进展" : "Team update"),
          summary: readableSummary(delivery.content),
          content:
            artifacts
              .map((a) => artifacts.length === 1 ? a.content : `### ${a.path}\n\n${a.content}`)
              .join("\n\n") || delivery.content,
          artifactIds: artifacts.map((a) => ({ id: a.id, name: a.path })),
          createdAt: Date.parse(delivery.createdAt),
          read:
            delivery.status === "delivered" &&
            (p.readDeliveries.includes(delivery.id) ||
              (!!node && p.readDeliveries.includes(node.id))),
          version: 1,
          hostDelivery: {
            status: delivery.status,
            superseded: !node && !!work && nodes.some(n =>
              n.kind === "delivery" && n.branchId === delivery.branchId &&
              Date.parse(n.createdAt) >= Date.parse(delivery.createdAt) &&
              state.works.find(w => w.id === n.source.workId)?.runId === work.runId),
            contextVersion: delivery.contextVersion,
            workId: delivery.workId,
            attemptId: delivery.attemptId,
            stale:
              delivery.contextVersion !==
                this.runtime.history.context(team.id, delivery.branchId)
                  .contextVersion ||
              work?.status !== "submitted" ||
              work.attemptId !== delivery.attemptId ||
              !!work.invalidatedByNodeId,
          },
        });
      }
      const candidates = workspace.deliveries.filter(d => d.teamId === team.id);
      workspace.deliveries = workspace.deliveries.filter(d => d.teamId !== team.id);
      const outcomes = new Map<string, typeof candidates[number]>();
      for (const delivery of candidates.sort((a,b) => a.createdAt - b.createdAt)) {
        if (!delivery.outcome) {
          workspace.updates!.push({ ...delivery, title: readableTitle(delivery.summary) });
          continue;
        }
        const identity = `${delivery.branchId}:${delivery.artifactIds?.length ? delivery.artifactIds.map(a => a.name).sort().join("|") : delivery.id}`;
        const prior = outcomes.get(identity);
        outcomes.set(identity, { ...delivery, version: (prior?.version ?? 0) + 1 });
      }
      workspace.deliveries.push(...outcomes.values());
      for (const member of state.members) {
        const works = state.works.filter((w) => w.memberId === member.id);
        const substantive = works.filter((w) => !w.interaction && w.kind !== "collaboration");
        const latestConversation = works.filter((w) => w.interaction || w.kind === "collaboration").at(-1);
        const work =
          works.filter((w) => active.has(w.status)).at(-1) ?? substantive.at(-1) ?? works.at(-1);
        const id = member.kind === "host" ? `host:${team.id}` : member.id;
        const latestAttempt = attempts
          .filter((a) => a.memberId === member.id)
          .at(-1);
        const nextExecution = member.kind === "member"
          ? this.runtime.catalog.memberExecution(team.id, member.branchId ?? this.runtime.history.ensure(team.id).id, member)
          : undefined;
        const displayedAttempt = member.kind === "host" || (latestAttempt && active.has(latestAttempt.status)) ? latestAttempt : undefined;
        const config = displayedAttempt?.config ?? nextExecution?.config ?? member.config;
        const status: Member["status"] = !work
          ? "idle"
          : work.status === "running"
            ? "working"
            : work.status === "queued" ||
                work.status === "waiting" ||
                work.status === "stopping" ||
                (member.kind === "host" &&
                  work.status === "submitted" &&
                  state.runs.find((r) => r.id === work.runId)?.state ===
                    "active")
              ? "waiting"
              : work.status === "interrupted"
                ? "paused"
                : ["failed", "rejected", "recovery_required"].includes(
                      work.status,
                    )
                  ? "error"
                  : ["accepted", "submitted", "self_checked"].includes(
                        work.status,
                      )
                    ? "complete"
                    : "idle";
        workspace.members.push({
          ...p.positions[id],
          id,
          removedAt: member.removedAt,
          teamId: team.id,
          name: member.kind === "host" ? "Host" : member.name,
          responsibility: member.responsibility,
          task:
            work?.collaborationExchangeId
              ? (this.runtime.store.get<TeamExchange>("exchanges", team.id, work.collaborationExchangeId).topic)
              : work?.interaction || work?.kind === "collaboration"
              ? (works
                  .filter((w) => !w.interaction && w.kind !== "collaboration")
                  .at(-1)?.title ?? member.responsibility)
              : work?.title === "Host follow-up"
                ? "Reviewing team results"
                : (work?.title ?? ""),
          status,
          conversationStatus: latestConversation && latestConversation !== work &&
            latestConversation.updatedAt > (work?.updatedAt ?? "")
            ? latestConversation.status === "interrupted" ? "paused"
              : ["failed", "rejected", "recovery_required"].includes(latestConversation.status) ? "error" : undefined
            : undefined,
          harness: harnessLabels[config.harness] ?? config.harness,
          model: String(
            displayedAttempt?.actual?.model ?? config.model ?? "Default model",
          ),
          effort: String(
            displayedAttempt?.actual?.requestedTurnEffort ??
              displayedAttempt?.actual?.threadEffort ??
              config.effort ??
              "Default",
          ),
          executionConfig: nextExecution?.config,
          configurationVersion: nextExecution?.allocationRevision,
          sessionId: latestAttempt?.sessionId ?? undefined,
          workId: work?.id,
          error: work?.error,
        });
      }
      const connections = new Map<string, Connection>();
      // Membership is a real Host relationship before the first assignment.
      // Exchanges stay empty until an assignment or message actually exists.
      for (const member of state.members.filter((m) => m.kind !== "host")) {
        const pair = [`host:${team.id}`, member.id].sort();
        const id = `relationship:${pair.join(":")}`;
        connections.set(id, {
          id,
          teamId: team.id,
          source: pair[0],
          target: pair[1],
          label: "Conversation",
          active: false,
          exchanges: [],
          activeDirections: [],
        });
      }
      for (const exchange of communicationExchanges(this.runtime, team.id)) {
        const pair = [exchange.source, exchange.target].sort();
        const id = `relationship:${pair.join(":")}`;
        const connection = connections.get(id) ?? {
          id,
          teamId: team.id,
          source: pair[0],
          target: pair[1],
          label: "Conversation",
          active: false,
          exchanges: [],
          activeDirections: [],
        };
        connection.exchanges!.push(exchange);
        if (exchange.active) {
          connection.active = true;
          if (
            !connection.activeDirections!.some(
              (d) =>
                d.source === exchange.source && d.target === exchange.target,
            )
          )
            connection.activeDirections!.push({
              source: exchange.source,
              target: exchange.target,
            });
        }
        connections.set(id, connection);
      }
      workspace.connections.push(...connections.values());
    }
    return workspace;
  }
}

export function productRoutes(runtime: TeamRuntime): Router {
  const router = Router();
  const product = new ProductStore(runtime);
  router.post(
    "/product/teams/:teamId/deliveries/:deliveryId/view",
    (req, res) => {
      const teamId = parse(key, req.params.teamId),
        deliveryId = parse(key, req.params.deliveryId);
      const input = parse(
        z
          .object({
            clientRequestId: z.string().uuid(),
            expectedContextVersion: key,
          })
          .strict(),
        req.body,
      );
      res.json(
        runtime.store.once(
          `product-delivery-view:${teamId}:${deliveryId}`,
          input.clientRequestId,
          input,
          () => {
            const delivery = runtime.communication.deliver(
              teamId,
              deliveryId,
              input.expectedContextVersion,
            );
            const revision = product.update((p) => {
              if (!p.readDeliveries.includes(deliveryId))
                p.readDeliveries.push(deliveryId);
            });
            return { delivery, revision };
          },
        ),
      );
    },
  );
  router.get(
    "/product/teams/:teamId/works/:workId/conversation",
    (req, res) => {
      const teamId = parse(key, req.params.teamId),
        workId = parse(key, req.params.workId);
      const work = runtime.store.get<Work>("works", teamId, workId);
      res.json(
        memberConversation(runtime, teamId, work.memberId, {
          workId,
          before:
            typeof req.query.before === "string" ? req.query.before : undefined,
          anchor:
            typeof req.query.anchor === "string" ? req.query.anchor : undefined,
        }),
      );
    },
  );
  router.post("/product/teams/:teamId/works/:workId/messages", (req, res) => {
    const teamId = parse(key, req.params.teamId),
      workId = parse(key, req.params.workId);
    const input = parse(
      z
        .object({
          clientRequestId: z.string().uuid(),
          content: z.string().trim().min(1).max(20000),
          mode: z.enum(["discuss", "revise"]),
          expectedRevision: z.number().int().positive(),
        })
        .strict(),
      req.body,
    );
    const work = runtime.store.get<Work>("works", teamId, workId);
    res.json(
      input.mode === "revise"
        ? runtime.continueWork(
            teamId,
            workId,
            input.content,
            input.clientRequestId,
            input.expectedRevision,
          )
        : runtime.store.once(
            `work-message:${teamId}:${workId}`,
            input.clientRequestId,
            input,
            () =>
              runtime.correspondence.send(
                teamId,
                "user",
                work.memberId,
                input.content,
                undefined,
                undefined,
                workId,
              ),
          ),
    );
  });
  router.get(
    "/product/teams/:teamId/insights/:insightId/sources",
    (req, res) => {
      const teamId = parse(key, req.params.teamId);
      const note = runtime.records
        .insights(teamId, undefined, true)
        .find((n) => n.id === parse(key, req.params.insightId));
      if (!note) throw notFound();
      res.json({
        sources: runtime.records.sources(
          teamId,
          note.sourceMessageIds,
          note.branchId,
        ),
        revisions: runtime.records
          .insights(teamId, note.branchId, true)
          .filter((n) => n.key === note.key),
      });
    },
  );
  router.post(
    "/product/teams/:teamId/branches/:branchId/insights",
    (req, res) => {
      const teamId = parse(key, req.params.teamId),
        branchId = parse(key, req.params.branchId);
      const input = parse(
        z
          .object({ clientRequestId: z.string().uuid(), insight: insightInput })
          .strict(),
        req.body,
      );
      res.json(
        runtime.store.once(
          `insight:${teamId}:${branchId}`,
          input.clientRequestId,
          input,
          () =>
            runtime.records.saveInsight(
              teamId,
              branchId,
              input.insight,
              "user",
            ),
        ),
      );
    },
  );
  router.post(
    "/product/teams/:teamId/branches/:branchId/outputs/restore",
    (req, res) => {
      const input = parse(
        z.object({ revisionId: key, expectedHeadId: key }).strict(),
        req.body,
      );
      res.json(
        runtime.records.restore(
          parse(key, req.params.teamId),
          parse(key, req.params.branchId),
          input.revisionId,
          input.expectedHeadId,
        ),
      );
    },
  );
  router.put("/product/teams/:teamId/members/:memberId/runtime", (req, res) => {
    const teamId = parse(key, req.params.teamId);
    const memberId = parse(key, req.params.memberId);
    const input = parse(z.object({
      expectedVersion: z.number().int().positive(),
      config: executionConfig,
    }).strict(), req.body);
    runtime.validateConfig(input.config);
    const member = runtime.store.activeMember(teamId, memberId);
    if (member.kind === "host")
      throw badRequest("host_configuration", "Change Host configuration through Team runtime settings.");
    const current = runtime.catalog.memberExecution(teamId, member.branchId ?? runtime.history.ensure(teamId).id, member);
    if (current.allocationRevision !== input.expectedVersion)
      throw conflict("version_conflict", "Member configuration changed. Try again.");
    if (input.config.access !== current.config.access)
      throw badRequest("access_change", "Keep the member's existing file access when changing its model.");
    // Attempts already running keep their frozen configuration and session.
    // A composer choice replaces only this member's default, never a shared resource.
    runtime.store.transaction(() => {
      member.config = input.config;
      delete member.selection;
      member.allocationVersion = current.allocationRevision + 1;
      runtime.store.save("members", member);
      runtime.store.event(teamId, "member.configuration", { memberId });
    });
    res.json({ config: member.config, version: member.allocationVersion });
  });
  router.get(
    "/product/teams/:teamId/members/:memberId/conversation",
    (req, res) => {
      res.json(
        memberConversation(
          runtime,
          parse(key, req.params.teamId),
          parse(key, req.params.memberId),
          {
            ...(typeof req.query.before === "string"
              ? { before: req.query.before }
              : {}),
            ...(typeof req.query.anchor === "string"
              ? { anchor: req.query.anchor }
              : {}),
          },
        ),
      );
    },
  );
  router.post(
    "/product/teams/:teamId/members/:memberId/messages",
    (req, res) => {
      const teamId = parse(key, req.params.teamId),
        memberId = parse(key, req.params.memberId);
      const input = parse(
        z
          .object({
            clientRequestId: z.string().uuid(),
            content: z.string().trim().min(1).max(100000),
          })
          .strict(),
        req.body,
      );
      const message = runtime.store.once(
        `member-input:${teamId}:${memberId}`,
        input.clientRequestId,
        input,
        () =>
          runtime.correspondence.send(teamId, "user", memberId, input.content),
      );
      res.json(message);
    },
  );
  const nativeSkills = async (teamId: string) => {
    const settings = runtime.store.settings(teamId);
    if (!settings) throw notFound();
    const harness = runtime.harnesses.get(settings.config.harness);
    if (!(harness instanceof CodexHarness)) return [];
    return (await harness.skills(settings.workspace))
      .map((skill) => {
        const bytes = readFileSync(skill.path);
        if (bytes.length > 100000) return null;
        return {
          id:
            "native-" +
            createHash("sha256").update(skill.path).update(bytes).digest("hex"),
          name: skill.name,
          description: skill.description,
          instructions: bytes.toString("utf8"),
          path: skill.path,
        };
      })
      .filter((s): s is NonNullable<typeof s> => !!s);
  };
  router.get("/product/teams/:teamId/tools", async (req, res) =>
    res.json({
      skills: (await nativeSkills(parse(key, req.params.teamId))).map(
        ({ instructions: _instructions, path: _path, ...skill }) => skill,
      ),
    }),
  );
  router.post("/product/harnesses/codex/login", async (_req, res) => {
    const harness = runtime.harnesses.get("codex");
    if (!(harness instanceof CodexHarness)) throw notFound();
    const result = await harness.login();
    const url = new URL(result.authUrl);
    if (
      url.protocol !== "https:" ||
      !["auth.openai.com", "auth0.openai.com"].includes(url.hostname)
    )
      throw badRequest(
        "login_url",
        "The sign-in address could not be verified.",
      );
    res.json({ loginId: result.loginId, url: result.authUrl });
  });
  router.post("/product/harnesses/codex/login/cancel", async (req, res) => {
    const input = parse(z.object({ loginId: key }).strict(), req.body);
    const harness = runtime.harnesses.get("codex");
    if (!(harness instanceof CodexHarness)) throw notFound();
    res.json(await harness.cancelLogin(input.loginId));
  });
  router.put("/product/teams/:teamId/credential", async (req, res) => {
    const teamId = parse(key, req.params.teamId);
    if (!runtime.store.teams.getTeam(teamId)) throw notFound();
    const input = parse(
      z.object({ secret: z.string().trim().min(8).max(16000) }).strict(),
      req.body,
    );
    const reference =
      "TEAMSWARM_KEY_" +
      createHash("sha256")
        .update(teamId)
        .digest("hex")
        .slice(0, 24)
        .toUpperCase() +
      "_" +
      randomUUID().replaceAll("-", "").toUpperCase();
    await saveProductCredential(
      runtime.store.teams.dataDir,
      reference,
      input.secret,
    );
    res.json({ reference });
  });
  router.get("/product", (req, res) => {
    res.setHeader("Cache-Control", "private, no-cache");
    const snapshot = product.snapshot();
    const tag = product.snapshotTag();
    res.setHeader("ETag", tag);
    if (req.headers["if-none-match"] === tag) { res.status(304).end(); return; }
    res.json(snapshot);
  });
  router.get("/product/conversations/:id/messages", (req, res) => {
    const input = parse(z.object({ before: z.string().min(1).max(200).optional() }).strict(), req.query);
    res.json(product.messagePage(req.params.id, input.before));
  });
  router.post("/product/import", (req, res) => {
    const input = parse(
      z
        .object({
          clientRequestId: key,
          workspace: z
            .object({
              version: z.literal(1),
              name: z.string().min(1).max(80),
              theme: z.enum(["light", "dark", "system"]),
              language: z.enum(["en", "zh-CN"]).default("en"),
              teams: z
                .array(
                  z
                    .object({ id: key, name: z.string().min(1).max(80) })
                    .passthrough(),
                )
                .max(1000),
              chats: z
                .array(
                  z
                    .object({
                      id: key,
                      teamId: key,
                      title: z.string().max(160),
                      createdAt: z.number(),
                      messages: z
                        .array(
                          z
                            .object({
                              id: key,
                              text: z.string().max(100000),
                              createdAt: z.number(),
                              role: z.enum(["user", "host"]).optional(),
                              files: z.array(fileInput),
                            })
                            .passthrough(),
                        )
                        .max(10000),
                    })
                    .passthrough(),
                )
                .max(10000),
              drafts: z.record(z.string(), draftInput),
              skills: z.array(skillInput),
              plugins: z.array(pluginInput).default([]),
              definitions: z.array(z.unknown()).default([]),
            })
            .passthrough(),
        })
        .strict(),
      req.body,
    );
    const result = runtime.store.once(
      "product-import",
      input.clientRequestId,
      input,
      () => {
        if (runtime.store.teams.listTeams().length)
          throw conflict(
            "import_destination",
            "This workspace already contains Teams. The original browser records have been preserved.",
          );
        const raw = input.workspace as unknown as Workspace;
        const created = new Date().toISOString();
        for (const team of raw.teams) {
          product.db
            .prepare(
              "INSERT INTO teams(id,name,purpose,created_at,updated_at) VALUES(?,?,'',?,?)",
            )
            .run(team.id, team.name, created, created);
          product.configureDefault(team.id);
        }
        for (const chat of raw.chats) {
          if (!raw.teams.some((t) => t.id === chat.teamId))
            throw badRequest(
              "import_scope",
              "A conversation has no matching Team.",
            );
          const at = new Date(chat.createdAt).toISOString();
          product.db
            .prepare(
              "INSERT INTO conversations(id,team_id,title,created_at,updated_at) VALUES(?,?,?,?,?)",
            )
            .run(chat.id, chat.teamId, chat.title || "Host", at, at);
          for (const message of chat.messages) {
            product.db
              .prepare(
                "INSERT INTO messages(id,conversation_id,role,content,created_at,delivery) VALUES(?,?,?,?,?,'recorded')",
              )
              .run(
                `${chat.id}:${message.id}`,
                chat.id,
                message.role === "host" ? "assistant" : "user",
                message.text,
                new Date(message.createdAt).toISOString(),
              );
            product.db
              .prepare("INSERT INTO product_message_details VALUES(?,?)")
              .run(
                `${chat.id}:${message.id}`,
                JSON.stringify({
                  files: message.files,
                  skill: message.skill,
                  references: message.references,
                  legacyId: message.id,
                }),
              );
          }
          runtime.history.importConversation(
            chat.teamId,
            chat.id,
            chat.parent ? chat.title : null,
            chat.inheritedDefinitions ?? [],
          );
        }
        product.update((p) => {
          p.name = raw.name;
          p.theme = raw.theme;
          p.language = raw.language;
          p.drafts = raw.drafts;
          p.skills = raw.skills;
          p.plugins = raw.plugins;
          for (const t of raw.teams)
            p.teams[t.id] = {
              color: t.color,
              lastChatId: t.lastChatId,
              canvasViewports: t.canvasViewports,
              hostPosition: t.hostPosition,
            };
          for (const c of raw.chats)
            p.chats[c.id] = {
              starred: c.starred,
              archived: c.archived,
              parent: c.parent,
              inheritedDefinitions: c.inheritedDefinitions,
            };
          p.legacyDefinitions = raw.definitions ?? [];
        });
        product.db
          .prepare("INSERT INTO product_imports VALUES(?,?,?)")
          .run(input.clientRequestId, JSON.stringify(raw), created);
        return { imported: true };
      },
    );
    res.json(result);
  });
  router.post("/product/teams", (req, res) => {
    const input = parse(
      z
        .object({
          clientRequestId: key,
          name: z.string().trim().min(1).max(80),
        })
        .strict(),
      req.body,
    );
    const result = runtime.store.once(
      "product-team",
      input.clientRequestId,
      input,
      () => {
        const team = runtime.store.teams.createTeam(input.name, "");
        product.configureDefault(team.id);
        return team;
      },
    );
    res.status(201).json(result);
  });
  router.post("/product/conversations", (req, res) => {
    const input = parse(
      z
        .object({
          clientRequestId: key,
          teamId: key,
          title: z.string().trim().min(1).max(160),
        })
        .strict(),
      req.body,
    );
    const result = runtime.store.once(
      `product-conversation:${input.teamId}`,
      input.clientRequestId,
      input,
      () => {
        const c = runtime.store.teams.createConversation(
          input.teamId,
          input.title,
          null,
        );
        if (!c) throw notFound();
        runtime.history.forConversation(input.teamId, c.id);
        return c;
      },
    );
    res.status(201).json(result);
  });
  router.patch("/product/preferences", (req, res) => {
    const input = parse(
      z
        .object({
          name: z.string().trim().min(1).max(80).optional(),
          theme: z.enum(["light", "dark", "system"]).optional(),
          language: z.enum(["en", "zh-CN"]).optional(),
          drafts: z
            .record(z.string().max(200), draftInput.nullable())
            .optional(),
          skills: z.array(skillInput).max(500).optional(),
          plugins: z.array(pluginInput).max(100).optional(),
          teams: z
            .record(
              z.string().max(200),
              z
                .object({
                  lastChatId: key.nullable().optional(),
                  color: z
                    .string()
                    .regex(/^#[0-9a-fA-F]{6}$/)
                    .optional(),
                  canvasViewports: z
                    .record(
                      z.string().max(40),
                      z.object({
                        x: z.number().finite(),
                        y: z.number().finite(),
                        zoom: z.number().positive().max(10),
                      }),
                    )
                    .optional(),
                  hostPosition: z
                    .object({ x: z.number().finite(), y: z.number().finite() })
                    .optional(),
                  historyPositions: z.record(z.string().max(200), z.object({ x: z.number().finite(), y: z.number().finite() })).optional(),
                })
                .strict(),
            )
            .optional(),
          chats: z
            .record(
              z.string().max(200),
              z
                .object({
                  title: z.string().trim().min(1).max(160).optional(),
                  starred: z.boolean().optional(),
                  archived: z.boolean().optional(),
                })
                .strict(),
            )
            .optional(),
          positions: z
            .record(
              z.string().max(200),
              z.object({ x: z.number().finite(), y: z.number().finite() }),
            )
            .optional(),
          readDeliveries: z.array(key).max(10000).optional(),
        })
        .strict(),
      req.body,
    );
    const revision = product.update((p) => {
      for (const field of [
        "name",
        "theme",
        "language",
        "skills",
        "plugins",
        "readDeliveries",
      ] as const)
        if (input[field] !== undefined)
          Object.assign(p, { [field]: input[field] });
      for (const [id, d] of Object.entries(input.drafts ?? {})) {
        if (d === null) delete p.drafts[id];
        else p.drafts[id] = d;
      }
      for (const [id, values] of Object.entries(input.teams ?? {})) {
        if (!runtime.store.teams.getTeam(id)) throw notFound();
        p.teams[id] = {
          ...p.teams[id],
          ...values,
          lastChatId:
            values.lastChatId === null
              ? undefined
              : (values.lastChatId ?? p.teams[id]?.lastChatId),
        };
      }
      for (const [id, values] of Object.entries(input.chats ?? {})) {
        const row = product.db
          .prepare("SELECT id FROM conversations WHERE id=?")
          .get(id);
        if (!row) throw notFound();
        if (values.title)
          product.db
            .prepare("UPDATE conversations SET title=?,updated_at=? WHERE id=?")
            .run(values.title, new Date().toISOString(), id);
        p.chats[id] = { ...p.chats[id], ...values };
      }
      Object.assign(p.positions, input.positions ?? {});
    });
    res.json({ revision });
  });
  router.put(
    "/product/files/:id",
    express.raw({ type: "application/octet-stream", limit: "25mb" }),
    (req, res) => {
      const file = parse(fileInput, {
        id: req.params.id,
        name: decodeURIComponent(String(req.headers["x-file-name"] ?? "")),
        type: String(req.headers["x-file-type"] ?? ""),
        size: Number(req.headers["x-file-size"]),
      });
      if (!Buffer.isBuffer(req.body))
        throw badRequest("file_body", "Select a file to upload.");
      res.json(product.upload(file, req.body));
    },
  );
  router.get("/product/files/:id", (req, res) => {
    const id = parse(z.string().uuid(), req.params.id);
    const file = product.file(id);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
    );
    res
      .type("application/octet-stream")
      .sendFile(id, {
        root: path.resolve(product.fileDirectory),
        dotfiles: "deny",
      });
  });
  router.get(
    "/product/teams/:teamId/artifacts/:artifactId/download",
    (req, res) => {
      const artifact = runtime.store.get<ArtifactVersion>(
        "artifacts",
        parse(key, req.params.teamId),
        parse(key, req.params.artifactId),
      );
      res.setHeader(
        "Content-Disposition",
        `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(artifact.path))}`,
      );
      res
        .type("application/octet-stream")
        .send(Buffer.from(artifact.content, "utf8"));
    },
  );
  router.post("/product/messages", async (req, res) => {
    const input = parse(
      z
        .object({
          clientRequestId: key,
          teamId: key,
          conversationId: key,
          content: z.string().max(20000),
          files: z.array(fileInput).max(30).default([]),
          skillId: key.optional(),
          references: z.array(referenceInput).max(50).default([]),
        })
        .strict(),
      req.body,
    );
    if (!input.content.trim() && !input.files.length)
      throw badRequest("empty_message", "Write a message or attach a file.");
    const settings = runtime.store.settings(input.teamId);
    if (!settings)
      throw badRequest(
        "runtime_required",
        "Choose an execution environment for this Team.",
      );
    const conversation = runtime.store.teams.getConversationDetail(
      input.teamId,
      input.conversationId,
    );
    if (!conversation) throw notFound();
    const recorded = product.db
      .prepare("SELECT 1 FROM runtime_receipts WHERE scope=? AND request_id=?")
      .get(`product-message:${input.teamId}`, input.clientRequestId);
    const catalog =
      !recorded && input.references.some((r) => r.kind === "native-skill")
        ? await nativeSkills(input.teamId)
        : [];
    const explicitNative = (recorded ? [] : input.references)
      .filter((r) => r.kind === "native-skill")
      .map((ref) => {
        const skill = catalog.find((s) => s.id === ref.id);
        if (!skill)
          throw conflict(
            "skill_changed",
            "A selected skill changed. Select its current version before sending.",
          );
        return skill;
      });
    const receipt = runtime.store.once(
      `product-message:${input.teamId}`,
      input.clientRequestId,
      input,
      () => {
        const branch = runtime.history.forConversation(
          input.teamId,
          input.conversationId,
        );
        const attachmentPaths = input.files.map((f) => {
          const stored = product.file(f.id);
          if (
            stored.name !== f.name ||
            stored.size !== f.size ||
            stored.type !== f.type
          )
            throw badRequest(
              "file_mismatch",
              "The attachment changed. Upload it again.",
            );
          const destination = stageAttachment(
            branch.workspace ?? settings.workspace,
            f.id,
            f.name,
            readFileSync(path.join(product.fileDirectory, f.id)),
          );
          return { name: f.name, path: destination };
        });
        const result = runtime.store.teams.recordMessage(
          input.teamId,
          input.conversationId,
          input.content,
          input.clientRequestId,
          (message) => {
            const p = product.read().preferences;
            const skill = p.skills.find(
              (s) => s.id === input.skillId && s.teamId === input.teamId,
            );
            const selectedSkills = input.references
              .filter((r) => r.kind === "skill")
              .map((r) =>
                p.skills.find(
                  (s) => s.id === r.id && s.teamId === input.teamId,
                ),
              )
              .filter(Boolean);
            const selectedCommands = input.references
              .filter((r) => r.kind === "plugin")
              .map((r) => p.plugins.find((s) => s.id === r.id))
              .filter(Boolean);
            product.db
              .prepare("INSERT INTO product_message_details VALUES(?,?)")
              .run(
                message.id,
                JSON.stringify({
                  files: input.files,
                  references: input.references,
                  skill: skill?.name,
                  executionInput: {
                    attachments: attachmentPaths,
                    instructions: [skill, ...selectedSkills, ...explicitNative]
                      .filter(Boolean)
                      .map((s) => ({
                        name: s!.name,
                        instructions: s!.instructions,
                      })),
                    commands: selectedCommands.map((c) => ({
                      name: c!.name,
                      instructions: c!.description,
                    })),
                  },
                }),
              );
            runtime.store.enqueueHost(
              input.teamId,
              input.conversationId,
              message.id,
              true,
              false,
            );
          },
        );
        if (!result) throw notFound();
        const work = runtime.store.enqueueHost(
          input.teamId,
          input.conversationId,
          result.message.id,
          true,
          false,
        );
        return { message: result.message, workId: work.id };
      },
    );
    runtime.enqueue(input.teamId, input.conversationId, receipt.message.id);
    res.json(receipt);
  });
  router.post("/product/teams/:teamId/definitions", (req, res) => {
    const teamId = parse(key, req.params.teamId);
    const input = parse(
      z
        .object({
          clientRequestId: key,
          conversationId: key,
          messageId: key,
          definition: definitionInput,
        })
        .strict(),
      req.body,
    );
    const conversation = runtime.store.teams.getConversationDetail(
      teamId,
      input.conversationId,
    );
    if (!conversation?.messages.some((m) => m.id === input.messageId))
      throw notFound();
    const branch = runtime.history.forConversation(
      teamId,
      input.conversationId,
    );
    res.json(
      runtime.store.once(
        `product-definition:${teamId}`,
        input.clientRequestId,
        input,
        () =>
          runtime.history.publish(teamId, branch.id, input.definition, {
            actor: "user",
            conversationId: input.conversationId,
            messageIds: [input.messageId],
          }),
      ),
    );
  });
  router.put("/product/teams/:teamId/runtime", (req, res) => {
    const teamId = parse(key, req.params.teamId);
    const current = runtime.store.settings(teamId);
    if (!current) throw notFound();
    const input = parse(
      z
        .object({
          expectedVersion: z.number().int().min(0),
          workspace: z.string().trim().min(1).max(4096).optional(),
          config: executionConfig,
          maxConcurrent: z.number().int().min(1).max(8).optional(),
        })
        .strict(),
      req.body,
    );
    runtime.validateConfig(input.config);
    const workspace = input.workspace ?? current.workspace;
    if (!path.isAbsolute(workspace) || !existsSync(workspace))
      throw badRequest(
        "workspace_missing",
        "Choose an existing absolute folder.",
      );
    const { version: _version, teamId: _teamId, ...settings } = current;
    res.json(
      runtime.store.configure(
        teamId,
        {
          ...settings,
          workspace,
          config: input.config,
          maxConcurrent: input.maxConcurrent ?? current.maxConcurrent,
        },
        input.expectedVersion,
      ),
    );
  });
  return router;
}
