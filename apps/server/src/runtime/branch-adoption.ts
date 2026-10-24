import { z } from "zod";
import { conflict } from "../errors.js";
import { definitionInput, type ProjectHistory } from "./project-history.js";
import type { CollaborationRecords } from "./collaboration-records.js";
import type { RuntimeStore } from "./store.js";
import type { Member, Run, Work } from "./types.js";

const id = z.string().min(1).max(200);
export const adoptionContextInput = z.object({
  authorizationQuote: z.string().trim().min(2).max(20000),
}).strict();
export const adoptionInput = z.object({
  authorizationQuote: z.string().trim().min(2).max(20000),
  expectedSourceHeadId: id,
  insightIds: z.array(id).min(1).max(20),
  definition: definitionInput,
}).strict();

// Require a direct decision, not a mention, example, question or conditional proposal.
function explicitDecision(text: string) {
  const plain = text.replace(/```[\s\S]*?```|`[^`]*`|「[^」]*」|“[^”]*”|"[^"]*"/g, " ");
  // Evaluate restrictions before sentence selection: later retractions and quoted
  // examples cannot turn into permission merely because they follow a newline.
  if (/(?:原话|例句|示例|例如|引用|假设|比如)[：:]|(?:下面|以下).{0,40}(?:原话|例句|示例)|(?:采用|采纳|合并).{0,30}(?:意味着什么|什么意思|含义)|(?:先不要|暂不|尚未|先不|不要|不能|不应|还没|撤回|取消|暂缓|推迟|别).{0,60}(?:正式采用|采用|采纳|合并|融入|主线)|(?:我还|需要再|等我).{0,30}(?:确认|决定)|\b(?:example|quotation|hypothetical|retract|cancel|do not adopt|don't adopt|do not merge|don't merge)\b/i.test(plain)) return false;
  if (/[?？]|(?:如果|假如|等到|是否|能否|要不要|前提|条件是|的话|否则|仅当|等一下)|\b(?:if|unless|should|could|whether|until|pending|provided|wait|hold off|only after|only when|subject to)\b/i.test(plain)) return false;
  return [plain.trim().replace(/^(?:(?:好的|可以|同意)[，,\s]*|yes[,\s]+)+/i, "").split(/[。！!\n]/)[0]].some(sentence => {
    if (/[?？]|(?:如果|假如|等到|是否|能否|要不要|前提|条件是|的话)|\b(?:if|unless|should|could|whether)\b/i.test(sentence)) return false;
    const action = sentence.split(/[，,；;]/)[0].trim();
    if (/[?？]|(?:如果|假如|等到|是否|能否|要不要|不要|暂不|尚未|先不|不想|不应|不能|并非|不是|还没)|\b(?:if|unless|not|don't|should|could|whether)\b/i.test(action)) return false;
    return /^(?:(?:现在|请|我决定|我确认|确定|那就|就|好的)[，,\s]*)*(?:正式采用|正式采纳|合回主线|合并到主线|将.+(?:融入|合并到)主线|把.+(?:融入|合并到)主线)(?:[^?？]*)$/i.test(action) || /^(?:please\s+)?(?:adopt\s+(?:this|the|our)|merge\s+.+\s+(?:into|to)\s+(?:the\s+)?mainline)\b[^?？]*$/i.test(action);
  });
}

/** An explicit user turn grants this bounded source -> mainline operation only. */
export class BranchAdoption {
  constructor(readonly store: RuntimeStore, readonly history: ProjectHistory, readonly records: CollaborationRecords) {}
  private authorize(work: Work, run: Run, quote: string) {
    const messages = this.store.teams.getConversationDetail(work.teamId, run.conversationId)?.messages ?? [];
    const message = messages.find(m => m.id === run.sourceMessageId);
    const latestUser = messages.filter(m => m.role === "user").at(-1);
    if (work.kind === "host-followup" || work.kind === "collaboration" || work.interaction ||
        message?.role !== "user" || latestUser?.id !== message.id || message.content.trim() !== quote.trim() ||
        !explicitDecision(quote))
      throw conflict("adoption_authorization_required", "Use the current user's explicit adoption decision and exact quotation; proposals and background events cannot authorize adoption.");
    const source = this.history.forRun(run), main = this.history.ensure(work.teamId);
    if (source.id === main.id) throw conflict("adoption_source_required", "Continue in the source branch to adopt its ideas into the mainline.");
    return { source, main, message };
  }
  context(work: Work, run: Run, quote: string) {
    const { source, main, message } = this.authorize(work, run, quote);
    return {
      authorization: { messageId: message.id, quote },
      source: this.history.context(work.teamId, source.id),
      base: source.baseNodeId ? this.history.detail(work.teamId, source.baseNodeId) : null,
      mainline: this.history.context(work.teamId, main.id),
      insights: this.records.insights(work.teamId, source.id),
      mainlineWork: this.store.list<Work>("works", work.teamId)
        .filter(w => this.store.get<Member>("members", work.teamId, w.memberId).kind !== "host" && !w.invalidatedByNodeId && ["queued", "running", "waiting", "submitted", "reviewing"].includes(w.status) && this.history.forRun(this.store.get<Run>("runs", work.teamId, w.runId)).id === main.id)
        .map(w => ({ id: w.id, title: w.title, instructions: w.instructions, status: w.status, acceptanceCriteria: w.acceptanceCriteria })),
      guidance: "Integrate only the explicitly adopted scope. Preserve unrelated current mainline content. Reconcile base/source/current mainline; ask only for a substantive unresolved decision. Submit complete document replacements, cite exact current insight IDs, and use both observed heads. Inspect mainlineWork for responsibilities made obsolete by the decision; put only those IDs in affectedWorkIds to stop or supersede them. Unchanged responsibilities stay intact and must read/apply current project context before completing. Adoption updates project documents; it does not authorize code implementation.",
    };
  }
  adopt(work: Work, run: Run, input: z.infer<typeof adoptionInput>) {
    this.authorize(work, run, input.authorizationQuote);
    // One decision has one atomic commit, including after a crash or a tool retry.
    return this.store.once(`branch-adoption:${work.teamId}`, run.sourceMessageId, input, () => this.store.transaction(() => {
      const { source, main } = this.authorize(work, run, input.authorizationQuote);
      if (source.headNodeId !== input.expectedSourceHeadId)
        throw conflict("history_conflict", "The source branch changed. Read adoption context again.");
      const ideas = this.records.insights(work.teamId, source.id);
      const selected = input.insightIds.map(id => ideas.find(i => i.id === id));
      const merged = new Set<string>();
      const revisions = this.records.insights(work.teamId, source.id, true);
      for (let cursor = 0; ;) {
        const page = this.history.timeline(work.teamId, cursor, 500);
        for (const node of page.nodes) for (const id of node.source.adoption?.insightIds ?? []) {
          const revision = revisions.find(i => i.id === id);
          if (revision) merged.add(`${revision.key}:${revision.content}`);
        }
        if (page.nodes.length < 500) break;
        cursor = page.nextCursor;
      }
      if (new Set(input.insightIds).size !== input.insightIds.length || selected.some(i => !i || !["proposed", "adopted"].includes(i.status) || merged.has(`${i.key}:${i.content}`)))
        throw conflict("adoption_insight_conflict", "Choose current unmerged ideas from this source branch; already adopted ideas remain in their previous merge.");
      const node = this.history.publish(work.teamId, main.id, input.definition, {
        actor: "host", workId: work.id, conversationId: run.conversationId,
        messageIds: [run.sourceMessageId],
        adoption: {
          sourceBranchId: source.id, sourceNodeId: source.headNodeId,
          baseNodeId: source.baseNodeId!, insightIds: input.insightIds,
          authorizationQuote: input.authorizationQuote,
          ideas: selected.map(i => ({ id: i!.id, title: i!.title, content: i!.content, sourceMessageIds: i!.sourceMessageIds })),
          changedKeys: [...input.definition.documents.map(d => d.key), ...input.definition.removeKeys],
        },
      }, "merge");
      for (const idea of selected) this.records.saveInsight(work.teamId, source.id, {
        key: idea!.key, expectedRevision: idea!.revision, kind: idea!.kind, status: "adopted",
        title: idea!.title, content: idea!.content, reason: input.definition.reason || input.definition.title,
        sourceMessageIds: [run.sourceMessageId],
      }, "host", work.id);
      const mainChat = this.history.mainConversation(work.teamId);
      this.store.appendAssistant({ ...run, conversationId: mainChat },
        `已正式采用「${source.name}」中的想法：${selected.map(i => i!.title).join("、")}。\n\n${input.definition.reason || input.definition.title}\n\n主线文档：${input.definition.documents.map(d => d.title).join("、")}。原分支与讨论来源已保留，可在历史画布的合并节点查看。`, `adoption:${node.id}`);
      this.store.event(work.teamId, "project.branch_adopted", { nodeId: node.id, sourceBranchId: source.id, mainBranchId: main.id, sourceMessageId: run.sourceMessageId }, work);
      return { node, mainConversationId: mainChat, project: this.history.context(work.teamId, main.id) };
    }));
  }
}
