import { useState } from "react";
import { LoaderCircle } from "lucide-react";
import { apiEffortPolicy } from "@team/contracts/model-effort";
import type { TeamExecution } from "@team/contracts/product";
import type { ExecutionConfig } from "@team/contracts/runtime";
import { FieldSelect } from "./FieldSelect";
import { ModelPicker } from "./ModelPicker";
import {
  connectionSource,
  selectedModelChoice,
  type ModelChoice,
} from "./modelCatalog";
import {
  hostDirectChoice,
  hostDirectConfig,
  resolveHostModel,
} from "./hostModelCatalog";
import { product, resolveModelConnection } from "./service";
import { useModelCatalog } from "./useModelCatalog";
import { effortChoiceLabel } from "./harnessCatalog";
import { useI18n } from "./i18n";

export function HostModelSettings({
  teamId,
  host,
  onConfigureModels,
}: {
  teamId: string;
  host: NonNullable<TeamExecution["host"]>;
  onConfigureModels: () => void;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<{
    version: number;
    config: ExecutionConfig;
    primaryEdited?: boolean;
    probe?: ExecutionConfig | null;
  }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const current = draft ?? {
    version: host.configurationVersion,
    config: host.config,
    probe: host.hostProbeConfig,
  };
  const { config, probe } = current;
  const catalog = useModelCatalog(teamId, config.harness, true, true);
  const probeModels = catalog.models.filter(hostDirectChoice);
  const choice = selectedModelChoice(catalog.models, config);
  const selectedProbe = probe && selectedModelChoice(probeModels, probe);
  const policy = apiEffortPolicy(config);
  const efforts = [
    ...new Set([
      ...(policy?.supported ??
        choice?.reasoningEfforts?.map((effort) => effort.reasoningEffort) ??
        []),
      ...(config.effort ? [config.effort] : []),
    ]),
  ];
  const update = (value: typeof current) => {
    setSaved(false);
    setDraft(value);
  };
  async function select(
    model: string | null,
    candidate?: ModelChoice,
    forProbe = false,
  ) {
    if (!model || !candidate || busy) return;
    setBusy(true);
    setError("");
    try {
      const next = await resolveHostModel(
        forProbe
          ? { ...config, access: "read-only", permissions: undefined }
          : config,
        model,
        candidate,
        resolveModelConnection,
      );
      update(
        forProbe
          ? { ...current, probe: next }
          : { ...current, config: next, primaryEdited: true },
      );
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      className="execution-form"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!draft || busy) return;
        setBusy(true);
        setSaved(false);
        setError("");
        try {
          await product.saveHostSettings(
            teamId,
            host.branchId,
            draft.version,
            draft.primaryEdited ? config : undefined,
            hostDirectConfig(config) ? probe : undefined,
          );
          setDraft(undefined);
          setSaved(true);
        } catch (reason) {
          setError((reason as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="form-body">
        <h3>{t("Host models")}</h3>
        <div className="form-pair">
          <div className="model-field">
            {t("Primary model")}
            <ModelPicker
              value={config.model}
              models={catalog.models}
              selectedKey={choice?.key}
              ariaLabel={t("Choose primary model")}
              showSource
              loading={catalog.loading}
              error={catalog.error}
              disabled={busy}
              onRetry={catalog.retry}
              onConfigure={onConfigureModels}
              onChange={(model, candidate) => void select(model, candidate)}
            />
            {choice?.connection && (
              <small>{t(connectionSource(choice.connection))}</small>
            )}
          </div>
          <label>
            {t("Effort")}
            <FieldSelect
              aria-label={t("Effort")}
              value={config.effort ?? ""}
              disabled={busy || !config.model}
              onValueChange={(effort) =>
                update({
                  ...current,
                  primaryEdited: true,
                  config: { ...config, effort: effort || null },
                })
              }
            >
              {["", ...efforts].map((effort) => (
                <option key={effort} value={effort}>
                  {effortChoiceLabel(effort, policy, t)}
                </option>
              ))}
            </FieldSelect>
          </label>
        </div>
        {hostDirectConfig(config) && (
          <div className="model-field">
            {t("Read-only probe model")}
            <ModelPicker
              value={probe?.model ?? null}
              models={probeModels}
              selectedKey={selectedProbe?.key}
              ariaLabel={t("Choose probe model")}
              showSource
              loading={catalog.loading}
              error={catalog.error}
              disabled={busy}
              onRetry={catalog.retry}
              onConfigure={onConfigureModels}
              onChange={(model, candidate) =>
                void select(model, candidate, true)
              }
            />
            <small>{probe?.model ?? t("Follows the primary model")}</small>
            {probe && (
              <button
                className="text-button"
                type="button"
                disabled={busy}
                onClick={() => update({ ...current, probe: null })}
              >
                {t("Use primary model for probes")}
              </button>
            )}
          </div>
        )}
        {error && (
          <p role="alert" className="form-error">
            {t(error)}
          </p>
        )}
      </div>
      <div className="form-footer">
        {saved && <span role="status">{t("Host models saved.")}</span>}
        {draft && (
          <button
            type="button"
            className="secondary-button"
            disabled={busy}
            onClick={() => {
              setDraft(undefined);
              setError("");
            }}
          >
            {t("Reset changes")}
          </button>
        )}
        <button
          type="submit"
          className="primary-button"
          disabled={!draft || busy}
        >
          {busy && <LoaderCircle size={16} className="spinner" />}
          {t("Save Host models")}
        </button>
      </div>
    </form>
  );
}
