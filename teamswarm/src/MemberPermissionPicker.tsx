import { useEffect, useRef, useState } from "react";
import { DropdownMenu } from "radix-ui";
import { ShieldCheck, ChevronDown, Check } from "lucide-react";
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
  const [open, setOpen] = useState(false);
  const lock = useRef(false);
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
  const choices = [
    ...(includeDefault
      ? [
          {
            id: "team-default",
            label: defaultLabel
              ? t("Team default: {permission}", { permission: t(defaultLabel) })
              : t("Team default"),
            help: "",
          },
        ]
      : []),
    ...(options?.options ?? []).map((option) => ({
      ...option,
      label: t(option.label),
      help: t(
        option.id === "full-access"
          ? "Read and write files across the device and run system commands."
          : "Read files without changing them.",
      ),
    })),
  ];
  const selected = choices.find((option) => option.id === value);
  const save = async (next: MemberPermissionPreset | "team-default") => {
    if (lock.current) return;
    lock.current = true;
    setSaving(true);
    setError("");
    try {
      await onChange(next);
      setFeedback(!!running);
      setOpen(false);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      lock.current = false;
      setSaving(false);
    }
  };
  return (
    <>
      <DropdownMenu.Root
        modal={false}
        open={open}
        onOpenChange={(next) => {
          if (!saving) setOpen(next);
        }}
      >
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            className={
              compact
                ? "runtime-choice member-permission-choice"
                : "field-select member-permission-field"
            }
            aria-label={t("Member permission strategy")}
            disabled={disabled || saving || !options}
            aria-busy={saving || undefined}
          >
            <ShieldCheck size={16} aria-hidden />
            <span>{selected?.label ?? t("Custom permissions")}</span>
            <ChevronDown size={14} aria-hidden />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            className="runtime-popover member-permission-menu"
            side={compact ? "top" : "bottom"}
            align="start"
            sideOffset={6}
            collisionPadding={12}
          >
            <DropdownMenu.Label className="menu-heading">
              {t("Member permission strategy")}
            </DropdownMenu.Label>
            <DropdownMenu.Separator className="separator" />
            <DropdownMenu.RadioGroup
              value={value}
              onValueChange={(next) =>
                void save(next as MemberPermissionPreset | "team-default")
              }
            >
              {choices.map((option) => (
                <DropdownMenu.RadioItem
                  key={option.id}
                  value={option.id}
                  className="menu-item member-permission-option"
                  disabled={saving}
                  onSelect={(e) => e.preventDefault()}
                >
                  <span className="item-label">
                    <span>{option.label}</span>
                    {option.help && <small>{option.help}</small>}
                  </span>
                  <DropdownMenu.ItemIndicator>
                    <Check size={15} />
                  </DropdownMenu.ItemIndicator>
                </DropdownMenu.RadioItem>
              ))}
            </DropdownMenu.RadioGroup>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
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
