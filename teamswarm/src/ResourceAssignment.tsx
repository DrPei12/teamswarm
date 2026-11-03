import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { DropdownMenu } from "radix-ui";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronRight,
  Trash2,
} from "lucide-react";
import type {
  ExecutionResource,
  ResourceSelection,
} from "@team/contracts/allocation";
import {
  allocationMessage,
  reservedResourceId,
  resourceFor,
} from "./allocation";
import { harnessLabel, effortLabel } from "./harnessCatalog";
import { useI18n } from "./i18n";
import { ApiError, product } from "./service";

function resourceSummary(resource: ExecutionResource) {
  return [
    harnessLabel(resource.config.harness),
    resource.config.model,
    resource.config.effort && effortLabel(resource.config.effort),
  ]
    .filter(Boolean)
    .join(" · ");
}

function ResourcePicker({
  resources,
  caption,
  label,
  disabled,
  host,
  onChoose,
}: {
  resources: ExecutionResource[];
  caption: string;
  label: string;
  disabled: boolean;
  host: boolean;
  onChoose: (resource: ExecutionResource | null) => void;
}) {
  const { t } = useI18n();
  const [harness, setHarness] = useState<string | null>(null);
  // A default model (null) is a valid group, distinct from no group yet.
  const [model, setModel] = useState<string | null | undefined>(undefined);
  const menu = useRef<HTMLDivElement>(null);
  const standard = resources.find((r) => r.id === reservedResourceId);
  const choices = resources.filter((r) => r.id !== reservedResourceId);
  const harnesses = [...new Set(choices.map((r) => r.config.harness))].sort(
    (a, b) => harnessLabel(a).localeCompare(harnessLabel(b)),
  );
  const group = choices.filter((r) => r.config.harness === harness);
  const models = [...new Set(group.map((r) => r.config.model ?? null))].sort(
    (a, b) => (a ?? "").localeCompare(b ?? ""),
  );
  const step =
    model !== undefined
      ? t("Choose configuration")
      : harness
        ? t("Choose model")
        : t("Choose harness");
  function back() {
    if (model !== undefined) setModel(undefined);
    else setHarness(null);
  }
  useLayoutEffect(() => {
    menu.current
      ?.querySelector<HTMLElement>("[data-resource-choice]")
      ?.focus({ preventScroll: true });
    if (menu.current) menu.current.scrollTop = 0;
  }, [harness, model]);
  return (
    <DropdownMenu.Root
      modal={false}
      onOpenChange={(open) => {
        if (open) {
          setHarness(null);
          setModel(undefined);
        }
      }}
    >
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className="field-select allocation-resource-trigger"
          aria-label={label}
          disabled={disabled}
        >
          <span>{caption}</span>
          <ChevronDown size={16} aria-hidden />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          ref={menu}
          className="menu allocation-resource-menu"
          align="start"
          sideOffset={6}
          collisionPadding={12}
          aria-label={step}
          onEscapeKeyDown={(event) => {
            if (harness) {
              event.preventDefault();
              back();
            }
          }}
          onKeyDown={(event) => {
            if (harness && event.key === "ArrowLeft") {
              event.preventDefault();
              back();
            }
          }}
        >
          {harness && (
            <DropdownMenu.Item
              className="menu-item"
              onSelect={(event) => {
                event.preventDefault();
                back();
              }}
            >
              <ArrowLeft size={15} />
              {model !== undefined
                ? model || t("Default model")
                : harnessLabel(harness)}
            </DropdownMenu.Item>
          )}
          <DropdownMenu.Label className="menu-heading">
            {step}
          </DropdownMenu.Label>
          {!harness && (
            <>
              {(host || standard) && (
                <>
                  <DropdownMenu.Item
                    className="menu-item"
                    onSelect={() => onChoose(host ? null : standard!)}
                  >
                    {t("Team default")}
                  </DropdownMenu.Item>
                  <DropdownMenu.Separator className="separator" />
                </>
              )}
              {harnesses.map((id) => (
                <DropdownMenu.Item
                  key={id}
                  data-resource-choice
                  className="menu-item catalog-level"
                  onSelect={(event) => {
                    event.preventDefault();
                    setHarness(id);
                  }}
                >
                  <span>{harnessLabel(id)}</span>
                  <ChevronRight size={15} />
                </DropdownMenu.Item>
              ))}
            </>
          )}
          {harness &&
            model === undefined &&
            models.map((id) => {
              const variants = group.filter(
                (r) => (r.config.model ?? null) === id,
              );
              return (
                <DropdownMenu.Item
                  key={JSON.stringify(id)}
                  data-resource-choice
                  className="menu-item catalog-level"
                  onSelect={(event) => {
                    if (variants.length === 1) onChoose(variants[0]);
                    else {
                      event.preventDefault();
                      setModel(id);
                    }
                  }}
                >
                  <span>{id || t("Default model")}</span>
                  {variants.length > 1 && <ChevronRight size={15} />}
                </DropdownMenu.Item>
              );
            })}
          {harness &&
            model !== undefined &&
            group
              .filter((r) => (r.config.model ?? null) === model)
              .map((r) => (
                <DropdownMenu.Item
                  key={r.id}
                  data-resource-choice
                  className="menu-item"
                  onSelect={() => onChoose(r)}
                >
                  {r.name}
                </DropdownMenu.Item>
              ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export function ResourceAssignment({
  resources,
  selection,
  inherited,
  revision,
  label,
  resetLabel,
  host = false,
  disabled = false,
  onSave,
  onReload,
  children,
}: {
  resources: ExecutionResource[];
  selection: ResourceSelection | null;
  inherited?: ResourceSelection | null;
  revision: number;
  label: string;
  resetLabel: string;
  host?: boolean;
  disabled?: boolean;
  onSave: (
    value: ResourceSelection | null,
    revision: number,
  ) => Promise<unknown>;
  onReload: () => Promise<void>;
  children?: (pending: boolean) => ReactNode;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<{
    selection: ResourceSelection | null;
    revision: number;
  } | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const lock = useRef(false);
  const selected = draft ? draft.selection : selection;
  const resource = resourceFor(resources, selected);
  const detailSelection = selected ?? inherited;
  const detailResource = resourceFor(resources, detailSelection);
  const display = (r: ExecutionResource) =>
    r.id === reservedResourceId ? t("Team default") : resourceSummary(r);
  const caption = resource
    ? display(resource)
    : selected
      ? t("Resource unavailable")
      : draft && host
        ? t("Team default")
        : t("Choose resource");
  const choose = (r: ExecutionResource | null) => {
    setError("");
    setDraft({
      selection: r
        ? {
            resourceId: r.id,
            resourceVersion: r.version,
            reason: "Selected by user",
          }
        : null,
      revision,
    });
  };
  async function save(value: ResourceSelection | null, expected: number) {
    if (lock.current) return;
    lock.current = true;
    setSaving(true);
    setError("");
    try {
      await onSave(value, expected);
      setDraft(null);
    } catch (e) {
      setError(
        e instanceof ApiError
          ? allocationMessage(e.code, e.message)
          : (e as Error).message,
      );
      if (e instanceof ApiError && e.code === "version_conflict") {
        setDraft(null);
        await Promise.allSettled([onReload(), product.refresh()]);
      }
    } finally {
      lock.current = false;
      setSaving(false);
    }
  }
  return (
    <div className="allocation-assignment">
      <div className="allocation-picker">
        <ResourcePicker
          resources={resources}
          caption={caption}
          label={label}
          disabled={saving || disabled}
          host={host}
          onChoose={choose}
        />
        <button
          type="button"
          className="secondary-button"
          disabled={!draft || saving || disabled}
          onClick={() => draft && void save(draft.selection, draft.revision)}
        >
          <Check size={15} />
          {t("Apply")}
        </button>
      </div>
      <div className="allocation-row-actions">
        {detailSelection && (
          <details className="allocation-details">
            <summary>{t("Configuration details")}</summary>
            <p>{detailResource?.name ?? t("Resource unavailable")}</p>
            <p>
              {t("Resource version")} {detailSelection.resourceVersion}
            </p>
            {detailResource &&
              detailResource.version !== detailSelection.resourceVersion && (
                <p>
                  {t("Current version")} {detailResource.version}
                </p>
              )}
          </details>
        )}
        {draft && (
          <button
            className="text-button"
            type="button"
            disabled={saving}
            onClick={() => {
              setDraft(null);
              setError("");
            }}
          >
            {t("Cancel")}
          </button>
        )}
        {selection && (
          <button
            className="text-button"
            type="button"
            disabled={saving || disabled}
            onClick={() => void save(null, revision)}
          >
            <Trash2 size={14} />
            {resetLabel}
          </button>
        )}
        {children?.(!!draft || saving)}
      </div>
      {error && (
        <p className="form-error" role="alert">
          {t(error)}
        </p>
      )}
    </div>
  );
}
