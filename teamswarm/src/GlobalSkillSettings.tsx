import { useEffect, useState } from "react";
import type { GlobalSkillCatalog } from "@team/contracts/runtime";
import { useI18n } from "./i18n";
import { api } from "./service";

type Row = GlobalSkillCatalog["skills"][number];
type Text = { name: string; instructions: string };
type Editor = Text & { skillId?: string; expectedVersion: number };

export function GlobalSkillSettings({ teamId }: { teamId?: string }) {
  const { t } = useI18n();
  const endpoint = teamId
    ? `/teams/${encodeURIComponent(teamId)}/text-skill-catalog`
    : "/global/text-skills";
  const [catalog, setCatalog] = useState<GlobalSkillCatalog>();
  const [editor, setEditor] = useState<Editor>();
  const [preview, setPreview] = useState<
    Text & { skillId: string; revision: number }
  >();
  const [versions, setVersions] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    void api<GlobalSkillCatalog>(endpoint, undefined, "GET", abort.signal)
      .then(setCatalog)
      .catch((e: Error) => {
        if (!abort.signal.aborted) setError(e.message);
      });
    return () => abort.abort();
  }, [endpoint, reload]);
  async function act(fn: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const body = (row: Row, revision: number) =>
    api<Text>(`/global/text-skills/${row.skillId}/revisions/${revision}`);
  async function refresh() {
    setCatalog(await api<GlobalSkillCatalog>(endpoint));
    setPreview(undefined);
    setVersions({});
  }
  const change = (input: object) =>
    act(async () => {
      await api("/global/text-skills", {
        expectedVersion: catalog!.version,
        ...input,
      });
      setEditor(undefined);
      await refresh();
    });
  const grant = (row: Row, revision: number, active: boolean) =>
    act(async () => {
      await api(
        `/teams/${encodeURIComponent(teamId!)}/text-skill-grants`,
        {
          skillId: row.skillId,
          revision,
          active,
          expectedVersion: catalog!.version,
          expectedGeneration: row.grant?.generation ?? 0,
        },
        "PUT",
      );
      await refresh();
    });
  return (
    <div className="mcp-settings text-skill-settings" aria-busy={busy}>
      {error && (
        <p role="alert" className="form-error">
          {t(error)}{" "}
          <button
            type="button"
            className="text-button"
            disabled={busy}
            onClick={() => {
              setError("");
              setReload((n) => n + 1);
            }}
          >
            {t("Reload catalog")}
          </button>
        </p>
      )}
      {!catalog && !error && <p role="status">{t("Loading…")}</p>}
      {catalog && !editor && !teamId && (
        <button
          className="primary-button"
          disabled={busy}
          onClick={() =>
            setEditor({
              name: "",
              instructions: "",
              expectedVersion: catalog.version,
            })
          }
        >
          {t("Add text skill")}
        </button>
      )}
      {editor && (
        <form
          className="mcp-service-form"
          onSubmit={(e) => {
            e.preventDefault();
            void change({
              action: editor.skillId ? "edit" : "create",
              ...editor,
            });
          }}
        >
          <label>
            {t("Skill name")}
            <input
              autoFocus
              required
              value={editor.name}
              maxLength={80}
              disabled={busy}
              onChange={(e) => setEditor({ ...editor, name: e.target.value })}
            />
          </label>
          <label>
            {t("Instructions")}
            <textarea
              aria-label={t("Instructions")}
              rows={8}
              maxLength={40000}
              required
              disabled={busy}
              value={editor.instructions}
              onChange={(e) =>
                setEditor({ ...editor, instructions: e.target.value })
              }
            />
          </label>
          {catalog && editor.expectedVersion !== catalog.version && (
            <p>
              {t("The catalog changed while you were editing.")}{" "}
              <button
                type="button"
                className="text-button"
                disabled={busy}
                onClick={() =>
                  setEditor({ ...editor, expectedVersion: catalog.version })
                }
              >
                {t("Use reloaded catalog")}
              </button>
            </p>
          )}
          <div className="mcp-actions">
            <button
              type="button"
              className="secondary-button"
              disabled={busy}
              onClick={() => setEditor(undefined)}
            >
              {t("Cancel")}
            </button>
            <button
              className="primary-button"
              disabled={
                busy ||
                !editor.instructions.trim() ||
                !editor.name.trim() ||
                catalog?.version !== editor.expectedVersion
              }
            >
              {t("Save revision")}
            </button>
          </div>
        </form>
      )}
      {catalog && !catalog.skills.length && !editor && (
        <p>{t("No text skills registered.")}</p>
      )}
      {catalog?.skills.map((row) => {
        const revision = versions[row.skillId] ?? row.revision;
        return (
          <section className="mcp-service" key={row.skillId}>
            <div className="mcp-heading">
              <div>
                <h3>{row.name}</h3>
                <small>
                  {row.archived
                    ? t("Archived")
                    : t("Latest revision: {n}", { n: row.revision })}
                  {teamId &&
                    ` · ${row.grant?.active ? t("Authorized revision: {n}", { n: row.grant.revision }) : t("Not authorized")}`}
                </small>
              </div>
            </div>
            <div className="mcp-actions">
              <label>
                {t("Revision")}{" "}
                <select
                  value={revision}
                  disabled={busy}
                  onChange={(e) => {
                    setVersions({
                      ...versions,
                      [row.skillId]: Number(e.target.value),
                    });
                    setPreview(undefined);
                  }}
                >
                  {Array.from(
                    { length: row.revision },
                    (_, i) => row.revision - i,
                  ).map((n) => (
                    <option key={n}>{n}</option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="secondary-button"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    setPreview({
                      ...(await body(row, revision)),
                      revision,
                      skillId: row.skillId,
                    });
                  })
                }
              >
                {t("View instructions")}
              </button>
              {teamId ? (
                <>
                  <button
                    className="secondary-button"
                    disabled={
                      busy ||
                      (row.grant?.active && row.grant.revision === revision)
                    }
                    onClick={() => void grant(row, revision, true)}
                  >
                    {t("Authorize revision")}
                  </button>
                  {row.grant?.active && (
                    <button
                      className="text-button"
                      disabled={busy}
                      onClick={() =>
                        void grant(row, row.grant!.revision, false)
                      }
                    >
                      {t("Revoke access")}
                    </button>
                  )}
                </>
              ) : (
                !editor && (
                  <>
                    {!row.archived && (
                      <button
                        className="secondary-button"
                        disabled={busy}
                        onClick={() =>
                          void act(async () => {
                            setEditor({
                              ...(await body(row, row.revision)),
                              skillId: row.skillId,
                              expectedVersion: catalog.version,
                            });
                          })
                        }
                      >
                        {t("Edit")}
                      </button>
                    )}
                    <button
                      className="text-button"
                      disabled={busy}
                      onClick={() =>
                        void change({
                          action: row.archived ? "restore" : "archive",
                          skillId: row.skillId,
                        })
                      }
                    >
                      {t(
                        row.archived ? "Restore" : "Archive and revoke access",
                      )}
                    </button>
                  </>
                )
              )}
            </div>
            {preview?.skillId === row.skillId && (
              <div className="skill-revision-preview">
                <strong>
                  {preview.name} · {t("Revision")} {preview.revision}
                </strong>
                <p>{preview.instructions}</p>
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
