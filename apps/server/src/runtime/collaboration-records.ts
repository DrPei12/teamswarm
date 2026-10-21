import { randomUUID } from "node:crypto";
import {
  realpathSync,
  renameSync,
  writeFileSync,
  existsSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
import { z } from "zod";
import { badRequest, conflict, notFound } from "../errors.js";
import { RuntimeStore, activeStates, hash, overlaps } from "./store.js";
import type {
  ArtifactVersion,
  Member,
  ProjectInsight,
  ProjectOutput,
  ProjectOutputRevision,
  Run,
  TeamExchange,
  TeamExchangeMessage,
  Work,
} from "./types.js";

const key = z.string().trim().min(1).max(200);
export const insightInput = z
  .object({
    key,
    expectedRevision: z.number().int().min(0),
    kind: z.enum(["idea", "decision"]),
    status: z.enum(["proposed", "adopted", "rejected", "superseded"]),
    title: z.string().trim().min(1).max(160),
    content: z.string().trim().min(1).max(12000),
    reason: z.string().trim().min(1).max(2000),
    sourceMessageIds: z.array(key).min(1).max(20),
  })
  .strict();

export const threadOf = (work: Work) => work.threadId ?? work.id;
export const deliverable = (work: Work) =>
  work.status === "accepted" ||
  (work.status === "self_checked" && work.verification === "self-check");

/** Platform-owned records survive native session changes. Bodies and provenance stay separate. */
export class CollaborationRecords {
  constructor(readonly store: RuntimeStore) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS project_outputs (
      id TEXT PRIMARY KEY, team_id TEXT NOT NULL REFERENCES teams(id), data TEXT NOT NULL CHECK(json_valid(data)));
      CREATE INDEX IF NOT EXISTS outputs_team ON project_outputs(team_id);
      CREATE TABLE IF NOT EXISTS project_insights (
      id TEXT PRIMARY KEY, team_id TEXT NOT NULL REFERENCES teams(id), data TEXT NOT NULL CHECK(json_valid(data)));
      CREATE INDEX IF NOT EXISTS insights_team ON project_insights(team_id);
      CREATE TABLE IF NOT EXISTS project_restore_intents (id TEXT PRIMARY KEY, data TEXT NOT NULL);`);
    this.recoverRestorations();
  }
  private rows<T>(table: "outputs" | "insights", teamId: string): T[] {
    return this.store.db
      .prepare(
        `SELECT data FROM project_${table} WHERE team_id=? ORDER BY rowid`,
      )
      .all(teamId)
      .map((r) => JSON.parse(String(r.data)) as T);
  }
  private insert(
    table: "outputs" | "insights",
    row: { id: string; teamId: string },
  ) {
    this.store.db
      .prepare(`INSERT INTO project_${table} VALUES(?,?,?)`)
      .run(row.id, row.teamId, JSON.stringify(row));
  }
  outputs(teamId: string, branchId?: string): ProjectOutput[] {
    const groups = new Map<string, ProjectOutputRevision[]>();
    for (const row of this.rows<ProjectOutputRevision>("outputs", teamId)) {
      if (branchId && row.branchId !== branchId) continue;
      const key = `${row.branchId}:${row.path}`;
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    return [...groups.values()].map((revisions) => {
      const current = revisions.at(-1)!;
      const work = this.store.get<Work>("works", teamId, current.workId);
      return {
        path: revisions[0].path,
        branchId: revisions[0].branchId,
        current,
        revisions,
        verification: work.verification,
        workStatus: work.status,
      };
    });
  }
  bindOutputs(work: Work) {
    if (work.outputHeads) return;
    const branch = this.store.history!.forRun(
      this.store.get<Run>("runs", work.teamId, work.runId),
    );
    work.outputHeads = Object.fromEntries(
      this.outputs(work.teamId, branch.id).map((o) => [o.path, o.current.id]),
    );
    this.store.save("works", work);
  }
  publishOutputs(work: Work) {
    // Accepted isolated work is an input, not the shared project's current file.
    if (!deliverable(work) || work.workspaceMode === "isolated") return;
    this.store.transaction(() => {
      const branch = this.store.history!.forRun(
        this.store.get<Run>("runs", work.teamId, work.runId),
      );
      const published = this.rows<ProjectOutputRevision>(
        "outputs",
        work.teamId,
      );
      // A later continuation may have changed the working file. An already
      // published immutable version must not be revalidated against those bytes.
      if (
        work.artifactIds.every((id) => {
          const artifact = this.store.get<ArtifactVersion>(
            "artifacts",
            work.teamId,
            id,
          );
          return (
            artifact.path === "@result" ||
            published.some(
              (revision) =>
                revision.branchId === branch.id &&
                revision.workId === work.id &&
                revision.artifactId === id,
            )
          );
        })
      )
        return;
      for (const artifact of this.store
        .verifyArtifacts(work)
        .filter((a) => a.path !== "@result")) {
        const name = artifact.path.replaceAll("\\", "/");
        const current = this.outputs(work.teamId, branch.id).find(
          (o) => o.path === name,
        )?.current;
        if (current?.artifactId === artifact.id) continue;
        if ((work.outputHeads?.[name] ?? null) !== (current?.id ?? null))
          throw conflict(
            "output_conflict",
            `The current result for ${name} changed. Continue from its current version before publishing.`,
          );
        const revision: ProjectOutputRevision = {
          id: randomUUID(),
          teamId: work.teamId,
          branchId: branch.id,
          path: name,
          artifactId: artifact.id,
          workId: work.id,
          parentId: current?.id ?? null,
          createdAt: new Date().toISOString(),
        };
        this.insert("outputs", revision);
        this.store.event(
          work.teamId,
          "output.published",
          { path: name, revisionId: revision.id, artifactId: artifact.id },
          work,
        );
      }
    });
  }
  restore(
    teamId: string,
    branchId: string,
    revisionId: string,
    expectedHeadId: string,
  ) {
    this.store.history!.branch(teamId, branchId);
    const output = this.outputs(teamId, branchId).find((o) =>
      o.revisions.some((r) => r.id === revisionId),
    );
    if (!output) throw notFound();
    if (
      output.current.restoredFrom === revisionId &&
      output.current.parentId === expectedHeadId
    )
      return output.current;
    if (output.current.id !== expectedHeadId)
      throw conflict(
        "output_conflict",
        "The result changed. Reload before restoring.",
      );
    const branch = this.store.history!.branch(teamId, branchId);
    const workspace = this.store.history!.workspace(branch);
    if (
      this.store.teams
        .listTeams()
        .some((t) =>
          this.store
            .list<Work>("works", t.id)
            .some(
              (w) =>
                (activeStates.has(w.status) ||
                  ["queued", "waiting"].includes(w.status)) &&
                !w.interaction &&
                this.store.get<Member>("members", t.id, w.memberId).config
                  .access === "workspace-write" &&
                overlaps(
                  this.store.get<Run>("runs", t.id, w.runId).settings.workspace,
                  workspace,
                ),
            ),
        )
    )
      throw conflict(
        "workspace_busy",
        "Finish or stop writable work before restoring a result.",
      );
    const old = this.store.get<ArtifactVersion>(
      "artifacts",
      teamId,
      output.current.artifactId,
    );
    const bytes = this.store.readWorkspaceFile(workspace, output.path);
    if (hash(bytes) !== old.sha256)
      throw conflict(
        "file_changed",
        "This file has local changes. Keep or submit them before restoring.",
      );
    const source = output.revisions.find((r) => r.id === revisionId)!;
    const artifact = this.store.get<ArtifactVersion>(
      "artifacts",
      teamId,
      source.artifactId,
    );
    const revision: ProjectOutputRevision = {
      ...source,
      id: randomUUID(),
      parentId: output.current.id,
      restoredFrom: source.id,
      createdAt: new Date().toISOString(),
    };
    const intent = {
      revision,
      workspace,
      previousHash: hash(bytes),
      content: artifact.content,
    };
    // The durable intent closes the filesystem/SQLite crash window. Recovery compares exact bytes.
    this.store.db
      .prepare("INSERT INTO project_restore_intents VALUES(?,?)")
      .run(revision.id, JSON.stringify(intent));
    this.finishRestore(intent);
    return revision;
  }
  private finishRestore(intent: {
    revision: ProjectOutputRevision;
    workspace: string;
    previousHash: string;
    content: string;
  }) {
    const { revision, workspace, previousHash, content } = intent;
    const current = this.outputs(revision.teamId, revision.branchId).find(
      (o) => o.path === revision.path,
    )?.current;
    if (current?.id === revision.id) {
      this.store.db
        .prepare("DELETE FROM project_restore_intents WHERE id=?")
        .run(revision.id);
      return;
    }
    if (current?.id !== revision.parentId)
      throw conflict(
        "output_conflict",
        "Restore recovery found a newer result.",
      );
    const bytes = this.store.readWorkspaceFile(workspace, revision.path);
    if (hash(bytes) !== hash(content)) {
      if (hash(bytes) !== previousHash)
        throw conflict(
          "file_changed",
          "Restore recovery found local edits; the saved intent needs reconciliation.",
        );
      const target = realpathSync(path.resolve(workspace, revision.path));
      const temporary = `${target}.teamswarm-${revision.id}.tmp`;
      try {
        writeFileSync(temporary, content, { flag: "wx" });
        renameSync(temporary, target);
      } finally {
        if (existsSync(temporary)) unlinkSync(temporary);
      }
    }
    this.store.transaction(() => {
      this.insert("outputs", revision);
      this.store.event(revision.teamId, "output.restored", {
        revisionId: revision.id,
        restoredFrom: revision.restoredFrom,
        path: revision.path,
      });
      this.store.db
        .prepare("DELETE FROM project_restore_intents WHERE id=?")
        .run(revision.id);
    });
  }
  private recoverRestorations() {
    for (const row of this.store.db
      .prepare("SELECT data FROM project_restore_intents")
      .all()) {
      const intent = JSON.parse(String(row.data));
      try {
        this.finishRestore(intent);
      } catch (error) {
        this.store.event(intent.revision.teamId, "output.restore_blocked", {
          revisionId: intent.revision.id,
          reason: (error as Error).message,
        });
      }
    }
  }
  insights(
    teamId: string,
    branchId?: string,
    history = false,
  ): ProjectInsight[] {
    const rows = this.rows<ProjectInsight>("insights", teamId).filter(
      (n) => !branchId || n.branchId === branchId,
    );
    return history
      ? rows
      : [...new Map(rows.map((n) => [`${n.branchId}:${n.key}`, n])).values()];
  }
  saveInsight(
    teamId: string,
    branchId: string,
    input: z.infer<typeof insightInput>,
    author: ProjectInsight["author"],
    sourceWorkId?: string,
  ) {
    return this.store.transaction(() => {
      this.store.history!.branch(teamId, branchId);
      const previous = this.insights(teamId, branchId).find(
        (n) => n.key === input.key,
      );
      if ((previous?.revision ?? 0) !== input.expectedRevision)
        throw conflict(
          "insight_conflict",
          "This idea or decision changed. Read the current version first.",
        );
      if (author === "member" && input.status !== "proposed")
        throw conflict(
          "host_required",
          "Members may preserve proposals; Host or the user decides their status.",
        );
      const sourceMessageIds = [
        ...new Set([
          ...(previous?.sourceMessageIds ?? []),
          ...input.sourceMessageIds,
        ]),
      ];
      for (const id of sourceMessageIds) {
        if (!resolveProjectSource(this.store, teamId, id, branchId))
          throw badRequest(
            "invalid_source",
            "The source message does not exist in this project branch.",
          );
      }
      const { expectedRevision: _, ...fields } = input;
      const note: ProjectInsight = {
        ...fields,
        id: randomUUID(),
        teamId,
        branchId,
        revision: (previous?.revision ?? 0) + 1,
        sourceMessageIds,
        sourceWorkId,
        author,
        createdAt: new Date().toISOString(),
      };
      this.insert("insights", note);
      this.store.event(teamId, "insight.saved", {
        insightId: note.id,
        key: note.key,
        revision: note.revision,
        status: note.status,
      });
      return note;
    });
  }
  sources(teamId: string, ids: string[], branchId?: string) {
    return ids.map((id) => {
      const source = resolveProjectSource(this.store, teamId, id, branchId);
      if (!source) throw notFound();
      return source;
    });
  }
}

export function resolveProjectSource(
  store: RuntimeStore,
  teamId: string,
  id: string,
  branchId?: string,
) {
  const row = store.db
    .prepare(
      "SELECT m.conversation_id,m.content,m.role FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE m.id=? AND c.team_id=?",
    )
    .get(id, teamId);
  if (row) {
    const branch = store.history!.forConversation(
      teamId,
      String(row.conversation_id),
    );
    if (branchId && branch.id !== branchId) return;
    return {
      id,
      branchId: branch.id,
      conversationId: String(row.conversation_id),
      content: String(row.content),
      author: String(row.role),
    };
  }
  const mail = store.db
    .prepare("SELECT data FROM runtime_correspondence WHERE id=? AND team_id=?")
    .get(id, teamId);
  if (mail) {
    const m = JSON.parse(String(mail.data));
    if (branchId && m.branchId !== branchId) return;
    const memberId = m.senderId === "user" ? m.recipientId : m.senderId;
    const member = store
      .list<Member>("members", teamId)
      .find((item) => item.id === memberId);
    return {
      id,
      branchId: m.branchId as string,
      content: m.content as string,
      author: m.senderId as string,
      senderId: m.senderId as string,
      memberId:
        member?.kind === "host" ? `host:${teamId}` : (memberId as string),
      workId: (m.sourceWorkId ?? m.targetWorkId ?? m.workId) as
        string | undefined,
      threadId: m.threadId as string | undefined,
    };
  }
  const exchanged = store.db
    .prepare(
      "SELECT m.data AS message,e.data AS exchange FROM runtime_exchange_messages m JOIN runtime_exchanges e ON e.id=json_extract(m.data,'$.exchangeId') AND e.team_id=m.team_id WHERE m.id=? AND m.team_id=?",
    )
    .get(id, teamId);
  if (!exchanged) return;
  const message = JSON.parse(String(exchanged.message)) as TeamExchangeMessage;
  const exchange = JSON.parse(String(exchanged.exchange)) as TeamExchange;
  if (branchId && exchange.branchId !== branchId) return;
  const work = store.get<Work>("works", teamId, message.workId);
  const run = store.get<Run>("runs", teamId, work.runId);
  if (
    store.history!.forRun(run).id !== exchange.branchId ||
    work.memberId !== message.senderId ||
    ![exchange.initiatorId, exchange.recipientId].includes(message.senderId)
  )
    return;
  const member = store.get<Member>("members", teamId, message.senderId);
  return {
    id,
    branchId: exchange.branchId,
    content: message.content,
    author: member.name,
    senderId: message.senderId,
    memberId: member.kind === "host" ? `host:${teamId}` : member.id,
    workId: message.workId,
    threadId: threadOf(work),
    exchangeId: message.exchangeId,
  };
}
