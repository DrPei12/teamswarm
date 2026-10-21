import type { Chat, Definition, Workspace } from "./store";

export const definitionLabels = {
  problem: "Problem",
  requirement: "Requirement",
  goal: "Goal",
  understanding: "Understanding",
};

export function definitionsAt(
  workspace: Workspace,
  chat: Chat,
  messageId: string,
): Definition[] {
  const end = chat.messages.findIndex((m) => m.id === messageId);
  if (end < 0) throw new Error("This point is no longer available.");
  const included = new Set(chat.messages.slice(0, end + 1).map((m) => m.id));
  const retained = chat.inheritedDefinitions || [];
  // An imported item is pinned to its original version. No later branch is traversed.
  const local = workspace.definitions.filter(
    (d) =>
      d.teamId === chat.teamId &&
      d.chatId === chat.id &&
      included.has(d.messageId),
  );
  return [...new Map([...retained, ...local].map((d) => [d.id, d])).values()];
}

export function forkAt(
  workspace: Workspace,
  chatId: string,
  messageId: string,
  selectedIds: string[],
  title: string,
): { workspace: Workspace; chat: Chat } {
  const source = workspace.chats.find((c) => c.id === chatId);
  if (!source) throw new Error("Conversation not found.");
  const end = source.messages.findIndex((m) => m.id === messageId);
  if (end < 0) throw new Error("This point is no longer available.");
  const explicit = selectedIds.map((id) =>
    workspace.definitions.find(
      (d) => d.id === id && d.teamId === source.teamId,
    ),
  );
  if (explicit.some((d) => !d))
    throw new Error("A selected item is no longer available.");
  const inheritedDefinitions = [
    ...new Map(
      [
        ...definitionsAt(workspace, source, messageId),
        ...(explicit as Definition[]),
      ].map((d) => [d.id, d]),
    ).values(),
  ];
  const chat: Chat = {
    id: crypto.randomUUID(),
    teamId: source.teamId,
    title: title.trim() || "New direction",
    createdAt: Date.now(),
    starred: false,
    parent: { chatId, messageId },
    messages: structuredClone(source.messages.slice(0, end + 1)),
    inheritedDefinitions: structuredClone(inheritedDefinitions),
  };
  return {
    chat,
    workspace: {
      ...workspace,
      chats: [...workspace.chats, chat],
      teams: workspace.teams.map((t) =>
        t.id === source.teamId
          ? { ...t, lastChatId: chat.id, context: undefined }
          : t,
      ),
    },
  };
}

export function ownMessages(chat: Chat, chats: Chat[]) {
  const parent = chats.find((c) => c.id === chat.parent?.chatId);
  if (!parent || !chat.parent) return chat.messages;
  const at = parent.messages.findIndex((m) => m.id === chat.parent?.messageId);
  const inherited = new Set(parent.messages.slice(0, at + 1).map((m) => m.id));
  return chat.messages.filter((m) => !inherited.has(m.id));
}
