import { useEffect, useState } from "react";
import type {
  SubspaceRecovery as Recovery,
  SubspaceRecoveryPlan,
} from "@team/contracts/runtime";
import { useI18n } from "./i18n";
import { api, product } from "./service";
import { executionFeedback } from "./executionFeedback";
import { Modal } from "./ui";

export function SubspaceRecovery({
  teamId,
  workId,
}: {
  teamId: string;
  workId: string;
}) {
  const { t } = useI18n();
  const url = `/teams/${encodeURIComponent(teamId)}/works/${encodeURIComponent(workId)}/subspaces`;
  const [recovery, setRecovery] = useState<Recovery>();
  const [review, setReview] = useState<SubspaceRecoveryPlan>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    void api<Recovery>(`${url}/recovery`, undefined, "GET", controller.signal)
      .then(setRecovery)
      .catch((e) => {
        if (!controller.signal.aborted) setError(executionFeedback(e.message));
      });
    return () => controller.abort();
  }, [url]);

  async function recover(
    plan: SubspaceRecoveryPlan,
    action: "resume" | "rollback",
  ) {
    if (busy || !recovery || (action === "rollback" && !plan.rollback)) return;
    setBusy(true);
    setError("");
    try {
      await api(
        `${url}/${encodeURIComponent(plan.id)}/recover`,
        action === "rollback"
          ? {
              action,
              expectedRevision: recovery.workRevision,
              expectedFingerprint: plan.rollback!.fingerprint,
            }
          : {},
      );
      setReview(undefined);
      setRecovery(await api<Recovery>(`${url}/recovery`));
      await product.refresh();
    } catch (error) {
      setReview(undefined);
      setError(executionFeedback((error as Error).message));
      void api<Recovery>(`${url}/recovery`)
        .then(setRecovery)
        .catch(() => {});
    } finally {
      setBusy(false);
    }
  }

  if (!recovery?.plans.length && !error) return null;
  return (
    <section
      className="subspace-recovery"
      aria-label={t("Child submission recovery")}
    >
      <strong>{t("Child submission recovery")}</strong>
      {error && <p role="alert">{t(error)}</p>}
      {recovery?.plans.map((plan) => (
        <div className="subspace-recovery-plan" key={plan.id}>
          {plan.error && <p>{t(executionFeedback(plan.error))}</p>}
          {plan.appliedPaths.length > 0 && (
            <details>
              <summary>
                {t("Applied files")} · {plan.appliedPaths.length}
              </summary>
              <ul>
                {plan.appliedPaths.map((path) => (
                  <li key={path}>{path}</li>
                ))}
              </ul>
            </details>
          )}
          <div className="subspace-recovery-actions">
            {plan.resumeAllowed && (
              <button
                type="button"
                className="text-button"
                disabled={busy}
                onClick={() => void recover(plan, "resume")}
              >
                {t("Resume child submission")}
              </button>
            )}
            {plan.rollback && (
              <button
                type="button"
                className="text-button"
                disabled={busy}
                onClick={() => setReview(plan)}
              >
                {t("Review file restoration")}
              </button>
            )}
          </div>
          {plan.rollbackBlocked && (
            <p>{t(executionFeedback(plan.rollbackBlocked))}</p>
          )}
        </div>
      ))}
      {review?.rollback && (
        <Modal
          open
          onOpenChange={(open) => {
            if (!open && !busy) setReview(undefined);
          }}
          title={t("Restore work copy files")}
        >
          <div className="subspace-restore-content">
            <p>
              {t(
                "Restore these files to their state before the child submission.",
              )}
            </p>
            <ul>
              {review.rollback.paths.map((file) => (
                <li key={file.path}>
                  <strong>{file.path}</strong>
                  <span>
                    {t(
                      file.sha256 === file.targetSha256
                        ? "Already at the pre-submission version"
                        : file.targetSha256 === null
                          ? "Remove from this work copy"
                          : "Restore pre-submission version",
                    )}
                  </span>
                </li>
              ))}
            </ul>
            <div className="subspace-recovery-actions">
              <button
                type="button"
                className="primary-button"
                disabled={busy}
                onClick={() => void recover(review, "rollback")}
              >
                {t("Restore files")}
              </button>
              <button
                type="button"
                className="secondary-button"
                disabled={busy}
                onClick={() => setReview(undefined)}
              >
                {t("Cancel")}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </section>
  );
}
