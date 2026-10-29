import { CanvasViewport } from "./CanvasViewport";
import { SwarmMark } from "./SwarmMark";
import { collaborationEdgeTypes, connectionPorts } from "./Visuals";
import { useEffect, useMemo, useRef, useState } from "react";
import { Tooltip, ContextMenu } from "radix-ui";
import { product } from "./service";
import { useI18n } from "./i18n";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  Handle,
  Position,
  useNodesState,
  useReactFlow,
  useViewport,
  type Node,
  type Edge,
  type NodeProps,
  type Viewport,
} from "@xyflow/react";
import {
  ArrowUpRight,
  ArrowLeft,
  Check,
  ChevronRight,
  GitBranch,
  GripVertical,
  Maximize,
  MessageSquare,
  Minus,
  Plus,
  Search,
  Users,
  X,
  FileText,
  Flag,
  Lightbulb,
  Crosshair,
  CornerDownRight,
  Cpu,
  Trash2,
  LoaderCircle,
} from "lucide-react";
import {
  DetailPanel,
  Modal,
  Menu,
  MenuItem,
  IconButton,
  ICON_SCALE,
  useMediaQuery,
  useTooltipContainer,
} from "./ui";
import {
  definitionLabels,
  definitionsAt,
  forkAt,
  ownMessages,
} from "./history";
import {
  defaultRuntime,
  type Chat,
  type Definition,
  type Member,
  type Team,
  type Workspace,
} from "./store";
import "@xyflow/react/dist/style.css";
import { ProjectHistory } from "./ProjectHistory";
import { MemberConversation, ExchangeList } from "./MemberConversation";
import { modelLabel } from "./ConversationActivity";

type Data = {
  title: string;
  detail: string;
  kind: "member" | "point" | "branch";
  status?: string;
  conversationStatus?: "paused" | "error";
  time?: string;
  definitions?: Definition[];
  deliveries?: number;
  active?: boolean;
  selected?: boolean;
  host?: boolean;
  model?: string;
  harness?: string;
  onOpen: () => void;
  onRemove?: () => void;
  onDrop?: (id: string) => void;
  onCarry?: (item: Definition) => void;
  onDrag?: (active: boolean) => void;
};
type CardNode = Node<Data>;
const kindIcon = {
  problem: Crosshair,
  requirement: FileText,
  goal: Flag,
  understanding: Lightbulb,
};
function DefinitionPreview({
  item,
  source,
}: {
  item: Definition;
  source?: string;
}) {
  const { t: tr } = useI18n();
  return (
    <details className="definition-preview">
      <summary aria-label={tr("Details for {title}", { title: item.title })}>
        <ChevronRight size={11 * ICON_SCALE} />
        {tr("Details")}
      </summary>
      <p>{item.text}</p>
      <small>
        {tr(definitionLabels[item.kind])} · v{item.revision} ·{" "}
        {item.author === "host" ? "Host" : tr("You")}
      </small>
      {source && <small>{source}</small>}
    </details>
  );
}
function DefinitionChip({
  item,
  onCarry,
  onDrag,
}: {
  item: Definition;
  onCarry?: (item: Definition) => void;
  onDrag?: (active: boolean) => void;
}) {
  const { t: tr } = useI18n();
  const Icon = kindIcon[item.kind];
  return (
    <button
      type="button"
      className={`definition-chip nodrag nopan ${item.kind}`}
      draggable
      aria-label={tr("Carry {title}", { title: item.title })}
      onDragStart={(e) => {
        e.dataTransfer.setData("application/x-teamswarm-definition", item.id);
        e.dataTransfer.effectAllowed = "copy";
        onDrag?.(true);
      }}
      onDragEnd={() => onDrag?.(false)}
      onClick={() => onCarry?.(item)}
      title={item.text}
    >
      <GripVertical size={12 * ICON_SCALE} className="drag-grip" />
      <Icon size={12 * ICON_SCALE} />
      <span>{item.title}</span>
    </button>
  );
}
function CanvasNode({ data, selected }: NodeProps<CardNode>) {
  const { t: tr } = useI18n();
  const [over, setOver] = useState(false);
  const { trigger, container } = useTooltipContainer();
  return (
    <ContextMenu.Root modal={false}>
      <ContextMenu.Trigger asChild disabled={!data.onRemove}>
        <div
          className={`graph-card ${data.kind} ${data.host ? "host-node" : ""} ${selected || data.selected ? "selected" : ""} ${data.active ? "current" : ""} ${over ? "drop-target" : ""}`}
          data-status={data.status}
          onDragOver={(e) => {
            if (
              e.dataTransfer.types.includes(
                "application/x-teamswarm-definition",
              ) &&
              data.onDrop
            ) {
              e.preventDefault();
              e.dataTransfer.dropEffect = "copy";
              setOver(true);
            }
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            const id = e.dataTransfer.getData(
              "application/x-teamswarm-definition",
            );
            if (id) data.onDrop?.(id);
          }}
        >
          <Handle type="target" position={Position.Left} />
          {data.kind === "member" &&
            [Position.Left, Position.Right, Position.Top, Position.Bottom].map(
              (position) => (
                <span key={position}>
                  <Handle type="source" id={position} position={position} />
                  <Handle type="target" id={position} position={position} />
                </span>
              ),
            )}
          <Tooltip.Root delayDuration={550}>
            <Tooltip.Trigger asChild>
              <button
                ref={trigger}
                type="button"
                className={`graph-card-main ${data.kind === "member" ? "" : "nodrag"}`}
                onClick={data.onOpen}
              >
                <span className={`graph-symbol ${data.status || ""}`}>
                  {data.kind === "member" ? (
                    data.host ? (
                      <SwarmMark />
                    ) : (
                      <Cpu size={22 * ICON_SCALE} />
                    )
                  ) : data.kind === "branch" ? (
                    <GitBranch size={19 * ICON_SCALE} />
                  ) : (
                    <MessageSquare size={18 * ICON_SCALE} />
                  )}
                </span>
                <span className="graph-copy">
                  <strong>
                    {data.kind === "member" && (
                      <i
                        className={`member-presence ${data.status || "idle"}`}
                        title={tr(data.status || "idle")}
                        aria-label={tr(data.status || "idle")}
                      />
                    )}
                    {data.title}
                  </strong>
                  {data.detail && (
                    <span>
                      {data.detail.replace(/^Review: /, `${tr("Review")} · `)}
                    </span>
                  )}
                </span>
                {data.status && data.kind !== "member" && (
                  <span
                    className={`member-state ${data.status}`}
                    title={tr(data.status)}
                  >
                    <span />
                    <span className="sr-only">{tr(data.status)}</span>
                  </span>
                )}
              </button>
            </Tooltip.Trigger>
            <Tooltip.Portal container={container}>
              <Tooltip.Content
                className="node-preview"
                role="tooltip"
                side="top"
                sideOffset={10}
                collisionPadding={16}
              >
                <strong>
                  {data.kind === "point" ? data.detail : data.title}
                </strong>
                {(data.kind === "point" ? data.title : data.detail) && (
                  <p>{data.kind === "point" ? data.title : data.detail}</p>
                )}
                {data.time && <time>{data.time}</time>}
              </Tooltip.Content>
            </Tooltip.Portal>
          </Tooltip.Root>
          {data.kind === "member" && (
            <div className="member-result-line">
              <span>{tr(data.status || "idle")}</span>
              {data.conversationStatus && (
                <span className="member-conversation-warning">
                  {tr(
                    data.conversationStatus === "paused"
                      ? "Last conversation paused"
                      : "Last conversation failed",
                  )}
                </span>
              )}
            </div>
          )}
          {data.kind === "member" && (
            <div className="member-caption">
              <span className="node-harness">{data.harness}</span>
              {data.model && (
                <span className="node-model" title={data.model}>
                  {tr(data.model)}
                </span>
              )}
            </div>
          )}
          {data.time && (
            <div className="point-meta">
              <time>{data.time}</time>
              {data.deliveries ? (
                <span>
                  <FileText size={11 * ICON_SCALE} />
                  {data.deliveries}
                </span>
              ) : null}
            </div>
          )}
          {!!data.definitions?.length && (
            <div className="node-definitions">
              {data.definitions.slice(0, 2).map((d) => (
                <DefinitionChip
                  key={d.id}
                  item={d}
                  onCarry={data.onCarry}
                  onDrag={data.onDrag}
                />
              ))}
              {data.definitions.length > 2 && (
                <button
                  className="more-definitions nodrag"
                  onClick={data.onOpen}
                >
                  +{data.definitions.length - 2}
                </button>
              )}
            </div>
          )}
          <Handle type="source" position={Position.Right} />
        </div>
      </ContextMenu.Trigger>
      {data.onRemove && (
        <ContextMenu.Portal>
          <ContextMenu.Content
            className="menu history-context-menu"
            collisionPadding={12}
          >
            <ContextMenu.Item className="menu-item" onSelect={data.onOpen}>
              <MessageSquare size={15} />
              <span className="item-label">{tr("Conversation")}</span>
            </ContextMenu.Item>
            <ContextMenu.Separator className="separator" />
            <ContextMenu.Item
              className="menu-item danger"
              onSelect={data.onRemove}
            >
              <Trash2 size={15} />
              <span className="item-label">{tr("Delete member")}</span>
            </ContextMenu.Item>
          </ContextMenu.Content>
        </ContextMenu.Portal>
      )}
    </ContextMenu.Root>
  );
}
const nodeTypes = { card: CanvasNode };

function CanvasTools({ onFind }: { onFind: () => void }) {
  const { t: tr } = useI18n();
  const flow = useReactFlow();
  const { zoom } = useViewport();
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  return (
    <div className="canvas-tools">
      <IconButton
        label={tr("Zoom out")}
        onClick={() => void flow.zoomOut({ duration: reducedMotion ? 0 : 160 })}
      >
        <Minus size={15 * ICON_SCALE} />
      </IconButton>
      <button
        className="zoom-label"
        onClick={() =>
          void flow.zoomTo(1, { duration: reducedMotion ? 0 : 180 })
        }
        aria-label={tr("Reset zoom")}
      >
        {Math.round(zoom * 100)}%
      </button>
      <IconButton
        label={tr("Zoom in")}
        onClick={() => void flow.zoomIn({ duration: reducedMotion ? 0 : 160 })}
      >
        <Plus size={15 * ICON_SCALE} />
      </IconButton>
      <span className="tool-divider" />
      <IconButton
        label={tr("Fit to view")}
        onClick={() =>
          void flow.fitView({
            padding: 0.24,
            duration: reducedMotion ? 0 : 220,
            maxZoom: 1,
          })
        }
      >
        <Maximize size={14 * ICON_SCALE} />
      </IconButton>
      <IconButton label={tr("Find node")} onClick={onFind}>
        <Search size={14 * ICON_SCALE} />
      </IconButton>
    </div>
  );
}
type Selection =
  | {
      kind: "member";
      id: string;
      messageId?: string;
      workId?: string;
      returnEdgeId?: string;
    }
  | { kind: "point"; chatId: string; messageId: string }
  | { kind: "edge"; id: string }
  | { kind: "carry"; definitionId: string }
  | null;
type ForkDraft = {
  chatId: string;
  messageId: string;
  selected: string[];
  title: string;
};
type Props = {
  workspace: Workspace;
  team: Team;
  mode: "collaboration" | "history";
  filesOpen?: boolean;
  chatId?: string;
  memberAnchor?: { memberId: string; messageId?: string; workId?: string };
  onUpdate: (change: (old: Workspace) => Workspace) => boolean;
  onNavigate: (chatId: string, messageId?: string) => void;
  onAddMember: () => void;
  onSettings: (tab?: "harnesses" | "connections" | "runtime") => void;
  onDelivery: (id: string) => void;
  onNavigateMember: (
    memberId: string,
    messageId: string,
    workId?: string,
  ) => void;
};
export function TeamCanvas(props: Props) {
  if (props.mode === "history" && props.workspace.service)
    return <ProjectHistory {...props} />;
  return (
    <ReactFlowProvider>
      <CanvasContent {...props} />
    </ReactFlowProvider>
  );
}
function CanvasContent({
  workspace,
  team,
  mode,
  filesOpen = false,
  chatId,
  memberAnchor,
  onUpdate,
  onNavigate,
  onAddMember,
  onSettings,
  onDelivery,
}: Props) {
  const { t: tr, locale } = useI18n();
  const [selection, setSelection] = useState<Selection>(null);
  useEffect(() => {
    if (memberAnchor?.memberId)
      setSelection({
        kind: "member",
        id: memberAnchor.memberId,
        messageId: memberAnchor.messageId,
        workId: memberAnchor.workId,
      });
  }, [memberAnchor?.memberId, memberAnchor?.messageId, memberAnchor?.workId]);
  const [fork, setFork] = useState<ForkDraft | null>(null);
  const [dragging, setDragging] = useState(false);
  const [query, setQuery] = useState("");
  const [find, setFind] = useState(false);
  const [findIndex, setFindIndex] = useState(0);
  const [error, setError] = useState("");
  const [deleting, setDeleting] = useState<Member | null>(null);
  // Retain the target while the dialog finishes its exit animation.
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const [deletingBusy, setDeletingBusy] = useState(false);
  const deletionLock = useRef(false);
  const deleteMember = async () => {
    if (!deleting || deletionLock.current) return;
    deletionLock.current = true;
    setDeletingBusy(true);
    setDeleteError("");
    try {
      await product.deleteMember(team.id, deleting.id);
      setSelection((current) =>
        current?.kind === "member" && current.id === deleting.id
          ? null
          : current,
      );
      setDeleteOpen(false);
    } catch (error) {
      setDeleteError((error as Error).message);
    } finally {
      deletionLock.current = false;
      setDeletingBusy(false);
    }
  };
  const flow = useReactFlow<CardNode>();
  const stage = useRef<HTMLDivElement>(null);
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const chats = workspace.chats
    .filter((c) => c.teamId === team.id)
    .sort((a, b) => a.createdAt - b.createdAt);
  const definitions = workspace.definitions.filter((d) => d.teamId === team.id);
  const members: Member[] = [
    {
      id: `host:${team.id}`,
      teamId: team.id,
      name: "Host",
      responsibility: tr("Team"),
      task: team.name,
      status: "idle",
      harness: (team.runtime || defaultRuntime).harness,
      model: (team.runtime || defaultRuntime).model,
      ...workspace.members.find(
        (m) => m.id === `host:${team.id}` && m.teamId === team.id,
      ),
      ...(team.hostPosition || {}),
    },
    ...workspace.members.filter(
      (m) => m.teamId === team.id && m.id !== `host:${team.id}` && !m.removedAt,
    ),
  ];
  const beginFork = (source: Chat, messageId: string, id?: string) => {
    if (id && !definitions.some((d) => d.id === id)) return;
    setFork((previous) => ({
      chatId: source.id,
      messageId,
      title:
        previous?.chatId === source.id && previous.messageId === messageId
          ? previous.title
          : `${source.title} · ${chats.filter((c) => c.parent).length + 2}`,
      selected: [
        ...new Set([
          ...(previous?.chatId === source.id && previous.messageId === messageId
            ? previous.selected
            : []),
          ...(id ? [id] : []),
        ]),
      ],
    }));
    setSelection(null);
    setDragging(false);
    setError("");
  };
  const carry = (item: Definition) => {
    setSelection({ kind: "carry", definitionId: item.id });
    setFork(null);
  };
  const graph = useMemo(() => {
    const nodes: CardNode[] = [];
    const edges: Edge[] = [];
    if (mode === "collaboration") {
      members.forEach((m, i) =>
        nodes.push({
          id: m.id,
          type: "card",
          position: {
            x: m.x ?? (i === 0 ? 440 : i % 2 ? 80 : 800),
            y: m.y ?? (i === 0 ? 240 : 60 + Math.floor((i - 1) / 2) * 210),
          },
          data: {
            title: m.name,
            detail:
              m.id === `host:${team.id}`
                ? team.name
                : m.task || m.responsibility || "",
            kind: "member",
            host: m.id === `host:${team.id}`,
            model: modelLabel(tr(m.model), m.effort),
            harness: m.harness,
            status: m.status,
            conversationStatus: m.conversationStatus,
            onOpen: () => setSelection({ kind: "member", id: m.id }),
            onRemove:
              workspace.service && m.id !== `host:${team.id}`
                ? () => {
                    setDeleteError("");
                    setDeleting(m);
                    setDeleteOpen(true);
                  }
                : undefined,
          },
        }),
      );
      workspace.connections
        .filter(
          (c) =>
            c.teamId === team.id &&
            members.some((m) => m.id === c.source) &&
            members.some((m) => m.id === c.target),
        )
        .forEach((c) =>
          edges.push({
            id: c.id,
            source: c.source,
            target: c.target,
            type: "signal",
            ariaLabel: tr("Exchanges between {source} and {target}", {
              source: members.find((m) => m.id === c.source)?.name ?? "Host",
              target: members.find((m) => m.id === c.target)?.name ?? "Host",
            }),
            ariaRole: "button",
            domAttributes: {
              onKeyDown: (event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  setSelection({ kind: "edge", id: c.id });
                }
              },
            },
            style: { strokeWidth: 1.5 },
            data: {
              label: c.label,
              lastEvent: c.lastEvent,
              active: c.active,
              directions: c.activeDirections?.map((d) =>
                d.source === c.source ? 1 : -1,
              ),
            },
          }),
        );
    } else {
      const positions = new Map<string, { x: number; y: number }>();
      const addPoint = (
        chat: Chat,
        messageId: string,
        i: number,
        row: number,
        startX: number,
      ) => {
        const m = chat.messages.find((m) => m.id === messageId)!;
        const id = `${chat.id}:${m.id}`;
        const position = { x: startX + i * 380, y: row * 290 + 80 };
        positions.set(id, position);
        const defs = definitions.filter(
          (d) => d.chatId === chat.id && d.messageId === m.id,
        );
        nodes.push({
          id,
          type: "card",
          position,
          draggable: false,
          data: {
            title: m.text || m.files[0]?.name || tr("Discussion"),
            detail: m.role === "host" ? "Host" : tr("You"),
            kind: "point",
            time: new Date(m.createdAt).toLocaleTimeString(locale, {
              hour: "2-digit",
              minute: "2-digit",
            }),
            definitions: defs,
            deliveries: workspace.deliveries.filter(
              (d) => d.chatId === chat.id && d.messageId === m.id,
            ).length,
            active: chat.id === chatId && m.id === chat.messages.at(-1)?.id,
            onOpen: () => {
              setFork(null);
              setSelection({ kind: "point", chatId: chat.id, messageId: m.id });
            },
            onDrop: (id) => beginFork(chat, m.id, id),
            onCarry: carry,
            onDrag: setDragging,
          },
        });
        return id;
      };
      // Parent chats are resolved before their descendants, independent of clock skew.
      const ordered: Chat[] = [];
      const pending = [...chats];
      while (pending.length) {
        let index = pending.findIndex(
          (c) =>
            !c.parent ||
            ordered.some((p) => p.id === c.parent?.chatId) ||
            !chats.some((p) => p.id === c.parent?.chatId),
        );
        if (index < 0) index = 0;
        ordered.push(...pending.splice(index, 1));
      }
      ordered.forEach((chat, row) => {
        const parentId = chat.parent
          ? `${chat.parent.chatId}:${chat.parent.messageId}`
          : undefined;
        // A parent point may itself be inherited. Locate the visible ancestor.
        const visibleParent =
          parentId && positions.has(parentId)
            ? parentId
            : chat.parent
              ? [...positions.keys()].find((id) =>
                  id.endsWith(`:${chat.parent!.messageId}`),
                )
              : undefined;
        const origin = visibleParent ? positions.get(visibleParent) : undefined;
        const startX = origin ? origin.x + 380 : 80;
        let previous = visibleParent;
        const own = ownMessages(chat, chats);
        const branchId = `branch:${chat.id}`;
        if (chat.parent) {
          nodes.push({
            id: branchId,
            type: "card",
            draggable: false,
            position: { x: startX, y: row * 290 + 80 },
            data: {
              title: chat.title,
              detail: tr("{count} retained", {
                count: chat.inheritedDefinitions?.length || 0,
              }),
              kind: "branch",
              active: chat.id === chatId && !own.length,
              onOpen: () => onNavigate(chat.id),
              definitions: chat.inheritedDefinitions,
              onCarry: carry,
              onDrag: setDragging,
            },
          });
          if (previous)
            edges.push({
              id: `fork:${chat.id}`,
              source: previous,
              target: branchId,
              type: "smoothstep",
              className: "branch-edge",
            });
          previous = branchId;
        }
        own.forEach((m, i) => {
          const id = addPoint(
            chat,
            m.id,
            i + (chat.parent ? 1 : 0),
            row,
            startX,
          );
          if (previous)
            edges.push({
              id: `path:${id}`,
              source: previous,
              target: id,
              type: "smoothstep",
            });
          previous = id;
        });
      });
    }
    return { nodes, edges };
    // Rebuild when persisted facts change; canvas viewport is deliberately not reset.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace, team.id, mode, chatId, tr, locale]);
  const [nodes, setNodes, onNodesChange] = useNodesState<CardNode>(graph.nodes);
  useEffect(() => {
    setNodes((previous) => {
      const measured = new Map(
        previous.map((node) => [node.id, node.measured]),
      );
      return graph.nodes.map((node) => ({
        ...node,
        measured: measured.get(node.id),
        ...(previous.find((old) => old.id === node.id)?.dragging
          ? {
              position: previous.find((old) => old.id === node.id)!.position,
              dragging: true,
            }
          : {}),
      }));
    });
  }, [graph.nodes, setNodes]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (e.key === "Escape") {
        setSelection(null);
        setFork(null);
        setFind(false);
        if (find)
          stage.current
            ?.querySelector<HTMLButtonElement>(
              ".canvas-tools button:last-child",
            )
            ?.focus();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [find]);
  const selectedMember =
    selection?.kind === "member"
      ? (members.find((m) => m.id === selection.id) ??
        workspace.members.find(
          (m) => m.teamId === team.id && m.id === selection.id,
        ))
      : undefined;
  const selectedChat =
    selection?.kind === "point"
      ? chats.find((c) => c.id === selection.chatId)
      : undefined;
  const selectedMessage =
    selection?.kind === "point"
      ? selectedChat?.messages.find((m) => m.id === selection.messageId)
      : undefined;
  const selectedDefinition =
    selection?.kind === "carry"
      ? definitions.find((d) => d.id === selection.definitionId)
      : undefined;
  const selectedEdge =
    selection?.kind === "edge"
      ? workspace.connections.find((c) => c.id === selection.id)
      : undefined;
  const forkSource = fork ? chats.find((c) => c.id === fork.chatId) : undefined;
  const base =
    fork && forkSource
      ? definitionsAt(workspace, forkSource, fork.messageId)
      : [];
  const selectedNodeId =
    selectedMember?.id ||
    (selection?.kind === "point"
      ? `${selection.chatId}:${selection.messageId}`
      : undefined) ||
    (fork ? `${fork.chatId}:${fork.messageId}` : undefined);
  const visibleNodes = useMemo(
    () =>
      nodes.map((node) => ({
        ...node,
        data: { ...node.data, selected: node.id === selectedNodeId },
      })),
    [nodes, selectedNodeId],
  );
  const findResults = nodes.filter((node) =>
    `${node.data.title} ${node.data.detail}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
  const openResult = (node: CardNode) => {
    node.data.onOpen();
    setFind(false);
  };
  const saveViewport = (
    _event: MouseEvent | TouchEvent | null,
    viewport: Viewport,
  ) =>
    onUpdate((old) => ({
      ...old,
      teams: old.teams.map((t) =>
        t.id === team.id
          ? {
              ...t,
              canvasViewports: { ...t.canvasViewports, [mode]: viewport },
            }
          : t,
      ),
    }));
  const memberReading = !!selectedMember && filesOpen;
  return (
    <div
      className={`canvas-view ${mode === "collaboration" ? "collaboration-view" : ""} ${memberReading ? "member-reading-view" : ""} ${dragging ? "carrying-definition" : ""}`}
    >
      <div
        className="canvas-stage"
        ref={stage}
        inert={memberReading}
        aria-hidden={memberReading || undefined}
      >
        <div className="canvas-heading">
          <span>
            {mode === "history" ? (
              <GitBranch size={14 * ICON_SCALE} />
            ) : (
              <Users size={14 * ICON_SCALE} />
            )}
          </span>
          <span>
            {mode === "history"
              ? tr(
                  chats.length === 1
                    ? "{count} direction"
                    : "{count} directions",
                  { count: chats.length },
                )
              : tr(
                  members.length === 1 ? "{count} member" : "{count} members",
                  {
                    count: members.length,
                  },
                )}
          </span>
          {mode === "collaboration" && (
            <button className="text-button" onClick={onAddMember}>
              <Plus size={13 * ICON_SCALE} />
              {tr("Add member")}
            </button>
          )}
          {mode === "collaboration" &&
            workspace.members.some(
              (m) => m.teamId === team.id && m.removedAt,
            ) && (
              <Menu
                label={tr("Deleted members")}
                trigger={
                  <button className="text-button">
                    {tr("Deleted members")}
                  </button>
                }
              >
                {workspace.members
                  .filter((m) => m.teamId === team.id && m.removedAt)
                  .map((m) => (
                    <MenuItem
                      key={m.id}
                      icon={<MessageSquare size={15} />}
                      onSelect={() =>
                        setSelection({ kind: "member", id: m.id })
                      }
                    >
                      {m.name}
                    </MenuItem>
                  ))}
              </Menu>
            )}
          {mode === "history" && chatId && (
            <button
              className="text-button"
              onClick={() => {
                const target = nodes.find((n) => n.data.active);
                if (target)
                  void flow.fitView({
                    nodes: [target],
                    padding: 0.7,
                    duration: reducedMotion ? 0 : 200,
                    maxZoom: 1,
                  });
              }}
            >
              <Crosshair size={13 * ICON_SCALE} />
              {tr("Current")}
            </button>
          )}
        </div>
        <ReactFlow<CardNode>
          ariaLabelConfig={{
            "node.a11yDescription.default": tr(
              "Select a node with Enter or Space. Move it with the arrow keys. Press Escape to cancel.",
            ),
            "node.a11yDescription.keyboardDisabled": tr(
              "Select a node with Enter or Space. Press Escape to cancel.",
            ),
            "node.a11yDescription.ariaLiveMessage": ({ direction, x, y }) =>
              tr("Moved {direction}. Position {x}, {y}.", {
                direction: tr(direction),
                x,
                y,
              }),
            "edge.a11yDescription.default": tr(
              "Select a connection with Enter or Space. Press Escape to cancel.",
            ),
            "handle.ariaLabel": tr("Connection handle"),
          }}
          nodes={visibleNodes}
          edges={graph.edges.map((edge) => ({
            ...edge,
            ...(mode === "collaboration" ? connectionPorts(edge, nodes) : {}),
            selected: edge.id === selectedEdge?.id,
            data: {
              ...edge.data,
              emphasized:
                !!selectedNodeId &&
                (edge.source === selectedNodeId ||
                  edge.target === selectedNodeId),
              muted:
                !!selectedNodeId &&
                edge.source !== selectedNodeId &&
                edge.target !== selectedNodeId,
            },
          }))}
          onNodesChange={onNodesChange}
          nodeTypes={nodeTypes}
          edgeTypes={collaborationEdgeTypes}
          nodesConnectable={false}
          nodesDraggable={mode === "collaboration"}
          nodeDragThreshold={4}
          elementsSelectable
          panOnScroll
          selectionOnDrag={false}
          minZoom={mode === "collaboration" ? 0.05 : 0.25}
          maxZoom={1.6}
          defaultViewport={team.canvasViewports?.[mode]}
          fitView={!team.canvasViewports?.[mode]}
          fitViewOptions={{ padding: 0.24, maxZoom: 1 }}
          onMoveEnd={saveViewport}
          onNodeDragStop={(_e, node) => {
            if (node.id.startsWith("host:")) {
              onUpdate((old) => ({
                ...old,
                teams: old.teams.map((t) =>
                  t.id === team.id ? { ...t, hostPosition: node.position } : t,
                ),
              }));
              return;
            }
            onUpdate((old) => ({
              ...old,
              members: old.members.map((m) =>
                m.id === node.id
                  ? { ...m, x: node.position.x, y: node.position.y }
                  : m,
              ),
            }));
          }}
          onEdgeClick={(_e, edge) => {
            if (mode === "collaboration")
              setSelection({ kind: "edge", id: edge.id });
          }}
          onPaneClick={() => {
            if (!fork) setSelection(null);
          }}
          defaultEdgeOptions={{
            style: { stroke: "var(--graph-line)", strokeWidth: 1.4 },
            interactionWidth: 18,
          }}
        >
          <CanvasViewport
            selectedId={selectedNodeId}
            relatedIds={
              selectedEdge
                ? [selectedEdge.source, selectedEdge.target]
                : undefined
            }
            restored={!!team.canvasViewports?.[mode]}
          />
          <Background
            variant={BackgroundVariant.Dots}
            gap={24}
            size={0.85}
            color="var(--graph-dot)"
          />
          <CanvasTools onFind={() => setFind(!find)} />
        </ReactFlow>
        {!nodes.length && (
          <div className="canvas-empty">
            <GitBranch size={26 * ICON_SCALE} />
            <span>{tr("No history yet")}</span>
            <button className="secondary-button" onClick={() => onNavigate("")}>
              {tr("Open Host")}
              <ArrowUpRight size={13 * ICON_SCALE} />
            </button>
          </div>
        )}
        {find && (
          <div className="canvas-find">
            <Search size={14 * ICON_SCALE} />
            <input
              autoFocus
              aria-autocomplete="list"
              aria-controls={query.trim() ? "canvas-find-results" : undefined}
              aria-activedescendant={
                query.trim() && findResults[findIndex]
                  ? `canvas-result-${findIndex}`
                  : undefined
              }
              placeholder={tr("Find a node…")}
              aria-label={tr("Find a node")}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setFindIndex(0);
              }}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return;
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  const next = Math.max(
                    0,
                    Math.min(
                      findResults.length - 1,
                      findIndex + (event.key === "ArrowDown" ? 1 : -1),
                    ),
                  );
                  setFindIndex(next);
                  document
                    .getElementById(`canvas-result-${next}`)
                    ?.scrollIntoView({ block: "nearest" });
                }
                if (
                  event.key === "Enter" &&
                  query.trim() &&
                  findResults[findIndex]
                ) {
                  event.preventDefault();
                  openResult(findResults[findIndex]);
                }
              }}
            />
            <IconButton
              label={tr("Close search")}
              onClick={() => {
                setFind(false);
                stage.current
                  ?.querySelector<HTMLButtonElement>(
                    ".canvas-tools button:last-child",
                  )
                  ?.focus();
              }}
            >
              <X size={13 * ICON_SCALE} />
            </IconButton>
            {query.trim() && (
              <div
                className="canvas-find-results"
                id="canvas-find-results"
                role={findResults.length ? "listbox" : undefined}
                aria-label={findResults.length ? tr("Find a node") : undefined}
              >
                {!findResults.length && (
                  <div className="canvas-find-empty" role="status">
                    {tr("No results")}
                  </div>
                )}
                {findResults.map((n, index) => (
                  <button
                    key={n.id}
                    id={`canvas-result-${index}`}
                    role="option"
                    aria-selected={index === findIndex}
                    tabIndex={-1}
                    onMouseMove={() => setFindIndex(index)}
                    onClick={() => openResult(n)}
                  >
                    <span>{n.data.title}</span>
                    <ArrowUpRight size={12 * ICON_SCALE} />
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
      {(selection || fork) && (
        <DetailPanel
          resizable={!memberReading}
          className={`canvas-detail ${selectedMember ? "conversation-detail" : ""}`}
          label={fork ? tr("New direction") : tr("Node details")}
          onClose={() => {
            setSelection(null);
            setFork(null);
          }}
          fallbackFocus={() =>
            stage.current?.querySelector<HTMLButtonElement>(
              ".canvas-tools button:last-child",
            ) || null
          }
        >
          <header>
            {selectedMember && (
              <IconButton
                label={tr("Back")}
                onClick={() =>
                  setSelection(
                    selection?.kind === "member" && selection.returnEdgeId
                      ? { kind: "edge", id: selection.returnEdgeId }
                      : null,
                  )
                }
              >
                <ArrowLeft size={16} />
              </IconButton>
            )}
            <span>
              {fork ? (
                <GitBranch size={16 * ICON_SCALE} />
              ) : selectedMember ? (
                <Users size={16 * ICON_SCALE} />
              ) : selectedDefinition ? (
                <FileText size={16 * ICON_SCALE} />
              ) : (
                <MessageSquare size={16 * ICON_SCALE} />
              )}
            </span>
            {selectedMember ? (
              <div className="member-header-identity">
                <strong title={selectedMember.name}>
                  {selectedMember.name}
                </strong>
                <small
                  className="member-header-model"
                  title={selectedMember.model}
                >
                  {selectedMember.harness}
                  {modelLabel(
                    tr(selectedMember.model),
                    selectedMember.effort,
                  ) && (
                    <>
                      {" "}
                      ·{" "}
                      {modelLabel(
                        tr(selectedMember.model),
                        selectedMember.effort,
                      )}
                    </>
                  )}
                </small>
              </div>
            ) : (
              <strong>
                {fork
                  ? tr("New direction")
                  : selectedDefinition?.title ||
                    (selectedEdge ? tr("Exchanges") : "") ||
                    tr("Discussion")}
              </strong>
            )}
            {selectedMember &&
              workspace.service &&
              !selectedMember.removedAt &&
              selectedMember.id !== `host:${team.id}` && (
                <IconButton
                  label={tr("Delete member")}
                  onClick={() => {
                    setDeleteError("");
                    setDeleting(selectedMember);
                    setDeleteOpen(true);
                  }}
                >
                  <Trash2 size={16} />
                </IconButton>
              )}
            <IconButton
              label={tr("Close details")}
              onClick={() => {
                setSelection(null);
                setFork(null);
              }}
            >
              <X size={16 * ICON_SCALE} />
            </IconButton>
          </header>
          <div
            className={`detail-scroll ${selectedMember ? "member-thread-wrapper" : ""}`}
          >
            {selectedMember && (
              <MemberConversation
                key={`${team.id}:${selectedMember.id}`}
                member={selectedMember}
                workspace={workspace}
                anchor={
                  selection?.kind === "member" ? selection.messageId : undefined
                }
                workId={
                  selection?.kind === "member" ? selection.workId : undefined
                }
                onUpdate={onUpdate}
                onSettings={onSettings}
              />
            )}
            {selectedEdge && (
              <ExchangeList
                exchanges={selectedEdge.exchanges ?? []}
                members={members}
                onOpen={(id, messageId) =>
                  setSelection({
                    kind: "member",
                    id,
                    messageId,
                    returnEdgeId: selectedEdge.id,
                  })
                }
              />
            )}
            {selectedMessage && selectedChat && (
              <>
                <span className="detail-eyebrow">
                  {selectedMessage.role === "host" ? "Host" : tr("You")} ·{" "}
                  {new Date(selectedMessage.createdAt).toLocaleString(locale)}
                </span>
                <p className="detail-message">{selectedMessage.text}</p>
                <button
                  className="detail-link"
                  onClick={() =>
                    onNavigate(selectedChat.id, selectedMessage.id)
                  }
                >
                  {tr("View conversation")}
                  <ArrowUpRight size={14 * ICON_SCALE} />
                </button>
                {definitions
                  .filter(
                    (d) =>
                      d.chatId === selectedChat.id &&
                      d.messageId === selectedMessage.id,
                  )
                  .map((d) => (
                    <div className="definition-detail" key={d.id}>
                      <span className="detail-eyebrow">
                        {tr(definitionLabels[d.kind])}
                      </span>
                      <DefinitionChip
                        item={d}
                        onCarry={carry}
                        onDrag={setDragging}
                      />
                      <p>{d.text}</p>
                    </div>
                  ))}
                {workspace.deliveries
                  .filter(
                    (d) =>
                      d.chatId === selectedChat.id &&
                      d.messageId === selectedMessage.id,
                  )
                  .map((d) => (
                    <button
                      className="delivery-inline"
                      key={d.id}
                      onClick={() => onDelivery(d.id)}
                    >
                      <FileText size={17 * ICON_SCALE} />
                      <span>
                        <strong>{d.title}</strong>
                        <small>v{d.version}</small>
                      </span>
                      <ArrowUpRight size={14 * ICON_SCALE} />
                    </button>
                  ))}
                <button
                  className="primary-button branch-button"
                  onClick={() => beginFork(selectedChat, selectedMessage.id)}
                >
                  <GitBranch size={14 * ICON_SCALE} />
                  {tr("Try from here")}
                </button>
              </>
            )}
            {selectedDefinition && (
              <>
                <span className="detail-eyebrow">
                  {tr(definitionLabels[selectedDefinition.kind])} · v
                  {selectedDefinition.revision}
                </span>
                <p className="detail-message">{selectedDefinition.text}</p>
                <button
                  className="detail-link"
                  onClick={() =>
                    onNavigate(
                      selectedDefinition.chatId,
                      selectedDefinition.messageId,
                    )
                  }
                >
                  {tr("View source")}
                  <ArrowUpRight size={13 * ICON_SCALE} />
                </button>
                <div className="detail-section-title">{tr("Carry to")}</div>
                {chats.flatMap((c) =>
                  ownMessages(c, chats).map((m) => (
                    <button
                      className="destination-row"
                      key={`${c.id}:${m.id}`}
                      onClick={() => beginFork(c, m.id, selectedDefinition.id)}
                    >
                      <CornerDownRight size={14 * ICON_SCALE} />
                      <span>{m.text.slice(0, 55) || c.title}</span>
                      <Plus size={13 * ICON_SCALE} />
                    </button>
                  )),
                )}
              </>
            )}
            {fork && forkSource && (
              <>
                <label className="field-label">
                  {tr("Name")}
                  <input
                    value={fork.title}
                    maxLength={80}
                    onChange={(e) =>
                      setFork({ ...fork, title: e.target.value })
                    }
                  />
                </label>
                <div className="fork-origin">
                  <GitBranch size={14 * ICON_SCALE} />
                  <span>
                    {forkSource.messages
                      .find((m) => m.id === fork.messageId)
                      ?.text.slice(0, 80)}
                  </span>
                </div>
                <div className="detail-section-title">
                  {tr("Retained from this point")}
                  <span>{base.length}</span>
                </div>
                {base.map((d) => (
                  <div className="retained-row" key={d.id}>
                    <Check size={12 * ICON_SCALE} />
                    <div>
                      <span>{d.title}</span>
                      <DefinitionPreview
                        item={d}
                        source={chats.find((c) => c.id === d.chatId)?.title}
                      />
                    </div>
                  </div>
                ))}
                <div className="detail-section-title">
                  {tr("Bring along")}{" "}
                  <span>
                    {
                      fork.selected.filter(
                        (id) => !base.some((d) => d.id === id),
                      ).length
                    }
                  </span>
                </div>
                <div className="carry-options">
                  {definitions
                    .filter((d) => !base.some((b) => b.id === d.id))
                    .map((d) => (
                      <div
                        className={`carry-option ${fork.selected.includes(d.id) ? "checked" : ""}`}
                        key={d.id}
                      >
                        <label>
                          <input
                            type="checkbox"
                            checked={fork.selected.includes(d.id)}
                            onChange={(e) =>
                              setFork({
                                ...fork,
                                selected: e.target.checked
                                  ? [...fork.selected, d.id]
                                  : fork.selected.filter((id) => id !== d.id),
                              })
                            }
                          />
                          <span>
                            <strong>{d.title}</strong>
                            <small>
                              {tr(definitionLabels[d.kind])} ·{" "}
                              {chats.find((c) => c.id === d.chatId)?.title}
                            </small>
                          </span>
                        </label>
                        <DefinitionPreview
                          item={d}
                          source={chats.find((c) => c.id === d.chatId)?.title}
                        />
                      </div>
                    ))}
                </div>
                {error && (
                  <p role="alert" className="form-error">
                    {tr(error)}
                  </p>
                )}
                <button
                  className="primary-button branch-button"
                  disabled={!fork.title.trim()}
                  onClick={() => {
                    try {
                      let resultChat: Chat | undefined;
                      const saved = onUpdate((old) => {
                        const result = forkAt(
                          old,
                          fork.chatId,
                          fork.messageId,
                          fork.selected,
                          fork.title,
                        );
                        resultChat = result.chat;
                        return result.workspace;
                      });
                      if (saved && resultChat) {
                        setFork(null);
                        onNavigate(resultChat.id);
                      }
                    } catch (e) {
                      setError((e as Error).message);
                    }
                  }}
                >
                  <GitBranch size={14 * ICON_SCALE} />
                  {tr("Create direction")}
                </button>
              </>
            )}
          </div>
        </DetailPanel>
      )}
      <Modal
        open={deleteOpen}
        title={tr("Delete member")}
        className="checkpoint-delete-modal"
        onOpenChange={(open) => {
          if (!open && !deletionLock.current) {
            setDeleteOpen(false);
            setDeleteError("");
          }
        }}
      >
        <div className="form-body">
          <p>{tr("Delete “{title}”?", { title: deleting?.name ?? "" })}</p>
          <p>{tr("Previous conversations and work will be kept.")}</p>
          {deleteError && (
            <p role="alert" className="form-error">
              {tr(deleteError)}
            </p>
          )}
        </div>
        <div className="form-footer">
          <button
            className="secondary-button"
            disabled={deletingBusy}
            onClick={() => {
              setDeleteOpen(false);
              setDeleteError("");
            }}
          >
            {tr("Cancel")}
          </button>
          <button
            className="primary-button danger-button"
            disabled={deletingBusy}
            onClick={() => void deleteMember()}
          >
            {deletingBusy && <LoaderCircle size={15} className="spinner" />}
            {tr("Delete")}
          </button>
        </div>
      </Modal>
    </div>
  );
}
