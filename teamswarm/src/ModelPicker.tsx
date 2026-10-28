import { useEffect, useId, useRef, useState } from "react";
import { Popover } from "radix-ui";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronRight,
  Search,
} from "lucide-react";
import { useI18n } from "./i18n";
import type { ModelChoice } from "./modelCatalog";

type Model = ModelChoice;
export function modelProvider(model: Model) {
  if (model.provider) return model.provider;
  // Model identity, not harness identity, determines the provider.
  const id = model.model.toLowerCase();
  if (/^(gpt-|o[134](?:-|$))/.test(id)) return "OpenAI";
  if (/^claude[-.]/.test(id)) return "Anthropic";
  if (/^gemini[-.]/.test(id)) return "Google";
  if (/^grok[-.]/.test(id)) return "xAI";
  if (/^deepseek[-.]/.test(id)) return "DeepSeek";
  if (/^qwen[\d.-]/.test(id)) return "Qwen";
  return "Other providers";
}

export function ModelPicker({
  value,
  models = [],
  onChange,
  loading,
  error,
  compact = false,
  disabled = false,
  onOpenChange,
  label,
  selectedKey,
  open: controlledOpen,
  onConfigure,
  onCloseAutoFocus,
  onRetry,
}: {
  value: string | null;
  models?: Model[];
  onChange: (value: string | null, choice?: Model) => void;
  loading?: boolean;
  error?: string;
  compact?: boolean;
  disabled?: boolean;
  onOpenChange?: (open: boolean) => void;
  label?: string;
  selectedKey?: string;
  open?: boolean;
  onConfigure?: () => void;
  onCloseAutoFocus?: (event: Event) => void;
  onRetry?: () => void;
}) {
  const { t } = useI18n();
  const [internalOpen, setOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const [provider, setProvider] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [custom, setCustom] = useState(false);
  const [customId, setCustomId] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const configuring = useRef(false);
  const labelId = useId();
  const catalog = [
    ...new Map(
      models.map((model) => [model.key ?? model.model, model]),
    ).values(),
  ];
  const groups = [...new Set(catalog.map(modelProvider))].sort();
  const filtered = catalog.filter(
    (model) =>
      (!provider || modelProvider(model) === provider) &&
      `${model.name} ${model.model} ${model.detail ?? ""}`
        .toLowerCase()
        .includes(query.trim().toLowerCase()),
  );
  const select = (next: string | null, choice?: Model) => {
    onChange(next, choice);
    changeOpen(false);
  };
  const changeOpen = (next: boolean) => {
    setOpen(next);
    if (next) {
      configuring.current = false;
      setProvider(null);
      setQuery("");
      setCustom(false);
      setCustomId("");
    }
    onOpenChange?.(next);
  };
  useEffect(() => {
    if (open) input.current?.focus({ preventScroll: true });
  }, [provider, custom, open]);
  return (
    <Popover.Root open={open} onOpenChange={changeOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          disabled={disabled}
          className={
            compact
              ? "runtime-choice model-picker-trigger compact"
              : "model-picker-trigger"
          }
          aria-label={label || t("Choose model")}
        >
          <span>
            {label ||
              catalog.find((model) => model.model === value)?.name ||
              value ||
              t("Choose model")}
          </span>
          <ChevronDown size={14} />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className="model-picker-popover"
          side={compact ? "top" : "bottom"}
          align="start"
          sideOffset={6}
          collisionPadding={12}
          aria-labelledby={labelId}
          onInteractOutside={(event) => {
            if (
              compact &&
              (event.target as Element).closest?.(".runtime-choice")
            )
              event.preventDefault();
          }}
          onCloseAutoFocus={(event) => {
            if (configuring.current) event.preventDefault();
            onCloseAutoFocus?.(event);
          }}
          onEscapeKeyDown={(event) => {
            if (provider || custom) {
              event.preventDefault();
              setProvider(null);
              setCustom(false);
              setQuery("");
            }
          }}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            input.current?.focus({ preventScroll: true });
          }}
          onKeyDown={(event) => {
            if (
              ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) &&
              !custom
            ) {
              const buttons = [
                ...(list.current?.querySelectorAll<HTMLButtonElement>(
                  "button:not(:disabled)",
                ) ?? []),
              ];
              if (!buttons.length) return;
              const current = buttons.indexOf(
                document.activeElement as HTMLButtonElement,
              );
              if ((event.key === "Home" || event.key === "End") && current < 0)
                return;
              event.preventDefault();
              const index =
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? buttons.length - 1
                    : (current +
                        (event.key === "ArrowDown" ? 1 : -1) +
                        buttons.length) %
                      buttons.length;
              buttons[index]?.focus();
            }
          }}
        >
          <div className="model-picker-heading">
            {(provider || custom) && (
              <button
                type="button"
                className="icon-button"
                aria-label={t("Back to providers")}
                onClick={() => {
                  setProvider(null);
                  setCustom(false);
                  setQuery("");
                }}
              >
                <ArrowLeft size={15} />
              </button>
            )}
            <strong id={labelId}>
              {custom
                ? t("Custom model")
                : provider
                  ? t(provider)
                  : t("Model providers")}
            </strong>
          </div>
          {custom ? (
            <div className="model-picker-custom">
              <p>
                {t("Enter the model ID supplied by your connection provider.")}
              </p>
              <input
                ref={input}
                aria-label={t("Model ID")}
                value={customId}
                maxLength={200}
                onChange={(event) => setCustomId(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    event.stopPropagation();
                    if (customId.trim()) select(customId.trim());
                  }
                }}
              />
              <button
                type="button"
                className="secondary-button"
                disabled={!customId.trim()}
                onClick={() => select(customId.trim())}
              >
                {t("Use model")}
              </button>
            </div>
          ) : (
            <>
              <div className="model-picker-search">
                <Search size={15} />
                <input
                  ref={input}
                  value={query}
                  aria-label={t("Search models")}
                  placeholder={t("Search models")}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") event.preventDefault();
                  }}
                />
              </div>
              <div className="model-picker-list" ref={list}>
                {!provider && !query
                  ? groups.map((group) => (
                      <button
                        type="button"
                        key={group}
                        className="model-picker-option"
                        onClick={() => {
                          setProvider(group);
                          setQuery("");
                        }}
                      >
                        <span>{t(group)}</span>
                        <small>
                          {
                            catalog.filter(
                              (model) => modelProvider(model) === group,
                            ).length
                          }
                        </small>
                        <ChevronRight size={14} />
                      </button>
                    ))
                  : filtered.map((model) => (
                      <button
                        type="button"
                        key={model.key ?? model.model}
                        className="model-picker-option"
                        onClick={() => select(model.model, model)}
                        disabled={!!model.unavailable}
                        title={
                          model.unavailable
                            ? t(model.unavailable)
                            : model.detail
                        }
                        aria-pressed={
                          selectedKey
                            ? selectedKey === model.key
                            : value === model.model && !model.unavailable
                        }
                      >
                        <span>
                          {model.name || model.model}
                          {(!provider || model.name !== model.model) && (
                            <small>
                              {!provider ? `${t(modelProvider(model))} · ` : ""}
                              {model.model}
                            </small>
                          )}
                          {model.detail && <small>{model.detail}</small>}
                          {model.unavailable && (
                            <small>{t(model.unavailable)}</small>
                          )}
                        </span>
                        {(selectedKey
                          ? selectedKey === model.key
                          : value === model.model && !model.unavailable) && (
                          <Check size={14} />
                        )}
                      </button>
                    ))}
                {loading && !catalog.length && (
                  <p className="menu-note" role="status">
                    {t("Loading models…")}
                  </p>
                )}
                {error && !loading && (
                  <p className="menu-note" role="alert">
                    {t(error)}
                    {onRetry && (
                      <button
                        type="button"
                        className="model-picker-link"
                        onClick={onRetry}
                      >
                        {t("Retry")}
                      </button>
                    )}
                  </p>
                )}
                {!loading && !error && !filtered.length && (
                  <p className="menu-note">
                    {t(query ? "No matching models" : "No configured models")}
                  </p>
                )}
              </div>
              <div
                className={`model-picker-footer ${onConfigure ? "configuration-link" : ""}`}
              >
                <button
                  type="button"
                  className={onConfigure ? "model-picker-link" : "text-button"}
                  onClick={() => {
                    if (onConfigure) {
                      configuring.current = true;
                      changeOpen(false);
                      onConfigure();
                    } else {
                      setCustom(true);
                      setCustomId("");
                    }
                  }}
                >
                  {t(onConfigure ? "Configure models" : "Enter model ID…")}
                </button>
              </div>
            </>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
