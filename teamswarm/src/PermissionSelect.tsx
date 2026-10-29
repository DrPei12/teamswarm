import type { ExecutionConfig } from "@team/contracts/runtime";
import {
  permissionMode,
  permissionsForMode,
  type PermissionMode,
} from "./permissions";
import { FieldSelect } from "./FieldSelect";
import { useI18n } from "./i18n";

export function PermissionSelect({
  config,
  onChange,
  disabled,
  compact = false,
}: {
  config: ExecutionConfig;
  onChange: (policy: ExecutionConfig["permissions"]) => void;
  disabled?: boolean;
  compact?: boolean;
}) {
  const { t } = useI18n();
  if (!["codex", "claude-code"].includes(config.harness)) return null;
  return (
    <FieldSelect
      aria-label={t("Execution permissions")}
      className={compact ? "permission-select compact" : "permission-select"}
      value={permissionMode(config)}
      onValueChange={(v) =>
        onChange(permissionsForMode(config, v as PermissionMode))
      }
      disabled={disabled}
    >
      {!permissionMode(config) && (
        <option value="" disabled>
          {t("Harness default")}
        </option>
      )}
      <option value="manual">{t("Request approval")}</option>
      <option value="auto">{t("Automatic review")}</option>
      <option value="full-access" disabled={config.access === "read-only"}>
        {t("Full access")}
      </option>
      {config.harness === "claude-code" && (
        <option value="accept-edits">{t("Accept edits")}</option>
      )}
    </FieldSelect>
  );
}
