import { useState } from "react";
import type { ExecutionConfig } from "@team/contracts/runtime";
import type { MemberPermissionPreset } from "@team/contracts/allocation";
import type { Team, Workspace } from "./store";
import { defaultRuntime } from "./store";
import { Modal } from "./ui";
import { RuntimeControls } from "./ComposerTools";
import { product } from "./service";
import { useI18n } from "./i18n";
import {
  MemberPermissionPicker,
  type MemberPermissionOptions,
} from "./MemberPermissionPicker";
import { harnessId, harnessLabel } from "./harnessCatalog";

export function NewMemberDialog({
  team,
  workspace,
  onClose,
  onSettings,
}: {
  team: Team;
  workspace: Workspace;
  onClose: () => void;
  onSettings: (tab?: "harnesses" | "connections" | "runtime") => void;
}) {
  const { t } = useI18n();
  const [execution, setExecution] = useState<ExecutionConfig | undefined>(
    workspace.executions?.[team.id]?.host?.config ??
      workspace.executions?.[team.id]?.settings?.config,
  );
  const config = execution
    ? {
        harness: harnessLabel(execution.harness),
        model: execution.model ?? "",
        effort: execution.effort ?? "Default",
      }
    : defaultRuntime;
  const [preset, setPreset] = useState<MemberPermissionPreset | "team-default">(
    "team-default",
  );
  const [policy, setPolicy] = useState<MemberPermissionOptions>();
  const [refresh, setRefresh] = useState(0);
  const [busy, setBusy] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [error, setError] = useState("");
  return (
    <Modal
      open
      onOpenChange={(value) => {
        if (!value && !busy) onClose();
      }}
      title={t("Add member")}
    >
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (busy || resolving || !execution || !policy) return;
          const form = new FormData(event.currentTarget);
          setBusy(true);
          setError("");
          try {
            await product.addMember(
              team.id,
              String(form.get("name")).trim(),
              String(form.get("responsibility")).trim(),
              config,
              crypto.randomUUID(),
              {
                executionConfig: execution,
                permissionPreset: preset,
                expectedPolicyVersion: policy.version,
              },
            );
            onClose();
          } catch (error) {
            setError((error as Error).message);
            if ((error as { code?: string }).code === "version_conflict") {
              setPolicy(undefined);
              setRefresh((value) => value + 1);
            }
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="form-body">
          <label>
            {t("Name")}
            <input
              autoFocus
              name="name"
              placeholder={t("Member name")}
              maxLength={60}
              required
              disabled={busy}
            />
          </label>
          <label>
            {t("Responsibility")}
            <input
              name="responsibility"
              placeholder={t("e.g. Design & typography")}
              maxLength={160}
              required
              disabled={busy}
            />
          </label>
          <fieldset className="new-member-runtime">
            <legend>{t("Execution configuration")}</legend>
            <RuntimeControls
              team={team}
              config={config}
              executionConfig={execution}
              showContext={false}
              showPermissions={false}
              disabled={busy || !execution}
              onSettings={onSettings}
              onChange={async (next, choice) => {
                if (!execution) return;
                setResolving(true);
                try {
                  const resolved = await product.resolveMemberConfiguration(
                    team.id,
                    execution,
                    next,
                    choice,
                  );
                  if (harnessId(next.harness) !== harnessId(config.harness)) {
                    setPreset("team-default");
                    setPolicy(undefined);
                  }
                  setExecution(resolved);
                } finally {
                  setResolving(false);
                }
              }}
            />
          </fieldset>
          <div className="new-member-permissions">
            <span>{t("Member permission strategy")}</span>
            <MemberPermissionPicker
              teamId={team.id}
              harness={config.harness}
              value={preset}
              includeDefault
              disabled={busy || resolving}
              onChange={(value) => setPreset(value)}
              onOptions={setPolicy}
              refreshKey={refresh}
            />
            <small>
              {t(
                "Review tasks run read-only; the member can use its saved permissions for other work.",
              )}
            </small>
          </div>
          {error && (
            <p role="alert" className="form-error">
              {t(error)}
            </p>
          )}
        </div>
        <div className="form-footer">
          <button
            type="button"
            className="secondary-button"
            disabled={busy}
            onClick={onClose}
          >
            {t("Cancel")}
          </button>
          <button
            className="primary-button"
            disabled={busy || resolving || !execution || !policy}
          >
            {t(busy ? "Adding…" : "Add member")}
          </button>
        </div>
      </form>
    </Modal>
  );
}
