import { randomUUID } from "node:crypto";
import path from "node:path";
import { mkdirSync } from "node:fs";
import { z } from "zod";
import { badRequest, conflict, notFound, ServiceError } from "../errors.js";
import { activeStates, hash, overlaps, type RuntimeStore } from "./store.js";
import { ProjectSnapshots } from "./project-snapshots.js";
import type {
  Attempt,
  Member,
  ProjectBranch,
  ProjectContext,
  ProjectDocument,
  ProjectNode,
  Run,
  Work,
  TeamExchange,
  TeamExchangeMessage,
} from "./types.js";

const id = z.string().min(1).max(200);
export const documentInput = z
  .object({
    key: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_/-]{0,119}$/),
    kind: z.enum(["goal", "requirement", "understanding", "design"]),
    title: z.string().trim().min(1).max(160),
    content: z.string().trim().min(1).max(40000),
    dependencies: z
      .array(id)
      .max(30)
      .default([])
      .describe(
        "Exact document revision IDs, or key:<stable-key> to reference the final revision of a document in this atomic update. Stored dependencies always resolve to exact revisions.",
      ),
  })
  .strict();
export const definitionInput = z
  .object({
    expectedHeadId: id,
    documents: z.array(documentInput).max(30),
    removeKeys: z.array(z.string().max(120)).max(30).default([]),
    title: z.string().trim().min(1).max(160),
    reason: z.string().trim().max(2000).default(""),
    affectedWorkIds: z
      .array(id)
      .max(100)
      .default([])
      .describe(
        "These responsibilities are stopped and superseded and require explicit replacement delegation. Use [] for work that should continue under the updated context; notify its members separately.",
      ),
    exchangeMessageIds: z
      .array(id)
      .max(30)
      .default([])
      .describe(
        "Only actual A2A message IDs returned by team_read_exchange. Use [] for user/Host discussion: its conversation source is recorded automatically. Never put conversation message IDs or exchange IDs here.",
      ),
  })
  .strict()
  .refine(
    (v) => v.documents.length + v.removeKeys.length > 0,
    "No document changes provided.",
  );
export const selectionInput = z
  .object({ revisionId: id, replaceRevisionId: id.nullable().default(null) })
  .strict();
type DefinitionInput = z.infer<typeof definitionInput>;
type Selection = z.infer<typeof selectionInput>;
type Source = ProjectNode["source"];
type Table = "branches" | "nodes" | "documents";
const now = () => new Date().toISOString();
const version = (documents: Record<string, string>) =>
  hash(
    JSON.stringify(
      Object.entries(documents).sort(([a], [b]) => a.localeCompare(b)),
    ),
  );

export function cleanDefinition(content: string) {
  // Narrow structural checks, not a ban on domain words such as "old password".
  if (
    /^\s*(?:#{1,6}\s*)?(?:变更记录|修订历史|更新日志|本次更新|版本演变|changelog|revision history)\s*[:：]?\s*$/im.test(
      content,
    ) ||
    /[（(]\s*从[^\n()（）]{1,60}(?:更新|升级|修改|修订)(?:过来|而来|到|为)[^\n()（）]{0,60}[）)]/.test(
      content,
    ) ||
    /^\s*(?:本文档|本方案|本版本)(?:是|为)?(?:最新|旧版|从.+更新)/m.test(
      content,
    ) ||
    /^\s*(?:我(?:们)?(?:已经|已|刚刚|先)(?:阅读|读取|检查|核对|更新|整理)|I (?:have (?:read|reviewed|updated)|will (?:read|review|update))\b)/im.test(content)
  )
    throw badRequest(
      "document_contains_history",
      "State project facts directly. Keep revision explanations in source metadata and the history node reason.",
    );
}

/** One immutable project history; each branch exposes a clean, versioned definition. */
export class ProjectHistory {
  readonly snapshots: ProjectSnapshots;
  constructor(readonly store: RuntimeStore) {
    this.snapshots = new ProjectSnapshots(store.teams.dataDir);
    store.transaction(() => {
      for (const table of ["branches", "nodes", "documents"] as const)
        store.db.exec(`
        CREATE TABLE IF NOT EXISTS project_${table} (id TEXT PRIMARY KEY, team_id TEXT NOT NULL REFERENCES teams(id), data TEXT NOT NULL CHECK(json_valid(data)));
        CREATE INDEX IF NOT EXISTS project_${table}_team ON project_${table}(team_id);`);
      store.db.exec(`
        CREATE TABLE IF NOT EXISTS project_conversations (conversation_id TEXT PRIMARY KEY REFERENCES conversations(id), team_id TEXT NOT NULL REFERENCES teams(id), branch_id TEXT NOT NULL REFERENCES project_branches(id));
        CREATE TABLE IF NOT EXISTS project_main_conversations (team_id TEXT PRIMARY KEY REFERENCES teams(id), conversation_id TEXT NOT NULL REFERENCES conversations(id));
        CREATE TABLE IF NOT EXISTS project_context_receipts (attempt_id TEXT NOT NULL, node_id TEXT NOT NULL, team_id TEXT NOT NULL, version TEXT NOT NULL, delivered_at TEXT, read_at TEXT, acknowledged_at TEXT, PRIMARY KEY(attempt_id, node_id));
        CREATE UNIQUE INDEX IF NOT EXISTS project_main_branch ON project_branches(team_id) WHERE json_extract(data, '$.baseNodeId') IS NULL;
        CREATE TRIGGER IF NOT EXISTS project_nodes_immutable BEFORE UPDATE ON project_nodes BEGIN SELECT RAISE(ABORT, 'History nodes are immutable'); END;
        CREATE TRIGGER IF NOT EXISTS project_documents_immutable BEFORE UPDATE ON project_documents BEGIN SELECT RAISE(ABORT, 'Document revisions are immutable'); END;
        CREATE TRIGGER IF NOT EXISTS project_nodes_no_delete BEFORE DELETE ON project_nodes BEGIN SELECT RAISE(ABORT, 'History nodes are immutable'); END;
        CREATE TRIGGER IF NOT EXISTS project_documents_no_delete BEFORE DELETE ON project_documents BEGIN SELECT RAISE(ABORT, 'Document revisions are immutable'); END;
        INSERT OR IGNORE INTO runtime_migrations VALUES (2, datetime('now'));`);
    });
  }
  private insert(
    table: Table,
    value: ProjectBranch | ProjectNode | ProjectDocument,
  ) {
    this.store.db
      .prepare(`INSERT INTO project_${table}(id,team_id,data) VALUES (?,?,?)`)
      .run(value.id, value.teamId, JSON.stringify(value));
  }
  private get<T>(table: Table, teamId: string, key: string): T {
    const row = this.store.db
      .prepare(`SELECT data FROM project_${table} WHERE team_id=? AND id=?`)
      .get(teamId, key);
    if (!row) throw notFound();
    return JSON.parse(String(row.data));
  }
  private list<T>(table: Table, teamId: string): T[] {
    return this.store.db
      .prepare(
        `SELECT data FROM project_${table} WHERE team_id=? ORDER BY rowid`,
      )
      .all(teamId)
      .map((r) => JSON.parse(String(r.data)));
  }
  branches(teamId: string): ProjectBranch[] {
    this.ensure(teamId);
    return this.list("branches", teamId);
  }
  branch(teamId: string, branchId: string): ProjectBranch {
    return this.get("branches", teamId, branchId);
  }
  node(teamId: string, nodeId: string): ProjectNode {
    return this.get("nodes", teamId, nodeId);
  }
  document(teamId: string, revisionId: string): ProjectDocument {
    return this.get("documents", teamId, revisionId);
  }
  ensure(teamId: string): ProjectBranch {
    if (!this.store.teams.getTeam(teamId)) throw notFound();
    const main = this.list<ProjectBranch>("branches", teamId).find(
      (b) => b.baseNodeId === null,
    );
    if (main) return main;
    return this.store.transaction(() => {
      const branch: ProjectBranch = {
        id: randomUUID(),
        teamId,
        name: "主线",
        headNodeId: randomUUID(),
        baseNodeId: null,
        workspace: null,
        createdAt: now(),
      };
      this.insert("branches", branch);
      this.insert("nodes", {
        id: branch.headNodeId,
        teamId,
        branchId: branch.id,
        parentNodeId: null,
        kind: "root",
        title: "项目起点",
        documents: {},
        contextVersion: version({}),
        workspaceSnapshotId: null,
        artifactIds: [],
        source: { actor: "runtime" },
        createdAt: now(),
      });
      return branch;
    });
  }
  forConversation(teamId: string, conversationId: string): ProjectBranch {
    if (!this.store.db.prepare("SELECT id FROM conversations WHERE team_id=? AND id=?").get(teamId, conversationId))
      throw notFound();
    const row = this.store.db
      .prepare(
        "SELECT branch_id FROM project_conversations WHERE team_id=? AND conversation_id=?",
      )
      .get(teamId, conversationId);
    if (row) return this.branch(teamId, String(row.branch_id));
    const main = this.ensure(teamId);
    this.store.db
      .prepare("INSERT INTO project_conversations VALUES (?,?,?)")
      .run(conversationId, teamId, main.id);
    return main;
  }
  mainConversation(teamId: string): string {
    const saved = this.store.db.prepare("SELECT conversation_id FROM project_main_conversations WHERE team_id=?").get(teamId);
    if (saved) return String(saved.conversation_id);
    return this.store.transaction(() => {
      const main = this.ensure(teamId);
      const rows = this.store.db.prepare("SELECT id FROM conversations WHERE team_id=? ORDER BY created_at,rowid").all(teamId);
      const first = rows.find(row => this.forConversation(teamId, String(row.id)).id === main.id);
      const conversationId = first ? String(first.id) : this.store.teams.createConversation(teamId, "Host", null)!.id;
      this.forConversation(teamId, conversationId);
      this.store.db.prepare("INSERT INTO project_main_conversations VALUES (?,?)").run(teamId, conversationId);
      return conversationId;
    });
  }
  /** Import browser-only branch records into independent workspaces; never replay messages. */
  importConversation(
    teamId: string,
    conversationId: string,
    name: string | null,
    definitions: { id: string; kind: string; title: string; text: string }[],
  ) {
    if (!name) return this.forConversation(teamId, conversationId);
    const main = this.ensure(teamId),
      base = this.node(teamId, main.headNodeId);
    const branchId = randomUUID(),
      workspace = path.join(this.store.teams.dataDir + "-workspaces", branchId);
    mkdirSync(workspace, { recursive: true });
    const documents: Record<string, string> = {};
    for (const definition of definitions) {
      const doc: ProjectDocument = {
        id: randomUUID(),
        teamId,
        key: `import-${definition.id}`
          .replace(/[^a-zA-Z0-9_/-]/g, "_")
          .slice(0, 120),
        kind: ["goal", "requirement", "understanding", "design"].includes(
          definition.kind,
        )
          ? (definition.kind as ProjectDocument["kind"])
          : "understanding",
        title: definition.title,
        content: definition.text,
        dependencies: [],
        createdAt: now(),
      };
      this.insert("documents", doc);
      documents[doc.key] = doc.id;
    }
    const node: ProjectNode = {
      id: randomUUID(),
      teamId,
      branchId,
      parentNodeId: base.id,
      kind: "fork",
      title: name,
      documents,
      contextVersion: version(documents),
      workspaceSnapshotId: this.snapshots.capture(workspace),
      artifactIds: [],
      source: { actor: "user", conversationId },
      createdAt: now(),
    };
    const branch: ProjectBranch = {
      id: branchId,
      teamId,
      name,
      headNodeId: node.id,
      baseNodeId: base.id,
      workspace,
      createdAt: now(),
    };
    this.insert("branches", branch);
    this.insert("nodes", node);
    this.store.db
      .prepare("INSERT INTO project_conversations VALUES(?,?,?)")
      .run(conversationId, teamId, branchId);
    return branch;
  }
  forRun(run: Run): ProjectBranch {
    return run.branchId
      ? this.branch(run.teamId, run.branchId)
      : this.forConversation(run.teamId, run.conversationId);
  }
  workspace(branch: ProjectBranch): string {
    const workspace =
      branch.workspace ?? this.store.settings(branch.teamId)?.workspace;
    if (!workspace)
      throw conflict(
        "workspace_required",
        "Configure the Team workspace before capturing or executing a branch.",
      );
    return workspace;
  }
  context(teamId: string, branchId: string, nodeId?: string): ProjectContext {
    const branch = this.branch(teamId, branchId);
    const node = this.node(teamId, nodeId ?? branch.headNodeId);
    if (nodeId && !this.ancestors(teamId, branch.headNodeId).has(nodeId))
      throw notFound();
    return {
      branchId,
      nodeId: node.id,
      contextVersion: node.contextVersion,
      documents: Object.values(node.documents).map((r) =>
        this.document(teamId, r),
      ),
    };
  }
  private ancestors(teamId: string, nodeId: string): Set<string> {
    const ids = new Set<string>();
    let next: string | null = nodeId;
    while (next) {
      if (ids.has(next))
        throw conflict("history_corrupt", "History contains a cycle.");
      ids.add(next);
      next = this.node(teamId, next).parentNodeId;
    }
    return ids;
  }
  timeline(teamId: string, after: number, limit: number) {
    this.ensure(teamId);
    const nodes = this.store.db
      .prepare(
        "SELECT rowid AS sequence,data FROM project_nodes WHERE team_id=? AND rowid>? ORDER BY rowid LIMIT ?",
      )
      .all(teamId, after, limit)
      .map((r) => ({
        sequence: Number(r.sequence),
        ...JSON.parse(String(r.data)),
      }));
    return { nodes, nextCursor: nodes.at(-1)?.sequence ?? after };
  }
  detail(teamId: string, nodeId: string) {
    const node = this.node(teamId, nodeId);
    return {
      node,
      documents: Object.values(node.documents).map((r) =>
        this.document(teamId, r),
      ),
      workspace: node.workspaceSnapshotId
        ? this.snapshots.manifest(node.workspaceSnapshotId)
        : null,
    };
  }
  recordWork(work: Work, kind: "work-result" | "acceptance") {
    return this.store.once(
      `history:${work.id}`,
      `${kind}:${work.attemptId}:${work.status}`,
      {},
      () => {
        const run = this.store.get<Run>("runs", work.teamId, work.runId);
        const branch = this.forRun(run);
        return this.append(
          branch,
          branch.headNodeId,
          kind,
          work.title,
          this.node(work.teamId, branch.headNodeId).documents,
          {
            actor: "runtime",
            workId: work.id,
            conversationId: run.conversationId,
            reason: work.status,
          },
          null,
          work.artifactIds,
        );
      },
    );
  }
  recordInsight(teamId: string, branchId: string, title: string, source: Source) {
    const branch = this.branch(teamId, branchId);
    const parent = this.node(teamId, branch.headNodeId);
    // Discussion records do not change the effective project definition or capture files.
    return this.append(branch, parent.id, "insight", title, parent.documents, source);
  }
  private append(
    branch: ProjectBranch,
    expectedHeadId: string,
    kind: ProjectNode["kind"],
    title: string,
    documents: Record<string, string>,
    source: Source,
    snapshotId?: string | null,
    artifactIds: string[] = [],
  ): ProjectNode {
    if (branch.headNodeId !== expectedHeadId)
      throw conflict(
        "history_conflict",
        "The branch changed. Reload its definition before saving.",
      );
    const parent = this.node(branch.teamId, expectedHeadId);
    const node: ProjectNode = {
      id: randomUUID(),
      teamId: branch.teamId,
      branchId: branch.id,
      parentNodeId: parent.id,
      kind,
      title,
      documents,
      contextVersion: version(documents),
      workspaceSnapshotId: snapshotId ?? null,
      artifactIds,
      source,
      createdAt: now(),
    };
    this.insert("nodes", node);
    const changed = this.store.db
      .prepare(
        "UPDATE project_branches SET data=? WHERE id=? AND team_id=? AND json_extract(data,'$.headNodeId')=?",
      )
      .run(
        JSON.stringify({ ...branch, headNodeId: node.id }),
        branch.id,
        branch.teamId,
        expectedHeadId,
      );
    if (changed.changes !== 1)
      throw conflict(
        "history_conflict",
        "The branch changed before this update could commit.",
      );
    this.store.event(branch.teamId, "project.node_created", {
      branchId: branch.id,
      nodeId: node.id,
      parentNodeId: parent.id,
      kind,
      contextVersion: node.contextVersion,
    });
    if (parent.contextVersion !== node.contextVersion)
      this.store.event(branch.teamId, "project.context_changed", {
        branchId: branch.id,
        nodeId: node.id,
        contextVersion: node.contextVersion,
      });
    return node;
  }
  private validateDependencies(
    teamId: string,
    documents: Record<string, string>,
  ) {
    const present = new Set(Object.values(documents));
    if (present.size > 100)
      throw badRequest(
        "document_capacity",
        "A branch supports at most 100 current project documents.",
      );
    let bytes = 0;
    for (const ref of present) {
      const document = this.document(teamId, ref);
      bytes += Buffer.byteLength(document.content);
      const missing = document.dependencies.filter((d) => !present.has(d));
      if (missing.length)
        throw conflict(
          "selection_dependencies",
          `Missing exact document revisions: ${missing.join(", ")}. During definition publication, use revision IDs from team_project_context or key:<stable-key> (for example key:goal). During user selection, explicitly select the required versions. Unchanged documents may be omitted from documents.`,
        );
    }
    if (bytes > 120000)
      throw badRequest(
        "context_capacity",
        "Current project definitions exceed 120 KB. Split supporting material from the execution definition.",
      );
  }
  publish(
    teamId: string,
    branchId: string,
    input: DefinitionInput,
    source: Source,
    kind: "definition" | "merge" = "definition",
  ): ProjectNode {
    return this.store.transaction(() => {
      const branch = this.branch(teamId, branchId);
      if (branch.headNodeId !== input.expectedHeadId)
        throw conflict(
          "history_conflict",
          "The branch changed. Reload before publishing.",
        );
      const documents = { ...this.node(teamId, branch.headNodeId).documents };
      const keys = input.documents.map((d) => d.key);
      if (
        new Set(keys).size !== keys.length ||
        keys.some((k) => input.removeKeys.includes(k))
      )
        throw badRequest(
          "duplicate_document",
          "A document can only be changed once in a definition update.",
        );
      for (const key of input.removeKeys) {
        if (!(key in documents)) throw notFound();
        delete documents[key];
      }
      const revisions = input.documents.map((inputDocument) => ({
        ...inputDocument,
        id: randomUUID(),
        teamId,
        createdAt: now(),
      }));
      for (const revision of revisions) documents[revision.key] = revision.id;
      for (const inputDocument of revisions) {
        cleanDefinition(inputDocument.content);
        const revision: ProjectDocument = {
          ...inputDocument,
          dependencies: inputDocument.dependencies.map((ref) => {
            if (!ref.startsWith("key:")) return ref;
            const resolved = documents[ref.slice(4)];
            if (!resolved)
              throw conflict(
                "selection_dependencies",
                "A referenced document key is absent from the resulting definition.",
              );
            return resolved;
          }),
        };
        this.insert("documents", revision);
      }
      this.validateDependencies(teamId, documents);
      for (const id of input.exchangeMessageIds ?? []) {
        let message: TeamExchangeMessage;
        try {
          message = this.store.get<TeamExchangeMessage>(
            "exchange_messages",
            teamId,
            id,
          );
        } catch (error) {
          if (!(error instanceof ServiceError) || error.code !== "not_found")
            throw error;
          throw badRequest(
            "invalid_exchange_source",
            "exchangeMessageIds requires actual A2A message IDs from team_read_exchange. For a user conversation use []; the source conversation and user message are recorded automatically.",
          );
        }
        if (
          this.store.get<TeamExchange>("exchanges", teamId, message.exchangeId)
            .branchId !== branch.id
        )
          throw conflict(
            "branch_scope",
            "Definition discussion sources must belong to this branch.",
          );
      }
      const node = this.append(
        branch,
        input.expectedHeadId,
        kind,
        input.title,
        documents,
        {
          ...source,
          reason: input.reason,
          exchangeMessageIds: input.exchangeMessageIds ?? [],
        },
        this.captureDefinition(branch),
      );
      this.invalidate(
        teamId,
        branchId,
        input.affectedWorkIds,
        node.id,
        source.workId,
      );
      return node;
    });
  }
  private invalidate(
    teamId: string,
    branchId: string,
    ids: string[],
    nodeId: string,
    publishingWorkId?: string,
  ) {
    for (const id of new Set(ids)) {
      const work = this.store.get<Work>("works", teamId, id);
      if (
        work.id === publishingWorkId ||
        this.forRun(this.store.get<Run>("runs", teamId, work.runId)).id !==
          branchId
      )
        throw badRequest(
          "invalid_affected_work",
          "Affected work must belong to this branch and cannot be the publishing work.",
        );
      work.invalidatedByNodeId = nodeId;
      this.store.setStatus(
        work,
        work.status === "recovery_required"
          ? "recovery_required"
          : activeStates.has(work.status)
            ? "stopping"
            : "superseded",
        "Project definition changed; create replacement work after reconsidering its instructions and acceptance criteria.",
      );
    }
  }
  private selected(
    teamId: string,
    target: Record<string, string>,
    selections: Selection[],
  ) {
    const documents = { ...target };
    const touched = new Set<string>();
    for (const selection of selections) {
      const source = this.document(teamId, selection.revisionId);
      if (touched.has(source.key))
        throw badRequest(
          "selection_conflict",
          "Select only one revision of a document.",
        );
      touched.add(source.key);
      const current = documents[source.key] ?? null;
      if (current !== source.id && current !== selection.replaceRevisionId)
        throw conflict(
          "selection_conflict",
          `Choose explicitly whether to replace document ${source.key}.`,
        );
      documents[source.key] = source.id;
    }
    this.validateDependencies(teamId, documents);
    return documents;
  }
  select(
    teamId: string,
    branchId: string,
    expectedHeadId: string,
    selections: Selection[],
    title: string,
  ) {
    return this.store.transaction(() => {
      const branch = this.branch(teamId, branchId);
      const documents = this.selected(
        teamId,
        this.node(teamId, branch.headNodeId).documents,
        selections,
      );
      return this.append(
        branch,
        expectedHeadId,
        "selection",
        title,
        documents,
        {
          actor: "user",
          selectedRevisionIds: selections.map((s) => s.revisionId),
        },
        this.captureDefinition(branch),
      );
    });
  }
  private writableBusy(branch: ProjectBranch, exceptWorkId?: string) {
    const workspace = this.workspace(branch);
    return this.store.teams
      .listTeams()
      .some((t) =>
        this.store
          .list<Work>("works", t.id)
          .some(
            (w) =>
              w.id !== exceptWorkId &&
              activeStates.has(w.status) &&
              this.store.get<Member>("members", t.id, w.memberId).config
                .access === "workspace-write" &&
              overlaps(this.store.workspace(w), workspace),
          ),
      );
  }
  private captureDefinition(branch: ProjectBranch): string | null {
    if (!(branch.workspace ?? this.store.settings(branch.teamId)?.workspace))
      return null;
    if (this.writableBusy(branch)) return null;
    try {
      return this.snapshots.capture(this.workspace(branch));
    } catch (error) {
      this.store.event(branch.teamId, "project.checkpoint_unavailable", {
        branchId: branch.id,
        reason:
          error instanceof Error ? error.message : "Checkpoint unavailable",
      });
      return null;
    }
  }
  checkpoint(
    teamId: string,
    branchId: string,
    expectedHeadId: string,
    title: string,
    source: Source = { actor: "user" },
    artifactIds: string[] = [],
    kind: "checkpoint" | "delivery" = "checkpoint",
  ) {
    return this.store.transaction(() => {
      const branch = this.branch(teamId, branchId);
      if (branch.headNodeId !== expectedHeadId)
        throw conflict(
          "history_conflict",
          "The branch changed before checkpoint capture.",
        );
      if (this.writableBusy(branch))
        throw conflict(
          "workspace_busy",
          "Confirm writable attempts have ended before capturing a checkpoint.",
        );
      const snapshot = this.snapshots.capture(this.workspace(branch));
      return this.append(
        branch,
        expectedHeadId,
        kind,
        title,
        this.node(teamId, expectedHeadId).documents,
        source,
        snapshot,
        artifactIds,
      );
    });
  }
  delivery(
    teamId: string,
    branchId: string,
    expectedHeadId: string,
    title: string,
    source: Source,
    artifactIds: string[],
    captureWorkspace: boolean,
  ) {
    return this.store.transaction(() => {
      const branch = this.branch(teamId, branchId);
      return this.append(
        branch,
        expectedHeadId,
        "delivery",
        title,
        this.node(teamId, expectedHeadId).documents,
        source,
        captureWorkspace ? this.captureDefinition(branch) : null,
        artifactIds,
      );
    });
  }
  prepareRun(run: Run, captureWorkspace = true): void {
    let branch = this.forRun(run);
    run.branchId = branch.id;
    run.settings = { ...run.settings, workspace: this.workspace(branch) };
    if (
      captureWorkspace &&
      !this.node(run.teamId, branch.headNodeId).workspaceSnapshotId &&
      !this.writableBusy(branch)
    ) {
      const snapshot = this.captureDefinition(branch);
      if (snapshot)
        this.append(
          branch,
          branch.headNodeId,
          "checkpoint",
          "执行起点",
          this.node(run.teamId, branch.headNodeId).documents,
          {
            actor: "runtime",
            conversationId: run.conversationId,
            messageIds: [run.sourceMessageId],
          },
          snapshot,
        );
      branch = this.branch(run.teamId, branch.id);
    }
    run.contextNodeId = branch.headNodeId;
  }
  fork(
    teamId: string,
    fromNodeId: string,
    name: string,
    selections: Selection[],
  ) {
    return this.store.transaction(() => {
      const base = this.node(teamId, fromNodeId);
      if (!base.workspaceSnapshotId)
        throw conflict(
          "checkpoint_required",
          "This node has no recoverable workspace checkpoint.",
        );
      const documents = this.selected(teamId, base.documents, selections);
      const branchId = randomUUID();
      const workspace = path.join(
        this.store.teams.dataDir + "-workspaces",
        branchId,
      );
      for (const team of this.store.teams.listTeams()) {
        const configured = this.store.settings(team.id)?.workspace;
        if (configured && overlaps(workspace, configured))
          throw conflict(
            "unsafe_workspace",
            "Managed branch directory overlaps a configured workspace.",
          );
      }
      this.snapshots.restore(base.workspaceSnapshotId, workspace);
      const node: ProjectNode = {
        id: randomUUID(),
        teamId,
        branchId,
        parentNodeId: base.id,
        kind: "fork",
        title: name,
        documents,
        contextVersion: version(documents),
        workspaceSnapshotId: base.workspaceSnapshotId,
        artifactIds: [],
        source: {
          actor: "user",
          selectedRevisionIds: selections.map((s) => s.revisionId),
        },
        createdAt: now(),
      };
      const branch: ProjectBranch = {
        id: branchId,
        teamId,
        name,
        headNodeId: node.id,
        baseNodeId: base.id,
        workspace,
        createdAt: now(),
      };
      this.insert("branches", branch);
      this.insert("nodes", node);
      const conversation = this.store.teams.createConversation(
        teamId,
        name,
        null,
      )!;
      this.store.db
        .prepare("INSERT INTO project_conversations VALUES (?,?,?)")
        .run(conversation.id, teamId, branch.id);
      this.store.event(teamId, "project.branch_created", {
        branchId,
        nodeId: node.id,
        fromNodeId,
        conversationId: conversation.id,
        selectedRevisionIds: selections.map((s) => s.revisionId),
      });
      return { branch, node, conversation };
    });
  }
  scope(run: Run) {
    const branch = this.forRun(run);
    const runs = this.store
      .list<Run>("runs", run.teamId)
      .filter((r) => this.forRun(r).id === branch.id);
    return { branch, runIds: new Set(runs.map((r) => r.id)) };
  }
  assertArtifact(run: Run, artifactId: string) {
    const artifact = this.store.get<import("./types.js").ArtifactVersion>(
      "artifacts",
      run.teamId,
      artifactId,
    );
    if (
      !this.scope(run).runIds.has(
        this.store.get<Work>("works", run.teamId, artifact.workId).runId,
      )
    )
      throw conflict(
        "branch_scope",
        "This artifact belongs to a different project branch.",
      );
  }
  bind(attempt: Attempt, run: Run) {
    const context = this.context(run.teamId, this.forRun(run).id);
    attempt.contextNodeId = context.nodeId;
    attempt.contextVersion = context.contextVersion;
    this.store.save("attempts", attempt);
    return context;
  }
  receipt(
    work: Work,
    attempt: Attempt,
    phase: "delivered" | "read",
    nodeId: string,
  ) {
    const node = this.node(work.teamId, nodeId);
    const column = phase === "delivered" ? "delivered_at" : "read_at";
    this.store.db
      .prepare(
        `INSERT INTO project_context_receipts(attempt_id,node_id,team_id,version,${column}) VALUES (?,?,?,?,?) ON CONFLICT(attempt_id,node_id) DO UPDATE SET ${column}=COALESCE(${column},excluded.${column})`,
      )
      .run(attempt.id, node.id, work.teamId, node.contextVersion, now());
    this.store.event(
      work.teamId,
      `project.context_${phase}`,
      { nodeId, contextVersion: node.contextVersion },
      work,
      attempt.id,
    );
  }
  read(work: Work, attempt: Attempt) {
    const context = this.context(
      work.teamId,
      this.forRun(this.store.get<Run>("runs", work.teamId, work.runId)).id,
    );
    this.receipt(work, attempt, "read", context.nodeId);
    return context;
  }
  acknowledge(work: Work, attempt: Attempt, nodeId: string) {
    const context = this.context(
      work.teamId,
      this.forRun(this.store.get<Run>("runs", work.teamId, work.runId)).id,
    );
    if (context.nodeId !== nodeId)
      throw conflict(
        "context_changed",
        "Read the branch definition again before acknowledging.",
      );
    const receipt = this.store.db
      .prepare(
        "SELECT read_at FROM project_context_receipts WHERE team_id=? AND attempt_id=? AND node_id=?",
      )
      .get(work.teamId, attempt.id, nodeId);
    if (!receipt?.read_at)
      throw conflict(
        "context_not_read",
        "Read the project context before acknowledging its application.",
      );
    this.store.db
      .prepare(
        "UPDATE project_context_receipts SET acknowledged_at=? WHERE attempt_id=? AND node_id=?",
      )
      .run(now(), attempt.id, nodeId);
    attempt.acknowledgedContextVersion = context.contextVersion;
    this.store.save("attempts", attempt);
    this.store.event(
      work.teamId,
      "project.context_application_claimed",
      { nodeId, contextVersion: context.contextVersion },
      work,
      attempt.id,
    );
    return {
      nodeId,
      contextVersion: context.contextVersion,
      acknowledged: true,
    };
  }
  isCurrent(work: Work, attemptId: string) {
    if (work.invalidatedByNodeId) return false;
    const attempt = this.store.get<Attempt>("attempts", work.teamId, attemptId);
    const branch = this.forRun(
      this.store.get<Run>("runs", work.teamId, work.runId),
    );
    // Pre-migration attempts saw no project documents. Recovery may confirm their end,
    // but cannot make them current once a non-empty definition has been published.
    return (
      this.node(work.teamId, branch.headNodeId).contextVersion ===
      (attempt.acknowledgedContextVersion ??
        attempt.contextVersion ??
        version({}))
    );
  }
  assertCurrent(work: Work, attemptId: string) {
    if (!this.isCurrent(work, attemptId))
      throw conflict(
        "context_update_required",
        "The shared project definition changed. Call team_project_context, reconsider your work, then team_acknowledge_context before continuing.",
      );
  }
  syncState(teamId: string, branchId: string) {
    const context = this.context(teamId, branchId);
    const attempts = this.store
      .list<Attempt>("attempts", teamId)
      .filter(
        (a) =>
          this.forRun(
            this.store.get<Run>(
              "runs",
              teamId,
              this.store.get<Work>("works", teamId, a.workId).runId,
            ),
          ).id === branchId,
      );
    return attempts.map((a) => ({
      attemptId: a.id,
      memberId: a.memberId,
      status: a.status,
      contextNodeId: a.contextNodeId ?? null,
      contextVersion: a.contextVersion ?? null,
      pending:
        (a.acknowledgedContextVersion ?? a.contextVersion ?? version({})) !==
        context.contextVersion,
      receipts: this.store.db
        .prepare(
          "SELECT node_id AS nodeId,version,delivered_at AS deliveredAt,read_at AS readAt,acknowledged_at AS applicationClaimedAt FROM project_context_receipts WHERE team_id=? AND attempt_id=? ORDER BY rowid",
        )
        .all(teamId, a.id),
    }));
  }
}
