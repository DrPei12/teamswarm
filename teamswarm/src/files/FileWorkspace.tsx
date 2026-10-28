import {
  lazy,
  Suspense,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Dialog } from "radix-ui";
import { get, set } from "idb-keyval";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  File,
  Folder,
  FolderOpen,
  LoaderCircle,
  Maximize2,
  Minimize2,
  PanelRightClose,
  Plus,
  RefreshCw,
  Save,
  Search,
  X,
} from "lucide-react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api } from "../service";
import { IconButton, Modal, useMediaQuery } from "../ui";
import { usePanelResize } from "../usePanelResize";
import { useI18n } from "../i18n";
import { ViewBoundary } from "../ViewBoundary";
import {
  isDirty,
  isMarkdown,
  isOffice,
  type FileContent,
  type FileDraft,
  type FileEntry,
} from "./types";
import "./files.css";
const CodeEditor = lazy(() => import("./CodeEditor"));
const OfficeDocument = lazy(() => import("./OfficeDocument"));
const PdfDocument = lazy(() => import("./PdfDocument"));

export function FileWorkspace({
  teamId,
  branchId,
  open,
  onClose,
}: {
  teamId: string;
  branchId: string;
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const base = `/teams/${encodeURIComponent(teamId)}/branches/${encodeURIComponent(branchId)}/files`;
  const storageKey = `teamswarm.files:${teamId}:${branchId}`;
  const [tabs, setTabs] = useState<FileDraft[]>([]);
  const [active, setActive] = useState("");
  const [browse, setBrowse] = useState(true);
  const [directory, setDirectory] = useState("");
  const [search, setSearch] = useState("");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [root, setRoot] = useState("");
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [opening, setOpening] = useState("");
  const [saving, setSaving] = useState("");
  const [error, setError] = useState("");
  const retry = useRef<(() => void) | undefined>(undefined);
  const [loaded, setLoaded] = useState(false);
  const [revision, setRevision] = useState(0);
  const [confirm, setConfirm] = useState<{
    path: string;
    action: "close" | "reload";
  }>();
  const [saved, setSaved] = useState("");
  const [expanded, setExpanded] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const overlay = useMediaQuery("(max-width: 1000px)");
  const resize = usePanelResize(panel, open && !overlay && !expanded, {
    key: "teamswarm.files-width",
    min: 360,
    max: 1100,
    reserve: 340,
  });
  const current = tabs.find((file) => file.path === active);
  const latest = useRef({ tabs, active, loaded });
  latest.current = { tabs, active, loaded };
  const request = useRef(0);
  useLayoutEffect(() => {
    if (open && !browse)
      panel.current
        ?.querySelector(".file-tab.selected")
        ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active, browse, tabs.length, open]);
  useEffect(() => {
    let alive = true;
    get<{ tabs: FileDraft[]; active: string }>(storageKey)
      .then((value) => {
        if (!alive) return;
        if (value?.tabs?.length) {
          setTabs(value.tabs);
          setActive(value.active);
          setBrowse(false);
        }
        setLoaded(true);
      })
      .catch(() => {
        if (alive) {
          setLoaded(true);
          setError(t("File drafts could not be restored."));
        }
      });
    return () => {
      alive = false;
      request.current++;
      if (latest.current.loaded)
        void set(storageKey, {
          tabs: latest.current.tabs,
          active: latest.current.active,
        }).catch(() => {});
    };
  }, [storageKey]);
  useEffect(() => {
    if (!loaded) return;
    const timer = setTimeout(() => {
      void set(storageKey, { tabs, active }).catch(() =>
        setError(
          t(
            "File drafts could not be saved. Keep this window open until you save the file.",
          ),
        ),
      );
    }, 180);
    return () => clearTimeout(timer);
  }, [tabs, active, loaded, storageKey, t]);
  useEffect(() => {
    const leave = (event: BeforeUnloadEvent) => {
      if (latest.current.tabs.some(isDirty)) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    const shortcut = (event: KeyboardEvent) => {
      if (
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === "p" &&
        open
      ) {
        event.preventDefault();
        setBrowse(true);
      }
    };
    window.addEventListener("beforeunload", leave);
    window.addEventListener("keydown", shortcut);
    return () => {
      window.removeEventListener("beforeunload", leave);
      window.removeEventListener("keydown", shortcut);
    };
  }, [open]);
  useEffect(() => {
    if (!open || !browse) return;
    const controller = new AbortController();
    const timer = setTimeout(
      () => {
        setLoading(true);
        setError("");
        api<{ entries: FileEntry[]; root: string; truncated: boolean }>(
          `${base}?path=${encodeURIComponent(search ? "" : directory)}${search ? `&q=${encodeURIComponent(search)}` : ""}`,
          undefined,
          "GET",
          controller.signal,
        )
          .then((result) => {
            if (!controller.signal.aborted) {
              setEntries(result.entries);
              setRoot(result.root);
              setTruncated(result.truncated);
            }
          })
          .catch((reason) => {
            if (!controller.signal.aborted) {
              retry.current = () => setRevision((n) => n + 1);
              setError(t(reason.message));
            }
          })
          .finally(() => {
            if (!controller.signal.aborted) setLoading(false);
          });
      },
      search ? 160 : 0,
    );
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [open, browse, base, directory, search, revision, t]);
  const edit = (path: string, patch: Partial<FileDraft>) => {
    setTabs((all) =>
      all.map((file) => (file.path === path ? { ...file, ...patch } : file)),
    );
    setSaved("");
  };
  async function openFile(path: string, reload = false) {
    if (!reload && tabs.some((file) => file.path === path)) {
      setActive(path);
      setBrowse(false);
      setError("");
      return;
    }
    const serial = ++request.current;
    setOpening(path);
    setError("");
    try {
      const data = await api<FileContent>(
        `${base}/content?path=${encodeURIComponent(path)}`,
      );
      if (serial !== request.current) return;
      const tab: FileDraft = {
        ...data,
        text: data.encoding === "utf8" ? data.content : "",
        edits: {},
        mode: isMarkdown(path) || isOffice(path) ? "preview" : "edit",
      };
      setTabs((all) =>
        all.some((file) => file.path === path)
          ? all.map((file) => (file.path === path ? tab : file))
          : [...all, tab],
      );
      setActive(path);
      setBrowse(false);
    } catch (reason) {
      if (serial === request.current) {
        retry.current = () => {
          void openFile(path, reload);
        };
        setError(t((reason as Error).message));
      }
    } finally {
      if (serial === request.current) setOpening("");
    }
  }
  async function saveFile(file = current) {
    if (!file || saving || !isDirty(file)) return false;
    setSaving(file.path);
    setError("");
    try {
      const content =
        file.encoding === "utf8"
          ? file.text
          : await (
              await import("./officeModel")
            ).saveOffice(file.path, file.content, file.edits);
      const result = await api<{ sha256: string; bytes: number }>(
        `${base}/content`,
        {
          path: file.path,
          expectedSha256: file.sha256,
          encoding: file.encoding,
          content,
        },
        "PUT",
      );
      setTabs((all) =>
        all.map((tab) =>
          tab.path !== file.path
            ? tab
            : {
                ...tab,
                content,
                sha256: result.sha256,
                size: result.bytes,
                edits: Object.fromEntries(
                  Object.entries(tab.edits).filter(
                    ([key, value]) => file.edits[key] !== value,
                  ),
                ),
              },
        ),
      );
      setSaved(file.path);
      return true;
    } catch (reason) {
      retry.current = () => {
        void saveFile(
          latest.current.tabs.find((tab) => tab.path === file.path),
        );
      };
      setError(t((reason as Error).message));
      return false;
    } finally {
      setSaving("");
    }
  }
  function closeTab(path: string) {
    const index = tabs.findIndex((file) => file.path === path);
    const next = tabs.filter((file) => file.path !== path);
    setTabs(next);
    if (active === path)
      setActive(next[Math.min(index, next.length - 1)]?.path ?? "");
    if (!next.length) setBrowse(true);
  }
  const raw = (path: string) =>
    `/api${base}/raw?path=${encodeURIComponent(path)}`;
  const body = (
    <>
      {!overlay && !expanded && (
        <div
          className="detail-resize-handle"
          role="separator"
          tabIndex={0}
          aria-label={t("Resize file panel")}
          aria-orientation="vertical"
          {...resize.handle}
        />
      )}
      <header className="file-tabs-header">
        <div
          className="file-tabs"
          role="tablist"
          aria-label={t("Open files")}
          onKeyDown={(event) => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
              return;
            const buttons = [
              ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
                '[role="tab"]',
              ),
            ];
            const index = buttons.indexOf(
              document.activeElement as HTMLButtonElement,
            );
            if (index < 0) return;
            event.preventDefault();
            const next =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? buttons.length - 1
                  : (index +
                      (event.key === "ArrowLeft" ? -1 : 1) +
                      buttons.length) %
                    buttons.length;
            buttons[next]?.click();
            buttons[next]?.focus({ preventScroll: true });
          }}
        >
          {tabs.map((file) => (
            <div
              key={file.path}
              className={`file-tab ${active === file.path && !browse ? "selected" : ""}`}
            >
              <button
                role="tab"
                aria-selected={active === file.path && !browse}
                title={file.path}
                onClick={() => {
                  setActive(file.path);
                  setBrowse(false);
                  setError("");
                }}
              >
                <File size={14} />
                <span>{file.path.split("/").at(-1)}</span>
                {isDirty(file) && <i aria-label={t("Unsaved changes")} />}
              </button>
              <button
                aria-label={t("Close {name}", { name: file.path })}
                className="file-tab-close"
                onClick={() =>
                  isDirty(file)
                    ? setConfirm({ path: file.path, action: "close" })
                    : closeTab(file.path)
                }
              >
                <X size={12} />
              </button>
            </div>
          ))}
          {!tabs.length && (
            <span className="file-panel-title">{t("Files")}</span>
          )}
        </div>
        <IconButton
          label={t("Open file")}
          onClick={() => {
            setBrowse(true);
            setError("");
          }}
        >
          <Plus size={16} />
        </IconButton>
        {!overlay && (
          <IconButton
            label={t(expanded ? "Restore file panel" : "Expand file panel")}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
          </IconButton>
        )}
        <IconButton label={t("Close file panel")} onClick={onClose}>
          <PanelRightClose size={16} />
        </IconButton>
      </header>
      {error && (
        <div className="file-error" role="alert">
          <span>{error}</span>
          {retry.current && (
            <button onClick={() => retry.current?.()}>{t("Retry")}</button>
          )}
        </div>
      )}
      {browse ? (
        <div className="file-browser">
          <div className="file-search">
            <Search size={15} />
            <input
              autoFocus
              aria-label={t("Search files")}
              placeholder={t("Search files")}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape" && current) {
                  event.stopPropagation();
                  setBrowse(false);
                }
              }}
            />
            <IconButton
              label={t("Refresh files")}
              onClick={() => setRevision((n) => n + 1)}
            >
              <RefreshCw size={14} />
            </IconButton>
          </div>
          <nav className="file-directory" aria-label={t("File path")}>
            <button
              onClick={() => {
                setDirectory("");
                setSearch("");
              }}
            >
              <FolderOpen size={14} />
              {root || t("Project")}
            </button>
            {directory
              .split("/")
              .filter(Boolean)
              .map((part, index, all) => (
                <span key={index}>
                  <ChevronRight size={12} />
                  <button
                    onClick={() =>
                      setDirectory(all.slice(0, index + 1).join("/"))
                    }
                  >
                    {part}
                  </button>
                </span>
              ))}
          </nav>
          <div className="file-list" aria-busy={loading || Boolean(opening)}>
            {directory && !search && (
              <button
                className="file-entry"
                onClick={() =>
                  setDirectory(directory.split("/").slice(0, -1).join("/"))
                }
              >
                <ChevronLeft size={15} />
                <span>..</span>
              </button>
            )}
            {entries.map((entry) => (
              <button
                key={entry.path}
                className="file-entry"
                onClick={() =>
                  entry.directory
                    ? setDirectory(entry.path)
                    : void openFile(entry.path)
                }
                title={entry.path}
              >
                {opening === entry.path ? (
                  <LoaderCircle size={15} className="spinner" />
                ) : entry.directory ? (
                  <Folder size={15} />
                ) : (
                  <File size={15} />
                )}
                <span>
                  {entry.name}
                  {search && entry.path !== entry.name && (
                    <small>{entry.path.slice(0, -entry.name.length - 1)}</small>
                  )}
                </span>
                {entry.directory && <ChevronRight size={13} />}
              </button>
            ))}
            {!entries.length && (
              <div className="file-empty">
                {loading ? (
                  <LoaderCircle size={18} className="spinner" />
                ) : (
                  t(search ? "No matching files" : "No files")
                )}
              </div>
            )}
            {truncated && (
              <p className="file-limit">
                {t("More files are available. Narrow your search.")}
              </p>
            )}
          </div>
        </div>
      ) : (
        current && (
          <>
            <div className="file-toolbar">
              <button
                className="file-breadcrumb"
                title={current.path}
                onClick={() => {
                  setDirectory(current.path.split("/").slice(0, -1).join("/"));
                  setSearch("");
                  setBrowse(true);
                }}
              >
                <FolderOpen size={14} />
                <span>{current.path}</span>
              </button>
              {(isMarkdown(current.path) || isOffice(current.path)) && (
                <div
                  className="file-view-toggle"
                  role="group"
                  aria-label={t("File view")}
                >
                  <button
                    aria-pressed={current.mode === "preview"}
                    onClick={() => edit(current.path, { mode: "preview" })}
                  >
                    {t("Preview")}
                  </button>
                  <button
                    aria-pressed={current.mode === "edit"}
                    onClick={() => edit(current.path, { mode: "edit" })}
                  >
                    {t(
                      isOffice(current.path) && !/\.xlsx$/i.test(current.path)
                        ? "Edit text"
                        : "Edit",
                    )}
                  </button>
                </div>
              )}
              <IconButton
                label={t("Reload file")}
                disabled={Boolean(saving)}
                onClick={() =>
                  isDirty(current)
                    ? setConfirm({ path: current.path, action: "reload" })
                    : void openFile(current.path, true)
                }
              >
                <RefreshCw size={14} />
              </IconButton>
              <a
                className="file-download icon-button"
                href={raw(current.path)}
                download={current.path.split("/").at(-1)}
                aria-label={t("Download file")}
                title={t("Download file")}
              >
                <Download size={14} />
              </a>
              {current.editable && (
                <button
                  className="file-save"
                  disabled={!isDirty(current) || Boolean(saving)}
                  onClick={() => void saveFile()}
                >
                  <Save size={14} />
                  <span>{t(saving ? "Saving…" : "Save")}</span>
                </button>
              )}
            </div>
            <div
              className="file-document"
              role="tabpanel"
              aria-label={current.path}
              onKeyDownCapture={(event) => {
                if (
                  (event.ctrlKey || event.metaKey) &&
                  event.key.toLowerCase() === "s"
                ) {
                  event.preventDefault();
                  event.stopPropagation();
                  void saveFile();
                }
              }}
            >
              <ViewBoundary key={current.path}>
                <Suspense
                  fallback={
                    <div className="file-empty">
                      <LoaderCircle size={18} className="spinner" />
                    </div>
                  }
                >
                  {isOffice(current.path) ? (
                    <OfficeDocument
                      key={current.path}
                      file={current}
                      saving={saving === current.path}
                      onChange={(edits) => edit(current.path, { edits })}
                    />
                  ) : current.encoding === "utf8" ? (
                    isMarkdown(current.path) && current.mode === "preview" ? (
                      <article className="file-markdown markdown">
                        <Markdown
                          remarkPlugins={[remarkGfm]}
                          components={{
                            a: ({ href, children }) => (
                              <a href={href} target="_blank" rel="noreferrer">
                                {children}
                              </a>
                            ),
                            img: ({ src, alt }) =>
                              typeof src === "string" &&
                              !/^(?:https?:|\/\/)/i.test(src) ? (
                                <img
                                  alt={alt ?? ""}
                                  src={raw(
                                    [
                                      current.path
                                        .split("/")
                                        .slice(0, -1)
                                        .join("/"),
                                      src.replace(/^\.\//, ""),
                                    ]
                                      .filter(Boolean)
                                      .join("/"),
                                  )}
                                />
                              ) : (
                                <span>{alt}</span>
                              ),
                          }}
                        >
                          {current.text}
                        </Markdown>
                      </article>
                    ) : (
                      <CodeEditor
                        key={current.path}
                        path={current.path}
                        value={current.text}
                        onChange={(text) => edit(current.path, { text })}
                        onSave={() => void saveFile()}
                      />
                    )
                  ) : /\.(png|jpe?g|gif|webp|avif)$/i.test(current.path) ? (
                    <div className="file-image">
                      <img
                        src={`${raw(current.path)}&version=${current.sha256}`}
                        alt={current.path}
                      />
                    </div>
                  ) : /\.pdf$/i.test(current.path) ? (
                    <PdfDocument key={current.path} file={current} />
                  ) : /\.(mp4|webm)$/i.test(current.path) ? (
                    <video
                      key={`${current.path}:${current.sha256}`}
                      className="file-media"
                      controls
                      src={`${raw(current.path)}&version=${current.sha256}`}
                    />
                  ) : /\.(mp3|wav)$/i.test(current.path) ? (
                    <audio
                      key={`${current.path}:${current.sha256}`}
                      className="file-media"
                      controls
                      src={`${raw(current.path)}&version=${current.sha256}`}
                    />
                  ) : (
                    <div className="file-empty">
                      <File size={28} />
                      <p>{t("Preview unavailable for this format")}</p>
                      <a href={raw(current.path)} download>
                        {t("Download file")}
                      </a>
                    </div>
                  )}
                </Suspense>
              </ViewBoundary>
            </div>
            <footer className="file-status">
              <span>
                {current.path.split(".").at(-1)?.toUpperCase()} ·{" "}
                {Intl.NumberFormat(undefined, {
                  maximumFractionDigits: 1,
                }).format(current.size / 1024)}{" "}
                KB
              </span>
              <span role="status">
                {isDirty(current)
                  ? t("Unsaved changes")
                  : saved === current.path
                    ? t("Saved")
                    : ""}
              </span>
            </footer>
          </>
        )
      )}
      <Modal
        open={Boolean(confirm)}
        onOpenChange={(value) => {
          if (!value) setConfirm(undefined);
        }}
        title={t("Save changes to {name}?", {
          name: confirm?.path.split("/").at(-1) ?? "",
        })}
      >
        {error && (
          <div className="file-error" role="alert">
            {error}
          </div>
        )}
        <div className="file-confirm-actions">
          <button onClick={() => setConfirm(undefined)}>{t("Cancel")}</button>
          <button
            onClick={() => {
              if (!confirm) return;
              confirm.action === "close"
                ? closeTab(confirm.path)
                : void openFile(confirm.path, true);
              setConfirm(undefined);
            }}
          >
            {t("Discard changes")}
          </button>
          <button
            className="primary"
            disabled={Boolean(saving)}
            onClick={async () => {
              if (!confirm) return;
              const action = confirm;
              if (
                await saveFile(tabs.find((file) => file.path === action.path))
              ) {
                setConfirm(undefined);
                if (action.action === "close") closeTab(action.path);
                else void openFile(action.path, true);
              }
            }}
          >
            {t("Save")}
          </button>
        </div>
      </Modal>
    </>
  );
  if (!open) return null;
  return (
    <Dialog.Root
      open
      modal={false}
      onOpenChange={(value) => {
        if (!value) onClose();
      }}
    >
      <Dialog.Content
        ref={panel}
        className={`file-workspace ${overlay || expanded ? "overlay-mode" : ""} ${current && isOffice(current.path) ? "office-file" : ""}`}
        style={!overlay && !expanded ? resize.style : undefined}
        aria-describedby={undefined}
        onInteractOutside={(event) => event.preventDefault()}
        onEscapeKeyDown={(event) => {
          if (expanded) {
            event.preventDefault();
            setExpanded(false);
          }
        }}
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          document.querySelector<HTMLButtonElement>(".files-toggle")?.focus();
        }}
      >
        <Dialog.Title className="sr-only">{t("Files")}</Dialog.Title>
        {body}
      </Dialog.Content>
    </Dialog.Root>
  );
}
