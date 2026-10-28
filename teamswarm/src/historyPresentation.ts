import type { ProjectNode } from "@team/contracts/runtime";

/** Skip removed manual checkpoints without changing the underlying ancestry. */
export function visibleHistoryNodeId(
  records: ProjectNode[],
  id: string | null,
): string | null {
  const byId = new Map(records.map((node) => [node.id, node]));
  return visibleAncestor(byId, id);
}

function visibleAncestor(
  byId: Map<string, ProjectNode>,
  id: string | null,
): string | null {
  const visited = new Set<string>();
  while (id && byId.get(id)?.deletedAt) {
    if (visited.has(id)) return null;
    visited.add(id);
    id = byId.get(id)!.parentNodeId;
  }
  return id;
}

export function visibleHistory(records: ProjectNode[]): ProjectNode[] {
  const byId = new Map(records.map((node) => [node.id, node]));
  return records
    .filter((node) => !node.deletedAt)
    .map((node) => ({
      ...node,
      parentNodeId: visibleAncestor(byId, node.parentNodeId),
    }));
}
