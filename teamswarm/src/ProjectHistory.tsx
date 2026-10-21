import { CanvasViewport } from "./CanvasViewport";
import {
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Handle,
  Position,
  useReactFlow,
  type Node,
  type Edge,
  type NodeProps,
} from "@xyflow/react";
import {
  GitBranch,
  FileText,
  Flag,
  Check,
  Plus,
  Minus,
  Maximize,
  X,
  ArrowUpRight,
  Search,
  GripVertical,
  LoaderCircle,
} from "lucide-react";
import type { ProjectNode, ProjectDocument } from "@team/contracts/runtime";
import type { Workspace, Team } from "./store";
import { DetailPanel, IconButton, useMediaQuery } from "./ui";
import { useI18n } from "./i18n";
import { product } from "./service";
import { MessageContent } from "./MessageContent";

type Props = {
  workspace: Workspace;
  team: Team;
  chatId?: string;
  onUpdate: (change: (old: Workspace) => Workspace) => boolean;
  onNavigate: (chatId: string, messageId?: string) => void;
  onDelivery: (id: string) => void;
};
type HistoryNode = Node<
  {
    node: ProjectNode;
    documents: ProjectDocument[];
    branch: string;
    active: boolean;
    open: () => void;
    carry: (id: string) => void;
    drop: (id: string) => void;
    drag: (
      id: string,
      title: string,
      event: ReactPointerEvent<HTMLButtonElement>,
    ) => void;
    draggingOver: boolean;
    consumeDragClick: () => boolean;
    formatTime: (at: string) => string;
  },
  "history"
>;
function HistoryCard({ data, selected }: NodeProps<HistoryNode>) {
  const { t } = useI18n();
  const [over, setOver] = useState(false);
  const Icon =
    data.node.kind === "fork"
      ? GitBranch
      : data.node.kind === "definition"
        ? FileText
        : data.node.kind === "delivery"
          ? Check
          : Flag;
  return (
    <div
      className={`graph-card point ${selected ? "selected" : ""} ${data.active ? "current" : ""} ${over || data.draggingOver ? "drop-target" : ""}`}
      data-kind={data.node.kind}
      data-history-node={
        data.node.workspaceSnapshotId ? data.node.id : undefined
      }
      onDragOver={(e) => {
        if (
          e.dataTransfer.types.includes("application/x-teamswarm-definition") &&
          data.node.workspaceSnapshotId
        ) {
          e.preventDefault();
          setOver(true);
        }
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        data.drop(e.dataTransfer.getData("application/x-teamswarm-definition"));
      }}
    >
      <Handle type="target" position={Position.Left} />
      <button className="graph-card-main nodrag" onClick={data.open}>
        <span className="graph-symbol">
          <Icon size={23} />
        </span>
        <span className="graph-copy">
          <strong>{data.node.title}</strong>
          <span>
            {data.branch} ·{" "}
            {t(
              {
                root: "Start",
                definition: "Definition",
                checkpoint: "Checkpoint",
                fork: "Branch",
                selection: "Selection",
                delivery: "Delivery",
                "work-result": "Work result",
                acceptance: "Independent acceptance",
              }[data.node.kind],
            )}
          </span>
        </span>
      </button>
      <div className="point-meta">
        <time>{data.formatTime(data.node.createdAt)}</time>
        {data.active && (
          <span className="current-position">
            <span />
            {t("Current position")}
          </span>
        )}
        {data.node.artifactIds.length > 0 && (
          <span>
            <FileText size={14} />
            {data.node.artifactIds.length}
          </span>
        )}
      </div>
      {data.documents.length > 0 && (
        <div className="node-definitions">
          {data.documents.slice(0, 2).map((d) => (
            <button
              key={d.id}
              className="definition-chip nodrag nopan"
              onPointerDown={(e) => data.drag(d.id, d.title, e)}
              onClick={(e) => {
                e.stopPropagation();
                if (!data.consumeDragClick()) data.carry(d.id);
              }}
              aria-label={t("Carry {title}", { title: d.title })}
            >
              <GripVertical size={14} />
              <span>{d.title}</span>
            </button>
          ))}
          {data.documents.length > 2 && (
            <button className="more-definitions nodrag" onClick={data.open}>
              +{data.documents.length - 2}
            </button>
          )}
        </div>
      )}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
const nodeTypes = { history: HistoryCard };
export function ProjectHistory(props: Props) {
  return (
    <ReactFlowProvider>
      <HistoryContent {...props} />
    </ReactFlowProvider>
  );
}
function HistoryContent({
  workspace,
  team,
  chatId,
  onUpdate,
  onNavigate,
  onDelivery,
}: Props) {
  const { t, locale } = useI18n();
  const reduced = useMediaQuery("(prefers-reduced-motion: reduce)");
  const flow = useReactFlow<HistoryNode>();
  const stage = useRef<HTMLDivElement>(null);
  const dragState = useRef<{
    id: string;
    title: string;
    x: number;
    y: number;
    active: boolean;
    target?: string;
  } | null>(null);
  const suppressClick = useRef(false);
  const [dragPreview, setDragPreview] = useState<{
    title: string;
    x: number;
    y: number;
    target?: string;
  } | null>(null);
  const startDrag = (
    id: string,
    title: string,
    e: ReactPointerEvent<HTMLButtonElement>,
  ) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragState.current = {
      id,
      title,
      x: e.clientX,
      y: e.clientY,
      active: false,
    };
    suppressClick.current = false;
  };
  const consumeDragClick = () => {
    const suppress = suppressClick.current;
    suppressClick.current = false;
    return suppress;
  };
  const [dimensions, setDimensions] = useState<
    Record<string, { width: number; height: number }>
  >({});
  const [selected, setSelected] = useState<string | null>(null),
    [forkId, setForkId] = useState<string | null>(null),
    [carry, setCarry] = useState<string | null>(null),
    [selectedDocs, setSelectedDocs] = useState<string[]>([]),
    [replacements, setReplacements] = useState<string[]>([]),
    [name, setName] = useState(""),
    [query, setQuery] = useState(""),
    [search, setSearch] = useState(false),
    [nodeQuery, setNodeQuery] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const request = useRef<{ signature: string; id: string } | undefined>(
    undefined,
  );
  const all = workspace.projectNodes?.filter((n) => n.teamId === team.id) ?? [];
  const branches =
    workspace.projectBranches?.filter((b) => b.teamId === team.id) ?? [];
  const documents =
    workspace.projectDocuments?.filter((d) => d.teamId === team.id) ?? [];
  const activeBranch =
    workspace.chats.find((c) => c.id === (chatId ?? team.lastChatId))
      ?.branchId ?? branches[0]?.id;
  const branch = branches.find((b) => b.id === activeBranch);
  const current = all.find((n) => n.id === selected),
    fork = all.find((n) => n.id === forkId),
    carryDoc = documents.find((d) => d.id === carry);
  const displayed = current ?? fork;
  const docsAt = (node: ProjectNode) =>
    documents.filter((d) => Object.values(node.documents).includes(d.id));
  const beginFork = (node: ProjectNode, id?: string) => {
    if (!node.workspaceSnapshotId) return;
    setForkId(node.id);
    setSelected(null);
    setCarry(null);
    setSelectedDocs(id ? [id] : []);
    setReplacements([]);
    setName(`${team.name} · ${branches.length + 1}`);
    setError("");
  };
  const graph = useMemo(() => {
    const depth = new Map<string, number>();
    const edges: Edge[] = [];
    const nodes: HistoryNode[] = all.map((node) => {
      const x = node.parentNodeId ? (depth.get(node.parentNodeId) ?? 0) + 1 : 0;
      depth.set(node.id, x);
      if (node.parentNodeId)
        edges.push({
          id: node.id,
          source: node.parentNodeId,
          target: node.id,
          type: "default",
          className: node.kind === "fork" ? "branch-edge" : "",
          style: { strokeWidth: 1.5, stroke: "var(--graph-line)" },
        });
      const parent = all.find((n) => n.id === node.parentNodeId);
      const changed = docsAt(node).filter(
        (d) => !parent || parent.documents[d.key] !== d.id,
      );
      return {
        id: node.id,
        type: "history",
        position: {
          x: 80 + x * 390,
          y: 100 + branches.findIndex((b) => b.id === node.branchId) * 290,
        },
        measured: dimensions[node.id],
        draggable: false,
        selected: node.id === (selected ?? forkId),
        data: {
          node,
          drag: startDrag,
          draggingOver: dragPreview?.target === node.id,
          consumeDragClick,
          branch: branches.find((b) => b.id === node.branchId)?.name ?? "",
          documents: changed,
          active: branch?.headNodeId === node.id,
          open: () => {
            setSelected(node.id);
            setForkId(null);
            setCarry(null);
            setError("");
          },
          carry: (id) => {
            setCarry(id);
            setSelected(null);
            setForkId(null);
          },
          drop: (id) => beginFork(node, id),
          formatTime: (at) =>
            new Date(at).toLocaleString(locale, {
              month: "short",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            }),
        },
      };
    });
    return { nodes, edges };
  }, [
    workspace,
    team.id,
    selected,
    forkId,
    locale,
    activeBranch,
    dimensions,
    dragPreview?.target,
  ]);
  const close = () => {
    setSelected(null);
    setForkId(null);
    setCarry(null);
    setError("");
  };
  const submit = async () => {
    if (!fork || busy || !name.trim()) return;
    setBusy(true);
    setError("");
    const selections = selectedDocs.map((id) => {
      const doc = documents.find((d) => d.id === id)!;
      return {
        revisionId: id,
        replaceRevisionId: fork.documents[doc.key] ?? null,
      };
    });
    const body = { fromNodeId: fork.id, name: name.trim(), selections };
    const signature = JSON.stringify(body);
    if (request.current?.signature !== signature)
      request.current = { signature, id: crypto.randomUUID() };
    try {
      const result = await product.command<{ conversation: { id: string } }>(
        `/teams/${team.id}/branches`,
        { ...body, clientRequestId: request.current.id },
      );
      close();
      onNavigate(result.conversation.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const checkpoint = async () => {
    if (!branch || busy) return;
    setBusy(true);
    setError("");
    try {
      await product.command(
        `/teams/${team.id}/branches/${branch.id}/checkpoints`,
        {
          clientRequestId: crypto.randomUUID(),
          expectedHeadId: branch.headNodeId,
          title: t("Checkpoint"),
        },
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const conflicts = fork
    ? selectedDocs.filter((id) => {
        const d = documents.find((d) => d.id === id);
        return d && fork.documents[d.key] && fork.documents[d.key] !== id;
      })
    : [];
  const source = displayed?.source;
  const sourceChat =
    workspace.chats.find((c) => c.id === source?.conversationId) ??
    workspace.chats.find((c) => c.branchId === displayed?.branchId);
  const sourceMessage = sourceChat?.messages.find(
    (m) => (m.recordId ?? m.id) === source?.messageIds?.[0],
  );
  return (
    <div
      className={`canvas-view project-history ${dragPreview ? "carrying-definition" : ""}`}
      onPointerMove={(e) => {
        const state = dragState.current;
        if (!state) return;
        if (
          !state.active &&
          Math.hypot(e.clientX - state.x, e.clientY - state.y) < 6
        )
          return;
        state.active = true;
        suppressClick.current = true;
        const target = document
          .elementFromPoint(e.clientX, e.clientY)
          ?.closest<HTMLElement>("[data-history-node]")?.dataset.historyNode;
        state.target = target;
        setDragPreview({
          title: state.title,
          x: e.clientX,
          y: e.clientY,
          target,
        });
      }}
      onPointerUp={() => {
        const state = dragState.current;
        dragState.current = null;
        setDragPreview(null);
        if (state?.active && state.target) {
          const node = all.find((n) => n.id === state.target);
          if (node) beginFork(node, state.id);
        }
      }}
      onPointerCancel={() => {
        dragState.current = null;
        setDragPreview(null);
      }}
      onKeyDownCapture={(e) => {
        if (e.key === "Escape" && dragState.current) {
          dragState.current = null;
          setDragPreview(null);
          suppressClick.current = true;
          e.preventDefault();
          e.stopPropagation();
        }
      }}
    >
      {dragPreview && (
        <div
          className="definition-drag-preview"
          style={{ left: dragPreview.x + 14, top: dragPreview.y + 14 }}
          aria-hidden="true"
        >
          <FileText size={16} />
          {dragPreview.title}
        </div>
      )}
      <div className="canvas-stage" ref={stage}>
        <div className="canvas-heading">
          <GitBranch size={18} />
          <span>
            {t(
              branches.length === 1
                ? "{count} direction"
                : "{count} directions",
              { count: branches.length },
            )}
          </span>
          <button
            className="text-button"
            onClick={() => branch && setSelected(branch.headNodeId)}
          >
            {t("Current position")}
          </button>
          <button
            className="text-button"
            onClick={() => void checkpoint()}
            disabled={busy || !branch}
          >
            <Plus size={17} />
            {t("Checkpoint")}
          </button>
        </div>
        <ReactFlow<HistoryNode>
          nodes={graph.nodes}
          edges={graph.edges}
          onNodesChange={(changes) =>
            setDimensions((previous) => {
              let next = previous;
              for (const change of changes)
                if (
                  change.type === "dimensions" &&
                  change.dimensions &&
                  (previous[change.id]?.width !== change.dimensions.width ||
                    previous[change.id]?.height !== change.dimensions.height)
                )
                  next = { ...next, [change.id]: change.dimensions };
              return next;
            })
          }
          nodeTypes={nodeTypes}
          fitView={!team.canvasViewports?.["project-history"]}
          defaultViewport={team.canvasViewports?.["project-history"]}
          fitViewOptions={{
            padding: 0.3,
            maxZoom: 0.9,
            nodes: all
              .filter((n) => n.branchId === activeBranch)
              .slice(-3)
              .map((n) => ({ id: n.id })),
          }}
          minZoom={0.2}
          maxZoom={1.5}
          nodesConnectable={false}
          nodesDraggable={false}
          deleteKeyCode={null}
          onPaneClick={close}
          onNodeClick={(_, node) => node.data.open()}
          onMoveEnd={(_, viewport) =>
            onUpdate((w) => ({
              ...w,
              teams: w.teams.map((tm) =>
                tm.id === team.id
                  ? {
                      ...tm,
                      canvasViewports: {
                        ...tm.canvasViewports,
                        "project-history": viewport,
                      },
                    }
                  : tm,
              ),
            }))
          }
          proOptions={{ hideAttribution: true }}
        >
          <CanvasViewport
            selectedId={selected ?? forkId ?? undefined}
            restored={!!team.canvasViewports?.["project-history"]}
          />
          <Background color="var(--graph-dot)" gap={24} size={1} />
        </ReactFlow>
        <div className="canvas-tools">
          <IconButton
            label={t("Zoom out")}
            onClick={() => void flow.zoomOut({ duration: reduced ? 0 : 180 })}
          >
            <Minus size={18} />
          </IconButton>
          <IconButton
            label={t("Zoom in")}
            onClick={() => void flow.zoomIn({ duration: reduced ? 0 : 180 })}
          >
            <Plus size={18} />
          </IconButton>
          <IconButton
            label={t("Fit to canvas")}
            onClick={() =>
              void flow.fitView({
                padding: 0.3,
                maxZoom: 1,
                duration: reduced ? 0 : 220,
              })
            }
          >
            <Maximize size={18} />
          </IconButton>
          <IconButton
            label={t("Find node")}
            onClick={() => setSearch((v) => !v)}
          >
            <Search size={18} />
          </IconButton>
        </div>
        {search && (
          <div className="history-search">
            <label>
              <Search size={17} />
              <input
                autoFocus
                aria-label={t("Find a node")}
                placeholder={t("Find a node…")}
                value={nodeQuery}
                onChange={(e) => setNodeQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    setSearch(false);
                    e.stopPropagation();
                  }
                }}
              />
              <IconButton label={t("Close")} onClick={() => setSearch(false)}>
                <X size={17} />
              </IconButton>
            </label>
            <div>
              {all
                .filter((n) =>
                  `${n.title} ${docsAt(n)
                    .map((d) => d.content)
                    .join(" ")}`
                    .toLowerCase()
                    .includes(nodeQuery.toLowerCase()),
                )
                .map((n) => (
                  <button
                    key={n.id}
                    onClick={() => {
                      setSelected(n.id);
                      setForkId(null);
                      setSearch(false);
                    }}
                  >
                    <span>{n.title}</span>
                    <small>
                      {branches.find((b) => b.id === n.branchId)?.name}
                    </small>
                  </button>
                ))}
            </div>
          </div>
        )}
        {error && !displayed && (
          <div className="history-error" role="alert">
            {t(error)}
          </div>
        )}
      </div>
      {(displayed || carryDoc) && (
        <DetailPanel
          label={t(
            fork ? "Try again from here" : carryDoc ? "Carry to" : "Details",
          )}
          className="canvas-detail history-detail"
          onClose={close}
          fallbackFocus={() => stage.current?.querySelector("button") ?? null}
        >
          <header className="detail-header">
            <span>
              {t(
                fork
                  ? "Try again from here"
                  : carryDoc
                    ? "Carry to"
                    : "Details",
              )}
            </span>
            <IconButton label={t("Close details")} onClick={close}>
              <X size={18} />
            </IconButton>
          </header>
          <div className="history-detail-body">
            {carryDoc ? (
              <>
                <h2>{carryDoc.title}</h2>
                <MessageContent text={carryDoc.content} />
                <div className="history-destinations">
                  {all
                    .filter((n) => n.workspaceSnapshotId)
                    .map((n) => (
                      <button
                        key={n.id}
                        onClick={() => beginFork(n, carryDoc.id)}
                      >
                        <GitBranch size={16} />
                        <span>
                          {n.title}
                          <small>
                            {branches.find((b) => b.id === n.branchId)?.name}
                          </small>
                        </span>
                        <ArrowUpRight size={16} />
                      </button>
                    ))}
                </div>
              </>
            ) : (
              displayed && (
                <>
                  <p className="detail-eyebrow">
                    {branches.find((b) => b.id === displayed.branchId)?.name}
                  </p>
                  <h2>{displayed.title}</h2>
                  <time>
                    {new Date(displayed.createdAt).toLocaleString(locale)}
                  </time>
                  {fork ? (
                    <>
                      <label className="history-label">
                        {t("Direction name")}
                        <input
                          value={name}
                          onChange={(e) => setName(e.target.value)}
                          maxLength={160}
                          required
                        />
                      </label>
                      <h3>{t("Retained at this point")}</h3>
                      {docsAt(fork).length ? (
                        docsAt(fork).map((d) => (
                          <details className="history-document" key={d.id}>
                            <summary>{d.title}</summary>
                            <MessageContent text={d.content} />
                          </details>
                        ))
                      ) : (
                        <p className="muted">
                          {t("No definitions at this point")}
                        </p>
                      )}
                      <h3>{t("Bring along")}</h3>
                      <label className="history-filter">
                        <Search size={16} />
                        <input
                          aria-label={t("Find definitions")}
                          placeholder={t("Find definitions…")}
                          value={query}
                          onChange={(e) => setQuery(e.target.value)}
                        />
                      </label>
                      <div className="history-selections">
                        {documents
                          .filter(
                            (d) =>
                              !Object.values(fork.documents).includes(d.id) &&
                              `${d.title} ${d.content}`
                                .toLowerCase()
                                .includes(query.toLowerCase()),
                          )
                          .map((d) => (
                            <div key={d.id} className="history-selection">
                              <label>
                                <input
                                  type="checkbox"
                                  checked={selectedDocs.includes(d.id)}
                                  onChange={(e) => {
                                    setSelectedDocs((ids) =>
                                      e.target.checked
                                        ? [
                                            ...ids.filter(
                                              (id) =>
                                                documents.find(
                                                  (x) => x.id === id,
                                                )?.key !== d.key,
                                            ),
                                            d.id,
                                          ]
                                        : ids.filter((id) => id !== d.id),
                                    );
                                    setReplacements((ids) =>
                                      ids.filter((id) => id !== d.id),
                                    );
                                  }}
                                />
                                <span>
                                  {d.title}
                                  <small>
                                    {new Date(d.createdAt).toLocaleString(
                                      locale,
                                    )}
                                  </small>
                                </span>
                              </label>
                              <details>
                                <summary>{t("Details")}</summary>
                                <MessageContent text={d.content} />
                              </details>
                              {selectedDocs.includes(d.id) &&
                                fork.documents[d.key] && (
                                  <label className="replace-definition">
                                    <input
                                      type="checkbox"
                                      checked={replacements.includes(d.id)}
                                      onChange={(e) =>
                                        setReplacements((ids) =>
                                          e.target.checked
                                            ? [...ids, d.id]
                                            : ids.filter((id) => id !== d.id),
                                        )
                                      }
                                    />
                                    {t("Replace the version at this point")}
                                  </label>
                                )}
                            </div>
                          ))}
                      </div>
                      {error && (
                        <p className="form-error" role="alert">
                          {t(error)}
                        </p>
                      )}
                      <button
                        className="primary-button history-fork-submit"
                        disabled={
                          busy ||
                          !name.trim() ||
                          conflicts.some((id) => !replacements.includes(id))
                        }
                        onClick={() => void submit()}
                      >
                        {busy ? (
                          <LoaderCircle className="spinner" size={17} />
                        ) : (
                          <GitBranch size={17} />
                        )}{" "}
                        {t("Start new direction")}
                      </button>
                    </>
                  ) : (
                    <>
                      {sourceMessage && (
                        <div className="history-discussion">
                          <MessageContent text={sourceMessage.text} />
                        </div>
                      )}
                      {sourceChat && (
                        <button
                          className="secondary-button history-open"
                          onClick={() =>
                            onNavigate(sourceChat.id, sourceMessage?.id)
                          }
                        >
                          <ArrowUpRight size={17} />
                          {t("Open conversation")}
                        </button>
                      )}
                      {displayed.source.reason && (
                        <p>{displayed.source.reason}</p>
                      )}
                      {docsAt(displayed).map((d) => (
                        <details className="history-document" key={d.id}>
                          <summary>{d.title}</summary>
                          <MessageContent text={d.content} />
                          <button
                            className="text-button"
                            onPointerDown={(e) => startDrag(d.id, d.title, e)}
                            onClick={() => {
                              if (consumeDragClick()) return;
                              setCarry(d.id);
                              setSelected(null);
                            }}
                          >
                            <GripVertical size={16} />
                            {t("Carry to")}
                          </button>
                        </details>
                      ))}
                      {displayed.kind === "delivery" && (
                        <button
                          className="secondary-button"
                          onClick={() => onDelivery(displayed.id)}
                        >
                          <FileText size={17} />
                          {t("Open delivery")}
                        </button>
                      )}
                      {displayed.workspaceSnapshotId ? (
                        <button
                          className="primary-button history-fork-submit"
                          onClick={() => beginFork(displayed)}
                        >
                          <GitBranch size={17} />
                          {t("Try again from here")}
                        </button>
                      ) : (
                        <p className="muted">
                          {t("No file checkpoint at this point")}
                        </p>
                      )}
                    </>
                  )}
                </>
              )
            )}
          </div>
        </DetailPanel>
      )}
    </div>
  );
}
