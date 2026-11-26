import { useEffect, useRef, useState } from "react";
import { Dialog } from "radix-ui";
import { ArrowUpRight, ClipboardCheck, Download, X } from "lucide-react";
import type {
  Acceptance,
  AcceptanceEvidence,
  AttemptStatus,
  WorkStatus,
} from "@team/contracts/runtime";
import { useI18n } from "./i18n";
import { api, product } from "./service";
import { harnessLabel } from "./harnessCatalog";
import { executionFeedback } from "./executionFeedback";
import "./candidate-review.css";

type Attempt = {
  id: string;
  status: AttemptStatus;
  harness: string;
  model?: string;
  startedAt: string;
  finishedAt: string | null;
  error?: string;
  instructionsRevision?: number;
};
type Receipt =
  | { id: string; available: false }
  | {
      id: string;
      available: true;
      command?: string;
      exitCode: number | null;
      finishedAt: string;
      outcome: "succeeded" | "failed";
      output: string;
      outputTruncated: boolean;
    };
type Criterion = Omit<Acceptance["criteria"][number], "evidenceEventIds"> & {
  receipts: Receipt[];
};
type WorkLink = { workId: string; memberId: string };
type Review = WorkLink & {
  status: WorkStatus;
  reviewer: string;
  error: string | null;
  supersededReason?: string;
  attempts: Attempt[];
};
type Verdict = WorkLink &
  Pick<Acceptance, "id" | "verdict" | "createdAt" | "contextVersion"> & {
    reviewer: string;
    attempt: Attempt;
    criteria: Criterion[];
  };
type Candidate = {
  id: string;
  createdAt: string;
  attemptId: string;
  snapshotId?: string;
  producer: { id: string; name: string };
  requirement: { id: string; revision: number };
  artifacts: { id: string; path: string; sha256: string }[];
  scope: {
    contextVersion?: string;
    documents: { key: string; id: string }[] | null;
  };
  criteria: AcceptanceEvidence[];
  stale?: { code: keyof typeof staleLabels; detail?: string | null };
  verdicts: Verdict[];
  reviews: Review[];
  effectiveReviewId?: string;
  next: (WorkLink & { title: string })[];
  actions: {
    revision: number;
    reviewers: { id: string; name: string }[];
    retry?: { workId: string; revision: number };
    recover?: { workId: string; revision: number };
    continueRevision?: number;
    repair?: { acceptanceId: string; revision: number };
    blocked?: "criteria" | "paused" | "host_repair";
  };
};
type Ledger = {
  title: string;
  branch: string;
  workStatus: WorkStatus;
  versions: { id: string; createdAt: string }[];
  candidate: Candidate | null;
};
type OnWork = (work: WorkLink, anchor?: string) => void;

const staleLabels = {
  replaced: "Replacement work superseded this candidate.",
  continued: "A later continuation superseded this candidate.",
  new_submission: "This work has moved on from this submission.",
  requirements: "The requirements for this work changed after submission.",
  definition: "The project definition used for this submission has changed.",
  workflow: "The execution plan or a prerequisite version has changed.",
} as const;
const reviewLabels: Partial<Record<WorkStatus, string>> = {
  queued: "Review queued",
  waiting: "Review waiting",
  running: "Review in progress",
  stopping: "Review stopping",
  interrupted: "Review interrupted",
  failed: "Review failed",
  recovery_required: "Review needs recovery",
  superseded: "Review superseded",
  submitted: "Review ended without a verdict",
};
const attemptLabels: Record<AttemptStatus, string> = {
  running: "Running",
  stopping: "Stopping",
  completed: "Completed",
  failed: "Failed",
  interrupted: "Interrupted",
  recovery_required: "Needs reconciliation",
  unknown: "Unknown",
};
const evidenceLabels: Record<AcceptanceEvidence["evidenceType"], string> = {
  native_check: "Command check",
  review_judgment: "Reviewer judgment",
  unresolved: "Evidence needed",
};
const openReview = (review?: Review) =>
  !!review &&
  ["queued", "waiting", "running", "stopping", "recovery_required"].includes(
    review.status,
  );
const pathSegment = encodeURIComponent;

export function CandidateReview({
  teamId,
  branchId,
  workId,
  nodeId,
  reviewWorkId,
  producerAttemptId,
  cursor,
  onWork,
  className = "text-button",
}: {
  teamId: string;
  branchId: string;
  workId: string;
  nodeId?: string;
  reviewWorkId?: string;
  producerAttemptId?: string;
  cursor: number;
  onWork?: OnWork;
  className?: string;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger className={`candidate-review-trigger ${className}`}>
        <ClipboardCheck size={15} aria-hidden />
        {t("Independent review")}
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="overlay" />
        <Dialog.Content
          // React Flow listens on document; keep its canvas shortcuts out of this portal.
          className="modal candidate-review-modal nokey"
          aria-describedby={undefined}
        >
          <header className="modal-header candidate-review-header">
            <Dialog.Title>{t("Independent review")}</Dialog.Title>
            <Dialog.Close className="icon-button" aria-label={t("Close")}>
              <X size={16} aria-hidden />
            </Dialog.Close>
          </header>
          <ReviewContent
            key={`${teamId}:${branchId}:${workId}:${nodeId ?? reviewWorkId ?? producerAttemptId ?? ""}`}
            teamId={teamId}
            branchId={branchId}
            workId={workId}
            nodeId={nodeId}
            reviewWorkId={reviewWorkId}
            producerAttemptId={producerAttemptId}
            cursor={cursor}
            onWork={
              onWork
                ? (work, anchor) => {
                    setOpen(false);
                    onWork(work, anchor);
                  }
                : undefined
            }
          />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function ReviewContent({
  teamId,
  branchId,
  workId,
  nodeId,
  reviewWorkId,
  producerAttemptId,
  cursor,
  onWork,
}: {
  teamId: string;
  branchId: string;
  workId: string;
  nodeId?: string;
  reviewWorkId?: string;
  producerAttemptId?: string;
  cursor: number;
  onWork?: OnWork;
}) {
  const { t, locale } = useI18n();
  const [selected, select] = useState("");
  const [loaded, setLoaded] = useState<{ key: string; data: Ledger }>();
  const [loadError, setLoadError] = useState<{ key: string; text: string }>();
  const [generation, reload] = useState(0);
  const [operation, setOperation] = useState("");
  const [operationError, setOperationError] = useState("");
  const [feedback, setFeedback] = useState("");
  const [form, setForm] = useState<"review" | "continue" | "repair" | null>(
    null,
  );
  const [instructions, setInstructions] = useState("");
  const [reviewerId, setReviewerId] = useState("");
  const actionLock = useRef(false);
  const formStart = useRef<HTMLElement | null>(null);
  const pending = useRef<{ signature: string; id: string } | undefined>(
    undefined,
  );
  const pinned = useRef("");
  const teamPath = `/teams/${pathSegment(teamId)}`;
  const workPath = `${teamPath}/works/${pathSegment(workId)}`;
  const readPath = `${teamPath}/branches/${pathSegment(branchId)}/works/${pathSegment(workId)}/candidate-review`;
  useEffect(() => {
    const controller = new AbortController();
    const candidateId = selected || pinned.current;
    const query = candidateId
      ? `?candidateId=${pathSegment(candidateId)}`
      : nodeId
        ? `?nodeId=${pathSegment(nodeId)}`
        : reviewWorkId
          ? `?reviewWorkId=${pathSegment(reviewWorkId)}`
          : producerAttemptId
            ? `?producerAttemptId=${pathSegment(producerAttemptId)}`
            : "";
    void api<Ledger>(readPath + query, undefined, "GET", controller.signal)
      .then((data) => {
        if (controller.signal.aborted) return;
        pinned.current = data.candidate?.id ?? "";
        setLoaded({ key: selected, data });
        setLoadError(undefined);
      })
      .catch((err: Error) => {
        if (!controller.signal.aborted)
          setLoadError({ key: selected, text: err.message });
      });
    return () => controller.abort();
  }, [
    readPath,
    nodeId,
    reviewWorkId,
    producerAttemptId,
    selected,
    cursor,
    generation,
  ]);
  useEffect(() => {
    if (form) formStart.current?.focus();
  }, [form]);

  const view = loaded?.data;
  const loadingSelection = loaded?.key !== selected;
  const error = loadError?.key === selected ? loadError.text : undefined;
  const candidate = loadingSelection ? undefined : view?.candidate;
  const actions = !error ? candidate?.actions : undefined;
  const active = candidate?.reviews.find(
    (review) => review.workId === candidate.effectiveReviewId,
  );
  const verdict = candidate?.verdicts.at(-1);
  const status = candidate?.stale
    ? "Earlier candidate"
    : verdict
      ? verdict.verdict === "accepted"
        ? "Accepted"
        : "Rejected"
      : active
        ? (reviewLabels[active.status] ?? "Awaiting independent review")
        : "Awaiting independent review";
  const date = (value: string) =>
    new Date(value).toLocaleString(locale, {
      dateStyle: "medium",
      timeStyle: "short",
    });
  const mutate = async (
    name: string,
    action: () => Promise<unknown>,
    done: string,
  ) => {
    if (actionLock.current || error) return;
    actionLock.current = true;
    setOperation(name);
    setOperationError("");
    setFeedback("");
    try {
      await action();
      setForm(null);
      setInstructions("");
      setReviewerId("");
      setFeedback(done);
      pending.current = undefined;
    } catch (reason) {
      setOperationError((reason as Error).message);
    } finally {
      actionLock.current = false;
      setOperation("");
      reload((n) => n + 1);
    }
  };
  const requestId = (url: string, request: object) => {
    const signature = JSON.stringify([url, request]);
    if (pending.current?.signature !== signature)
      pending.current = { signature, id: crypto.randomUUID() };
    return pending.current.id;
  };
  const openForm = (next: "review" | "continue" | "repair") => {
    if (form !== next) {
      setForm(next);
      setInstructions("");
      setReviewerId("");
    }
    setOperationError("");
  };
  const navigate = (target: WorkLink, anchor = `assignment:${target.workId}`) =>
    onWork?.(target, anchor);

  return (
    <div className="candidate-review-content">
      {view && (
        <div className="candidate-review-intro">
          <p>{view.branch}</p>
          <h3>{view.title}</h3>
          {view.versions.length > 1 && (
            <label className="candidate-review-version">
              <span>{t("Submission")}</span>
              <select
                value={selected || view.candidate?.id}
                onChange={(event) => {
                  select(event.target.value);
                  setForm(null);
                  setOperationError("");
                  setFeedback("");
                }}
                disabled={!!operation}
              >
                {view.versions.map((item) => (
                  <option key={item.id} value={item.id}>
                    {date(item.createdAt)} ({item.id.slice(0, 8)})
                  </option>
                ))}
              </select>
            </label>
          )}
          {candidate && (
            <span
              className="candidate-review-status"
              data-state={
                candidate.stale
                  ? "historical"
                  : (verdict?.verdict ?? active?.status)
              }
            >
              {t(status)}
            </span>
          )}
        </div>
      )}
      {error && (
        <div className="candidate-review-notice">
          <p role="alert">{t(executionFeedback(error))}</p>
          <button
            type="button"
            className="secondary-button"
            onClick={() => {
              setLoadError(undefined);
              reload((n) => n + 1);
            }}
          >
            {t("Reload review")}
          </button>
        </div>
      )}
      {loadingSelection && !error && (
        <p role="status">{t("Loading review…")}</p>
      )}
      {view && !loadingSelection && !candidate && (
        <div className="candidate-review-empty">
          <strong>{t("No candidate submitted")}</strong>
          <p>{t("The review opens once this work submits a result.")}</p>
        </div>
      )}
      {candidate && view && (
        <>
          {candidate.stale && (
            <p className="candidate-review-notice">
              {candidate.stale.detail
                ? t(executionFeedback(candidate.stale.detail))
                : t(staleLabels[candidate.stale.code])}
            </p>
          )}
          <section
            className="candidate-review-section"
            aria-label={t("Candidate scope")}
          >
            <h4>{t("Candidate scope")}</h4>
            <p className="candidate-review-metadata">
              {t("Submitted by {name} on {date}", {
                name: candidate.producer.name,
                date: date(candidate.createdAt),
              })}
            </p>
            <ul className="candidate-review-files">
              {candidate.artifacts.map((file) => (
                <li key={file.id}>
                  <a
                    href={`/api/product${teamPath}/artifacts/${pathSegment(file.id)}/download`}
                    download={
                      file.path === "@result"
                        ? "summary.txt"
                        : file.path.split("/").at(-1)
                    }
                  >
                    <Download size={14} aria-hidden />
                    {file.path === "@result"
                      ? t("Submission summary")
                      : file.path}
                  </a>
                  <details>
                    <summary>{t("File version")}</summary>
                    <dl className="candidate-review-pins">
                      <dt>{t("Version ID")}</dt>
                      <dd>
                        <code>{file.id}</code>
                      </dd>
                      <dt>SHA-256</dt>
                      <dd>
                        <code>{file.sha256}</code>
                      </dd>
                    </dl>
                  </details>
                </li>
              ))}
            </ul>
            <details>
              <summary>{t("Submission versions and definition")}</summary>
              <dl className="candidate-review-pins">
                <dt>{t("Submission ID")}</dt>
                <dd>
                  <code>{candidate.id}</code>
                </dd>
                {candidate.snapshotId && (
                  <>
                    <dt>{t("Frozen snapshot")}</dt>
                    <dd>
                      <code>{candidate.snapshotId}</code>
                    </dd>
                  </>
                )}
                <dt>{t("Producer attempt")}</dt>
                <dd>
                  <code>{candidate.attemptId}</code>
                </dd>
                <dt>
                  {t("Requirement revision {revision}", {
                    revision: String(candidate.requirement.revision),
                  })}
                </dt>
                <dd>
                  <code>{candidate.requirement.id}</code>
                </dd>
                {candidate.scope.contextVersion && (
                  <>
                    <dt>{t("Definition version")}</dt>
                    <dd>
                      <code>{candidate.scope.contextVersion}</code>
                    </dd>
                  </>
                )}
                {candidate.scope.documents === null ? (
                  <>
                    <dt>{t("Definition scope")}</dt>
                    <dd>{t("Branch definition")}</dd>
                  </>
                ) : (
                  candidate.scope.documents.map((doc) => (
                    <div className="candidate-review-pin" key={doc.key}>
                      <dt>{doc.key}</dt>
                      <dd>
                        <code>{doc.id}</code>
                      </dd>
                    </div>
                  ))
                )}
              </dl>
            </details>
          </section>
          <section
            className="candidate-review-section"
            aria-label={t("Verdict and evidence")}
          >
            <h4>{t("Verdict and evidence")}</h4>
            {candidate.verdicts.length ? (
              [...candidate.verdicts]
                .reverse()
                .map((item) => (
                  <VerdictRecord key={item.id} verdict={item} onWork={onWork} />
                ))
            ) : (
              <>
                {!openReview(active) && !active && (
                  <p>
                    {t("No independent verdict recorded for this submission.")}
                  </p>
                )}
                {active && (
                  <div className="candidate-review-assigned">
                    <strong>{active.reviewer}</strong>
                    <span>
                      {t(
                        reviewLabels[active.status] ??
                          "Awaiting independent review",
                      )}
                    </span>
                    {onWork && (
                      <button
                        className="text-button"
                        onClick={() =>
                          navigate(
                            active,
                            active.attempts.at(-1)
                              ? `attempt:${active.attempts.at(-1)!.id}`
                              : undefined,
                          )
                        }
                      >
                        <ArrowUpRight size={14} aria-hidden />
                        {t("Open reviewer work")}
                      </button>
                    )}
                  </div>
                )}
                {active?.error && (
                  <p className="candidate-review-notice">
                    {t(executionFeedback(active.error))}
                  </p>
                )}
                {!!candidate.criteria.length && (
                  <ol className="candidate-review-criteria">
                    {candidate.criteria.map((item, index) => (
                      <li key={index}>
                        <strong>{item.criterion}</strong>
                        <span>{t(evidenceLabels[item.evidenceType])}</span>
                      </li>
                    ))}
                  </ol>
                )}
              </>
            )}
            {!!candidate.reviews.length && (
              <details className="candidate-review-attempt-history">
                <summary>{t("Review assignments and attempts")}</summary>
                {candidate.reviews
                  .slice()
                  .reverse()
                  .map((review) => (
                    <div
                      key={review.workId}
                      className="candidate-review-assignment"
                    >
                      <strong>{review.reviewer}</strong>
                      {reviewLabels[review.status] &&
                        (!candidate.verdicts.some(
                          (record) => record.workId === review.workId,
                        ) ||
                          review.status === "superseded") && (
                          <span>{t(reviewLabels[review.status]!)}</span>
                        )}
                      {(review.supersededReason || review.error) && (
                        <p>
                          {t(
                            executionFeedback(
                              review.supersededReason ?? review.error!,
                            ),
                          )}
                        </p>
                      )}
                      {!review.attempts.length && (
                        <p>{t("No reviewer attempt recorded.")}</p>
                      )}
                      {[...review.attempts].reverse().map((attempt) => (
                        <AttemptRecord
                          key={attempt.id}
                          attempt={attempt}
                          date={date}
                          onOpen={
                            onWork
                              ? () => navigate(review, `attempt:${attempt.id}`)
                              : undefined
                          }
                        />
                      ))}
                    </div>
                  ))}
              </details>
            )}
          </section>
          {((actions &&
            (actions.reviewers.length > 0 ||
              actions.retry ||
              actions.recover ||
              actions.continueRevision ||
              actions.repair ||
              actions.blocked)) ||
            candidate.next.length > 0 ||
            operationError ||
            feedback) && (
            <section
              className="candidate-review-section candidate-review-next"
              aria-label={t("Next steps")}
            >
              <h4>{t("Next steps")}</h4>
              {actions?.blocked === "criteria" && (
                <p>
                  {t(
                    "Ask Host to specify the evidence each criterion requires before assigning review.",
                  )}
                </p>
              )}
              {actions?.blocked === "paused" && (
                <p>{t("Resume the run to make changes to this work.")}</p>
              )}
              {actions?.blocked === "host_repair" && (
                <p>
                  {t("Ask Host to assign a repair under the current contract.")}
                </p>
              )}
              {candidate.next.map((item) =>
                onWork ? (
                  <button
                    key={item.workId}
                    className="text-button"
                    onClick={() => navigate(item)}
                  >
                    <ArrowUpRight size={14} aria-hidden />{" "}
                    {t("Open next work: {title}", { title: item.title })}
                  </button>
                ) : null,
              )}
              <div className="candidate-review-controls">
                {actions?.recover && (
                  <button
                    className="secondary-button"
                    disabled={!!operation}
                    onClick={() => {
                      const { workId: id, revision } = actions.recover!;
                      const url = `${teamPath}/works/${pathSegment(id)}/reconcile`;
                      void mutate(
                        "recover",
                        () =>
                          product.command(url, { expectedRevision: revision }),
                        "Review recovery checked.",
                      );
                    }}
                  >
                    {t(
                      operation === "recover"
                        ? "Checking recovery…"
                        : "Recover review",
                    )}
                  </button>
                )}
                {actions?.retry && (
                  <button
                    className="secondary-button"
                    disabled={!!operation}
                    onClick={() => {
                      const { workId: id, revision } = actions.retry!;
                      void mutate(
                        "retry",
                        () =>
                          product.command(
                            `${teamPath}/works/${pathSegment(id)}/retry`,
                            { expectedRevision: revision },
                          ),
                        "Review retry requested.",
                      );
                    }}
                  >
                    {t(
                      operation === "retry"
                        ? "Requesting retry…"
                        : "Retry review",
                    )}
                  </button>
                )}
                {!!actions?.reviewers.length &&
                  (!actions.retry ||
                    actions.reviewers.some(
                      (item) => item.id !== active?.memberId,
                    )) && (
                    <button
                      className="secondary-button"
                      disabled={!!operation}
                      onClick={() => openForm("review")}
                    >
                      {t(
                        active
                          ? "Assign another review"
                          : "Request independent review",
                      )}
                    </button>
                  )}
                {actions?.continueRevision && (
                  <button
                    className="secondary-button"
                    disabled={!!operation}
                    onClick={() => openForm("continue")}
                  >
                    {t("Continue modifying")}
                  </button>
                )}
                {actions?.repair && (
                  <button
                    className="secondary-button"
                    disabled={!!operation}
                    onClick={() => openForm("repair")}
                  >
                    {t("Return for changes")}
                  </button>
                )}
              </div>
              {form &&
                actions &&
                (form === "review"
                  ? !!actions.reviewers.length
                  : form === "repair"
                    ? !!actions.repair
                    : !!actions.continueRevision) && (
                  <form
                    className="candidate-review-form"
                    onSubmit={(event) => {
                      event.preventDefault();
                      const content = instructions.trim();
                      if (!content) return;
                      if (form === "review") {
                        if (
                          !actions.reviewers.some(
                            (item) => item.id === reviewerId,
                          )
                        )
                          return;
                        const url = `${workPath}/review`;
                        const body = {
                          expectedRevision: actions.revision,
                          reviewerMemberId: reviewerId,
                          instructions: content,
                        };
                        void mutate(
                          "review",
                          () =>
                            product.command(url, {
                              ...body,
                              clientRequestId: requestId(url, body),
                            }),
                          "Review requested.",
                        );
                      } else {
                        const url = `/product${workPath}/messages`;
                        const body =
                          form === "repair" && actions.repair
                            ? {
                                expectedRevision: actions.repair.revision,
                                mode: "repair",
                                content,
                                acceptanceId: actions.repair.acceptanceId,
                              }
                            : {
                                expectedRevision: actions.continueRevision,
                                mode: "revise",
                                content,
                              };
                        void mutate(
                          form,
                          () =>
                            product.command(url, {
                              ...body,
                              clientRequestId: requestId(url, body),
                            }),
                          form === "repair"
                            ? "Returned for changes."
                            : "Continuation requested.",
                        );
                      }
                    }}
                  >
                    {form === "review" && (
                      <label>
                        {t("Reviewer")}
                        <select
                          ref={(element) => {
                            formStart.current = element;
                          }}
                          value={reviewerId}
                          disabled={!!operation}
                          required
                          onChange={(event) =>
                            setReviewerId(event.target.value)
                          }
                        >
                          <option value="">{t("Choose a reviewer")}</option>
                          {actions.reviewers
                            .filter(
                              (item) =>
                                !actions.retry || item.id !== active?.memberId,
                            )
                            .map((item) => (
                              <option key={item.id} value={item.id}>
                                {item.name}
                              </option>
                            ))}
                        </select>
                      </label>
                    )}
                    <label>
                      {t(
                        form === "review"
                          ? "Review instructions"
                          : "Requested changes",
                      )}
                      <textarea
                        ref={(element) => {
                          if (form !== "review") formStart.current = element;
                        }}
                        rows={3}
                        required
                        maxLength={20000}
                        value={instructions}
                        disabled={!!operation}
                        onChange={(event) =>
                          setInstructions(event.target.value)
                        }
                      />
                    </label>
                    <div className="candidate-review-controls">
                      <button
                        className="primary-button"
                        disabled={
                          !!operation ||
                          !instructions.trim() ||
                          (form === "review" && !reviewerId)
                        }
                      >
                        {t(
                          operation
                            ? "Sending…"
                            : form === "review"
                              ? "Assign review"
                              : "Send changes",
                        )}
                      </button>
                      <button
                        type="button"
                        className="secondary-button"
                        disabled={!!operation}
                        onClick={() => setForm(null)}
                      >
                        {t("Cancel")}
                      </button>
                    </div>
                  </form>
                )}
              {operationError && (
                <p role="alert" className="candidate-review-notice">
                  {t(executionFeedback(operationError))}
                </p>
              )}
              {feedback && <p role="status">{t(feedback)}</p>}
            </section>
          )}
        </>
      )}
    </div>
  );
}

function VerdictRecord({
  verdict,
  onWork,
}: {
  verdict: Verdict;
  onWork?: OnWork;
}) {
  const { t, locale } = useI18n();
  const date = (value: string) =>
    new Date(value).toLocaleString(locale, {
      dateStyle: "medium",
      timeStyle: "short",
    });
  return (
    <article
      className="candidate-review-verdict"
      aria-label={t(verdict.verdict === "accepted" ? "Accepted" : "Rejected")}
    >
      <div className="candidate-review-assigned">
        <strong>
          {t(verdict.verdict === "accepted" ? "Accepted" : "Rejected")}
        </strong>
        <span>{verdict.reviewer}</span>
        <time dateTime={verdict.createdAt}>{date(verdict.createdAt)}</time>
      </div>
      <ol className="candidate-review-criteria">
        {verdict.criteria.map((item) => (
          <li key={item.criterion}>
            <strong>{item.criterion}</strong>
            <span data-result={item.passed ? "pass" : "fail"}>
              {t(item.passed ? "Passed" : "Failed")} ·{" "}
              {t(evidenceLabels[item.evidenceType])}
            </span>
            <p>{item.evidence}</p>
            {item.receipts.map((receipt) => (
              <details className="candidate-review-receipt" key={receipt.id}>
                <summary>
                  {receipt.available
                    ? t("Command receipt")
                    : t("Command receipt unavailable")}
                </summary>
                {receipt.available && (
                  <>
                    {receipt.command && <pre>{receipt.command}</pre>}
                    <p>
                      {receipt.exitCode === null
                        ? t(
                            receipt.outcome === "succeeded"
                              ? "Command succeeded"
                              : "Command failed",
                          )
                        : t("Exit code {code}", {
                            code: String(receipt.exitCode),
                          })}{" "}
                      ·{" "}
                      <time dateTime={receipt.finishedAt}>
                        {date(receipt.finishedAt)}
                      </time>
                    </p>
                    {receipt.output && (
                      <pre tabIndex={0} aria-label={t("Command output")}>
                        {receipt.output}
                      </pre>
                    )}
                    {receipt.outputTruncated && (
                      <span>{t("Command output preview is shortened.")}</span>
                    )}
                  </>
                )}
                <p>
                  {t("Receipt ID")} <code>{receipt.id}</code>
                </p>
              </details>
            ))}
          </li>
        ))}
      </ol>
      <details>
        <summary>{t("Verdict and reviewer attempt IDs")}</summary>
        <AttemptRecord
          attempt={verdict.attempt}
          date={date}
          onOpen={
            onWork
              ? () => onWork(verdict, `attempt:${verdict.attempt.id}`)
              : undefined
          }
        />
        <dl className="candidate-review-pins">
          <dt>{t("Verdict ID")}</dt>
          <dd>
            <code>{verdict.id}</code>
          </dd>
          {verdict.contextVersion && (
            <>
              <dt>{t("Review context version")}</dt>
              <dd>
                <code>{verdict.contextVersion}</code>
              </dd>
            </>
          )}
        </dl>
      </details>
    </article>
  );
}

function AttemptRecord({
  attempt,
  date,
  onOpen,
}: {
  attempt: Attempt;
  date: (value: string) => string;
  onOpen?: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="candidate-review-attempt">
      <p>
        {harnessLabel(attempt.harness)}
        {attempt.model && ` / ${attempt.model}`} ·{" "}
        {t(attemptLabels[attempt.status])}
      </p>
      <dl className="candidate-review-pins">
        <dt>{t("Reviewer attempt")}</dt>
        <dd>
          <code>{attempt.id}</code>
        </dd>
        <dt>{t("Started")}</dt>
        <dd>
          <time dateTime={attempt.startedAt}>{date(attempt.startedAt)}</time>
        </dd>
        {attempt.finishedAt && (
          <>
            <dt>{t("Finished")}</dt>
            <dd>
              <time dateTime={attempt.finishedAt}>
                {date(attempt.finishedAt)}
              </time>
            </dd>
          </>
        )}
        {attempt.instructionsRevision && (
          <>
            <dt>{t("Review instructions revision")}</dt>
            <dd>{attempt.instructionsRevision}</dd>
          </>
        )}
      </dl>
      {attempt.error && <p>{t(executionFeedback(attempt.error))}</p>}
      {onOpen && (
        <button type="button" className="text-button" onClick={onOpen}>
          <ArrowUpRight size={14} aria-hidden />
          {t("Open reviewer work")}
        </button>
      )}
    </div>
  );
}
