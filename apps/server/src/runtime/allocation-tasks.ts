import type { Member, Requirement, Run, Work } from "./types.js";

const editable = new Set<Work["status"]>(["queued", "waiting", "yielded", "failed", "interrupted", "rejected"]);

export function allocationTaskIds(state: { members: Member[]; works: Work[]; runs: Run[]; requirements: Requirement[] }): string[] {
  const workers = new Set(state.members.filter(member => member.kind === "member" && !member.removedAt).map(member => member.id));
  const runs = new Map(state.runs.map(run => [run.id, run]));
  const replaced = new Set(state.requirements.filter(item => item.status === "effective").flatMap(item => item.affectedWorkIds));
  const tasks = state.works.filter(work =>
    !work.interaction && !work.collaborationExchangeId && (!work.kind || work.kind === "task"));
  const byId = new Map(tasks.map(task => [task.id, task]));
  // A continuation owns its predecessor's outstanding responsibility on this branch.
  // Mail received on the same thread is not a production continuation.
  for (const task of tasks) {
    const previous = task.continuationOf && byId.get(task.continuationOf);
    if (!previous) continue;
    const run = runs.get(task.runId), original = runs.get(previous.runId);
    if (run && original && (run.branchId ?? run.conversationId) === (original.branchId ?? original.conversationId))
      replaced.add(previous.id);
  }
  return tasks.filter(task => {
    const run = runs.get(task.runId);
    return workers.has(task.memberId) && run && run.state !== "completed" && editable.has(task.status) &&
      !task.invalidatedByNodeId && !task.supersededByWorkIds?.length && !replaced.has(task.id);
  }).map(task => task.id);
}
