import { useEffect, useRef, useState } from "react";
import { DropdownMenu } from "radix-ui";
import { Check, ChevronDown, Shield } from "lucide-react";
import type {
  ExecutionConfig,
  NativePermissions,
} from "@team/contracts/runtime";
import { usePermissionOptions } from "./usePermissionOptions";
import { useI18n } from "./i18n";

export function PermissionSelect({
  config,
  onChange,
  disabled,
  compact = false,
  running = false,
  open: controlledOpen,
  onOpenChange,
  onAdvanced,
}: {
  config: ExecutionConfig;
  onChange: (policy: NativePermissions) => unknown | Promise<unknown>;
  disabled?: boolean;
  compact?: boolean;
  running?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onAdvanced?: () => void;
}) {
  const { t } = useI18n();
  const catalog = usePermissionOptions(config.harness);
  const [localOpen, setLocalOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [feedback, setFeedback] = useState("");
  const pending = useRef<NativePermissions | null>(null);
  const mounted = useRef(true);
  const lock = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!feedback) return;
    const timer = setTimeout(() => setFeedback(""), 2800);
    return () => clearTimeout(timer);
  }, [feedback]);
  useEffect(() => {
    pending.current = null;
    setError("");
    setFeedback("");
  }, [config.harness]);
  const setOpen = (value: boolean) => {
    setLocalOpen(value);
    onOpenChange?.(value);
  };
  const choices = catalog.options?.options ?? [];
  const current = config.permissions;
  const selected = current
    ? choices.find(
        (option) =>
          Object.entries(option.permissions).every(
            ([key, value]) =>
              JSON.stringify(
                (current as unknown as Record<string, unknown>)[key],
              ) === JSON.stringify(value),
          ) &&
          !(
            "sandbox" in current &&
            current.sandbox === "danger-full-access" &&
            option.id !== "full-access"
          ),
      )
    : choices.find((option) => option.id === catalog.options?.defaultId);
  const label =
    selected?.label ?? (current ? "Custom permissions" : "Harness settings");
  async function save(policy: NativePermissions) {
    if (lock.current) return;
    lock.current = true;
    pending.current = policy;
    setSaving(true);
    setError("");
    try {
      await onChange(policy);
      if (mounted.current) {
        setOpen(false);
        if (compact)
          setFeedback(
            running ? "Applies to the next execution" : "Permissions saved",
          );
        pending.current = null;
      }
    } catch (e) {
      if (mounted.current) {
        setError(e instanceof Error ? e.message : "Could not save permissions");
        setOpen(true);
      }
    } finally {
      lock.current = false;
      if (mounted.current) setSaving(false);
    }
  }
  return (
    <span className={`permission-control ${compact ? "compact" : ""}`}>
      <DropdownMenu.Root
        modal={false}
        open={controlledOpen ?? localOpen}
        onOpenChange={setOpen}
      >
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            className={`${compact ? "runtime-choice" : "field-select"} permission-select`}
            aria-label={`${t("Execution permissions")}: ${t(label)}`}
            aria-busy={saving || undefined}
            disabled={
              disabled || saving || (!catalog.options && !catalog.error)
            }
            data-full-access={selected?.id === "full-access" || undefined}
          >
            <Shield size={14} aria-hidden="true" />
            <span>{t(label)}</span>
            <ChevronDown size={11} aria-hidden="true" />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            className="runtime-popover permission-menu"
            side={compact ? "top" : "bottom"}
            align="start"
            sideOffset={compact ? 12 : 5}
            collisionPadding={12}
          >
            <DropdownMenu.Label className="menu-heading">
              {t("Execution permissions")}
            </DropdownMenu.Label>
            <DropdownMenu.Separator className="separator" />
            <DropdownMenu.RadioGroup
              value={selected?.id ?? ""}
              onValueChange={(id) => {
                const choice = choices.find((c) => c.id === id);
                if (choice) void save(choice.permissions);
              }}
            >
              {choices.map((option, index) => (
                <span key={option.id} className="permission-option-group">
                  {option.group === "native" &&
                    choices[index - 1]?.group !== "native" && (
                      <DropdownMenu.Separator className="separator" />
                    )}
                  <DropdownMenu.RadioItem
                    className="menu-item permission-option"
                    value={option.id}
                    disabled={
                      saving ||
                      (option.requiresWrite && config.access === "read-only")
                    }
                    title={
                      option.requiresWrite && config.access === "read-only"
                        ? t("Read-only access prevents this permission mode.")
                        : undefined
                    }
                    data-full-access={option.id === "full-access" || undefined}
                    onSelect={(e) => e.preventDefault()}
                  >
                    <span className="item-label">{t(option.label)}</span>
                    <DropdownMenu.ItemIndicator>
                      <Check size={14} />
                    </DropdownMenu.ItemIndicator>
                  </DropdownMenu.RadioItem>
                </span>
              ))}
            </DropdownMenu.RadioGroup>
            {!choices.length && !catalog.error && (
              <div className="menu-note">
                {t(
                  catalog.options
                    ? "Uses this Harness's native settings"
                    : "Permission options unavailable",
                )}
              </div>
            )}
            {(error || catalog.error) && (
              <div className="permission-error" role="alert">
                <span>{t(error || catalog.error)}</span>
                <button
                  type="button"
                  className="model-picker-link"
                  disabled={saving}
                  onClick={() =>
                    pending.current
                      ? void save(pending.current)
                      : catalog.retry()
                  }
                >
                  {t("Retry")}
                </button>
              </div>
            )}
            {onAdvanced && (
              <>
                <DropdownMenu.Separator className="separator" />
                <DropdownMenu.Item
                  className="menu-item permission-settings"
                  onSelect={() => {
                    setOpen(false);
                    onAdvanced();
                  }}
                >
                  {t("Advanced settings")} →
                </DropdownMenu.Item>
              </>
            )}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      {feedback && (
        <span className="permission-feedback" role="status">
          {t(feedback)}
        </span>
      )}
    </span>
  );
}
