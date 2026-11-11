import { useState } from "react";
import { ListChecks, RotateCcw, X } from "lucide-react";
import type {
  ExecutionResource,
  ResourceSelection,
} from "@team/contracts/allocation";
import type { Member, Workspace } from "@team/contracts/product";
import type { Work } from "@team/contracts/runtime";
import { harnessLabel, effortLabel } from "./harnessCatalog";
import { allocationMessage } from "./allocation";
import { ResourceAssignment } from "./ResourceAssignment";
import { ApiError, product } from "./service";
import { useI18n } from "./i18n";

type Props = {
  teamId: string;
  workspace: Workspace;
  resources: ExecutionResource[];
  onChanged: () => Promise<void>;
};
const retryable = (work: Work) =>
  ["failed", "interrupted", "rejected"].includes(work.status);
function executionName(config: Member["executionConfig"]) {
  return config
    ? [
        harnessLabel(config.harness),
        config.model,
        config.effort && effortLabel(config.effort),
      ]
        .filter(Boolean)
        .join(" · ")
    : "";
}

function TaskRow({
  teamId,
  work,
  owner,
  resources,
  onChanged,
}: Pick<Props, "teamId" | "resources" | "onChanged"> & {
  work: Work;
  owner: Member;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const endpoint =
    "/teams/" +
    encodeURIComponent(teamId) +
    "/works/" +
    encodeURIComponent(work.id);
  async function action(name: "hide" | "restore" | "retry") {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      if (name === "retry")
        await product.command(endpoint + "/retry", {
          expectedRevision: work.revision,
          fromAllocationList: true,
        });
      else
        await product.command(
          endpoint + "/allocation-list",
          { expectedRevision: work.revision, hidden: name === "hide" },
          "PUT",
        );
    } catch (e) {
      setError(
        e instanceof ApiError
          ? allocationMessage(e.code, e.message)
          : (e as Error).message,
      );
      if (e instanceof ApiError && e.code === "version_conflict")
        await product.refresh();
    } finally {
      setBusy(false);
    }
  }
  return (
    <li>
      <div className="allocation-row">
        <div className="allocation-subject">
          <strong>{work.title}</strong>
          <small>
            {owner.name} · {t(work.status)}
          </small>
          {!work.allocationDismissedAt && (
            <span className="scope-tag">
              {work.selection
                ? t("Task-specific configuration")
                : t("Inherited from member default")}
            </span>
          )}
        </div>
        {work.allocationDismissedAt ? (
          <button
            type="button"
            className="secondary-button"
            disabled={busy}
            onClick={() => void action("restore")}
          >
            {t("Restore to list")}
          </button>
        ) : (
          <ResourceAssignment
            resources={resources}
            selection={work.selection ?? null}
            inherited={owner.resourceSelection}
            revision={work.revision}
            label={t("Set task resource")}
            resetLabel={t("Remove task override")}
            disabled={busy}
            onReload={onChanged}
            onSave={(selection, expectedRevision) =>
              product.setWorkAllocation(teamId, work.id, {
                selection,
                expectedRevision,
              })
            }
          >
            {(pending) => (
              <>
                {retryable(work) && (
                  <button
                    type="button"
                    className="text-button"
                    disabled={busy || pending}
                    onClick={() => void action("retry")}
                  >
                    <RotateCcw size={14} />
                    {t("Retry")}
                  </button>
                )}
                <button
                  type="button"
                  className="text-button"
                  disabled={busy || pending}
                  onClick={() => void action("hide")}
                  title={t("Keep this task and its conversation history.")}
                >
                  <X size={14} />
                  {t("Remove from list")}
                </button>
              </>
            )}
          </ResourceAssignment>
        )}
      </div>
      {error && (
        <p role="alert" className="form-error">
          {t(error)}
        </p>
      )}
    </li>
  );
}

export function AllocationBoard({
  teamId,
  workspace,
  resources,
  onChanged,
}: Props) {
  const { t } = useI18n();
  const execution = workspace.executions?.[teamId];
  const host = execution?.host;
  const members = workspace.members.filter(
    (m) => m.teamId === teamId && m.id !== "host:" + teamId && !m.removedAt,
  );
  const owners = new Map(members.map((m) => [m.id, m]));
  const ids = new Set(execution?.allocationTaskIds);
  const tasks =
    execution?.works
      .filter((w) => ids.has(w.id) && owners.has(w.memberId))
      .sort(
        (a, b) =>
          Number(retryable(b)) - Number(retryable(a)) ||
          b.updatedAt.localeCompare(a.updatedAt),
      ) ?? [];
  const visible = tasks.filter((w) => !w.allocationDismissedAt);
  const hidden = tasks.filter((w) => w.allocationDismissedAt);
  const row = (work: Work) => (
    <TaskRow
      key={work.id}
      teamId={teamId}
      work={work}
      owner={owners.get(work.memberId)!}
      resources={resources}
      onChanged={onChanged}
    />
  );
  return (
    <>
      {host && (
        <section
          className="allocation-section"
          aria-label={t("Host execution resource")}
        >
          <h3>{t("Host execution resource")}</h3>
          <p className="allocation-note">
            {t(
              "Applies to the Host's next turn in this branch. Other branches and running work keep their selections.",
            )}
          </p>
          <div className="allocation-row">
            <div className="allocation-subject">
              <strong>{executionName(host.config)}</strong>
              {host.selectionCurrent === false && (
                <small>{t("Reselect resource")}</small>
              )}
            </div>
            <ResourceAssignment
              key={host.branchId}
              resources={resources}
              selection={host.selection ?? null}
              revision={host.configurationVersion}
              label={t("Host execution resource")}
              assignedCaption={t("Change resource")}
              resetLabel={t("Restore Team default")}
              host
              onReload={onChanged}
              onSave={(selection: ResourceSelection | null, expectedRevision) =>
                product.command(
                  "/teams/" +
                    encodeURIComponent(teamId) +
                    "/branches/" +
                    encodeURIComponent(host.branchId) +
                    "/host-allocation",
                  { selection, expectedRevision },
                  "PUT",
                )
              }
            />
          </div>
        </section>
      )}
      <section
        className="allocation-section"
        aria-label={t("Member and task allocation")}
      >
        <h3>{t("Member and task allocation")}</h3>
        <h4>{t("Member defaults")}</h4>
        {!members.length ? (
          <p>{t("No members yet.")}</p>
        ) : (
          <ul className="allocation-list">
            {members.map((member) => (
              <li key={member.id}>
                <div className="allocation-row">
                  <div className="allocation-subject">
                    <strong>{member.name}</strong>
                    <small>{executionName(member.executionConfig)}</small>
                  </div>
                  {member.configurationVersion != null && (
                    <ResourceAssignment
                      resources={resources}
                      selection={member.resourceSelection ?? null}
                      revision={member.configurationVersion}
                      label={t("Set member default")}
                      assignedCaption={t("Change resource")}
                      resetLabel={t("Remove resource assignment")}
                      onReload={onChanged}
                      onSave={(selection, expectedRevision) =>
                        product.setMemberAllocation(teamId, member.id, {
                          selection,
                          expectedRevision,
                        })
                      }
                    />
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
        <section className="task-allocation" aria-label={t("Task resources")}>
          <h4>{t("Task resources")}</h4>
          {!execution?.allocationTaskIds ? (
            <p role="status">{t("Loading…")}</p>
          ) : visible.length ? (
            <ul className="allocation-list">{visible.map(row)}</ul>
          ) : (
            <p className="allocation-empty">
              <ListChecks size={18} aria-hidden />
              {t("No tasks need allocation or retry.")}
            </p>
          )}
          {hidden.length > 0 && (
            <details className="allocation-removed">
              <summary>
                {t("Removed from this list ({count})", {
                  count: hidden.length,
                })}
              </summary>
              <ul className="allocation-list">{hidden.map(row)}</ul>
            </details>
          )}
        </section>
      </section>
    </>
  );
}
