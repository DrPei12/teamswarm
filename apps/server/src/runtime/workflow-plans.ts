import { conflict } from "../errors.js";
import { deliverable, threadOf } from "./collaboration-records.js";
import type { RuntimeStore } from "./store.js";
import type { Member, Requirement, Run, Work, WorkflowNode, WorkflowPlan, WorkflowView } from "./types.js";

export class WorkflowPlans {
  constructor(private store: RuntimeStore) {
    store.workflows = this;
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS runtime_workflow_revisions (
        team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        run_id TEXT NOT NULL, revision INTEGER NOT NULL,
        data TEXT NOT NULL CHECK(json_valid(data)), PRIMARY KEY(team_id,run_id,revision));
    `);
    store.changes.track("runtime_workflow_revisions", "workflow", "team_id", true);
  }

  get(run: Run, revision?: number): WorkflowPlan | undefined {
    const row = revision === undefined
      ? this.store.db.prepare(`
        SELECT data FROM runtime_workflow_revisions WHERE team_id=? AND run_id=? ORDER BY revision DESC LIMIT 1
      `).get(run.teamId, run.id)
      : this.store.db.prepare(`
        SELECT data FROM runtime_workflow_revisions WHERE team_id=? AND run_id=? AND revision=?
      `).get(run.teamId, run.id, revision);
    return row ? JSON.parse(String(row.data)) : undefined;
  }

  private works(run: Run, plan: WorkflowPlan) {
    const generations = new Map(plan.nodes.map(node => [node.key, node.generation]));
    return new Map(this.store.workQuery(run.teamId, { runId: run.id })
      .flatMap(work => work.workflowNodeKey && work.workflowRevision! <= plan.revision &&
        generations.get(work.workflowNodeKey) === work.workflowGeneration
        ? [[work.workflowNodeKey, work] as const] : []));
  }

  view(run: Run, revision?: number): WorkflowView | null {
    const plan = this.get(run, revision);
    if (!plan) return null;
    const bindings = this.works(run, plan);
    const members = plan.nodes.some(node => node.assigneeMemberId)
      ? new Map(this.store.list<Member>("members", run.teamId).map(member => [member.id, member.name])) : undefined;
    const verified = new Set([...bindings].filter(([, work]) => this.verified(work) &&
      this.inputsCurrent(work, bindings)).map(([key]) => key));
    return {
      ...plan,
      nodes: plan.nodes.map(node => {
        const work = bindings.get(node.key);
        const assigneeName = node.assigneeMemberId && members?.get(node.assigneeMemberId);
        return {
          ...node, workId: work?.id ?? null, memberId: work?.memberId ?? null, workStatus: work?.status ?? null,
          ...(assigneeName ? { assigneeName } : {}),
          verified: verified.has(node.key),
          ready: (!work || ["failed", "interrupted", "rejected", "superseded"].includes(work.status)) &&
            node.dependsOn.every(key => verified.has(key)),
        };
      }),
    };
  }

  private verified(work: Work) {
    return deliverable(work) && !!work.attemptId && !work.invalidatedByNodeId && !work.supersededByWorkIds?.length &&
      this.store.history!.isCurrent(work, work.attemptId) &&
      (this.store.get<Run>("runs", work.teamId, work.runId).state === "completed" ||
        this.store.workQuery(work.teamId, { threadId: threadOf(work) }).filter(candidate => !candidate.interaction).at(-1)?.id === work.id) &&
      (!work.integratesWorkIds?.length || work.workspaceMode !== "isolated" || work.publication?.state === "published");
  }

  private inputsCurrent(work: Work, bindings: Map<string, Work>) {
    const queue = [work];
    const checked = new Set<string>();
    for (const current of queue) {
      if (checked.has(current.id)) continue;
      checked.add(current.id);
      for (const pin of current.workflowInputs ?? []) {
        const predecessor = bindings.get(pin.nodeKey);
        if (!predecessor || predecessor.id !== pin.workId || predecessor.attemptId !== pin.attemptId ||
            !this.verified(predecessor) ||
            JSON.stringify(predecessor.artifactIds) !== JSON.stringify(pin.artifactIds)) return false;
        queue.push(predecessor);
      }
    }
    return true;
  }

  current(work: Work) {
    const subject = work.reviewOf ? this.store.get<Work>("works", work.teamId, work.reviewOf) : work;
    if (!subject.workflowNodeKey) return true;
    const run = this.store.get<Run>("runs", subject.teamId, subject.runId);
    const plan = this.get(run);
    if (!plan) return false;
    const bindings = this.works(run, plan);
    return bindings.get(subject.workflowNodeKey)?.id === subject.id && this.inputsCurrent(subject, bindings);
  }

  isBound(work: Work) {
    if (!work.workflowNodeKey) return true;
    const run = this.store.get<Run>("runs", work.teamId, work.runId);
    const plan = this.get(run);
    return !!plan && this.works(run, plan).get(work.workflowNodeKey)?.id === work.id;
  }

  assertCurrent(work: Work) {
    if (!this.current(work))
      throw conflict("workflow_input_changed", "The assigned workflow or a predecessor result changed. Reassign this node with the current versions.");
  }

  revise(run: Run, author: Work, attemptId: string, input: {
    expectedRevision: number;
    upsert: (Omit<WorkflowNode, "generation" | "assigneeMemberId"> & { assigneeMemberId?: string | null })[];
    remove: string[];
    renew?: string[];
  }) {
    return this.store.transaction(() => {
      const requirement = this.store.get<Requirement>("requirements", run.teamId, run.requirementId);
      if (run.state !== "active" || requirement.status !== "effective" || !requirement.outcomeRequirementId)
        throw conflict("workflow_outcome_required", "Establish an effective outcome before planning this Run.");
      const prior = this.get(run);
      if ((prior?.revision ?? 0) !== input.expectedRevision)
        throw conflict("workflow_changed", "Read the current workflow revision.");
      const incoming = new Set(input.upsert.map(node => node.key));
      const renewed = new Set(input.renew ?? []);
      if (incoming.size !== input.upsert.length || new Set(input.remove).size !== input.remove.length ||
          renewed.size !== (input.renew?.length ?? 0) || input.remove.some(key => incoming.has(key) || renewed.has(key)))
        throw conflict("workflow_duplicate_node", "Change each workflow node once per revision.");
      const outcome = this.store.get<Requirement>("requirements", run.teamId, requirement.outcomeRequirementId).outcome!;
      const keys = new Set(outcome.specification.criteria.map(criterion => criterion.key));
      const nodes = new Map((prior?.nodes ?? []).map(node => [node.key, node]));
      const generations = new Map(Object.entries(prior?.generations ?? {}));
      const bindings = prior ? this.works(run, prior) : new Map<string, Work>();
      for (const key of renewed) {
        const bound = bindings.get(key);
        const node = nodes.get(key);
        if (!node || !bound || !["accepted", "self_checked", "submitted", "failed", "interrupted", "rejected", "superseded"].includes(bound.status))
          throw conflict("workflow_node_busy", "Finish or reconcile the assigned execution before renewing its node.");
        const generation = node.generation + 1;
        generations.set(key, generation);
        nodes.set(key, { ...node, generation });
      }
      for (const key of input.remove) {
        const existing = bindings.get(key);
        if (!nodes.has(key) || existing && existing.status !== "superseded")
          throw conflict("workflow_node_owned", "Remove an unassigned or superseded workflow node.");
        nodes.delete(key);
      }
      for (const { assigneeMemberId, ...patch } of input.upsert) {
        const priorNode = nodes.get(patch.key);
        const assignee = assigneeMemberId === undefined ? priorNode?.assigneeMemberId : assigneeMemberId;
        const node: WorkflowNode = {
          key: patch.key, title: patch.title,
          dependsOn: [...new Set(patch.dependsOn)].sort(),
          outcomeCriteria: [...new Set(patch.outcomeCriteria)].sort(),
          ...(assignee ? { assigneeMemberId: assignee } : {}),
          generation: priorNode?.generation ?? (generations.get(patch.key) ?? 0) + 1,
        };
        if (node.outcomeCriteria.some(key => !keys.has(key)))
          throw conflict("outcome_criterion_unknown", "Select criterion keys from the agreed outcome.");
        if (bindings.has(node.key) && !renewed.has(node.key) && JSON.stringify(nodes.get(node.key)) !== JSON.stringify(node))
          throw conflict("workflow_node_owned", "Continue or replace the assigned work before changing its workflow node.");
        nodes.set(node.key, node);
        generations.set(node.key, node.generation);
      }
      for (const key of new Set([...incoming, ...renewed])) {
        const assignee = nodes.get(key)?.assigneeMemberId;
        if (!assignee) continue;
        const member = this.store.activeMember(run.teamId, assignee);
        const branch = this.store.history!.forRun(run);
        if (member.kind === "host" || (member.branchId ?? this.store.history!.ensure(run.teamId).id) !== branch.id)
          throw conflict("workflow_assignee_scope", "Choose an active worker from this workflow's project branch.");
      }
      this.assertDag(nodes);
      const ordered = [...nodes.values()].sort((a, b) => a.key.localeCompare(b.key));
      if (prior && JSON.stringify(prior.nodes) === JSON.stringify(ordered))
        return prior;
      const plan: WorkflowPlan = {
        teamId: run.teamId, runId: run.id, outcomeRequirementId: requirement.outcomeRequirementId,
        revision: input.expectedRevision + 1, parentRevision: prior?.revision ?? null,
        authorAttemptId: attemptId, createdAt: new Date().toISOString(), nodes: ordered,
        generations: Object.fromEntries(generations),
      };
      this.store.db.prepare("INSERT INTO runtime_workflow_revisions VALUES(?,?,?,?)")
        .run(run.teamId, run.id, plan.revision, JSON.stringify(plan));
      this.store.event(run.teamId, "workflow.revised", {
        revision: plan.revision, outcomeRequirementId: plan.outcomeRequirementId,
        upsert: [...incoming], remove: input.remove, renew: [...renewed],
      }, author, attemptId);
      return plan;
    });
  }

  admission(run: Run, key?: string, expectedRevision?: number, memberId?: string) {
    const plan = this.get(run);
    if (!plan && !key) return undefined;
    if (!plan || plan.revision !== expectedRevision)
      throw conflict("workflow_changed", "Read the current workflow before dispatch.");
    const node = plan.nodes.find(candidate => candidate.key === key);
    if (!node) throw conflict("workflow_node_required", "Choose a node in the current workflow.");
    if (node.assigneeMemberId && node.assigneeMemberId !== memberId)
      throw conflict("workflow_assignee_changed", "Assign this workflow node to its planned member or revise the plan.");
    const bindings = this.works(run, plan);
    const predecessors = node.dependsOn.map(id => bindings.get(id));
    if (predecessors.some(work => !work || !this.verified(work) || !this.inputsCurrent(work, bindings)))
      throw conflict("workflow_blocked", "Wait for the workflow predecessors to finish verification.");
    return {
      node, revision: plan.revision, existing: bindings.get(node.key),
      inputs: predecessors.map(work => ({
        nodeKey: work!.workflowNodeKey!, workId: work!.id,
        attemptId: work!.attemptId!, artifactIds: [...work!.artifactIds],
      })),
    };
  }

  assertMemberRemovable(teamId: string, memberId: string) {
    const runs = this.store.list<Run>("runs", teamId).filter(run => run.state === "active" || run.state === "paused");
    for (const run of runs) {
      if (!this.get(run)?.nodes.some(node => node.assigneeMemberId === memberId)) continue;
      if (this.view(run)?.nodes.some(node => node.assigneeMemberId === memberId && !node.verified))
        throw conflict("workflow_member_assigned", "Reassign the member's unfinished workflow nodes before removing them.");
    }
  }

  private assertDag(nodes: Map<string, WorkflowNode>) {
    const outgoing = new Map<string, string[]>();
    const incoming = new Map<string, number>();
    for (const node of nodes.values()) {
      incoming.set(node.key, node.dependsOn.length);
      for (const dependency of node.dependsOn) {
        if (!nodes.has(dependency))
          throw conflict("workflow_dependency_missing", `Select an existing workflow dependency for ${node.key}.`);
        const targets = outgoing.get(dependency) ?? [];
        targets.push(node.key);
        outgoing.set(dependency, targets);
      }
    }
    const ready = [...incoming].filter(([, count]) => count === 0).map(([key]) => key);
    for (const key of ready) {
      for (const dependant of outgoing.get(key) ?? []) {
        const remaining = incoming.get(dependant)! - 1;
        incoming.set(dependant, remaining);
        if (!remaining) ready.push(dependant);
      }
    }
    if (ready.length !== nodes.size)
      throw conflict("workflow_cycle", "Workflow dependencies must be acyclic.");
  }
}
