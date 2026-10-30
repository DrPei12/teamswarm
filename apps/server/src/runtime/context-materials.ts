import { conflict, notFound } from "../errors.js";
import { RuntimeStore, hash } from "./store.js";
import { ProjectHistory } from "./project-history.js";
import { TeamCatalog } from "./catalog.js";
import {
  estimateTokens,
  excerpt,
  queryTerms,
  relevance,
} from "./context-budget.js";
import { WorkspaceAccess } from "./workspace-access.js";
import { resolveProjectSource } from "./collaboration-records.js";
import type { ProjectInsight, Run, Work } from "./types.js";

export interface ContextMaterial {
  ref: string;
  kind: "document" | "note" | "work" | "member" | "insight" | "harness";
  topic: string;
  title: string;
  revision: string;
  content: string;
  links: string[];
  memberIds: string[];
  stale?: boolean;
  data: Record<string, any>;
}

function materialSources(m: ContextMaterial) {
  return [
    ...Object.entries(m.data.sourceRevisions ?? {}).map(([ref, revision]) => ({
      ref,
      revision,
    })),
    ...Object.entries(m.data.sourceFiles ?? {}).map(([path, sha256]) => ({
      path,
      sha256,
    })),
    ...(m.data.sourceMessageIds ?? []).map((messageId: string) => ({
      messageId,
    })),
  ];
}

export const catalogRevision = (m: ContextMaterial) =>
  m.revision + (m.stale ? ":recheck" : "");

export function materialHeader(
  m: ContextMaterial,
  query = "",
  tokenBudget = 1200,
) {
  const sources = materialSources(m);
  const header = {
    ref: m.ref,
    kind: m.kind,
    topic: m.topic,
    title: m.title,
    revision: m.revision,
    preview: "",
    characters: m.content.length,
    links: [] as string[],
    linkCount: m.links.length,
    sources: [] as unknown[],
    sourceCount: sources.length,
    ...(m.data.historical ? { historical: true } : {}),
    ...(m.stale ? { requiresRecheck: true } : {}),
  };
  header.preview = excerpt(
    m.content,
    query,
    Math.min(
      360,
      Math.max(0, Math.floor((tokenBudget - estimateTokens(header) - 50) / 3)),
    ),
  );
  for (const link of m.links) {
    if (
      estimateTokens({ ...header, links: [...header.links, link] }) >
      tokenBudget * 0.8
    )
      break;
    header.links.push(link);
  }
  for (const source of sources) {
    if (
      estimateTokens({ ...header, sources: [...header.sources, source] }) >
      tokenBudget
    )
      break;
    header.sources.push(source);
  }
  return header;
}

/** Branch-local references resolve against current project records, not a second definition store. */
export class ContextMaterials {
  constructor(
    readonly store: RuntimeStore,
    readonly history: ProjectHistory,
    readonly catalog: TeamCatalog,
  ) {
    store.db.exec(
      "CREATE INDEX IF NOT EXISTS context_message_conversation ON messages(conversation_id, created_at)",
    );
  }

  all(
    run: Run,
    project = this.history.context(run.teamId, this.history.forRun(run).id),
  ): ContextMaterial[] {
    const scope = this.catalog.scoped(run.teamId, project.branchId);
    const documents = new Map(project.documents.map((d) => [d.id, d]));
    const works = new Map(scope.works.map((w) => [w.id, w]));
    const items: ContextMaterial[] = project.documents.map((d) => ({
      ref: `document:${d.key}`,
      kind: "document",
      topic: `definition/${d.key.split("/").slice(0, -1).join("/")}`.replace(
        /\/$/,
        "",
      ),
      title: d.title,
      revision: d.id,
      content: d.content,
      links: d.dependencies
        .map((id) => documents.get(id))
        .filter(Boolean)
        .map((d) => `document:${d!.key}`),
      memberIds: [],
      data: d,
    }));
    for (const id of this.catalog.harnesses.keys()) {
      const description = this.catalog.harness(id).description;
      const memberIds = scope.members.filter(member => member.config.harness === id).map(member => member.id);
      const links = Object.keys(description.sections).map(section => `${description.ref}/${section}`);
      items.push({ ref: description.ref, kind: "harness", topic: "harnesses", title: description.name,
        revision: description.revision, content: description.summary, links, memberIds, data: { id, sections: links } });
      for (const [section, body] of Object.entries(description.sections))
        items.push({ ref: `${description.ref}/${section}`, kind: "harness", topic: `harnesses/${id}`,
          title: `${description.name}: ${section}`, revision: description.revision,
          content: JSON.stringify(body), links: [description.ref], memberIds, data: { harness: id, section } });
    }
    const fileDigests = new Map<string, string | null>();
    const capabilityVersion = this.catalog.capabilities.read(
      run.teamId,
    ).version;
    for (const row of this.store.db
      .prepare(
        "SELECT data FROM host_notes WHERE team_id=? AND branch_id=? ORDER BY key",
      )
      .all(run.teamId, project.branchId)) {
      const n = JSON.parse(String(row.data));
      if (n.status !== "open") continue;
      const changedFiles = Object.entries(n.sourceFiles ?? {}).some(
        ([file, digest]) => {
          if (!fileDigests.has(file)) {
            try {
              fileDigests.set(
                file,
                new WorkspaceAccess(
                  this.history.workspace(this.history.forRun(run)),
                  [],
                  [this.store.teams.dataDir],
                ).read(file, 0, 1).sha256,
              );
            } catch {
              fileDigests.set(file, null);
            }
          }
          return fileDigests.get(file) !== digest;
        },
      );
      const stale =
        changedFiles ||
        (n.sourceRevisions
          ? Object.entries(n.sourceRevisions as Record<string, string>).some(
              ([ref, revision]) =>
                ref.startsWith("document:")
                  ? project.documents.find((d) => `document:${d.key}` === ref)
                      ?.id !== revision
                  : ref.startsWith("work:")
                    ? String(works.get(ref.slice(5))?.revision) !== revision
                    : ref.startsWith("harness:")
                      ? items.find(item => item.ref === ref)?.revision !== revision
                    : false,
            ) ||
            (n.kind === "experience" &&
              n.capabilityVersion !== capabilityVersion)
          : n.contextVersion !== project.contextVersion ||
            n.capabilityVersion !== capabilityVersion);
      items.push({
        ref: `note:${n.key}`,
        kind: "note",
        topic: `memory/${n.topic ?? n.kind ?? "working"}`,
        title: n.title ?? n.key,
        revision: String(n.version),
        content: n.content,
        links: [
          ...(n.sourceRefs ?? []),
          ...(n.sourceMessageIds ?? []).map((id: string) => `message:${id}`),
        ],
        memberIds: n.memberIds ?? [],
        stale,
        data: { ...n, requiresRecheck: stale },
      });
    }
    for (const w of scope.works) {
      if (scope.members.find((m) => m.id === w.memberId)?.kind === "host")
        continue;
      items.push({
        ref: `work:${w.id}`,
        kind: "work",
        topic: "work",
        title: w.title,
        revision: String(w.revision),
        content: [w.instructions, w.result, w.continuation?.summary]
          .filter(Boolean)
          .join("\n"),
        links: [
          ...w.dependsOn,
          ...(w.reviewOf ? [w.reviewOf] : []),
          ...(w.continuationOf ? [w.continuationOf] : []),
        ]
          .map((id) => `work:${id}`)
          .concat(w.contextRefs ?? []),
        memberIds: [w.memberId],
        data: w,
      });
    }
    for (const m of scope.members) {
      const links = scope.works
        .filter(
          (w) =>
            w.memberId === m.id &&
            !["accepted", "self_checked", "superseded"].includes(w.status),
        )
        .map((w) => `work:${w.id}`);
      items.push({
        ref: `member:${m.id}`,
        kind: "member",
        topic: "members",
        title: m.name,
        revision: hash(
          JSON.stringify({
            name: m.name,
            responsibility: m.responsibility,
            allocationVersion: m.allocationVersion,
            links,
          }),
        ),
        content: m.responsibility,
        links,
        memberIds: [m.id],
        data: {
          id: m.id,
          name: m.name,
          responsibility: m.responsibility,
          kind: m.kind,
        },
      });
    }
    if (
      this.store.db
        .prepare("SELECT name FROM sqlite_master WHERE name='project_insights'")
        .get()
    ) {
      const current = new Map<string, ProjectInsight>();
      for (const row of this.store.db
        .prepare(
          "SELECT data FROM project_insights WHERE team_id=? AND json_extract(data,'$.branchId')=? ORDER BY rowid",
        )
        .all(run.teamId, project.branchId)) {
        const i = JSON.parse(String(row.data)) as ProjectInsight;
        current.set(i.key, i);
      }
      for (const i of current.values())
        items.push({
          ref: `insight:${i.id}`,
          kind: "insight",
          topic: "decisions",
          title: i.title,
          revision: String(i.revision),
          content: i.content,
          links: i.sourceMessageIds.map((id) => `message:${id}`),
          memberIds: [],
          data: i,
        });
    }
    return items;
  }

  resolve(items: ContextMaterial[], ref: string): ContextMaterial {
    const material = items.find(
      (m) =>
        m.ref === ref ||
        (m.kind === "document" && `document:${m.data.id}` === ref),
    );
    if (!material)
      throw conflict(
        "context_reference_unavailable",
        `Read the branch index for a current reference: ${ref}`,
      );
    return material;
  }

  validateRefs(run: Run, refs: string[]) {
    const items = this.all(run);
    return [...new Set(refs.map((ref) => this.resolve(items, ref).ref))];
  }

  private forRead(
    run: Run,
    items: ContextMaterial[],
    ref: string,
  ): ContextMaterial {
    if (
      items.some(
        (m) =>
          m.ref === ref ||
          (m.kind === "document" && `document:${m.data.id}` === ref),
      )
    )
      return this.resolve(items, ref);
    // An explicit immutable revision can be a source for an old decision. It
    // must have appeared in this branch's ancestry; current handoffs use keys.
    if (ref.startsWith("document:")) {
      const revision = ref.slice(9);
      let nodeId: string | null = this.history.forRun(run).headNodeId;
      while (nodeId) {
        const node = this.history.node(run.teamId, nodeId);
        if (Object.values(node.documents).includes(revision)) {
          const d = this.history.document(run.teamId, revision);
          return {
            ref,
            kind: "document",
            topic: "definition/history",
            title: d.title,
            revision: d.id,
            content: d.content,
            links: d.dependencies.map((id) => `document:${id}`),
            memberIds: [],
            data: { ...d, historical: true },
          };
        }
        nodeId = node.parentNodeId;
      }
    }
    return this.resolve(items, ref);
  }

  rank(
    items: ContextMaterial[],
    work: Work,
    query = "",
    memberId = work.memberId,
  ) {
    const terms = queryTerms(query || `${work.title}\n${work.instructions}`);
    const related = new Set([
      ...(work.contextRefs ?? []),
      ...work.dependsOn.map((id) => `work:${id}`),
      ...(work.reviewOf ? [`work:${work.reviewOf}`] : []),
      ...(work.continuationOf ? [`work:${work.continuationOf}`] : []),
    ]);
    if (work.interaction?.resumeFromWorkId)
      related.add(`work:${work.interaction.resumeFromWorkId}`);
    // Follow actual dependency links, including definitions selected for a parent work.
    const queue = [...related];
    for (let i = 0; i < queue.length; i++)
      for (const ref of items.find((m) => m.ref === queue[i])?.links ?? []) {
        if (!related.has(ref)) {
          related.add(ref);
          queue.push(ref);
        }
      }
    return items
      .map((m) => ({
        material: m,
        related: related.has(m.ref),
        score:
          (related.has(m.ref) ? 100 : 0) +
          relevance(`${m.title} ${m.topic}`, terms) * 8 +
          relevance(m.content, terms) * 2 +
          (m.kind === "document" && m.data.kind === "goal" ? 50 : 0) +
          (m.kind === "document" && m.data.kind === "requirement" ? 20 : 0) +
          (m.kind === "note" && m.data.kind === "overview" && !m.stale
            ? 60
            : 0) +
          (m.kind === "note" && m.memberIds.length === 0 ? 12 : 0) +
          (m.memberIds.includes(memberId) ? 15 : 0) +
          (m.kind === "work" &&
          !["accepted", "self_checked", "superseded"].includes(m.data.status)
            ? 10
            : 0) -
          (m.stale ? 80 : 0),
      }))
      .sort(
        (a, b) =>
          b.score - a.score || a.material.ref.localeCompare(b.material.ref),
      );
  }

  topics(items: ContextMaterial[], topic = "") {
    const counts = new Map<string, number>();
    for (const m of items) {
      if (topic && m.topic !== topic && !m.topic.startsWith(topic + "/"))
        continue;
      const rest = topic ? m.topic.slice(topic.length + 1) : m.topic;
      const child = topic
        ? rest
          ? `${topic}/${rest.split("/")[0]}`
          : topic
        : rest.split("/")[0];
      counts.set(child, (counts.get(child) ?? 0) + 1);
    }
    return [...counts].map(([topic, count]) => ({ topic, count }));
  }

  index(
    run: Run,
    work: Work,
    input: {
      query?: string;
      topic?: string;
      workId?: string;
      memberId?: string;
      offset?: number;
      limit?: number;
    },
    tokenBudget = 4096,
  ) {
    const project = this.history.context(
      run.teamId,
      this.history.forRun(run).id,
    );
    const items = this.all(run, project);
    const target = input.workId
      ? (this.resolve(items, `work:${input.workId}`).data as Work)
      : work;
    if (input.memberId) this.resolve(items, `member:${input.memberId}`);
    const terms = queryTerms(input.query ?? "");
    const matched = items.filter(
      (m) =>
        (!input.topic ||
          m.topic === input.topic ||
          m.topic.startsWith(input.topic + "/")) &&
        (!input.query ||
          relevance(`${m.title} ${m.content} ${m.ref}`, terms) > 0 ||
          m.ref.includes(input.query)) &&
        (!input.memberId ||
          !m.memberIds.length ||
          m.memberIds.includes(input.memberId)),
    );
    const ordered = this.rank(matched, target, input.query, input.memberId).map(
      (x) => x.material,
    );
    const offset = input.offset ?? 0,
      page: ReturnType<typeof materialHeader>[] = [];
    for (const m of ordered.slice(offset, offset + (input.limit ?? 20))) {
      const header = materialHeader(
        m,
        input.query,
        Math.min(1200, tokenBudget - 200),
      );
      if (estimateTokens([...page, header]) > tokenBudget - 200) break;
      page.push(header);
    }
    return {
      branchId: project.branchId,
      nodeId: project.nodeId,
      contextVersion: project.contextVersion,
      topics: this.topics(items, input.topic),
      items: page,
      total: ordered.length,
      nextOffset:
        offset + page.length < ordered.length ? offset + page.length : null,
    };
  }

  read(
    run: Run,
    refs: string[],
    offset: number,
    maxChars: number,
    tokenBudget: number,
    expectedRevisions: Record<string, string> = {},
    section: "body" | "links" | "sources" = "body",
  ) {
    const materials = this.all(run);
    const items: unknown[] = [];
    for (const ref of refs) {
      const m = this.forRead(run, materials, ref);
      const expected = expectedRevisions[ref] ?? expectedRevisions[m.ref];
      if ((offset > 0 && !expected) || (expected && expected !== m.revision))
        throw conflict(
          "context_material_changed",
          `Read ${m.ref} from offset 0 and use its revision for subsequent pages.`,
        );
      if (section !== "body") {
        const values = section === "links" ? m.links : materialSources(m);
        const page: unknown[] = [];
        const base = {
          ref: m.ref,
          revision: m.revision,
          section,
          offset,
          total: values.length,
        };
        for (const value of values.slice(offset)) {
          if (
            estimateTokens([
              ...items,
              {
                ...base,
                values: [...page, value],
                nextOffset: offset + page.length + 1,
              },
            ]) >
            tokenBudget - 100
          )
            break;
          page.push(value);
        }
        if (!page.length && offset < values.length) {
          if (items.length) break;
          throw conflict(
            "context_capacity",
            "A source reference exceeds this model's tool budget. Use a larger context window.",
          );
        }
        items.push({
          ...base,
          values: page,
          nextOffset:
            offset + page.length < values.length ? offset + page.length : null,
        });
        continue;
      }
      let end = Math.min(m.content.length, offset + maxChars);
      let item = {
        ...materialHeader(m, "", Math.min(1200, tokenBudget / 2)),
        content: m.content.slice(offset, end),
        offset,
        nextOffset: end < m.content.length ? end : null,
      };
      while (
        end > offset &&
        estimateTokens([...items, item]) > tokenBudget - 100
      ) {
        end = offset + Math.floor((end - offset) / 2);
        item = {
          ...item,
          content: m.content.slice(offset, end),
          nextOffset: end < m.content.length ? end : null,
        };
      }
      if (end === offset && offset < m.content.length) {
        if (!items.length)
          throw conflict(
            "context_capacity",
            "This reference exceeds the model's tool budget. Use a larger context window.",
          );
        break;
      }
      if (estimateTokens([...items, item]) > tokenBudget - 100) break;
      items.push(item);
    }
    const result = {
      items,
      remainingRefs: [] as string[],
      nextRefOffset: items.length < refs.length ? items.length : null,
    };
    for (const ref of refs.slice(items.length)) {
      if (
        estimateTokens({
          ...result,
          remainingRefs: [...result.remainingRefs, ref],
        }) > tokenBudget
      )
        break;
      result.remainingRefs.push(ref);
    }
    return result;
  }

  messages(
    run: Run,
    options: {
      query?: string;
      offset?: number;
      limit?: number;
      conversationId?: string;
      boundary?: string;
      maxTokens?: number;
    },
  ) {
    const conversationId = options.conversationId ?? run.conversationId;
    const branch = this.history.forRun(run);
    if (
      this.history.forConversation(run.teamId, conversationId).id !== branch.id
    )
      throw conflict("branch_scope", "Read messages only from this branch.");
    const boundary = options.boundary
      ? this.store.db
          .prepare(
            "SELECT rowid AS n FROM messages WHERE id=? AND conversation_id=?",
          )
          .get(options.boundary, conversationId)
      : undefined;
    if (options.boundary && !boundary) throw notFound();
    const terms = queryTerms(options.query ?? "");
    const args: (string | number)[] = [conversationId];
    let where = "conversation_id=?";
    if (boundary) {
      where += " AND rowid<=?";
      args.push(Number(boundary.n));
    }
    if (terms.length) {
      where += ` AND (${terms.map(() => "instr(lower(content),?)>0").join(" OR ")})`;
      args.push(...terms);
    }
    const total = Number(
      this.store.db
        .prepare(`SELECT count(*) AS n FROM messages WHERE ${where}`)
        .get(...args)!.n,
    );
    const score = terms.length
      ? terms.map(() => "(instr(lower(content),?)>0)").join("+")
      : "0";
    const ordered = this.store.db
      .prepare(
        `SELECT id, role, content, rowid AS seq, (${score}) AS score FROM messages WHERE ${where} ORDER BY score DESC, rowid DESC LIMIT ? OFFSET ?`,
      )
      .all(...terms, ...args, options.limit ?? 20, options.offset ?? 0);
    const items: {
      id: string;
      role: string;
      content: string;
      partial?: boolean;
      characters?: number;
    }[] = [];
    for (const row of ordered) {
      const item = {
        id: String(row.id),
        role: String(row.role),
        content: String(row.content),
      };
      if (
        options.maxTokens &&
        estimateTokens([...items, item]) > options.maxTokens
      ) {
        if (!items.length)
          items.push({
            ...item,
            content: excerpt(
              item.content,
              options.query,
              Math.max(80, Math.floor(options.maxTokens / 2)),
            ),
            partial: true,
            characters: item.content.length,
          });
        break;
      }
      items.push(item);
    }
    const next = (options.offset ?? 0) + items.length;
    return { items, total, nextOffset: next < total ? next : null };
  }

  message(
    run: Run,
    id: string,
    offset: number,
    maxChars: number,
    tokenBudget: number,
  ) {
    const source = resolveProjectSource(this.store, run.teamId, id);
    if (!source) throw notFound();
    if (source.branchId !== this.history.forRun(run).id)
      throw conflict("branch_scope", "Read messages only from this branch.");
    if (
      "exchangeId" in source &&
      !this.all(run).some(
        (m) =>
          ["note", "insight"].includes(m.kind) &&
          m.links.includes(`message:${id}`),
      )
    )
      throw conflict(
        "exchange_source_not_shared",
        "Read this exchange through team_read_exchange. Project source reads cover messages cited by shared notes or insights.",
      );
    const { content: text, ...provenance } = source;
    let end = Math.min(text.length, offset + maxChars);
    const result = () => ({
      ...provenance,
      content: text.slice(offset, end),
      offset,
      characters: text.length,
      nextOffset: end < text.length ? end : null,
    });
    while (end > offset && estimateTokens(result()) > tokenBudget)
      end = offset + Math.floor((end - offset) / 2);
    return result();
  }
}
