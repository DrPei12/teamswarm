import { useEffect, useState } from "react";
import type { ExecutionApproval } from "@team/contracts/runtime";
import { api, product } from "./service";
import { useI18n } from "./i18n";
import type { Workspace } from "./store";

function approvalDetails(text: string): string {
  try {
    const input = JSON.parse(text);
    if (!input || typeof input !== "object" || Array.isArray(input))
      return text;
    const {
      threadId: _thread,
      turnId: _turn,
      itemId: _item,
      ...details
    } = input;
    const { command, cwd, reason, ...rest } = details;
    return (
      [
        command &&
          (Array.isArray(command) ? command.join(" ") : String(command)),
        cwd && String(cwd),
        reason && String(reason),
        Object.keys(rest).length ? JSON.stringify(rest, null, 2) : null,
      ]
        .filter(Boolean)
        .join("\n\n") || text
    );
  } catch {
    return text;
  }
}

type Answer = { accepted: boolean; answers?: string[][] };

function QuestionRequest({
  request,
  member,
  busy,
  onSend,
}: {
  request: ExecutionApproval;
  member?: string;
  busy: boolean;
  onSend: (answer: Answer) => void;
}) {
  const { t } = useI18n();
  const questions = request.questions ?? [];
  const [chosen, setChosen] = useState<string[][]>(() =>
    questions.map(() => []),
  );
  const [other, setOther] = useState<string[]>(() => questions.map(() => ""));
  const answers = questions.map((_, i) => [
    ...chosen[i],
    ...(other[i].trim() ? [other[i].trim()] : []),
  ]);
  const complete = answers.every(
    (a, i) => a.length > 0 && (questions[i].multiSelect || a.length === 1),
  );
  const choose = (index: number, label: string, multi: boolean) => {
    setChosen((old) =>
      old.map((values, i) =>
        i !== index
          ? values
          : !multi
            ? [label]
            : values.includes(label)
              ? values.filter((v) => v !== label)
              : [...values, label],
      ),
    );
    if (!multi) setOther((old) => old.map((v, i) => (i === index ? "" : v)));
  };
  const write = (index: number, value: string, multi: boolean) => {
    setOther((old) => old.map((v, i) => (i === index ? value : v)));
    if (!multi && value.trim())
      setChosen((old) => old.map((v, i) => (i === index ? [] : v)));
  };
  return (
    <section
      className="approval-request question-request"
      aria-label={t("Needs your answer")}
    >
      <div className="approval-heading">
        <strong>{t("Needs your answer")}</strong>
        <span>{member}</span>
      </div>
      {questions.map((q, i) => (
        <fieldset className="question-item" key={i} disabled={busy}>
          <legend>
            {q.header && <span className="question-header">{q.header}</span>}
            {q.question}
          </legend>
          {q.multiSelect && <small>{t("Select all that apply")}</small>}
          {q.options.map((o) => (
            <label className="question-option" key={o.label}>
              <input
                type={q.multiSelect ? "checkbox" : "radio"}
                name={`${request.id}:${i}`}
                checked={chosen[i].includes(o.label)}
                onChange={() => choose(i, o.label, !!q.multiSelect)}
              />
              <span>
                <span>{o.label}</span>
                {o.description && <small>{o.description}</small>}
              </span>
            </label>
          ))}
          {q.allowOther && (
            <input
              className="question-other"
              value={other[i]}
              maxLength={2000}
              aria-label={t(q.options.length ? "Other answer" : "Your answer")}
              placeholder={t(q.options.length ? "Other answer" : "Your answer")}
              onChange={(e) => write(i, e.target.value, !!q.multiSelect)}
            />
          )}
        </fieldset>
      ))}
      <div className="approval-actions">
        <button
          className="secondary-button"
          disabled={busy}
          onClick={() => onSend({ accepted: false })}
        >
          {t("Skip")}
        </button>
        <button
          className="primary-button"
          disabled={busy || !complete}
          onClick={() => onSend({ accepted: true, answers })}
        >
          {t("Send answer")}
        </button>
      </div>
    </section>
  );
}

export function ApprovalRequests({
  teamId,
  memberId,
  workspace,
}: {
  teamId: string;
  memberId?: string;
  workspace: Workspace;
}) {
  const { t } = useI18n();
  const [requests, setRequests] = useState<ExecutionApproval[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [revision, reload] = useState(0);
  const cursor = workspace.executions?.[teamId]?.latestEvent;
  useEffect(() => {
    let active = true;
    void api<ExecutionApproval[]>(
      `/teams/${encodeURIComponent(teamId)}/approvals`,
    )
      .then((rows) => {
        if (active) {
          setRequests(rows.filter((a) => !memberId || a.memberId === memberId));
          setError("");
        }
      })
      .catch((e) => {
        if (active) setError((e as Error).message);
      });
    return () => {
      active = false;
    };
  }, [teamId, memberId, cursor, revision]);
  const send = async (request: ExecutionApproval, answer: Answer) => {
    setBusy(request.id);
    setError("");
    try {
      await api(
        `/teams/${encodeURIComponent(teamId)}/approvals/${encodeURIComponent(request.id)}`,
        { ...answer, language: workspace.language },
      );
      setRequests((old) => old.filter((a) => a.id !== request.id));
      await product.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  if (!requests.length && !error) return null;
  return (
    <div
      className="approval-requests"
      role="region"
      aria-label={t("Pending requests")}
    >
      {requests.map((request) =>
        request.kind === "question" ? (
          <QuestionRequest
            key={request.id}
            request={request}
            member={
              workspace.members.find((m) => m.id === request.memberId)?.name
            }
            busy={!!busy}
            onSend={(answer) => void send(request, answer)}
          />
        ) : (
          <section
            className="approval-request"
            key={request.id}
            aria-label={t("Approval required")}
          >
            <div className="approval-heading">
              <strong>{t("Approval required")}</strong>
              <span>
                {workspace.members.find((m) => m.id === request.memberId)?.name}
              </span>
            </div>
            <span>
              {t(
                (
                  {
                    "item/commandExecution/requestApproval": "Run command",
                    "item/fileChange/requestApproval": "Edit file",
                    "item/permissions/requestApproval": "Execution permissions",
                    Bash: "Run command",
                    Write: "Edit file",
                    Edit: "Edit file",
                    team_write_file: "Edit file",
                    team_edit_file: "Edit file",
                    team_set_member_permissions: "Change member permissions",
                  } as Record<string, string>
                )[request.tool] ?? request.tool,
              )}
            </span>
            {request.memberChange ? (
              <div className="approval-member-change">
                <p>
                  {t(request.memberChange.current)} →{" "}
                  {t(request.memberChange.requested)}
                </p>
                <p>{request.memberChange.reason}</p>
                {request.details && (
                  <pre>{approvalDetails(request.details)}</pre>
                )}
                <small>
                  {t(
                    "Applies to future executions. Running turns keep their permissions.",
                  )}
                </small>
              </div>
            ) : (
              <pre>{approvalDetails(request.details)}</pre>
            )}
            <div className="approval-actions">
              {[false, true].map((accepted) => (
                <button
                  key={String(accepted)}
                  className={accepted ? "primary-button" : "secondary-button"}
                  disabled={!!busy}
                  onClick={() => void send(request, { accepted })}
                >
                  {t(
                    accepted
                      ? request.kind === "member-permissions"
                        ? "Approve change"
                        : "Allow once"
                      : "Decline",
                  )}
                </button>
              ))}
            </div>
          </section>
        ),
      )}
      {error && (
        <p role="alert" className="form-error">
          {t(error)}
          <button className="text-button" onClick={() => reload((n) => n + 1)}>
            {t("Retry")}
          </button>
        </p>
      )}
    </div>
  );
}
