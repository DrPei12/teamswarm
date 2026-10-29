import { useId, useState } from "react";
import { LoaderCircle, RefreshCw, Search } from "lucide-react";
import type { HarnessInspection } from "./harnessCatalog";
import { useI18n } from "./i18n";

export function SubscriptionModelList({
  models,
  selected,
  loading,
  error,
  connected,
  onChange,
  onRefresh,
}: {
  models: NonNullable<HarnessInspection["models"]>;
  selected: string[];
  loading: boolean;
  error: string;
  connected: boolean;
  onChange: (models: string[], all?: boolean) => void;
  onRefresh: () => void;
}) {
  const { t } = useI18n();
  const titleId = useId();
  const [query, setQuery] = useState("");
  const choices = new Map(models.map((model) => [model.model, model]));
  for (const model of selected)
    if (!choices.has(model)) choices.set(model, { model, name: model });
  const rows = [...choices.values()];
  const selectedIds = new Set(selected);
  const allSelected =
    !!rows.length && rows.every((model) => selectedIds.has(model.model));
  const search = query.trim().toLocaleLowerCase();
  const visible = rows.filter((model) =>
    `${model.name} ${model.model}`.toLocaleLowerCase().includes(search),
  );
  return (
    <section
      className="cap-model-section cap-subscription-models"
      aria-labelledby={titleId}
    >
      <div className="cap-model-heading">
        <h4 id={titleId}>{t("Available models")}</h4>
        <button
          type="button"
          className="text-button"
          disabled={!connected || loading}
          onClick={onRefresh}
        >
          {loading ? (
            <LoaderCircle size={13} className="spinner" />
          ) : (
            <RefreshCw size={13} />
          )}
          {t("Refresh models")}
        </button>
      </div>
      <div className="cap-model-list-toolbar">
        <label className="cap-model-search">
          <Search size={14} aria-hidden="true" />
          <input
            type="search"
            aria-label={t("Search models")}
            placeholder={t("Search models")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.preventDefault();
            }}
          />
        </label>
        <label className="cap-model-select-all">
          <input
            type="checkbox"
            checked={allSelected}
            ref={(input) => {
              if (input)
                input.indeterminate = !allSelected && selected.length > 0;
            }}
            disabled={!rows.length}
            onChange={(event) =>
              onChange(
                event.target.checked ? rows.map((model) => model.model) : [],
                event.target.checked,
              )
            }
          />
          <span>{t("Select all")}</span>
        </label>
        <span className="cap-model-count">
          {t("{selected} / {total} selected", {
            selected: selected.length,
            total: rows.length,
          })}
        </span>
      </div>
      {error && (
        <div className="cap-model-error" role="alert">
          {t(error)}
        </div>
      )}
      <div
        className="cap-model-list"
        role="group"
        aria-label={t("Available models")}
        aria-busy={loading}
      >
        {visible.map((model) => (
          <label className="cap-model-row" key={model.model}>
            <input
              type="checkbox"
              checked={selectedIds.has(model.model)}
              onChange={(event) =>
                onChange(
                  event.target.checked
                    ? [...selected, model.model]
                    : selected.filter((id) => id !== model.model),
                )
              }
            />
            <span>
              <strong>{model.name}</strong>
              {model.name !== model.model && <small>{model.model}</small>}
            </span>
          </label>
        ))}
        {!visible.length && (
          <div className="cap-model-list-empty" role="status">
            {t(
              !connected
                ? "Choose an account to view models."
                : loading
                  ? "Loading models…"
                  : search && rows.length
                    ? "No matching models"
                    : error
                      ? "Model list unavailable"
                      : "No models returned",
            )}
          </div>
        )}
      </div>
    </section>
  );
}
