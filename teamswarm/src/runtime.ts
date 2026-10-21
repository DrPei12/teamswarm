import type {
  Connection,
  Definition,
  Delivery,
  Member,
  Message,
  Workspace,
} from "./store";

export type TeamEvent =
  | {
      id: string;
      teamId: string;
      type: "message";
      chatId: string;
      message: Message;
    }
  | { id: string; teamId: string; type: "definition"; definition: Definition }
  | { id: string; teamId: string; type: "delivery"; delivery: Delivery }
  | { id: string; teamId: string; type: "member"; member: Member }
  | { id: string; teamId: string; type: "connection"; connection: Connection }
  | {
      id: string;
      teamId: string;
      type: "context";
      used: number;
      limit: number;
    };

export function applyTeamEvent(
  workspace: Workspace,
  event: TeamEvent,
): Workspace {
  if (!workspace.teams.some((t) => t.id === event.teamId))
    throw new Error("Team not found.");
  if (workspace.eventIds?.includes(event.id)) return workspace;
  let next: Workspace = {
    ...workspace,
    eventIds: [...(workspace.eventIds || []), event.id].slice(-2000),
  };
  const hasMessage = (chatId: string, messageId: string) =>
    workspace.chats.some(
      (c) =>
        c.id === chatId &&
        c.teamId === event.teamId &&
        c.messages.some((m) => m.id === messageId),
    );
  if (event.type === "message") {
    if (
      !workspace.chats.some(
        (c) => c.id === event.chatId && c.teamId === event.teamId,
      )
    )
      throw new Error("Conversation not found.");
    next = {
      ...next,
      chats: workspace.chats.map((c) =>
        c.id === event.chatId &&
        !c.messages.some((m) => m.id === event.message.id)
          ? { ...c, messages: [...c.messages, event.message] }
          : c,
      ),
    };
  } else if (event.type === "definition") {
    const d = event.definition;
    if (d.teamId !== event.teamId || !hasMessage(d.chatId, d.messageId))
      throw new Error("Definition source not found.");
    if (workspace.definitions.some((item) => item.id === d.id))
      return workspace;
    next = { ...next, definitions: [...workspace.definitions, d] };
  } else if (event.type === "delivery") {
    const d = event.delivery;
    if (d.teamId !== event.teamId || !hasMessage(d.chatId, d.messageId))
      throw new Error("Delivery source not found.");
    if (workspace.deliveries.some((item) => item.id === d.id)) return workspace;
    next = {
      ...next,
      deliveries: [...workspace.deliveries, { ...d, read: false }],
    };
  } else if (event.type === "member") {
    if (event.member.teamId !== event.teamId)
      throw new Error("Member scope does not match.");
    if (
      workspace.members.some(
        (m) => m.id === event.member.id && m.teamId !== event.teamId,
      )
    )
      throw new Error("Member already belongs to another Team.");
    next = {
      ...next,
      members: workspace.members.some((m) => m.id === event.member.id)
        ? workspace.members.map((m) =>
            m.id === event.member.id
              ? {
                  ...event.member,
                  x: m.x ?? event.member.x,
                  y: m.y ?? event.member.y,
                }
              : m,
          )
        : [...workspace.members, event.member],
    };
  } else if (event.type === "connection") {
    const c = event.connection;
    const ids = new Set([
      `host:${event.teamId}`,
      ...workspace.members
        .filter((m) => m.teamId === event.teamId)
        .map((m) => m.id),
    ]);
    if (c.teamId !== event.teamId || !ids.has(c.source) || !ids.has(c.target))
      throw new Error("Connection scope does not match.");
    next = {
      ...next,
      connections: [
        ...workspace.connections.filter((item) => item.id !== c.id),
        c,
      ],
    };
  } else if (event.type === "context") {
    if (
      !Number.isFinite(event.used) ||
      !Number.isFinite(event.limit) ||
      event.used < 0 ||
      event.limit <= 0
    )
      throw new Error("Invalid context usage.");
    next = {
      ...next,
      teams: workspace.teams.map((t) =>
        t.id === event.teamId
          ? { ...t, context: { used: event.used, limit: event.limit } }
          : t,
      ),
    };
  }
  return next;
}

export function subscribeTeamEvents(listener: (event: TeamEvent) => void) {
  const handler = (event: Event) =>
    listener((event as CustomEvent<TeamEvent>).detail);
  window.addEventListener("teamswarm:runtime", handler);
  return () => window.removeEventListener("teamswarm:runtime", handler);
}
