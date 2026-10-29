import { FieldSelect } from "./FieldSelect";
import { SegmentedControl } from "./design-system/SegmentedControl";
import { useEffect, useState } from "react";
import type {
  ArtifactVersion,
  ProjectInsight,
  ProjectOutput,
} from "@team/contracts/runtime";
import type { Chat, Message, Workspace } from "./store";
import type { InsightSource } from "@team/contracts/product";
import { api, product } from "./service";
import { Modal } from "./ui";
import { MessageContent } from "./MessageContent";
import { InsightStatus } from "./InsightStatus";
import { useI18n } from "./i18n";
import "./collaboration.css";

export function ProjectRecords({
  workspace,
  teamId,
  chat,
  source,
  onClose,
  onNavigate,
  onNavigateMember,
}: {
  workspace: Workspace;
  teamId: string;
  chat?: Chat;
  source?: Message;
  onClose: () => void;
  onNavigate: (chatId: string, messageId: string) => void;
  onNavigateMember: (
    memberId: string,
    messageId: string,
    workId?: string,
  ) => void;
}) {
  const { t } = useI18n();
  const [tab, setTab] = useState<"outputs" | "insights">(
    source ? "insights" : "outputs",
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<ProjectInsight | "new" | null>(
    source ? "new" : null,
  );
  const branchId =
    chat?.branchId ??
    workspace.projectBranches?.find((b) => b.teamId === teamId)?.id;
  const outputs = (workspace.outputs ?? []).filter(
    (o) => o.current.teamId === teamId && o.branchId === branchId,
  );
  const insights = (workspace.insights ?? []).filter(
    (n) => n.teamId === teamId && n.branchId === branchId,
  );
  const inputSource =
    source ??
    [...(chat?.messages ?? [])].reverse().find((m) => !m.pending && m.recordId);
  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!branchId || !editing) return;
    const form = new FormData(event.currentTarget);
    const old = editing === "new" ? undefined : editing;
    const sourceMessageIds =
      old?.sourceMessageIds ??
      (inputSource ? [inputSource.recordId ?? inputSource.id] : []);
    setBusy(true);
    setError("");
    try {
      await product.command(
        `/product/teams/${teamId}/branches/${branchId}/insights`,
        {
          clientRequestId: crypto.randomUUID(),
          insight: {
            key: old?.key ?? crypto.randomUUID(),
            expectedRevision: old?.revision ?? 0,
            title: String(form.get("title")),
            content: String(form.get("content")),
            kind: String(form.get("kind")),
            status: String(form.get("status")),
            reason: String(form.get("reason")),
            sourceMessageIds,
          },
        },
      );
      setEditing(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const current = editing && editing !== "new" ? editing : undefined;
  return (
    <Modal
      open
      onOpenChange={(open) => !open && onClose()}
      title={t("Results and reasoning")}
    >
      <div className="project-records">
        <SegmentedControl
          value={tab}
          onChange={setTab}
          label={t("Project records")}
          options={[
            {
              value: "outputs",
              label: `${t("Current results")} · ${outputs.length}`,
            },
            {
              value: "insights",
              label: `${t("Ideas and decisions")} · ${insights.length}`,
            },
          ]}
        />
        {error && (
          <p role="alert" className="record-error">
            {error}
          </p>
        )}
        {tab === "outputs" ? (
          <div className="record-list">
            <p className="record-hint">
              {t(
                "Each file has one current version. Earlier versions stay in its history.",
              )}
            </p>
            {!outputs.length && (
              <p>{t("Completed work will publish its files here.")}</p>
            )}
            {outputs.map((output) => (
              <OutputRecord key={output.path} output={output} teamId={teamId} />
            ))}
          </div>
        ) : (
          <div className="record-list">
            <p className="record-hint">
              {t(
                "Proposals preserve exploration. Only adopted decisions guide future work.",
              )}
            </p>
            {!editing && inputSource && (
              <button
                className="secondary-button"
                onClick={() => setEditing("new")}
              >
                {t("Save an idea or decision")}
              </button>
            )}
            {editing && (
              <form
                className="record-editor"
                onSubmit={save}
                key={current?.id ?? inputSource?.id}
              >
                <label>
                  {t("Title")}
                  <input
                    name="title"
                    required
                    maxLength={160}
                    defaultValue={
                      current?.title ?? inputSource?.text.slice(0, 60)
                    }
                  />
                </label>
                <label>
                  {t("Content")}
                  <textarea
                    name="content"
                    required
                    maxLength={12000}
                    rows={5}
                    defaultValue={current?.content ?? inputSource?.text}
                  />
                </label>
                <div className="record-fields">
                  <label>
                    {t("Kind")}
                    <FieldSelect
                      name="kind"
                      defaultValue={current?.kind ?? "idea"}
                    >
                      <option value="idea">{t("Idea")}</option>
                      <option value="decision">{t("Decision")}</option>
                    </FieldSelect>
                  </label>
                  <label>
                    {t("Status")}
                    <FieldSelect
                      name="status"
                      defaultValue={current?.status ?? "proposed"}
                    >
                      {[
                        "proposed",
                        ...(current?.status === "adopted" ? ["adopted"] : []),
                        "rejected",
                        "superseded",
                      ].map((s) => (
                        <option key={s} value={s}>
                          {t(`insight.${s}`)}
                        </option>
                      ))}
                    </FieldSelect>
                  </label>
                </div>
                <label>
                  {t("Reason")}
                  <input
                    name="reason"
                    required
                    maxLength={2000}
                    defaultValue={
                      current
                        ? ""
                        : t("Preserve this point from the conversation")
                    }
                  />
                </label>
                <p className="record-hint">
                  {t(
                    "The original source message remains attached to every revision.",
                  )}
                </p>
                <div className="record-actions">
                  <button className="primary-button" disabled={busy}>
                    {t("Save")}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setEditing(null)}
                  >
                    {t("Cancel")}
                  </button>
                </div>
              </form>
            )}
            {insights.map((note) => (
              <InsightRecord
                key={note.id}
                note={note}
                onEdit={() => setEditing(note)}
                onNavigate={onNavigate}
                onNavigateMember={onNavigateMember}
              />
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}

function OutputRecord({
  output,
  teamId,
}: {
  output: ProjectOutput;
  teamId: string;
}) {
  const { t } = useI18n();
  const [selected, setSelected] = useState("");
  const revision =
    output.revisions.find((r) => r.id === selected) ?? output.current;
  const [artifact, setArtifact] = useState<ArtifactVersion>();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setError("");
    setArtifact(undefined);
    void api<ArtifactVersion>(
      `/teams/${teamId}/artifact-versions/${revision.artifactId}`,
      undefined,
      "GET",
      controller.signal,
    )
      .then((a) => {
        if (!controller.signal.aborted) setArtifact(a);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [open, teamId, revision.artifactId]);
  return (
    <article className="output-record">
      <button
        className="record-heading"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <strong>{output.path}</strong>
        <span>{t("{count} versions", { count: output.revisions.length })}</span>
      </button>
      {open && (
        <div className="record-body">
          <label>
            {t("Version")}
            <FieldSelect
              aria-label={`${t("Version")} ${output.path}`}
              value={revision.id}
              onValueChange={(value) => setSelected(value)}
            >
              {[...output.revisions].reverse().map((r, i) => (
                <option key={r.id} value={r.id}>
                  {r.id === output.current.id
                    ? t("Current version")
                    : `v${output.revisions.length - i}`}{" "}
                  · {new Date(r.createdAt).toLocaleString()}
                  {r.restoredFrom ? ` · ${t("Restored")}` : ""}
                </option>
              ))}
            </FieldSelect>
          </label>
          {revision.id !== output.current.id && (
            <button
              className="secondary-button"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError("");
                try {
                  await product.command(
                    `/product/teams/${teamId}/branches/${output.branchId}/outputs/restore`,
                    {
                      revisionId: revision.id,
                      expectedHeadId: output.current.id,
                    },
                  );
                  setSelected("");
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {t("Restore this version")}
            </button>
          )}
          {error && (
            <p role="alert" className="record-error">
              {error}
            </p>
          )}
          {artifact ? (
            <>
              <a
                className="record-download"
                href={`/api/product/teams/${teamId}/artifacts/${artifact.id}/download`}
                download
              >
                {t("View saved artifact")}
              </a>
              <pre className="output-content">{artifact.content}</pre>
            </>
          ) : (
            !error && <p>{t("Loading…")}</p>
          )}
        </div>
      )}
    </article>
  );
}

function InsightRecord({
  note,
  onEdit,
  onNavigate,
  onNavigateMember,
}: {
  note: ProjectInsight;
  onEdit: () => void;
  onNavigate: (chatId: string, messageId: string) => void;
  onNavigateMember: (
    memberId: string,
    messageId: string,
    workId?: string,
  ) => void;
}) {
  const { t } = useI18n();
  const [sources, setSources] = useState<InsightSource[]>();
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [loadingSources, setLoadingSources] = useState(false);
  const [revisions, setRevisions] = useState<ProjectInsight[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!sourcesOpen) return;
    const controller = new AbortController();
    setLoadingSources(true);
    setError("");
    setSources(undefined);
    setRevisions([]);
    void api<{ sources: InsightSource[]; revisions: ProjectInsight[] }>(
      `/product/teams/${note.teamId}/insights/${note.id}/sources`,
      undefined,
      "GET",
      controller.signal,
    )
      .then((result) => {
        if (!controller.signal.aborted) {
          setSources(result.sources);
          setRevisions(result.revisions);
        }
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError((e as Error).message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingSources(false);
      });
    return () => controller.abort();
  }, [sourcesOpen, note.teamId, note.id]);
  return (
    <article className="insight-record">
      <div className="record-heading">
        <strong>{note.title}</strong>
        <span>
          {t(note.kind === "idea" ? "Idea" : "Decision")} ·{" "}
          <InsightStatus status={note.status} />
        </span>
      </div>
      <MessageContent text={note.content} />
      <div className="record-actions">
        <button onClick={onEdit}>{t("Edit")}</button>
        <button
          aria-expanded={sourcesOpen}
          onClick={() => {
            setError("");
            setSourcesOpen((open) => !open);
          }}
        >
          {t("Sources and history")} · {note.revision}
        </button>
      </div>
      {sourcesOpen && error && <p role="alert">{error}</p>}
      {sourcesOpen && loadingSources && <p role="status">{t("Loading…")}</p>}
      {sourcesOpen && sources && (
        <div className="insight-sources">
          {sources.map((source) => (
            <blockquote key={source.id}>
              <p>{source.content}</p>
              <cite>
                {source.author === "user"
                  ? t("You")
                  : source.author === "assistant"
                    ? "Host"
                    : source.author}
              </cite>
              {source.conversationId && (
                <button
                  onClick={() => onNavigate(source.conversationId!, source.id)}
                >
                  {t("Go to source message")}
                </button>
              )}
              {!source.conversationId && source.memberId && (
                <button
                  onClick={() =>
                    onNavigateMember(source.memberId!, source.id, source.workId)
                  }
                >
                  {t("Go to source message")}
                </button>
              )}
            </blockquote>
          ))}
          {revisions.map((r) => (
            <details key={r.id}>
              <summary>
                v{r.revision} · {t(`insight.${r.status}`)} · {r.reason}
              </summary>
              <p>{r.content}</p>
            </details>
          ))}
        </div>
      )}
    </article>
  );
}
