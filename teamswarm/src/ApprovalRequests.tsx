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
  return (
    <>
      {requests.map((request) => (
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
                } as Record<string, string>
              )[request.tool] ?? request.tool,
            )}
          </span>
          <pre>{approvalDetails(request.details)}</pre>
          <div className="approval-actions">
            {[false, true].map((accepted) => (
              <button
                key={String(accepted)}
                className={accepted ? "primary-button" : "secondary-button"}
                disabled={!!busy}
                onClick={async () => {
                  setBusy(request.id);
                  setError("");
                  try {
                    await api(
                      `/teams/${encodeURIComponent(teamId)}/approvals/${encodeURIComponent(request.id)}`,
                      { accepted },
                    );
                    setRequests((old) =>
                      old.filter((a) => a.id !== request.id),
                    );
                    await product.refresh();
                  } catch (e) {
                    setError((e as Error).message);
                  } finally {
                    setBusy(null);
                  }
                }}
              >
                {t(accepted ? "Allow once" : "Decline")}
              </button>
            ))}
          </div>
        </section>
      ))}
      {error && (
        <p role="alert" className="form-error">
          {t(error)}
          <button className="text-button" onClick={() => reload((n) => n + 1)}>
            {t("Retry")}
          </button>
        </p>
      )}
    </>
  );
}
