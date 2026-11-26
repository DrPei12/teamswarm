import { useEffect, useRef, useState } from "react";
import type { PublicationRetentionPreview } from "@team/contracts/runtime";
import { executionFeedback } from "./executionFeedback";
import { useI18n } from "./i18n";
import { api, ApiError, product } from "./service";
import { Modal } from "./ui";

const versionLabels = {
  candidate: "Matches the submitted file",
  base: "Matches the pre-publication file",
  changed: "Differs from both saved versions",
  missing: "Not present in the project",
} as const;

export function PublicationRetention({
  teamId,
  workId,
}: {
  teamId: string;
  workId: string;
}) {
  const { t } = useI18n();
  const url = `/teams/${encodeURIComponent(teamId)}/works/${encodeURIComponent(workId)}/publication/retention`;
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<PublicationRetentionPreview>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [kept, setKept] = useState(false);
  const reader = useRef<AbortController | null>(null);
  const savingRef = useRef(false);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => () => reader.current?.abort(), []);

  async function review() {
    reader.current?.abort();
    const controller = new AbortController();
    reader.current = controller;
    setOpen(true);
    setPreview(undefined);
    setError("");
    setLoading(true);
    try {
      const result = await api<PublicationRetentionPreview>(
        url,
        undefined,
        "GET",
        AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
      );
      if (!controller.signal.aborted) setPreview(result);
    } catch (error) {
      if (!controller.signal.aborted)
        setError(executionFeedback((error as Error).message));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
      if (reader.current === controller) reader.current = null;
    }
  }

  function close() {
    if (savingRef.current) return;
    reader.current?.abort();
    setOpen(false);
    // This modal is opened by state rather than a Dialog.Trigger.
    requestAnimationFrame(() => trigger.current?.focus());
  }

  async function keepCurrent() {
    if (!preview || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError("");
    try {
      await api(
        url,
        {
          expectedRevision: preview.revision,
          expectedFingerprint: preview.fingerprint,
        },
        "POST",
        AbortSignal.timeout(20_000),
      );
      setKept(true);
      setOpen(false);
      void product.refresh();
    } catch (error) {
      if (
        error instanceof ApiError &&
        [
          "publication_preview_changed",
          "publication_workspace_changed",
          "version_conflict",
          "publication_state",
        ].includes(error.code)
      )
        setPreview(undefined);
      setError(executionFeedback((error as Error).message));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  if (kept) return <p role="status">{t("Current project files kept.")}</p>;
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="text-button"
        onClick={() => void review()}
      >
        {t("Review current files")}
      </button>
      <Modal
        open={open}
        onOpenChange={(value) => {
          if (!value) close();
        }}
        title={t("Review current files")}
        className="publication-retention-modal nokey"
      >
        <div className="subspace-restore-content">
          <p>
            {t(
              "Keep the files as they are and close this publication without applying the remaining changes. The submitted version stays in work history.",
            )}
          </p>
          {loading && <p role="status">{t("Checking current files…")}</p>}
          {error && (
            <p className="form-error" role="alert">
              {t(error)}
            </p>
          )}
          {preview && (
            <ul>
              {preview.files.map((file) => (
                <li key={file.path}>
                  <strong>{file.path}</strong>
                  <span>{t(versionLabels[file.version])}</span>
                </li>
              ))}
            </ul>
          )}
          <div className="subspace-recovery-actions">
            {preview ? (
              <button
                type="button"
                className="primary-button"
                disabled={saving}
                onClick={() => void keepCurrent()}
              >
                {t(saving ? "Saving…" : "Keep current files")}
              </button>
            ) : (
              error && (
                <button
                  type="button"
                  className="primary-button"
                  onClick={() => void review()}
                >
                  {t("Check current files again")}
                </button>
              )
            )}
            <button
              type="button"
              className="secondary-button"
              disabled={saving}
              onClick={close}
            >
              {t("Cancel")}
            </button>
          </div>
        </div>
      </Modal>
    </>
  );
}
