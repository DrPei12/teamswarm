import { Disclosure } from "./Disclosure";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  lazy,
  Suspense,
  type FormEvent,
  type ReactNode,
  type CSSProperties,
} from "react";
import { LanguageProvider, useI18n, type Language } from "./i18n";
import { Dialog, Tooltip, Popover } from "radix-ui";
import {
  ChevronDown,
  Plus,
  Settings2,
  Check,
  PanelLeft,
  X,
  Star,
  MoreHorizontal,
  Pencil,
  ArrowUpRight,
  ArrowDown,
  Monitor,
  Sun,
  Moon,
  Hash,
  Search,
  Keyboard,
  AlertCircle,
  File,
  LoaderCircle,
  GitBranch,
  Users,
  MessageSquare,
  BookmarkPlus,
  Package,
  Archive,
  Paperclip,
} from "lucide-react";
import { ComposerInput, RuntimeControls } from "./ComposerTools";
import { ComposerSurface } from "./design-system/ComposerSurface";
import { SwarmMark } from "./SwarmMark";
import { ProjectRecords } from "./ProjectRecords";
const TeamCanvas = lazy(() =>
  import("./TeamCanvas").then((module) => ({ default: module.TeamCanvas })),
);
import { definitionLabels } from "./history";
import { product, useProduct } from "./service";
import {
  Startup,
  ExecutionSettings,
  ExecutionActivity,
} from "./ExecutionSettings";
import { MessageContent } from "./MessageContent";
import { ConversationActivity } from "./ConversationActivity";
import { usePanelResize } from "./usePanelResize";
import {
  Icon,
  IconButton,
  Menu,
  MenuItem,
  Modal,
  DetailPanel,
  Separator,
  ICON_SCALE,
} from "./ui";
import {
  emptyDraft,
  downloadFile,
  type Workspace,
  type Draft,
  type Chat,
  type Attachment,
  type DefinitionKind,
  type Message,
  defaultRuntime,
} from "./store";

type Screen =
  | "settings"
  | "team"
  | "skill"
  | "shortcuts"
  | "search"
  | "member"
  | "plugins"
  | null;
type Route = {
  teamId: string;
  chatId?: string;
  view?: "host" | "collaboration" | "history";
  messageId?: string;
  memberId?: string;
  workId?: string;
};
function parseRoute(): Route {
  const bits = location.hash.slice(1).split("/").filter(Boolean);
  const memberRoute = bits[2] === "collaboration" && bits[3] === "member";
  return {
    teamId: bits[0] === "team" ? bits[1] || "general" : "general",
    chatId: bits[2] === "chat" ? bits[3] : undefined,
    view:
      bits[2] === "collaboration" || bits[2] === "history" ? bits[2] : "host",
    messageId: memberRoute
      ? bits[5] === "message"
        ? bits[6]
        : undefined
      : bits[4] === "message"
        ? bits[5]
        : undefined,
    memberId: memberRoute ? bits[4] : undefined,
    workId: memberRoute && bits[7] === "work" ? bits[8] : undefined,
  };
}
export default function App() {
  const state = useProduct();
  useEffect(() => {
    void product.start();
  }, []);
  return (
    <LanguageProvider language={state.workspace?.language || "en"}>
      {!state.workspace || !state.workspace.teams.length ? (
        <Startup state={state} />
      ) : (
        <WorkspaceView workspace={state.workspace} />
      )}
    </LanguageProvider>
  );
}
function WorkspaceView({ workspace }: { workspace: Workspace }) {
  const { t: tr, locale } = useI18n();
  const [route, setRoute] = useState<Route>(parseRoute);
  const routeTo = (next: Route) => {
    setRoute(next);
    const target =
      next.view === "collaboration"
        ? `/collaboration${next.memberId ? `/member/${next.memberId}/message/${next.messageId ?? ""}${next.workId ? `/work/${next.workId}` : ""}` : ""}`
        : next.view === "history"
          ? "/history"
          : next.chatId
            ? `/chat/${next.chatId}${next.messageId ? `/message/${next.messageId}` : ""}`
            : "/agent";
    location.hash = `/team/${next.teamId}${target}`;
  };
  const [screen, setScreen] = useState<Screen>(null);
  const [executionSettings, setExecutionSettings] = useState(false);
  const serviceState = useProduct();
  const sendLock = useRef(false);
  const [sidebar, setSidebar] = useState(false);
  const [navCollapsed, setNavCollapsed] = useState(() => {
    try {
      return localStorage.getItem("teamswarm.navigation-collapsed") === "true";
    } catch {
      return false;
    }
  });
  const toggleNavigation = () => {
    if (narrow) {
      setSidebar((open) => !open);
      return;
    }
    setNavCollapsed((value) => {
      try {
        localStorage.setItem("teamswarm.navigation-collapsed", String(!value));
      } catch {
        /* Optional preference. */
      }
      return !value;
    });
  };
  const [narrow, setNarrow] = useState(
    () => matchMedia("(max-width:760px)").matches,
  );
  const [collapsed, setCollapsed] = useState(false);
  const [teamExpanded, setTeamExpanded] = useState<Record<string, boolean>>({});
  const [notice, setNotice] = useState("");
  const [history, setHistory] = useState(false);
  const [recordsOpen, setRecordsOpen] = useState(false);
  const [insightSource, setInsightSource] = useState<Message>();
  const [definitionSource, setDefinitionSource] = useState<Message | null>(
    null,
  );
  const [definitionKind, setDefinitionKind] =
    useState<DefinitionKind>("requirement");
  const [deliveryId, setDeliveryId] = useState<string | null>(null);
  const [deliveryOpen, setDeliveryOpen] = useState(false);
  const [viewingDelivery, setViewingDelivery] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [historyLoadError, setHistoryLoadError] = useState("");
  const [rename, setRename] = useState<Chat | null>(null);
  const [search, setSearch] = useState("");
  const [searchIndex, setSearchIndex] = useState(0);
  const editor = useRef<HTMLTextAreaElement>(null);
  const uploads = useRef<HTMLInputElement>(null);
  const thread = useRef<HTMLDivElement>(null);
  const followHost = useRef(true);
  const inspectingHostActivity = useRef(false);
  const [hostAtBottom, setHostAtBottom] = useState(true);
  const navigationPanel = useRef<HTMLElement>(null);
  const navigationResize = usePanelResize(
    navigationPanel,
    !narrow && !navCollapsed,
    {
      side: "left",
      key: "teamswarm.navigation-width",
      min: 208,
      max: 420,
      reserve: 540,
    },
  );
  const syncHostScroll = () => {
    const el = thread.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= 24;
    followHost.current = atBottom && !inspectingHostActivity.current;
    setHostAtBottom(atBottom);
  };
  const currentState = useRef(workspace);
  currentState.current = workspace;
  const team =
    workspace.teams.find((t) => t.id === route.teamId) || workspace.teams[0];
  const view = route.view || "host";
  const teamDeliveries = workspace.deliveries.filter(
    (d) => d.teamId === team.id,
  );
  const openedDelivery = teamDeliveries.find((d) => d.id === deliveryId);
  const chat = workspace.chats.find(
    (c) => c.id === route.chatId && c.teamId === team.id,
  );
  useEffect(() => {
    if (
      !route.messageId ||
      historyLoadError === route.messageId ||
      !chat?.historyBefore ||
      loadingOlder ||
      chat.messages.some(
        (message) =>
          message.id === route.messageId ||
          message.recordId === route.messageId,
      )
    )
      return;
    setLoadingOlder(true);
    void product
      .loadOlder(chat.id)
      .catch((error) => {
        setNotice(error.message);
        setHistoryLoadError(route.messageId!);
      })
      .finally(() => setLoadingOlder(false));
  }, [route.messageId, chat, loadingOlder, historyLoadError]);
  const focusedHostMessageId = route.messageId
    ? chat?.messages.find(
        (message) =>
          message.id === route.messageId ||
          message.recordId === route.messageId,
      )?.id
    : undefined;
  const draftKey = chat?.id || `new:${team.id}`;
  const draft = workspace.drafts[draftKey] || emptyDraft;
  const skills = workspace.skills.filter((s) => s.teamId === team.id);
  const selectedSkill = skills.find((s) => s.id === draft.skillId);
  const teamChats = workspace.chats
    .filter((c) => c.teamId === team.id && !c.archived)
    .sort((a, b) => b.createdAt - a.createdAt);
  const newChat = () => {
    update((old) => ({
      ...old,
      teams: old.teams.map((t) =>
        t.id === team.id
          ? { ...t, context: undefined, lastChatId: undefined }
          : t,
      ),
    }));
    routeTo({ teamId: team.id });
    setSidebar(false);
    setHistory(false);
    requestAnimationFrame(() => editor.current?.focus());
  };
  const navigate = (next: Route) => {
    if (
      next.chatId &&
      !update((old) => ({
        ...old,
        teams: old.teams.map((t) =>
          t.id === next.teamId
            ? {
                ...t,
                lastChatId: next.chatId,
                context: t.lastChatId === next.chatId ? t.context : undefined,
              }
            : t,
        ),
      }))
    )
      return;
    routeTo(next);
    setSidebar(false);
    setHistory(false);
    setScreen(null);
    setDeliveryId(null);
  };
  const update = (change: (old: Workspace) => Workspace) =>
    product.update(change);
  useEffect(() => product.watch(team.id), [team.id]);
  const updateDraft = (change: Partial<Draft>, key = draftKey) =>
    update((old) => ({
      ...old,
      drafts: {
        ...old.drafts,
        [key]: { ...(old.drafts[key] || emptyDraft), ...change },
      },
    }));
  useEffect(() => {
    const sync = () => {
      setRoute(parseRoute());
    };
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);
  useEffect(() => {
    const media = matchMedia("(max-width:760px)");
    const sync = () => setNarrow(media.matches);
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);
  useEffect(() => {
    if (sidebar && narrow)
      document.querySelector<HTMLButtonElement>(".workspace-switch")?.focus();
  }, [sidebar, narrow]);
  useEffect(() => {
    if (screen === "search")
      document
        .querySelector(".search-result.selected")
        ?.scrollIntoView({ block: "nearest" });
  }, [searchIndex, screen]);
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      document.documentElement.dataset.theme =
        workspace.theme === "system"
          ? media.matches
            ? "dark"
            : "light"
          : workspace.theme;
      window.teamswarmDesktop?.setTheme(
        document.documentElement.dataset.theme === "dark",
      );
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [workspace.theme]);
  useEffect(() => {
    document.title = chat ? `${chat.title} · TeamSwarm` : "TeamSwarm";
  }, [chat]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 4500);
    return () => clearTimeout(timer);
  }, [notice]);
  useLayoutEffect(() => {
    if (editor.current) {
      editor.current.style.height = "0px";
      editor.current.style.height = `${Math.min(Math.max(editor.current.scrollHeight, 44), 260)}px`;
      if (followHost.current && thread.current)
        thread.current.scrollTop = thread.current.scrollHeight;
    }
  }, [draft.text, route]);
  useEffect(() => {
    inspectingHostActivity.current = false;
    followHost.current = !route.messageId;
    setHostAtBottom(!route.messageId);
    if (route.messageId) {
      const target = document.getElementById(`message-${focusedHostMessageId}`);
      target?.scrollIntoView({ block: "center" });
      target?.focus({ preventScroll: true });
    } else
      thread.current?.scrollTo({
        top: thread.current.scrollHeight,
        behavior: "instant",
      });
  }, [chat?.id, route.messageId, view, focusedHostMessageId]);
  useEffect(() => {
    const el = thread.current;
    const content = el?.querySelector(".messages");
    if (!el || !content) return;
    const observer = new ResizeObserver(() => {
      if (followHost.current) el.scrollTop = el.scrollHeight;
      syncHostScroll();
    });
    observer.observe(content);
    observer.observe(el);
    const composer = el.querySelector(".composer-position");
    if (composer) observer.observe(composer);
    return () => observer.disconnect();
  }, [chat?.id, view]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearch("");
        setSearchIndex(0);
        setScreen("search");
      }
      if (
        (event.metaKey || event.ctrlKey) &&
        event.shiftKey &&
        event.key.toLowerCase() === "o"
      ) {
        event.preventDefault();
        newChat();
      }
      if (event.key === "Escape") {
        setDeliveryId(null);
        if (sidebar) {
          setSidebar(false);
          requestAnimationFrame(() =>
            document
              .querySelector<HTMLButtonElement>(".navigation-toggle")
              ?.focus(),
          );
        }
        setNotice("");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  const send = async () => {
    if (sendLock.current || busy || (!draft.text.trim() && !draft.files.length))
      return;
    sendLock.current = true;
    setBusy(true);
    const teamId = team.id,
      sourceChatId = chat?.id;
    try {
      const result = await product.send(
        teamId,
        sourceChatId,
        structuredClone(draft),
      );
      const currentRoute = parseRoute();
      if (
        (currentRoute.teamId === teamId || !location.hash) &&
        currentRoute.chatId === sourceChatId
      ) {
        inspectingHostActivity.current = false;
        followHost.current = true;
        routeTo({ teamId, chatId: result.chatId });
        requestAnimationFrame(() =>
          thread.current?.scrollTo({
            top: thread.current.scrollHeight,
            behavior: "smooth",
          }),
        );
      }
    } catch (error) {
      setNotice((error as Error).message);
    } finally {
      sendLock.current = false;
      setBusy(false);
    }
  };
  const openDelivery = async (id: string) => {
    if (viewingDelivery) return;
    const delivery = teamDeliveries.find((d) => d.id === id);
    if (!delivery) return;
    setViewingDelivery(true);
    setNotice("");
    try {
      if (delivery.hostDelivery) await product.viewDelivery(delivery);
      else if (
        !update((old) => ({
          ...old,
          deliveries: old.deliveries.map((d) =>
            d.id === id ? { ...d, read: true } : d,
          ),
        }))
      )
        return;
      setDeliveryId(id);
      setDeliveryOpen(false);
    } catch (error) {
      setNotice((error as Error).message);
    } finally {
      setViewingDelivery(false);
    }
  };
  const openHost = (teamId = team.id) => {
    const target = workspace.teams.find((t) => t.id === teamId);
    navigate({ teamId, chatId: target?.lastChatId, view: "host" });
  };
  const addFiles = async (files: File[]) => {
    if (!files.length) return;
    const key = draftKey;
    setBusy(true);
    try {
      const saved: Attachment[] = [];
      for (const file of files) {
        if (file.size > 25 * 1024 * 1024) {
          setNotice(tr("{name}: maximum size is 25 MB", { name: file.name }));
          continue;
        }
        saved.push(await product.upload(file));
      }
      update((old) => ({
        ...old,
        drafts: {
          ...old.drafts,
          [key]: {
            ...(old.drafts[key] || emptyDraft),
            files: [...(old.drafts[key]?.files || []), ...saved],
          },
        },
      }));
    } catch {
      setNotice(tr("Couldn’t attach file. Try again."));
    } finally {
      setBusy(false);
      if (uploads.current) uploads.current.value = "";
    }
  };
  const fileButton = (file: Attachment, removable = false): ReactNode => (
    <span className="file-chip" key={file.id}>
      <button
        type="button"
        onClick={() =>
          downloadFile(file).catch(() =>
            setNotice(tr("Couldn’t open file. Try again.")),
          )
        }
      >
        <File size={14 * ICON_SCALE} />
        <span>{file.name}</span>
      </button>
      {removable && (
        <button
          type="button"
          aria-label={tr("Remove {name}", { name: file.name })}
          onClick={() =>
            updateDraft({ files: draft.files.filter((f) => f.id !== file.id) })
          }
        >
          <X size={12 * ICON_SCALE} />
        </button>
      )}
    </span>
  );
  const searchResults = [
    ...workspace.teams.map((t) => ({
      id: t.id,
      label: t.name,
      detail: tr("Team"),
      icon: <Hash size={15 * ICON_SCALE} />,
      run: () => navigate({ teamId: t.id }),
    })),
    ...workspace.chats.map((c) => ({
      id: c.id,
      label: c.title,
      detail: `${workspace.teams.find((t) => t.id === c.teamId)?.name || tr("Chat")}${c.archived ? ` · ${tr("Archived")}` : ""}`,
      icon: <Icon name="agent" />,
      run: () => navigate({ teamId: c.teamId, chatId: c.id }),
    })),
  ].filter((r) =>
    `${r.label} ${r.detail}`.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <Tooltip.Provider delayDuration={450}>
      <a className="skip-link" href="#main">
        {tr("Skip to content")}
      </a>
      <div className="app-shell">
        <aside
          ref={navigationPanel}
          style={
            {
              ...(!narrow && navCollapsed ? {} : navigationResize.style),
              "--navigation-content-width": narrow
                ? "100%"
                : `${navigationResize.expandedWidth - 24}px`,
            } as CSSProperties
          }
          className={`sidebar ${sidebar ? "is-open" : ""} ${!narrow && navCollapsed ? "is-collapsed" : ""}`}
          inert={narrow ? !sidebar : navCollapsed}
          aria-label={tr("Workspace navigation")}
          onKeyDown={(event) => {
            if (event.key === "Tab" && sidebar && narrow) {
              const buttons = [
                ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
                  "button:not(:disabled)",
                ),
              ];
              const first = buttons[0],
                last = buttons.at(-1);
              if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last?.focus();
              } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first?.focus();
              }
            }
          }}
        >
          <div className="workspace-bar">
            <Menu
              trigger={
                <button
                  className="workspace-switch"
                  aria-label={tr("Workspace menu")}
                >
                  <span className="avatar">
                    <SwarmMark />
                  </span>
                  <span>{workspace.name}</span>
                  <ChevronDown size={12 * ICON_SCALE} />
                </button>
              }
            >
              <div className="menu-heading">{workspace.name}</div>
              <MenuItem
                icon={<Settings2 size={15 * ICON_SCALE} />}
                onSelect={() => setScreen("settings")}
              >
                {tr("Settings")}
              </MenuItem>
              <Separator />
              <MenuItem
                icon={<Plus size={15 * ICON_SCALE} />}
                onSelect={() => setScreen("team")}
              >
                {tr("Create team")}
              </MenuItem>
              <Separator />
              <MenuItem
                icon={<Keyboard size={15 * ICON_SCALE} />}
                onSelect={() => setScreen("shortcuts")}
              >
                {tr("Keyboard shortcuts")}
              </MenuItem>
            </Menu>
          </div>
          <div className="sidebar-primary">
            <button
              className="sidebar-action new-conversation"
              onClick={newChat}
            >
              <Plus size={16} />
              <span>{tr("New chat")}</span>
            </button>
            <button
              className="sidebar-action"
              onClick={() => {
                setSearch("");
                setScreen("search");
              }}
            >
              <Icon name="search" />
              <span>{tr("Search workspace")}</span>
              <kbd>Ctrl K</kbd>
            </button>
          </div>
          <nav className="navigation">
            {workspace.chats.some((c) => c.starred) && (
              <section className="nav-group">
                <div className="group-heading">{tr("Favorites")}</div>
                {workspace.chats
                  .filter((c) => c.starred)
                  .map((c) => (
                    <button
                      className={`nav-row ${chat?.id === c.id ? "active" : ""}`}
                      key={c.id}
                      onClick={() =>
                        navigate({ teamId: c.teamId, chatId: c.id })
                      }
                    >
                      <Icon name="agent" />
                      <span>{c.title}</span>
                    </button>
                  ))}
              </section>
            )}
            <section className="nav-group">
              <div className="group-title">
                <button
                  className="group-heading"
                  aria-expanded={!collapsed}
                  onClick={() => setCollapsed(!collapsed)}
                >
                  {tr("Your teams")}
                  <ChevronDown
                    className={collapsed ? "rotate-left" : ""}
                    size={11 * ICON_SCALE}
                  />
                </button>
                <IconButton
                  label={tr("Create team")}
                  className="group-add"
                  onClick={() => setScreen("team")}
                >
                  <Plus size={13 * ICON_SCALE} />
                </IconButton>
              </div>
              <Disclosure open={!collapsed}>
                {workspace.teams.map((t) => (
                  <div
                    className={`team-block ${team.id === t.id ? "is-current-team" : ""}`}
                    key={t.id}
                  >
                    <div className="team-heading">
                      <button
                        className="nav-row"
                        onClick={() => openHost(t.id)}
                      >
                        <span className="team-mark" style={{ color: t.color }}>
                          <Hash size={15 * ICON_SCALE} />
                        </span>
                        <span>{t.name}</span>
                      </button>
                      <button
                        className="team-collapse"
                        aria-label={tr("Toggle {name}", { name: t.name })}
                        aria-expanded={teamExpanded[t.id] !== false}
                        onClick={() =>
                          setTeamExpanded({
                            ...teamExpanded,
                            [t.id]: teamExpanded[t.id] === false,
                          })
                        }
                      >
                        <ChevronDown
                          size={11 * ICON_SCALE}
                          className={
                            teamExpanded[t.id] === false ? "rotate-left" : ""
                          }
                        />
                      </button>
                    </div>
                    <Disclosure
                      open={teamExpanded[t.id] !== false}
                      className="team-views"
                    >
                      {(["host", "collaboration", "history"] as const).map(
                        (section) => (
                          <button
                            key={section}
                            className={`nav-row team-home ${team.id === t.id && view === section ? "active" : ""}`}
                            aria-current={
                              team.id === t.id && view === section
                                ? "page"
                                : undefined
                            }
                            onClick={() =>
                              section === "host"
                                ? openHost(t.id)
                                : navigate({ teamId: t.id, view: section })
                            }
                          >
                            {section === "host" ? (
                              <MessageSquare size={14 * ICON_SCALE} />
                            ) : section === "collaboration" ? (
                              <Users size={14 * ICON_SCALE} />
                            ) : (
                              <GitBranch size={14 * ICON_SCALE} />
                            )}
                            <span>
                              {section === "host"
                                ? "Host"
                                : section === "collaboration"
                                  ? tr("Collaboration")
                                  : tr("History")}
                            </span>
                          </button>
                        ),
                      )}
                    </Disclosure>
                  </div>
                ))}
              </Disclosure>
            </section>
            {!!teamChats.length && (
              <section className="recent-chats">
                <div className="group-heading">
                  {tr("Recent conversations")}
                </div>
                {teamChats.slice(0, 8).map((c) => (
                  <button
                    key={c.id}
                    className={`nav-row ${chat?.id === c.id && view === "host" ? "active" : ""}`}
                    title={c.title}
                    onClick={() => navigate({ teamId: team.id, chatId: c.id })}
                  >
                    <MessageSquare size={13} />
                    <span>{c.title}</span>
                  </button>
                ))}
              </section>
            )}
          </nav>
          {!narrow && !navCollapsed && (
            <div
              className="detail-resize-handle navigation-resize-handle"
              role="separator"
              tabIndex={0}
              aria-label={tr("Resize navigation")}
              aria-orientation="vertical"
              {...navigationResize.handle}
            />
          )}
          <div className="sidebar-bottom">
            <SwarmMark />
            <span>TeamSwarm</span>
            <Menu
              side="top"
              trigger={
                <IconButton label={tr("Help")} className="help-button">
                  <Icon name="help" />
                </IconButton>
              }
            >
              <MenuItem
                icon={<Keyboard size={15 * ICON_SCALE} />}
                onSelect={() => setScreen("shortcuts")}
              >
                {tr("Keyboard shortcuts")}
              </MenuItem>
              <MenuItem
                icon={<Settings2 size={15 * ICON_SCALE} />}
                onSelect={() => setScreen("settings")}
              >
                {tr("Settings")}
              </MenuItem>
            </Menu>
          </div>
        </aside>
        {sidebar && (
          <button
            className="sidebar-scrim"
            aria-label={tr("Close sidebar")}
            onClick={() => setSidebar(false)}
          />
        )}
        <div className="work-area" inert={narrow && sidebar}>
          <main
            id="main"
            className={`surface ${chat ? "has-chat" : ""} ${view !== "host" ? "canvas-surface" : ""}`}
          >
            <h1 className="sr-only">
              {view === "host"
                ? team.name
                : view === "history"
                  ? tr("History")
                  : tr("Collaboration")}
            </h1>
            <header className="topbar">
              <IconButton
                label={tr(
                  (narrow ? !sidebar : navCollapsed)
                    ? "Open sidebar"
                    : "Close sidebar",
                )}
                className="navigation-toggle"
                onClick={toggleNavigation}
              >
                <PanelLeft size={16 * ICON_SCALE} />
              </IconButton>
              {view === "host" ? (
                <Menu
                  className="chat-menu"
                  trigger={
                    <button
                      className="chat-switch"
                      aria-label={tr("Switch chat")}
                    >
                      <SwarmMark className="host-heading-mark" />
                      <span>{team.name}</span>
                      <ChevronDown size={12 * ICON_SCALE} />
                    </button>
                  }
                >
                  {teamChats.length > 0 && (
                    <>
                      <MenuItem
                        icon={<Plus size={15 * ICON_SCALE} />}
                        onSelect={newChat}
                        shortcut="Ctrl ⇧ O"
                      >
                        {tr("New chat")}
                      </MenuItem>
                      <Separator />
                    </>
                  )}
                  {teamChats.length ? (
                    teamChats.map((c) => (
                      <MenuItem
                        key={c.id}
                        icon={<Icon name="agent" />}
                        onSelect={() =>
                          navigate({ teamId: team.id, chatId: c.id })
                        }
                      >
                        {c.title}
                      </MenuItem>
                    ))
                  ) : (
                    <div className="menu-empty">{tr("No history")}</div>
                  )}
                </Menu>
              ) : (
                <div className="canvas-title">
                  <span>{team.name}</span>
                  <span>/</span>
                  <strong>
                    {view === "history" ? tr("History") : tr("Collaboration")}
                  </strong>
                </div>
              )}
              <button
                type="button"
                className="execution-settings-trigger"
                onClick={() => setExecutionSettings(true)}
                aria-label={tr("Team capabilities")}
              >
                <Settings2 size={15 * ICON_SCALE} />
              </button>
              <div className="delivery-area">
                <IconButton
                  label={tr("Results and reasoning")}
                  onClick={() => {
                    setInsightSource(undefined);
                    setRecordsOpen(true);
                  }}
                >
                  <BookmarkPlus size={16 * ICON_SCALE} />
                </IconButton>
                <Popover.Root
                  open={deliveryOpen}
                  onOpenChange={setDeliveryOpen}
                >
                  <Popover.Trigger asChild>
                    <button
                      className="delivery-trigger"
                      aria-label={tr("Deliveries")}
                    >
                      <Package size={16 * ICON_SCALE} />
                      {teamDeliveries.some((d) => !d.read) && (
                        <span className="unread-dot" />
                      )}
                    </button>
                  </Popover.Trigger>
                  <Popover.Portal>
                    <Popover.Content
                      className="deliveries-popover"
                      align="end"
                      sideOffset={10}
                      aria-label={tr("Deliveries")}
                    >
                      <div className="popover-heading">
                        {tr("Deliveries")}
                        <span>{teamDeliveries.length}</span>
                      </div>
                      {teamDeliveries.length ? (
                        teamDeliveries.map((d) => (
                          <button
                            className="delivery-row"
                            aria-label={d.title}
                            key={d.id}
                            disabled={viewingDelivery}
                            onClick={() => openDelivery(d.id)}
                          >
                            <span
                              className={`delivery-read ${!d.read ? "unread" : ""}`}
                            />
                            <span>
                              <strong>{d.title}</strong>
                              <small>{d.summary}</small>
                            </span>
                            <ArrowUpRight size={13 * ICON_SCALE} />
                          </button>
                        ))
                      ) : (
                        <div className="menu-empty">
                          {tr("No deliveries yet")}
                        </div>
                      )}
                    </Popover.Content>
                  </Popover.Portal>
                </Popover.Root>
              </div>
              {chat && view === "host" && (
                <div className="topbar-actions">
                  <IconButton
                    label={
                      chat.starred
                        ? tr("Remove from favorites")
                        : tr("Add to favorites")
                    }
                    onClick={() =>
                      update((old) => ({
                        ...old,
                        chats: old.chats.map((c) =>
                          c.id === chat.id ? { ...c, starred: !c.starred } : c,
                        ),
                      }))
                    }
                  >
                    <Star
                      size={15 * ICON_SCALE}
                      fill={chat.starred ? "currentColor" : "none"}
                    />
                  </IconButton>
                  <Menu
                    align="end"
                    trigger={
                      <IconButton label={tr("Chat options")}>
                        <MoreHorizontal size={17 * ICON_SCALE} />
                      </IconButton>
                    }
                  >
                    <MenuItem
                      icon={<Pencil size={14 * ICON_SCALE} />}
                      onSelect={() => setRename(chat)}
                    >
                      {tr("Rename")}
                    </MenuItem>
                    <Separator />
                    <MenuItem
                      icon={<Archive size={14 * ICON_SCALE} />}
                      onSelect={() => {
                        if (
                          update((old) => ({
                            ...old,
                            chats: old.chats.map((c) =>
                              c.id === chat.id
                                ? { ...c, archived: !c.archived }
                                : c,
                            ),
                          }))
                        )
                          setNotice(
                            chat.archived
                              ? tr("Conversation restored")
                              : tr("Conversation archived"),
                          );
                      }}
                    >
                      {chat.archived ? tr("Restore chat") : tr("Archive chat")}
                    </MenuItem>
                  </Menu>
                </div>
              )}
            </header>
            {view !== "host" ? (
              <Suspense
                fallback={<div className="canvas-view" aria-busy="true" />}
              >
                <TeamCanvas
                  key={`${team.id}:${view}`}
                  workspace={workspace}
                  team={team}
                  mode={view}
                  chatId={team.lastChatId}
                  memberAnchor={
                    route.memberId
                      ? {
                          memberId: route.memberId,
                          messageId: route.messageId,
                          workId: route.workId,
                        }
                      : undefined
                  }
                  onUpdate={update}
                  onNavigate={(id, messageId) =>
                    navigate({
                      teamId: team.id,
                      chatId: id || team.lastChatId,
                      messageId,
                    })
                  }
                  onAddMember={() => setScreen("member")}
                  onDelivery={openDelivery}
                />
              </Suspense>
            ) : (
              <div
                className="conversation-area"
                ref={thread}
                onWheel={(event) => {
                  inspectingHostActivity.current = false;
                  if (event.deltaY < 0) followHost.current = false;
                  else syncHostScroll();
                }}
                onTouchStart={() => {
                  inspectingHostActivity.current = false;
                  followHost.current = false;
                }}
                onKeyDown={(event) => {
                  if (
                    [
                      "PageUp",
                      "PageDown",
                      "Home",
                      "End",
                      "ArrowUp",
                      "ArrowDown",
                    ].includes(event.key)
                  )
                    inspectingHostActivity.current = false;
                }}
                onClickCapture={(event) => {
                  if (
                    (event.target as Element).closest(
                      ".activity-summary, .activity-toggle",
                    )
                  ) {
                    inspectingHostActivity.current = true;
                    followHost.current = false;
                  }
                }}
                onScroll={syncHostScroll}
                onPointerDownCapture={(event) => {
                  if (
                    !(event.target as Element).closest(
                      ".activity-summary, .activity-toggle",
                    )
                  )
                    inspectingHostActivity.current = false;
                }}
              >
                {chat && (
                  <div className="messages" aria-label={tr("Conversation")}>
                    {chat.historyBefore && (
                      <button
                        className="load-older-messages"
                        disabled={loadingOlder}
                        onClick={async () => {
                          const element = thread.current;
                          const height = element?.scrollHeight ?? 0;
                          const top = element?.scrollTop ?? 0;
                          followHost.current = false;
                          setLoadingOlder(true);
                          try {
                            await product.loadOlder(chat.id);
                            requestAnimationFrame(() => {
                              if (element)
                                element.scrollTop =
                                  top + element.scrollHeight - height;
                            });
                          } catch (error) {
                            setNotice((error as Error).message);
                          } finally {
                            setLoadingOlder(false);
                          }
                        }}
                      >
                        {tr(
                          loadingOlder
                            ? "Loading earlier messages…"
                            : "Load earlier messages",
                        )}
                      </button>
                    )}
                    {chat.parent && (
                      <div className="branch-context">
                        <GitBranch size={14 * ICON_SCALE} />
                        <span>{chat.title}</span>
                        <button
                          onClick={() =>
                            navigate({ teamId: team.id, view: "history" })
                          }
                        >
                          {tr("{count} retained", {
                            count: chat.inheritedDefinitions?.length || 0,
                          })}
                          <ArrowUpRight size={12 * ICON_SCALE} />
                        </button>
                      </div>
                    )}
                    {!!chat.inheritedDefinitions?.length && (
                      <details className="branch-definitions">
                        <summary>{tr("Context")}</summary>
                        {chat.inheritedDefinitions.map((d) => (
                          <div key={d.id}>
                            <span>{tr(definitionLabels[d.kind])}</span>
                            <strong>{d.title}</strong>
                            <p>{d.text}</p>
                          </div>
                        ))}
                      </details>
                    )}
                    {chat.messages.map((m) => (
                      <article
                        className={`message message-${m.role} ${focusedHostMessageId === m.id ? "highlighted" : ""}`}
                        key={m.id}
                        id={`message-${m.id}`}
                        tabIndex={-1}
                      >
                        <div className="message-heading">
                          <span className="message-avatar">
                            {m.role === "host" && <SwarmMark />}
                            {m.role === "host" ? "Host" : tr("You")}
                          </span>
                          <time dateTime={new Date(m.createdAt).toISOString()}>
                            {new Date(m.createdAt).toLocaleTimeString(locale, {
                              hour: "2-digit",
                              minute: "2-digit",
                            })}
                          </time>
                          <Menu
                            align="end"
                            trigger={
                              <IconButton
                                label={tr("Save definition")}
                                className="message-save"
                              >
                                <BookmarkPlus size={14 * ICON_SCALE} />
                              </IconButton>
                            }
                          >
                            <MenuItem
                              onSelect={() => {
                                setInsightSource(m);
                                setRecordsOpen(true);
                              }}
                            >
                              {tr("Save an idea or decision")}
                            </MenuItem>
                            {Object.entries(definitionLabels).map(
                              ([kind, label]) => (
                                <MenuItem
                                  key={kind}
                                  onSelect={() => {
                                    setDefinitionKind(kind as DefinitionKind);
                                    setDefinitionSource(m);
                                  }}
                                >
                                  {tr(label)}
                                </MenuItem>
                              ),
                            )}
                          </Menu>
                        </div>
                        {m.skill && (
                          <span className="skill-tag">
                            <Icon name="skills" />
                            {m.skill}
                          </span>
                        )}
                        {!!m.activity?.length && (
                          <ConversationActivity
                            items={m.activity}
                            members={workspace.members.filter(
                              (member) => member.teamId === team.id,
                            )}
                            running={m.pending}
                          />
                        )}
                        <MessageContent
                          text={m.text}
                          pending={m.pending}
                          artifacts={(m.artifacts ?? []).map((a) => ({
                            ...a,
                            teamId: team.id,
                          }))}
                        />
                        {workspace.definitions
                          .filter(
                            (d) => d.chatId === chat.id && d.messageId === m.id,
                          )
                          .map((d) => (
                            <button
                              key={d.id}
                              className="message-definition"
                              onClick={() =>
                                navigate({ teamId: team.id, view: "history" })
                              }
                            >
                              <BookmarkPlus size={12 * ICON_SCALE} />
                              {d.title}
                              <ArrowUpRight size={11 * ICON_SCALE} />
                            </button>
                          ))}

                        {m.files.length > 0 && (
                          <div className="files-row">
                            {m.files.map((f) => fileButton(f))}
                          </div>
                        )}
                      </article>
                    ))}
                  </div>
                )}
                <div className="composer-position">
                  {!chat && (
                    <div className="welcome">
                      <SwarmMark />
                      <h2>{tr("What shall we work on?")}</h2>
                      <p>
                        {tr(
                          "Bring an idea to {team}. Host will help move it forward.",
                          { team: team.name },
                        )}
                      </p>
                    </div>
                  )}
                  {chat && !hostAtBottom && (
                    <button
                      type="button"
                      className="thread-bottom host-thread-bottom"
                      aria-label={tr("Scroll to latest")}
                      onClick={() => {
                        inspectingHostActivity.current = false;
                        followHost.current = true;
                        thread.current?.scrollTo({
                          top: thread.current.scrollHeight,
                          behavior: matchMedia(
                            "(prefers-reduced-motion: reduce)",
                          ).matches
                            ? "instant"
                            : "smooth",
                        });
                      }}
                    >
                      <ArrowDown size={15} />
                      {tr("Latest")}
                    </button>
                  )}
                  <ExecutionActivity
                    workspace={workspace}
                    teamId={team.id}
                    chatId={chat?.id}
                    onSettings={() => setExecutionSettings(true)}
                  />
                  <ComposerSurface
                    className="composer"
                    onSubmit={(e) => {
                      e.preventDefault();
                      send();
                    }}
                    onDragOver={(e) => {
                      e.preventDefault();
                      e.currentTarget.classList.add("drag-over");
                    }}
                    onDragLeave={(e) =>
                      e.currentTarget.classList.remove("drag-over")
                    }
                    onDrop={(e) => {
                      e.preventDefault();
                      e.currentTarget.classList.remove("drag-over");
                      void addFiles([...e.dataTransfer.files]);
                    }}
                  >
                    {selectedSkill && (
                      <div className="selected-skill">
                        <Icon name="skills" />
                        {selectedSkill.name}
                        <button
                          type="button"
                          aria-label={tr("Remove skill")}
                          onClick={() => updateDraft({ skillId: undefined })}
                        >
                          <X size={12 * ICON_SCALE} />
                        </button>
                      </div>
                    )}
                    {!!draft.references?.length && (
                      <div className="files-row">
                        {draft.references.map((ref) => (
                          <span className="selected-skill" key={ref.id}>
                            {ref.label}
                            <button
                              type="button"
                              aria-label={tr("Remove {name}", {
                                name: ref.label,
                              })}
                              onClick={() =>
                                updateDraft({
                                  references: draft.references?.filter(
                                    (r) => r.id !== ref.id,
                                  ),
                                })
                              }
                            >
                              <X size={14} />
                            </button>
                          </span>
                        ))}
                      </div>
                    )}
                    {draft.files.length > 0 && (
                      <div className="files-row">
                        {draft.files.map((f) => fileButton(f, true))}
                      </div>
                    )}
                    <ComposerInput
                      ref={editor}
                      value={draft.text}
                      references={draft.references ?? []}
                      workspace={workspace}
                      team={team}
                      onChange={updateDraft}
                      onSend={send}
                      onFiles={(files) => void addFiles(files)}
                      onCreateSkill={() => setScreen("skill")}
                      onPlugins={() => setScreen("plugins")}
                    />
                    <div className="composer-toolbar">
                      <RuntimeControls
                        team={team}
                        onChange={(runtime) => {
                          void product
                            .configure(team.id, runtime)
                            .catch((error) =>
                              setNotice((error as Error).message),
                            );
                        }}
                        onSettings={() => setExecutionSettings(true)}
                      />
                      <span className="toolbar-spacer" />
                      <input
                        ref={uploads}
                        type="file"
                        multiple
                        hidden
                        aria-label={tr("Choose attachments")}
                        onChange={(e) =>
                          void addFiles([...(e.target.files || [])])
                        }
                      />
                      <IconButton
                        label={tr("Attach images, files, or videos")}
                        onClick={() => uploads.current?.click()}
                        disabled={busy}
                      >
                        {busy ? (
                          <LoaderCircle
                            size={15 * ICON_SCALE}
                            className="spinner"
                          />
                        ) : (
                          <Icon name="attach" />
                        )}
                      </IconButton>
                      <IconButton
                        label={tr("Send message")}
                        className={`send-button ${draft.text.trim() || draft.files.length ? "ready" : ""}`}
                        type="submit"
                        disabled={
                          busy || (!draft.text.trim() && !draft.files.length)
                        }
                      >
                        <Icon name="send" />
                      </IconButton>
                    </div>
                  </ComposerSurface>
                  {!chat && (
                    <div className="welcome-actions">
                      {[
                        {
                          label: "Explore an idea",
                          text: "I have an idea I'd like to explore. Help me clarify the goal and constraints before we start.",
                          icon: <MessageSquare size={14} />,
                        },
                        {
                          label: "Plan a project",
                          text: "Help me turn this goal into a practical plan with clear responsibilities and checkpoints.",
                          icon: <GitBranch size={14} />,
                        },
                        {
                          label: "Review progress",
                          text: "Review our current progress, completed work, open questions, and the next useful step.",
                          icon: <Users size={14} />,
                        },
                      ].map((item) => (
                        <button
                          key={item.label}
                          type="button"
                          onClick={() => {
                            updateDraft({ text: tr(item.text) });
                            editor.current?.focus();
                          }}
                        >
                          {item.icon}
                          {tr(item.label)}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
            {openedDelivery && (
              <DetailPanel
                className="delivery-detail"
                label={tr("Delivery details")}
                onClose={() => setDeliveryId(null)}
                fallbackFocus={() =>
                  document.querySelector<HTMLButtonElement>(".delivery-trigger")
                }
              >
                <header>
                  <Package size={16 * ICON_SCALE} />
                  <strong>{openedDelivery.title}</strong>
                  <span>v{openedDelivery.version}</span>
                  <IconButton
                    label={tr("Close delivery")}
                    onClick={() => setDeliveryId(null)}
                  >
                    <X size={16 * ICON_SCALE} />
                  </IconButton>
                </header>
                <div className="detail-scroll">
                  <details className="delivery-host-note">
                    <summary>{tr("Host notes")}</summary>
                    <MessageContent
                      text={openedDelivery.summary}
                      artifacts={(openedDelivery.artifactIds ?? []).map(
                        (a) => ({ ...a, teamId: team.id }),
                      )}
                    />
                  </details>
                  <div className="delivery-content">
                    <MessageContent text={openedDelivery.content} />
                  </div>
                  {openedDelivery.files?.map((file) => fileButton(file))}
                  {openedDelivery.artifactIds?.map((file) => (
                    <a
                      className="file-chip"
                      key={file.id}
                      href={`/api/product/teams/${team.id}/artifacts/${file.id}/download`}
                      download
                    >
                      <Paperclip size={15 * ICON_SCALE} />
                      <span>{file.name}</span>
                    </a>
                  ))}
                  <button
                    className="detail-link"
                    onClick={() => {
                      const item = openedDelivery;
                      navigate({
                        teamId: team.id,
                        chatId: item.chatId,
                        messageId: item.messageId,
                      });
                    }}
                  >
                    {tr("View conversation")}
                    <ArrowUpRight size={13 * ICON_SCALE} />
                  </button>
                </div>
              </DetailPanel>
            )}
          </main>
          <footer className="statusbar">
            <button
              className="agent-footer"
              onClick={() =>
                view === "host" ? editor.current?.focus() : openHost()
              }
            >
              <Icon name="agent" />
              <span>Host</span>
            </button>
            <Popover.Root open={history} onOpenChange={setHistory}>
              <Popover.Trigger asChild>
                <IconButton label={tr("Chat history")}>
                  <Icon name="history" />
                </IconButton>
              </Popover.Trigger>
              <Popover.Portal>
                <Popover.Content
                  aria-label={tr("Chat history")}
                  className="history-popover"
                  side="top"
                  align="end"
                  sideOffset={8}
                  collisionPadding={10}
                >
                  <div className="popover-heading">
                    {tr("Chat history")}
                    <IconButton label={tr("New chat")} onClick={newChat}>
                      <Plus size={15 * ICON_SCALE} />
                    </IconButton>
                  </div>
                  {teamChats.length ? (
                    teamChats.map((c) => (
                      <button
                        className="history-row"
                        key={c.id}
                        onClick={() =>
                          navigate({ teamId: team.id, chatId: c.id })
                        }
                      >
                        <Icon name="agent" />
                        <span>{c.title}</span>
                        <ArrowUpRight size={13 * ICON_SCALE} />
                      </button>
                    ))
                  ) : (
                    <div className="history-empty">
                      <Icon name="history" />
                      <span>{tr("No chats yet")}</span>
                    </div>
                  )}
                </Popover.Content>
              </Popover.Portal>
            </Popover.Root>
          </footer>
        </div>
      </div>
      {recordsOpen && (
        <ProjectRecords
          workspace={workspace}
          teamId={team.id}
          chat={chat ?? workspace.chats.find((c) => c.id === team.lastChatId)}
          source={insightSource}
          onClose={() => setRecordsOpen(false)}
          onNavigate={(chatId, messageId) => {
            setRecordsOpen(false);
            navigate({ teamId: team.id, chatId, messageId });
          }}
          onNavigateMember={(memberId, messageId, workId) => {
            setRecordsOpen(false);
            navigate({
              teamId: team.id,
              view: "collaboration",
              memberId,
              messageId,
              workId,
            });
          }}
        />
      )}
      <Modal
        open={!!definitionSource}
        onOpenChange={(open) => !open && setDefinitionSource(null)}
        title={tr(`Save ${definitionKind}`)}
      >
        {definitionSource && (
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (!chat || !definitionSource || busy) return;
              const data = new FormData(e.currentTarget),
                title = String(data.get("title")).trim(),
                text = String(data.get("text")).trim();
              if (!title || !text) return;
              const branch = workspace.projectBranches?.find(
                (b) => b.id === chat.branchId,
              );
              if (!branch) return;
              setBusy(true);
              try {
                await product.command(`/product/teams/${team.id}/definitions`, {
                  clientRequestId: crypto.randomUUID(),
                  conversationId: chat.id,
                  messageId: definitionSource.recordId ?? definitionSource.id,
                  definition: {
                    expectedHeadId: branch.headNodeId,
                    title,
                    reason: "",
                    documents: [
                      {
                        key: `note-${crypto.randomUUID()}`,
                        kind:
                          definitionKind === "problem"
                            ? "understanding"
                            : definitionKind,
                        title,
                        content: text,
                        dependencies: [],
                      },
                    ],
                    removeKeys: [],
                    affectedWorkIds: [],
                  },
                });
                setDefinitionSource(null);
              } catch (error) {
                setNotice((error as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <div className="form-body">
              <label>
                {tr("Title")}
                <input
                  name="title"
                  defaultValue={definitionSource.text.slice(0, 60)}
                  maxLength={100}
                  required
                />
              </label>
              <label>
                {tr("Definition")}
                <textarea
                  name="text"
                  defaultValue={definitionSource.text}
                  rows={6}
                  required
                />
              </label>
            </div>
            <div className="form-footer">
              <button
                type="button"
                className="secondary-button"
                onClick={() => setDefinitionSource(null)}
              >
                {tr("Cancel")}
              </button>
              <button className="primary-button">
                {tr("Save definition")}
              </button>
            </div>
          </form>
        )}
      </Modal>
      <ExecutionSettings
        open={executionSettings}
        onClose={() => setExecutionSettings(false)}
        teamId={team.id}
        workspace={workspace}
      />
      {serviceState.error && (
        <div className="service-error" role="alert">
          <AlertCircle size={17} />
          <span>{tr(serviceState.error)}</span>
          <button
            onClick={() =>
              void product
                .flush()
                .then(() => product.refresh())
                .catch(() => {})
            }
          >
            {tr("Try again")}
          </button>
        </div>
      )}
      <Modal
        open={screen === "member"}
        onOpenChange={(open) => !open && setScreen(null)}
        title={tr("Add member")}
      >
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (busy) return;
            const data = new FormData(e.currentTarget),
              name = String(data.get("name")).trim(),
              responsibility = String(data.get("responsibility")).trim();
            const settings = workspace.executions?.[team.id]?.settings;
            if (!name || !responsibility || !settings) return;
            const ids: Record<string, string> = {
              Codex: "codex",
              "Claude Code": "claude-code",
              Grok: "grok",
              pi: "pi",
              OpenCode: "opencode",
              "DeepSeek Harness": "deepseek-harness",
            };
            const model = String(data.get("model")).trim();
            setBusy(true);
            try {
              await product.command(`/teams/${team.id}/members`, {
                clientRequestId: crypto.randomUUID(),
                name,
                responsibility,
                config: {
                  ...settings.config,
                  harness:
                    ids[String(data.get("harness"))] ??
                    String(data.get("harness")),
                  model: model === "Default model" ? null : model,
                },
              });
              setScreen(null);
            } catch (error) {
              setNotice((error as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <div className="form-body">
            <label>
              {tr("Name")}
              <input
                name="name"
                placeholder={tr("Member name")}
                maxLength={60}
                required
              />
            </label>
            <label>
              {tr("Responsibility")}
              <input
                name="responsibility"
                placeholder={tr("e.g. Design & typography")}
                maxLength={160}
              />
            </label>
            <div className="form-columns">
              <label>
                {tr("Harness")}
                <input
                  name="harness"
                  defaultValue={(team.runtime || defaultRuntime).harness}
                  required
                />
              </label>
              <label>
                {tr("Model")}
                <input
                  name="model"
                  defaultValue={(team.runtime || defaultRuntime).model}
                  required
                />
              </label>
            </div>
          </div>
          <div className="form-footer">
            <button
              type="button"
              className="secondary-button"
              onClick={() => setScreen(null)}
            >
              {tr("Cancel")}
            </button>
            <button className="primary-button">{tr("Add member")}</button>
          </div>
        </form>
      </Modal>
      <Modal
        open={screen === "plugins"}
        onOpenChange={(open) => !open && setScreen(null)}
        title={tr("Plugins")}
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const data = new FormData(e.currentTarget);
            const name = String(data.get("name")).trim();
            const command = String(data.get("command"))
              .trim()
              .replace(/^\//, "");
            if (!name || !command) return;
            if (
              update((old) => ({
                ...old,
                plugins: [
                  ...old.plugins,
                  {
                    id: crypto.randomUUID(),
                    name,
                    command,
                    description: String(data.get("description")).trim(),
                  },
                ],
              }))
            )
              setScreen(null);
          }}
        >
          <div className="form-body">
            {workspace.plugins.map((p) => (
              <div className="plugin-config" key={p.id}>
                <span>{p.name}</span>
                <code>/{p.command}</code>
                <button
                  type="button"
                  aria-label={tr("Remove {name}", { name: p.name })}
                  onClick={() =>
                    update((old) => ({
                      ...old,
                      plugins: old.plugins.filter((item) => item.id !== p.id),
                    }))
                  }
                >
                  <X size={13 * ICON_SCALE} />
                </button>
              </div>
            ))}
            <label>
              {tr("Name")}
              <input name="name" required maxLength={60} />
            </label>
            <label>
              {tr("Command")}
              <input
                name="command"
                placeholder={tr("command")}
                pattern="/?[a-zA-Z0-9_-]+"
                required
              />
            </label>
            <label>
              {tr("Description")}
              <input name="description" maxLength={160} />
            </label>
          </div>
          <div className="form-footer">
            <button
              type="button"
              className="secondary-button"
              onClick={() => setScreen(null)}
            >
              {tr("Cancel")}
            </button>
            <button className="primary-button">{tr("Add command")}</button>
          </div>
        </form>
      </Modal>
      <Modal
        open={screen === "settings"}
        onOpenChange={(open) => !open && setScreen(null)}
        title={tr("Settings")}
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const data = new FormData(e.currentTarget);
            if (
              update((old) => ({
                ...old,
                name: String(data.get("name")).trim() || old.name,
              }))
            )
              setScreen(null);
          }}
        >
          <div className="form-body">
            <label>
              {tr("Workspace name")}
              <input
                name="name"
                defaultValue={workspace.name}
                required
                maxLength={60}
              />
            </label>
            <label>
              {tr("Language")}
              <select
                name="language"
                value={workspace.language}
                onChange={(event) =>
                  update((old) => ({
                    ...old,
                    language: event.target.value as Language,
                  }))
                }
              >
                <option value="en">English</option>
                <option value="zh-CN">简体中文</option>
              </select>
            </label>
            <label>{tr("Appearance")}</label>
            <div className="theme-options">
              {(["light", "dark", "system"] as const).map((value) => (
                <button
                  type="button"
                  key={value}
                  className={workspace.theme === value ? "selected" : ""}
                  aria-pressed={workspace.theme === value}
                  onClick={() => update((old) => ({ ...old, theme: value }))}
                >
                  <span
                    className={`theme-preview ${value}`}
                    aria-hidden="true"
                  />
                  <span className="theme-label">
                    {value === "light" ? (
                      <Sun size={18 * ICON_SCALE} />
                    ) : value === "dark" ? (
                      <Moon size={18 * ICON_SCALE} />
                    ) : (
                      <Monitor size={18 * ICON_SCALE} />
                    )}
                    <span>{tr(value[0].toUpperCase() + value.slice(1))}</span>
                  </span>
                  {workspace.theme === value && (
                    <Check size={13 * ICON_SCALE} />
                  )}
                </button>
              ))}
            </div>
          </div>
          <div className="form-footer">
            <button
              type="button"
              className="secondary-button"
              onClick={() => setScreen(null)}
            >
              {tr("Cancel")}
            </button>
            <button className="primary-button">{tr("Save changes")}</button>
          </div>
        </form>
      </Modal>
      <Modal
        open={screen === "team"}
        onOpenChange={(open) => !open && setScreen(null)}
        title={tr("Create team")}
      >
        <form
          onSubmit={async (e: FormEvent<HTMLFormElement>) => {
            e.preventDefault();
            if (busy) return;
            const name = String(
              new FormData(e.currentTarget).get("name"),
            ).trim();
            if (!name) return;
            setBusy(true);
            try {
              const created = await product.createTeam(name);
              navigate({ teamId: created.id });
            } catch (error) {
              setNotice((error as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <div className="form-body">
            <label>
              {tr("Team name")}
              <input
                name="name"
                placeholder={tr("e.g. Design")}
                required
                maxLength={60}
                autoComplete="off"
              />
            </label>
          </div>
          <div className="form-footer">
            <button
              type="button"
              className="secondary-button"
              onClick={() => setScreen(null)}
            >
              {tr("Cancel")}
            </button>
            <button className="primary-button" disabled={busy}>
              {tr("Create team")}
            </button>
          </div>
        </form>
      </Modal>
      <Modal
        open={screen === "skill"}
        onOpenChange={(open) => !open && setScreen(null)}
        title={tr("Create skill")}
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const data = new FormData(e.currentTarget);
            const name = String(data.get("name")).trim(),
              instructions = String(data.get("instructions")).trim();
            if (!name || !instructions) return;
            const id = crypto.randomUUID();
            if (
              update((old) => ({
                ...old,
                skills: [
                  ...old.skills,
                  { id, teamId: team.id, name, instructions },
                ],
              }))
            ) {
              updateDraft({ skillId: id });
              setScreen(null);
              editor.current?.focus();
            }
          }}
        >
          <div className="form-body">
            <label>
              {tr("Name")}
              <input
                name="name"
                placeholder={tr("Skill name")}
                required
                maxLength={80}
              />
            </label>
            <label>
              {tr("Instructions")}
              <textarea
                name="instructions"
                placeholder={tr("What should this skill do?")}
                rows={7}
                required
              />
            </label>
          </div>
          <div className="form-footer">
            <button
              className="secondary-button"
              type="button"
              onClick={() => setScreen(null)}
            >
              {tr("Cancel")}
            </button>
            <button className="primary-button">{tr("Create skill")}</button>
          </div>
        </form>
      </Modal>
      <Modal
        open={screen === "shortcuts"}
        onOpenChange={(open) => !open && setScreen(null)}
        title={tr("Keyboard shortcuts")}
      >
        <div className="shortcuts">
          {[
            [tr("Search workspace"), "Ctrl / ⌘ K"],
            [tr("New chat"), "Ctrl / ⌘ Shift O"],
            [tr("Send message"), "Enter"],
            [tr("New line"), "Shift Enter"],
            [tr("Close menu"), "Esc"],
          ].map(([label, key]) => (
            <div key={label}>
              <span>{label}</span>
              <kbd>{key}</kbd>
            </div>
          ))}
        </div>
      </Modal>
      <Modal
        open={!!rename}
        onOpenChange={(open) => !open && setRename(null)}
        title={tr("Rename chat")}
      >
        <form
          key={rename?.id}
          onSubmit={(e) => {
            e.preventDefault();
            const title = String(
              new FormData(e.currentTarget).get("title"),
            ).trim();
            if (
              title &&
              update((old) => ({
                ...old,
                chats: old.chats.map((c) =>
                  c.id === rename?.id ? { ...c, title } : c,
                ),
              }))
            )
              setRename(null);
          }}
        >
          <div className="form-body">
            <label>
              {tr("Name")}
              <input
                name="title"
                required
                maxLength={100}
                defaultValue={rename?.title}
              />
            </label>
          </div>
          <div className="form-footer">
            <button
              className="secondary-button"
              type="button"
              onClick={() => setRename(null)}
            >
              {tr("Cancel")}
            </button>
            <button className="primary-button">{tr("Save")}</button>
          </div>
        </form>
      </Modal>
      <Dialog.Root
        open={screen === "search"}
        onOpenChange={(open) => !open && setScreen(null)}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="overlay" />
          <Dialog.Content
            className="search-dialog"
            aria-describedby={undefined}
          >
            <Dialog.Title className="sr-only">
              {tr("Search workspace")}
            </Dialog.Title>
            <div className="search-field">
              <Search size={19 * ICON_SCALE} />
              <input
                role="combobox"
                aria-label={tr("Search workspace")}
                aria-expanded="true"
                aria-controls="search-results"
                aria-activedescendant={
                  searchResults[searchIndex]
                    ? `result-${searchResults[searchIndex].id}`
                    : undefined
                }
                placeholder={tr("Search workspace…")}
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setSearchIndex(0);
                }}
                onKeyDown={(e) => {
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setSearchIndex((i) =>
                      Math.min(i + 1, searchResults.length - 1),
                    );
                  }
                  if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setSearchIndex((i) => Math.max(i - 1, 0));
                  }
                  if (e.key === "Enter") {
                    e.preventDefault();
                    searchResults[searchIndex]?.run();
                  }
                }}
              />
              <Dialog.Close className="escape-key">Esc</Dialog.Close>
            </div>
            <div
              className="search-results"
              id="search-results"
              role="listbox"
              aria-label={tr("Results")}
            >
              {searchResults.length ? (
                searchResults.map((r, i) => (
                  <button
                    id={`result-${r.id}`}
                    role="option"
                    aria-selected={i === searchIndex}
                    className={`search-result ${i === searchIndex ? "selected" : ""}`}
                    key={r.id}
                    onMouseMove={() => setSearchIndex(i)}
                    onClick={r.run}
                  >
                    {r.icon}
                    <span>{r.label}</span>
                    <small>{r.detail}</small>
                  </button>
                ))
              ) : (
                <div className="search-empty">
                  {tr("No results for “{query}”", { query: search })}
                </div>
              )}
            </div>
            <div className="search-footer">
              <span>
                <kbd>↑</kbd>
                <kbd>↓</kbd>
                {tr("to navigate")}
              </span>
              <span>
                <kbd>↵</kbd>
                {tr("to open")}
              </span>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      {notice && (
        <div className="toast" role="status">
          <AlertCircle size={16 * ICON_SCALE} />
          <span>{tr(notice)}</span>
          <button
            aria-label={tr("Dismiss notification")}
            onClick={() => setNotice("")}
          >
            <X size={14 * ICON_SCALE} />
          </button>
        </div>
      )}
    </Tooltip.Provider>
  );
}
