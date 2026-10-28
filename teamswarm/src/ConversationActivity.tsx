import { memo, useState } from "react";
import { Disclosure as ActivityBody } from "./Disclosure";
import {
  ChevronRight,
  FileCode2,
  Terminal,
  Wrench,
  Circle,
  Users,
  BookOpen,
} from "lucide-react";
import type { TranscriptItem } from "@team/contracts/product";
import { MessageContent } from "./MessageContent";
import { useI18n } from "./i18n";
import {
  groupActivity,
  delegationRows,
  toolValue,
  canExpandActivity,
  field,
  type ActivityGroup,
} from "./activityPresentation.ts";

function GroupedActivity({
  group,
  members,
}: {
  group: ActivityGroup;
  members: { id: string; name: string }[];
}) {
  const { t } = useI18n();
  const failed = group.items.some(
    (i) => i.status === "failed" || i.status === "interrupted",
  );
  const running = group.items.some((i) => i.status === "running");
  if (group.kind === "context")
    return (
      <div
        className={`activity-item activity-context ${failed ? "failed" : running ? "running" : ""}`}
      >
        <BookOpen size={15} />
        <span>{t("Read project context")}</span>
        {failed && <small>{t("Some context could not be read")}</small>}
        {group.items
          .filter((i) => i.status === "failed" || i.status === "interrupted")
          .map((i) => (
            <ActionError key={i.id} item={i} />
          ))}
        {running && <small>{t("Running…")}</small>}
      </div>
    );
  const names = [
    ...new Set(
      delegationRows(group.items, members)
        .map((row) => row.name)
        .filter(Boolean),
    ),
  ];
  return (
    <div
      className={`activity-item ${failed ? "failed" : running ? "running" : ""}`}
    >
      <div className="activity-summary-row">
        <Users size={15} />
        <span>
          {t("Create members and assign work")}
          {names.length ? ` · ${names.join("、")}` : ""}
        </span>
        {failed && <small>{t("Needs attention")}</small>}
      </div>
      {group.items.map((item) => (
        <ActionError key={item.id} item={item} />
      ))}
    </div>
  );
}

function ActionError({ item }: { item: TranscriptItem }) {
  const { t } = useI18n();
  if (item.status !== "failed" && item.status !== "interrupted") return null;
  const result = toolValue(item.output);
  return (
    <small className="session-status">
      {field(result, "error") ||
        field(result, "message") ||
        t("This action did not complete.")}
    </small>
  );
}

function ToolDetails({ item }: { item: TranscriptItem }) {
  const args = toolValue(item.text);
  if (item.title === "team_write_file")
    return (
      <>
        <pre>{field(args, "text")}</pre>
        <ActionError item={item} />
      </>
    );
  if (item.title === "team_edit_file")
    return (
      <>
        <pre className="activity-diff-before">{field(args, "oldText")}</pre>
        <pre className="activity-diff-after">{field(args, "newText")}</pre>
        <ActionError item={item} />
      </>
    );
  return (
    <>
      {item.text && <pre>{item.text}</pre>}
      {item.output && <pre className="activity-output">{item.output}</pre>}
    </>
  );
}

const toolLabels: Record<string, string> = {
  team_write_file: "Wrote file",
  team_edit_file: "Edited file",
  team_read_work: "Read work details",
  team_read_file: "Read file",
  team_review: "Request independent review",
  team_directory: "Read execution resources",
  team_directory_detail: "Read resource details",
  team_check_resource: "Check execution connection",
  team_select_resource: "Select execution resource",
  team_derive_resource: "Save model choice",
  team_project_context: "Read project context",
  team_adoption_context: "Read project context",
  team_adopt_branch: "Adopt ideas into mainline",
  team_save_insight: "Preserve an idea",
  team_state: "Read team progress",
  team_submit_result: "Submit work result",
  team_read_artifact: "Read submitted file",
  team_accept_work: "Record independent review",
  team_review_evidence: "Read verification evidence",
  team_message: "Send collaboration message",
  team_inbox: "Read member messages",
  team_delegate: "Assign work",
  team_add_member: "Create member",
  team_define_requirements: "Confirm requirements",
  team_publish_definition: "Update shared project context",
};
function commandLabel(command: string) {
  const shell = command.match(
    /(?:^|[\\/])(?:pwsh|powershell)(?:\.exe)?["']?\s+.*?-(?:Command|c)\s+([\s\S]*)$/i,
  );
  return (shell?.[1] ?? command).replace(/^(['"])([\s\S]*)\1$/, "$2");
}

const ActivityItem = memo(function ActivityItem({
  item,
}: {
  item: TranscriptItem;
}) {
  const { t } = useI18n();
  const [choice, setChoice] = useState<boolean | null>(null);
  const open = choice ?? false;
  if (item.kind === "message")
    return (
      <MessageContent text={item.text} pending={item.status === "running"} />
    );
  const Icon =
    item.kind === "command"
      ? Terminal
      : item.kind === "file" ||
          ["team_write_file", "team_edit_file"].includes(item.title ?? "")
        ? FileCode2
        : item.kind === "reasoning"
          ? Circle
          : Wrench;
  const filePath = ["team_write_file", "team_edit_file"].includes(
    item.title ?? "",
  )
    ? field(toolValue(item.text), "path").split(/[\\/]/).at(-1)
    : undefined;
  const title =
    (item.kind === "command"
      ? t(
          item.status === "running"
            ? "Running {command}"
            : item.status === "completed"
              ? "Ran {command}"
              : "Command did not complete: {command}",
          { command: commandLabel(item.title || item.text) },
        )
      : item.title
        ? [t(toolLabels[item.title] ?? item.title), filePath]
            .filter(Boolean)
            .join(" ")
        : "") ||
    (item.kind === "reasoning"
      ? t("Thinking")
      : item.kind === "file"
        ? item.changes?.map((c) => c.path.split(/[\\/]/).at(-1)).join(", ") ||
          t("File changes")
        : t("Tool activity"));
  if (!canExpandActivity(item))
    return (
      <div className={`activity-item ${item.status}`}>
        <div className="activity-summary-row">
          <Icon size={15} />
          <span title={title}>{title}</span>
        </div>
        <ActionError item={item} />
      </div>
    );
  return (
    <div className={`activity-item ${item.status}`}>
      <button
        className="activity-toggle"
        aria-expanded={open}
        onClick={() => setChoice(!open)}
      >
        <Icon size={15} />
        <span title={title}>{title}</span>
        <ChevronRight size={13} className={open ? "expanded" : ""} />
        {item.exitCode != null && item.exitCode !== 0 && (
          <small>
            {t("Exit code")} {item.exitCode}
          </small>
        )}
      </button>
      <ActivityBody open={open} className="activity-body">
        {item.kind === "reasoning" ? (
          <MessageContent
            text={item.text || t("Waiting for progress…")}
            pending={item.status === "running"}
          />
        ) : (
          <>
            <ToolDetails item={item} />
            {item.changes?.map((change, index) => (
              <div className="activity-change" key={`${change.path}:${index}`}>
                <span>
                  {change.kind} · {change.path}
                </span>
                {change.diff && <pre>{change.diff}</pre>}
              </div>
            ))}
            {item.truncated && <small>{t("Output truncated")}</small>}
            {!item.output &&
              !item.changes?.length &&
              item.status === "running" && <span>{t("Running…")}</span>}
          </>
        )}
      </ActivityBody>
    </div>
  );
});

export const ConversationActivity = memo(function ConversationActivity({
  items,
  running = false,
  elapsedMs,
  members = [],
}: {
  items: TranscriptItem[];
  running?: boolean;
  elapsedMs?: number;
  members?: { id: string; name: string }[];
}) {
  const { t } = useI18n();
  const [choice, setChoice] = useState<boolean | null>(null);
  const open = choice ?? running;
  if (!items.length) return null;
  const seconds = Math.max(1, Math.round((elapsedMs ?? 0) / 1000));
  return (
    <div className={`conversation-activity ${running ? "running" : ""}`}>
      <button
        className="activity-summary"
        aria-expanded={open}
        onClick={() => setChoice(!open)}
      >
        <span>
          {running
            ? t("Working…")
            : elapsedMs == null
              ? t("Work activity")
              : t("Worked for {duration}", {
                  duration:
                    seconds >= 60
                      ? `${Math.floor(seconds / 60)}m ${seconds % 60}s`
                      : `${seconds}s`,
                })}
        </span>
        <ChevronRight size={14} className={open ? "expanded" : ""} />
      </button>
      <ActivityBody open={open} className="activity-items">
        {groupActivity(items).map((group) =>
          group.kind === "item" ? (
            <ActivityItem item={group.items[0]} key={group.id} />
          ) : (
            <GroupedActivity group={group} members={members} key={group.id} />
          ),
        )}
      </ActivityBody>
    </div>
  );
});

export function modelLabel(model: string, effort?: string) {
  const display = model
    .replace(/^gpt-/i, "GPT-")
    .replace(
      /-(astra|sol|luna|terra|codex)(?=$|-)/gi,
      (_, part: string) =>
        ` ${part[0].toUpperCase()}${part.slice(1).toLowerCase()}`,
    );
  return effort && effort !== "Default"
    ? `${display} · ${effort[0].toUpperCase()}${effort.slice(1)}`
    : display;
}
