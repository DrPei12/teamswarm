import { canReallocateWork } from "./allocation-contract.js";
import type { Member, Requirement, Run, Work } from "./types.js";

const formal = (work: Work) =>
  !work.interaction &&
  !work.collaborationExchangeId &&
  (!work.kind || work.kind === "task");

type AllocationState = {
  works: Work[];
  runs: Run[];
  requirements: Requirement[];
};

export function historicalAllocationWork(state: AllocationState): Set<string> {
  const runs = new Map(state.runs.map((run) => [run.id, run]));
  const replaced = new Set(
    state.requirements
      .filter((item) => item.status === "effective")
      .flatMap((item) => item.affectedWorkIds),
  );
  const byId = new Map(state.works.map((task) => [task.id, task]));
  // A continuation owns its predecessor's outstanding responsibility on this branch.
  // Mail received on the same thread is not a production continuation.
  for (const task of state.works) {
    if (
      runs.get(task.runId)?.state === "completed" ||
      task.invalidatedByNodeId ||
      task.supersededByWorkIds?.length
    )
      replaced.add(task.id);
    const previous = task.continuationOf && byId.get(task.continuationOf);
    if (!previous || !formal(task) || !formal(previous)) continue;
    const run = runs.get(task.runId),
      original = runs.get(previous.runId);
    if (
      run &&
      original &&
      (run.branchId ?? run.conversationId) ===
        (original.branchId ?? original.conversationId)
    )
      replaced.add(previous.id);
  }
  return replaced;
}

export function allocationTaskIds(
  state: AllocationState & { members: Member[] },
): string[] {
  const workers = new Set(
    state.members
      .filter((member) => member.kind === "member" && !member.removedAt)
      .map((member) => member.id),
  );
  const runs = new Set(state.runs.map((run) => run.id));
  const past = historicalAllocationWork(state);
  return state.works
    .filter(
      (task) =>
        formal(task) &&
        workers.has(task.memberId) &&
        runs.has(task.runId) &&
        canReallocateWork(task.status) &&
        !past.has(task.id),
    )
    .map((task) => task.id);
}
