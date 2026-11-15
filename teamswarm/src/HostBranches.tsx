import { GitBranch, MoreHorizontal, Trash2 } from "lucide-react";
import { IconButton, Menu, MenuItem } from "./ui";
import { useI18n } from "./i18n";
import type { Workspace } from "./store";

type BranchLink = { chatId: string; title: string; children: BranchLink[] };

export function collectHostBranches(
  workspace: Workspace,
): Map<string, BranchLink[]> {
  const visibleChats = workspace.chats.filter(
    (chat) => !chat.archived && chat.kind !== "side" && chat.branchId,
  );
  const branchChats = new Map<string, (typeof visibleChats)[number]>();
  const nodes = new Map(workspace.projectNodes?.map((node) => [node.id, node]));
  const chatsById = new Map(visibleChats.map((chat) => [chat.id, chat]));
  for (const chat of visibleChats) {
    if (chat.branchId && !branchChats.has(chat.branchId))
      branchChats.set(chat.branchId, chat);
  }
  const roots = new Map<string, BranchLink[]>();
  const links = new Map<string, BranchLink>();
  for (const branch of workspace.projectBranches ?? []) {
    const chat = branchChats.get(branch.id);
    if (branch.baseNodeId && chat)
      links.set(branch.id, {
        chatId: chat.id,
        title: chat.title,
        children: [],
      });
  }
  for (const branch of workspace.projectBranches ?? []) {
    const link = links.get(branch.id);
    if (!link || !branch.baseNodeId) continue;
    const chat = branchChats.get(branch.id)!;
    const parentId =
      (chat.parent ? chatsById.get(chat.parent.chatId)?.branchId : undefined) ??
      nodes.get(branch.baseNodeId)?.branchId;
    const parent =
      parentId && parentId !== branch.id ? links.get(parentId) : undefined;
    if (parent) parent.children.push(link);
    else {
      const list = roots.get(branch.teamId) ?? [];
      list.push(link);
      roots.set(branch.teamId, list);
    }
  }
  return roots;
}

export function HostBranches({
  branches,
  activeChat,
  onOpen,
  onRemove,
}: {
  branches: BranchLink[];
  activeChat?: string;
  onOpen: (chatId: string) => void;
  onRemove: (chatId: string) => void;
}) {
  const { t } = useI18n();
  if (!branches.length) return null;
  return (
    <ul className="host-branches">
      {branches.map((branch) => (
        <li key={branch.chatId}>
          <div className="host-branch-row">
            <button
              type="button"
              className={`nav-row host-branch-link ${activeChat === branch.chatId ? "active" : ""}`}
              aria-current={activeChat === branch.chatId ? "page" : undefined}
              title={branch.title}
              onClick={() => onOpen(branch.chatId)}
            >
              <GitBranch size={13} />
              <span>{branch.title}</span>
            </button>
            <Menu
              trigger={
                <IconButton label={t("Branch options")}>
                  <MoreHorizontal size={15} />
                </IconButton>
              }
            >
              <MenuItem
                icon={<Trash2 size={15} />}
                onSelect={() => onRemove(branch.chatId)}
              >
                {t("Delete chat")}
              </MenuItem>
            </Menu>
          </div>
          <HostBranches
            branches={branch.children}
            activeChat={activeChat}
            onOpen={onOpen}
            onRemove={onRemove}
          />
        </li>
      ))}
    </ul>
  );
}
