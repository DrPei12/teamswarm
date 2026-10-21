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
import type { HarnessInspection } from "./harnessCatalog";

type Model = NonNullable<HarnessInspection["models"]>[number];
export function modelProvider(model: Model) {
  if (model.provider) return model.provider;
  // Model identity, not harness identity, determines the provider.
  const id = model.model.toLowerCase();
  if (/^(gpt-|o[134](?:-|$))/.test(id)) return "OpenAI";
  if (/^claude[-.]/.test(id)) return "Anthropic";
  if (/^gemini[-.]/.test(id)) return "Google";
  if (/^grok[-.]/.test(id)) return "xAI";
  if (/^deepseek[-.]/.test(id)) return "DeepSeek";
  return "Other providers";
}

export function ModelPicker({
  value,
  models = [],
  onChange,
  loading,
  error,
  compact = false,
  onOpenChange,
  label,
  allowDefault = true,
}: {
  value: string | null;
  models?: Model[];
  onChange: (value: string | null) => void;
  loading?: boolean;
  error?: string;
  compact?: boolean;
  onOpenChange?: (open: boolean) => void;
  label?: string;
  allowDefault?: boolean;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [provider, setProvider] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [custom, setCustom] = useState(false);
  const [customId, setCustomId] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const labelId = useId();
  const catalog = [
    ...new Map(models.map((model) => [model.model, model])).values(),
  ];
  const groups = [...new Set(catalog.map(modelProvider))].sort();
  const filtered = catalog.filter(
    (model) =>
      (!provider || modelProvider(model) === provider) &&
      `${model.name} ${model.model}`
        .toLowerCase()
        .includes(query.trim().toLowerCase()),
  );
  const select = (next: string | null) => {
    onChange(next);
    changeOpen(false);
  };
  const changeOpen = (next: boolean) => {
    setOpen(next);
    if (next) {
      setProvider(null);
      setQuery("");
      setCustom(false);
      setCustomId("");
    }
    onOpenChange?.(next);
  };
  useEffect(() => {
    if (open) input.current?.focus();
  }, [provider, custom, open]);
  return (
    <Popover.Root open={open} onOpenChange={changeOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
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
              t("Default model")}
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
            input.current?.focus();
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
                {allowDefault && !provider && !query && (
                  <button
                    type="button"
                    className="model-picker-option"
                    onClick={() => select(null)}
                  >
                    <span>{t("Default model")}</span>
                    {!value && <Check size={14} />}
                  </button>
                )}
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
                        key={model.model}
                        className="model-picker-option"
                        onClick={() => select(model.model)}
                        aria-pressed={value === model.model}
                      >
                        <span>
                          {model.name || model.model}
                          {(!provider || model.name !== model.model) && (
                            <small>
                              {!provider ? `${t(modelProvider(model))} · ` : ""}
                              {model.model}
                            </small>
                          )}
                        </span>
                        {value === model.model && <Check size={14} />}
                      </button>
                    ))}
                {loading && (
                  <p className="menu-note" role="status">
                    {t("Loading models…")}
                  </p>
                )}
                {error && (
                  <p className="menu-note" role="alert">
                    {t(error)}
                  </p>
                )}
                {!loading && !error && !filtered.length && (
                  <p className="menu-note">
                    {t(
                      query
                        ? "No matching models"
                        : "This harness has not provided a model list. You can enter a model ID.",
                    )}
                  </p>
                )}
              </div>
              <div className="model-picker-footer">
                <button
                  type="button"
                  className="text-button"
                  onClick={() => {
                    setCustom(true);
                    setCustomId("");
                  }}
                >
                  {t("Enter model ID…")}
                </button>
              </div>
            </>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
