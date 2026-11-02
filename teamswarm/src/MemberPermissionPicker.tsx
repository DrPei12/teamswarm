import { useEffect, useState } from "react";
import { ShieldCheck, ChevronDown } from "lucide-react";
import type { MemberPermissionPreset } from "@team/contracts/allocation";
import type { ExecutionConfig } from "@team/contracts/runtime";
import { api } from "./service";
import { permissionMode } from "./permissions";
import { harnessId } from "./harnessCatalog";
import { useI18n } from "./i18n";

export type MemberPermissionOptions = {
  version: number;
  policy: "request" | "autonomous";
  defaultPreset: MemberPermissionPreset;
  options: { id: MemberPermissionPreset; label: string }[];
};
export const currentMemberPreset = (
  config: ExecutionConfig,
): MemberPermissionPreset =>
  config.access === "read-only"
    ? "read-only"
    : (permissionMode(config) as MemberPermissionPreset) || "workspace-write";

export function MemberPermissionPicker({
  teamId,
  harness,
  value,
  onChange,
  disabled,
  compact,
  running,
  includeDefault,
  refreshKey = 0,
  onOptions,
}: {
  teamId: string;
  harness: string;
  value: MemberPermissionPreset | "team-default";
  onChange: (
    preset: MemberPermissionPreset | "team-default",
  ) => Promise<unknown> | void;
  disabled?: boolean;
  compact?: boolean;
  running?: boolean;
  includeDefault?: boolean;
  refreshKey?: number;
  onOptions?: (options: MemberPermissionOptions) => void;
}) {
  const { t } = useI18n();
  const [options, setOptions] = useState<MemberPermissionOptions | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState(false);
  const [revision, setRevision] = useState(0);
  const id = harnessId(harness);
  useEffect(() => {
    let active = true;
    setOptions(null);
    setError("");
    void api<MemberPermissionOptions>(
      `/product/teams/${encodeURIComponent(teamId)}/member-permission-options?harness=${encodeURIComponent(id)}`,
    )
      .then((result) => {
        if (active) {
          setOptions(result);
          onOptions?.(result);
        }
      })
      .catch((e) => {
        if (active) setError((e as Error).message);
      });
    return () => {
      active = false;
    };
  }, [teamId, id, revision, refreshKey, onOptions]);
  useEffect(() => {
    if (!running) setFeedback(false);
  }, [running]);
  const defaultLabel = options?.options.find(
    (o) => o.id === options.defaultPreset,
  )?.label;
  return (
    <>
      <label
        className={
          compact
            ? "runtime-choice member-permission-choice"
            : "member-permission-field"
        }
      >
        {compact && <ShieldCheck size={15} aria-hidden />}
        <select
          aria-label={t("Member permission strategy")}
          disabled={disabled || saving || !options}
          value={value}
          onChange={async (e) => {
            const next = e.target.value as
              MemberPermissionPreset | "team-default";
            if (saving) return;
            setSaving(true);
            setError("");
            try {
              await onChange(next);
              setFeedback(!!running);
            } catch (error) {
              setError((error as Error).message);
            } finally {
              setSaving(false);
            }
          }}
        >
          {includeDefault && (
            <option value="team-default">
              {defaultLabel
                ? t("Team default: {permission}", {
                    permission: t(defaultLabel),
                  })
                : t("Team default")}
            </option>
          )}
          {!includeDefault && !options?.options.some((o) => o.id === value) && (
            <option value={value}>{t("Custom permissions")}</option>
          )}
          {options?.options.map((option) => (
            <option value={option.id} key={option.id}>
              {t(option.label)}
            </option>
          ))}
        </select>
        {compact && <ChevronDown size={14} aria-hidden />}
      </label>
      {feedback && (
        <span className="runtime-pending" role="status">
          {t("Applies next turn")}
        </span>
      )}
      {error && (
        <span className="form-error" role="alert">
          {t(error)}{" "}
          <button
            type="button"
            className="text-button"
            onClick={() => setRevision((v) => v + 1)}
          >
            {t("Retry")}
          </button>
        </span>
      )}
    </>
  );
}
