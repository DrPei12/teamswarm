import type { TranscriptItem } from "@team/contracts/product";

type RecordValue = Record<string, unknown>;
export type ActivityGroup = {
  id: string;
  kind: "context" | "delegation" | "item";
  items: TranscriptItem[];
};
const contextTools = new Set([
  "team_state",
  "team_project_context",
  "team_inbox",
  "team_read_artifact",
  "team_review_evidence",
  "team_native_evidence",
]);
const delegationTools = new Set(["team_add_member", "team_delegate"]);

export function toolValue(text?: string): RecordValue {
  try {
    let value: unknown = JSON.parse(text || "{}");
    for (let depth = 0; depth < 4; depth++) {
      if (Array.isArray(value))
        value =
          value.find((v) => v && typeof v === "object" && "text" in v) ??
          value[0];
      else if (
        value &&
        typeof value === "object" &&
        "type" in value &&
        "text" in value &&
        typeof value.text === "string"
      ) {
        const body = value.text;
        try {
          value = JSON.parse(body);
        } catch {
          return { message: body };
        }
      } else break;
    }
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as RecordValue)
      : {};
  } catch {
    return {};
  }
}
export const field = (object: RecordValue, key: string) =>
  typeof object[key] === "string" ? (object[key] as string) : "";

export function groupActivity(items: TranscriptItem[]): ActivityGroup[] {
  const groups: ActivityGroup[] = [];
  let context: ActivityGroup | undefined;
  let delegation: ActivityGroup | undefined;
  for (const item of items) {
    if (item.kind === "tool" && contextTools.has(item.title ?? "")) {
      if (!context) {
        context = { id: item.id, kind: "context", items: [] };
        groups.push(context);
      }
      context.items.push(item);
    } else if (item.kind === "tool" && delegationTools.has(item.title ?? "")) {
      if (!delegation) {
        delegation = { id: item.id, kind: "delegation", items: [] };
        groups.push(delegation);
      }
      delegation.items.push(item);
    } else groups.push({ id: item.id, kind: "item", items: [item] });
  }
  return groups;
}

export function delegationRows(
  items: TranscriptItem[],
  members: { id: string; name: string }[],
) {
  const rows: {
    id: string;
    name: string;
    responsibility: string;
    created?: TranscriptItem;
    assignments: TranscriptItem[];
  }[] = [];
  const names = new Map(members.map((m) => [m.id, m.name]));
  for (const item of items.filter((i) => i.title === "team_add_member")) {
    const args = toolValue(item.text),
      result = toolValue(item.output);
    const id = field(result, "id") || item.id;
    const name = field(args, "name") || field(result, "name");
    if (name && item.status === "completed") names.set(id, name);
    rows.push({
      id,
      name,
      responsibility: field(args, "responsibility"),
      created: item,
      assignments: [],
    });
  }
  for (const item of items.filter((i) => i.title === "team_delegate")) {
    const args = toolValue(item.text),
      id = field(args, "memberId");
    let row = rows.find(
      (row) => row.id === id && row.created?.status === "completed",
    );
    if (!row) {
      row = {
        id: item.id,
        name: names.get(id) || "",
        responsibility: "",
        assignments: [],
      };
      rows.push(row);
    }
    row.assignments.push(item);
  }
  return rows;
}
