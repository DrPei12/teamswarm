import { useEffect, useState } from "react";
import { X } from "lucide-react";
import type {
  ProjectMemoryEntry,
  ProjectMemoryRevision,
} from "@team/contracts/runtime";
import { useI18n } from "./i18n";
import { MessageContent } from "./MessageContent";
import { api } from "./service";
import { DetailPanel, IconButton } from "./ui";

const identity = (entry: ProjectMemoryEntry) => entry.kind + ":" + entry.key;
type RevisionPage = {
  items: ProjectMemoryRevision[];
  nextBefore: number | null;
};
type Correction = { title: string; content: string };
type Draft = Correction & { base: ProjectMemoryEntry; requestId: string };

export function HistoryMemory({
  teamId,
  branchId,
  branchName,
  onClose,
  fallbackFocus,
}: {
  teamId: string;
  branchId: string;
  branchName: string;
  onClose: () => void;
  fallbackFocus: () => HTMLElement | null;
}) {
  const { t } = useI18n();
  const [entries, setEntries] = useState<ProjectMemoryEntry[]>();
  const [selected, setSelected] = useState<string>();
  const [revisions, setRevisions] = useState<RevisionPage>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState<Draft>();
  const route = `/teams/${teamId}/branches/${branchId}/memory`;
  const entry = entries?.find((item) => identity(item) === selected);
  const revisionQuery = entry
    ? new URLSearchParams({ kind: entry.kind, key: entry.key }).toString()
    : "";

  useEffect(() => {
    const controller = new AbortController();
    void api<ProjectMemoryEntry[]>(route, undefined, "GET", controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setEntries(result);
      })
      .catch((err) => {
        if (!controller.signal.aborted) setError(err.message);
      });
    return () => controller.abort();
  }, [route]);

  useEffect(() => {
    if (!revisionQuery) return;
    const controller = new AbortController();
    void api<RevisionPage>(
      route + "/revisions?" + revisionQuery,
      undefined,
      "GET",
      controller.signal,
    )
      .then((result) => {
        if (!controller.signal.aborted) setRevisions(result);
      })
      .catch((err) => {
        if (!controller.signal.aborted) setError(err.message);
      });
    return () => controller.abort();
  }, [route, revisionQuery, entry?.revision]);

  async function loadMore() {
    if (revisions?.nextBefore == null) return;
    setError("");
    setPending(true);
    try {
      const page = await api<RevisionPage>(
        route +
          "/revisions?" +
          revisionQuery +
          "&before=" +
          revisions.nextBefore,
      );
      setRevisions({
        items: [...revisions.items, ...page.items],
        nextBefore: page.nextBefore,
      });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPending(false);
    }
  }

  async function change(current: ProjectMemoryEntry, edit?: Draft) {
    setPending(true);
    setError("");
    try {
      const result = await api<ProjectMemoryEntry>(
        route,
        {
          kind: current.kind,
          key: current.key,
          expectedRevision: current.revision,
          expectedVersion: current.version,
          ...(edit
            ? { correction: { title: edit.title, content: edit.content } }
            : { active: !current.active }),
          clientRequestId: edit?.requestId ?? crypto.randomUUID(),
        },
        "POST",
      );
      if (edit) setDraft(undefined);
      setEntries((previous) =>
        previous?.map((item) =>
          identity(item) === identity(result) ? result : item,
        ),
      );
    } catch (err) {
      setError((err as Error).message);
      try {
        setEntries(await api<ProjectMemoryEntry[]>(route));
      } catch {
        /* Keep the last loaded versions. */
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <DetailPanel
      label={t("Project memory")}
      className="canvas-detail history-detail"
      onClose={onClose}
      fallbackFocus={fallbackFocus}
    >
      <header className="detail-header">
        <span>{t("Project memory")}</span>
        <IconButton label={t("Close details")} onClick={onClose}>
          <X size={18} />
        </IconButton>
      </header>
      <div className="history-detail-body history-memory">
        <p className="detail-eyebrow">{branchName}</p>
        {error && <p role="alert">{t(error)}</p>}
        {!entries && !error && <p role="status">{t("Loading…")}</p>}
        {entries?.length === 0 && (
          <p className="muted">{t("No saved project memory")}</p>
        )}
        <nav aria-label={t("Project memory")} className="history-memory-list">
          {entries?.map((item) => (
            <button
              type="button"
              key={identity(item)}
              data-memory-key={item.key}
              disabled={pending || !!draft}
              aria-pressed={selected === identity(item)}
              className="text-button"
              onClick={() => {
                if (selected !== identity(item)) setRevisions(undefined);
                setDraft(undefined);
                setSelected(identity(item));
                setError("");
              }}
            >
              <span>{item.title}</span>
              {!item.active && <small>{t("Archived memory")}</small>}
            </button>
          ))}
        </nav>
        {entry && (
          <section className="history-memory-detail" aria-label={entry.title}>
            <div className="history-memory-heading">
              <h2>{entry.title}</h2>
              {!draft && (
                <div className="history-memory-actions">
                  {entry.kind === "note" &&
                    revisions?.items[0]?.revision === entry.revision && (
                      <button
                        className="secondary-button"
                        disabled={pending}
                        onClick={() => {
                          setDraft({
                            base: entry,
                            title: entry.title,
                            content: revisions.items[0].content,
                            requestId: crypto.randomUUID(),
                          });
                          setError("");
                        }}
                      >
                        {t("Correct note")}
                      </button>
                    )}
                  <button
                    className="secondary-button"
                    disabled={pending}
                    onClick={() => void change(entry)}
                  >
                    {t(entry.active ? "Archive memory" : "Restore memory")}
                  </button>
                </div>
              )}
            </div>
            {draft && (
              <form
                className="history-note-correction form-body"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!pending) void change(draft.base, draft);
                }}
              >
                <label>
                  {t("Note title")}
                  <input
                    required
                    disabled={pending}
                    maxLength={200}
                    value={draft.title}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        title: event.target.value,
                        requestId: crypto.randomUUID(),
                      })
                    }
                  />
                </label>
                <label>
                  {t("Note content")}
                  <textarea
                    required
                    disabled={pending}
                    maxLength={20000}
                    rows={6}
                    value={draft.content}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        content: event.target.value,
                        requestId: crypto.randomUUID(),
                      })
                    }
                  />
                </label>
                <div className="history-memory-actions">
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={pending}
                    onClick={() => {
                      setDraft(undefined);
                      setError("");
                    }}
                  >
                    {t("Cancel")}
                  </button>
                  {entry.revision === draft.base.revision &&
                  entry.version === draft.base.version ? (
                    <button className="primary-button" disabled={pending}>
                      {t("Save correction")}
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={
                        pending ||
                        revisions?.items[0]?.revision !== entry.revision
                      }
                      onClick={() =>
                        setDraft({
                          ...draft,
                          base: entry,
                          requestId: crypto.randomUUID(),
                        })
                      }
                    >
                      {t("Use current revision")}
                    </button>
                  )}
                </div>
              </form>
            )}
            {!revisions && !error && <p role="status">{t("Loading…")}</p>}
            {revisions?.items.map((revision) => (
              <details key={revision.revision} className="history-document">
                <summary>
                  {t("Memory revision")} {revision.revision}
                </summary>
                <MessageContent text={revision.content} />
              </details>
            ))}
            {revisions?.nextBefore != null && (
              <button
                className="secondary-button"
                disabled={pending}
                onClick={() => void loadMore()}
              >
                {t("Load older revisions")}
              </button>
            )}
          </section>
        )}
      </div>
    </DetailPanel>
  );
}
