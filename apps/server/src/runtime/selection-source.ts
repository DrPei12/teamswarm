import type { ResourceSelection } from "@team/contracts/allocation";
import type { RuntimeStore } from "./store.js";

type Assignment = {
  selection?: ResourceSelection | null;
  selectionSource?: "runtime" | "resource-panel";
};

type Target = "host" | "member" | "work";
const signature = (target: Target, id: string, pin: ResourceSelection) =>
  JSON.stringify([target, id, pin.resourceId, pin.resourceVersion, pin.reason]);

/** Resolve future defaults without modifying stored assignments or attempt snapshots. */
export class RuntimeSelections {
  private legacyHostReceipts = new Map<string, Set<string>>();
  constructor(
    private readonly store: RuntimeStore,
    private readonly panelEnabled: boolean,
  ) {}

  active(
    teamId: string,
    target: Target,
    id: string,
    owner?: Assignment,
  ): ResourceSelection | null {
    const pin = owner?.selection;
    if (!pin) return null;
    if (this.panelEnabled || owner.selectionSource === "runtime") return pin;
    if (owner.selectionSource === "resource-panel") return null;
    // These are the write formats used by earlier shipped clients. Other untagged pins keep their meaning.
    const legacyPanel =
      pin.reason === "Selected by user" ||
      (target === "member" &&
        pin.reason.startsWith("Member default set for ")) ||
      (target === "work" && pin.reason.startsWith("Task resource set for "));
    if (!legacyPanel) return pin;
    // A Host could have used the same free text. Its durable action receipt takes precedence.
    return this.legacyHostSelections(teamId).has(signature(target, id, pin))
      ? pin
      : null;
  }

  private legacyHostSelections(teamId: string): Set<string> {
    const cached = this.legacyHostReceipts.get(teamId);
    if (cached) return cached;
    const keys = new Set<string>();
    const actions = this.store.db
      .prepare(
        `
      SELECT json_extract(r.result,'$.target') AS target,
             coalesce(json_extract(r.result,'$.targetId'),json_extract(r.result,'$.memberId'),json_extract(r.result,'$.workId'),json_extract(r.result,'$.branchId')) AS id,
             json_extract(r.result,'$.selection') AS pin
        FROM runtime_attempts a JOIN runtime_receipts r ON r.scope=a.id
       WHERE a.team_id=? AND json_extract(r.result,'$.effective')='next_attempt'
         AND json_extract(r.result,'$.target') IN ('host','member','work') AND json_type(r.result,'$.selection')='object'
    `,
      )
      .all(teamId);
    for (const row of actions)
      keys.add(
        signature(
          row.target as Target,
          String(row.id),
          JSON.parse(String(row.pin)),
        ),
      );
    const creations = this.store.db
      .prepare(
        "SELECT data FROM runtime_events WHERE team_id=? AND type='member.resource_selected' AND attempt_id IS NOT NULL",
      )
      .all(teamId);
    for (const row of creations) {
      const data = JSON.parse(String(row.data));
      if (data.pinned !== false)
        keys.add(signature("member", data.memberId, data));
    }
    this.legacyHostReceipts.set(teamId, keys);
    return keys;
  }
}
