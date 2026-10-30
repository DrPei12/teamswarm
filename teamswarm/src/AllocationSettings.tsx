import { permissionsForAccess, permissionsForHarness } from "./permissions";
import { FieldSelect } from "./FieldSelect";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  Check,
  Download,
  LoaderCircle,
  Pencil,
  Plus,
  RotateCcw,
  Trash2,
  Upload,
} from "lucide-react";
import type {
  ExecutionResource,
  ResourceSelection,
} from "@team/contracts/allocation";
import { harnessManifest } from "@team/contracts/harness-catalog";
import type { ExecutionConfig, Work } from "@team/contracts/runtime";
import type { Workspace } from "./store";
import { ApiError, api, product } from "./service";
import { useI18n } from "./i18n";
import { ModelPicker } from "./ModelPicker";
import { HarnessInstallation } from "./HarnessInstallation";
import { HarnessAccount, hasSubscription } from "./HarnessAccount";
import {
  useHarnessCatalog,
  supportedEfforts,
  effortLabel,
  type HarnessInspection,
} from "./harnessCatalog.ts";
import {
  allocationMessage,
  availabilityFacts,
  availabilityStatus,
  configFields,
  effectiveSelection,
  isCustomProvider,
  previewPackage,
  reservedResourceId,
  resourceFor,
  resourceIssues,
  type HarnessObservation,
  type PackagePreview,
  type ServerPackagePreview,
} from "./allocation";

const issueLabels: Record<string, string> = {
  incompatible_protocol: "Protocol not supported by this harness",
  unknown_harness: "Unknown harness",
  missing_configuration: "Missing model, endpoint or credential reference",
  unsupported_context_window:
    "This Harness does not accept a context window override",
  unsupported_output_budget:
    "This Harness does not accept an output token budget",
  unsupported_effort: "This harness does not support an explicit effort",
  unsupported_thinking_format: "Thinking format requires Pi chat completions",
};

const statusLabels: Record<string, string> = {
  not_checked: "Not checked",
  available: "Execution access observed",
  not_installed: "Not installed",
  missing_credentials: "Missing credentials",
  incompatible: "Incompatible",
  unavailable: "Unavailable",
  stale: "Stale",
};

export function AllocationSettings({
  teamId,
  workspace,
  assignmentsOnly = false,
}: {
  teamId: string;
  workspace: Workspace;
  assignmentsOnly?: boolean;
}) {
  const { t } = useI18n();
  const [resources, setResources] = useState<ExecutionResource[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [editing, setEditing] = useState<ExecutionResource | "new" | null>(
    null,
  );
  const [observations, setObservations] = useState<
    Record<string, HarnessObservation>
  >({});
  const [checking, setChecking] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const result = assignmentsOnly
        ? await api<{ resources: ExecutionResource[] }>(
            `/teams/${teamId}/resources?enabled=true`,
          )
        : await product.resources(teamId);
      setResources(result.resources);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [teamId, assignmentsOnly]);

  useEffect(() => {
    void load();
  }, [load]);

  const check = useCallback(async () => {
    setChecking(true);
    setError("");
    const harnesses = [...new Set(resources.map((r) => r.config.harness))];
    const entries = await Promise.all(
      harnesses.map(async (id) => {
        try {
          const result = await api<HarnessObservation>(
            `/harnesses/${encodeURIComponent(id)}/check`,
            {},
          );
          return [id, result] as const;
        } catch (e) {
          return [
            id,
            {
              checkedAt: new Date().toISOString(),
              status: "unavailable",
              error: (e as Error).message,
            } as HarnessObservation,
          ] as const;
        }
      }),
    );
    setObservations(Object.fromEntries(entries));
    setChecking(false);
  }, [resources]);

  const reserved = resources.find((r) => r.id === reservedResourceId);
  const stored = resources.filter(
    (r) => r.id !== reservedResourceId && !r.id.startsWith("cap_"),
  );
  const action = async (run: () => Promise<unknown>, done: string) => {
    setError("");
    setNotice("");
    try {
      await run();
      setNotice(done);
      setEditing(null);
      await load();
    } catch (e) {
      const conflict = e instanceof ApiError && e.code === "version_conflict";
      setError(
        e instanceof ApiError
          ? conflict
            ? allocationMessage("version_changed", e.message)
            : allocationMessage(e.code, e.message)
          : (e as Error).message,
      );
      // A stale optimistic version is a real state change: show the current
      // version instead of leaving the outdated row on screen.
      if (conflict) await load();
    }
  };

  return (
    <div className="allocation-settings">
      {!assignmentsOnly && (
        <section
          className="allocation-section"
          aria-label={t("Execution resources")}
        >
          <header className="allocation-heading">
            <h3>{t("Execution resources")}</h3>
            <div className="allocation-actions">
              <button
                type="button"
                className="secondary-button"
                onClick={() => void check()}
                disabled={checking || !resources.length}
              >
                {checking ? (
                  <LoaderCircle size={15} className="spinner" />
                ) : (
                  <RotateCcw size={15} />
                )}{" "}
                {t("Check availability")}
              </button>
              <button
                type="button"
                className="secondary-button"
                onClick={() => void load()}
                disabled={loading}
              >
                {t("Reload")}
              </button>
              <button
                type="button"
                className="primary-button"
                onClick={() => setEditing("new")}
              >
                <Plus size={15} /> {t("Add resource")}
              </button>
            </div>
          </header>

          {loading ? (
            <p role="status">
              <LoaderCircle size={15} className="spinner" /> {t("Loading…")}
            </p>
          ) : (
            <>
              {!stored.length && <p>{t("No additional resources yet.")}</p>}
              <ul className="resource-list">
                {reserved && (
                  <ResourceRow
                    key={reserved.id}
                    resource={reserved}
                    observation={observations[reserved.config.harness]}
                    reserved
                  />
                )}
                {stored.map((resource) => (
                  <ResourceRow
                    key={resource.id}
                    resource={resource}
                    observation={observations[resource.config.harness]}
                    onEdit={() => setEditing(resource)}
                    onDelete={() =>
                      void action(
                        () => product.deleteResource(teamId, resource.id),
                        "Resource removed.",
                      )
                    }
                  />
                ))}
              </ul>
            </>
          )}
        </section>
      )}
      {editing && (
        <ResourceForm
          teamId={teamId}
          resource={editing === "new" ? null : editing}
          onCancel={() => setEditing(null)}
          onSubmit={(input) =>
            action(
              () =>
                editing === "new"
                  ? product.createResource(teamId, input)
                  : product.updateResource(teamId, editing.id, {
                      expectedVersion: editing.version,
                      ...input,
                    }),
              editing === "new" ? "Resource created." : "Resource saved.",
            )
          }
        />
      )}
      <HostAllocation
        teamId={teamId}
        workspace={workspace}
        resources={resources}
      />
      <AllocationBoard
        teamId={teamId}
        workspace={workspace}
        resources={resources}
        onChanged={load}
      />
      {!assignmentsOnly && (
        <PortablePackagePanel
          teamId={teamId}
          resources={stored}
          onImported={load}
        />
      )}
      {notice && (
        <p className="allocation-success" role="status">
          <Check size={15} /> {t(notice)}
        </p>
      )}
      {error && (
        <p className="form-error" role="alert">
          <AlertCircle size={15} /> {t(error)}
        </p>
      )}
    </div>
  );
}

function ResourceRow({
  resource,
  observation,
  reserved = false,
  onEdit,
  onDelete,
}: {
  resource: ExecutionResource;
  observation: HarnessObservation | undefined;
  reserved?: boolean;
  onEdit?: () => void;
  onDelete?: () => void;
}) {
  const { t } = useI18n();
  const issues = resourceIssues(resource.config);
  const custom = isCustomProvider(resource.config);
  const status = availabilityStatus(observation, resource.config);
  const facts = availabilityFacts(observation, resource.config);
  return (
    <li className={`resource-row${reserved ? " reserved" : ""}`}>
      <div className="resource-head">
        <div>
          <strong>{reserved ? t("Team default") : resource.name}</strong>
          <span className="resource-version">
            {t("Version")} {resource.version}
          </span>
        </div>
        <div className="resource-actions">
          <span className={`status-badge ${status}`}>
            {t(statusLabels[status])}
          </span>
          {onEdit && (
            <button type="button" className="text-button" onClick={onEdit}>
              <Pencil size={14} /> {t("Edit")}
            </button>
          )}
          {onDelete && (
            <button type="button" className="text-button" onClick={onDelete}>
              <Trash2 size={14} /> {t("Remove")}
            </button>
          )}
        </div>
      </div>
      {(reserved || resource.description) && (
        <p className="resource-description">
          {reserved ? t("Managed in the Runtime tab.") : resource.description}
        </p>
      )}
      <dl className="resource-config">
        {configFields(resource.config).map((field) => (
          <div key={field.label}>
            <dt>{t(field.label)}</dt>
            <dd>{t(field.value)}</dd>
          </div>
        ))}
      </dl>
      {observation?.checkedAt && (
        <p className="resource-observation">
          {t("Observed at {time}", { time: observation.checkedAt })} ·{" "}
          {t("Runtime entry")}: {t(factLabels.installed[facts.installed])} ·{" "}
          {t("Credentials")}: {t(factLabels.credentials[facts.credentials])}
        </p>
      )}
      {custom && issues.length === 0 && (
        <p className="allocation-hint">
          {t(
            "This connection uses its own endpoint and credential reference. It is configured, but a request through it has not been verified.",
          )}
        </p>
      )}
      {status === "not_checked" && observation?.checkedAt && !custom && (
        <p className="allocation-hint">
          {t("Execution access has not been verified.")}
        </p>
      )}
      {status === "available" && (
        <p className="allocation-hint">
          {t(
            "An execution entry point is available. Model access and usage limits have not been checked.",
          )}
        </p>
      )}
      {issues.length > 0 && (
        <ul className="resource-issues">
          {issues.map((issue) => (
            <li key={issue}>
              <AlertCircle size={13} /> {t(issueLabels[issue] ?? issue)}
            </li>
          ))}
        </ul>
      )}
      {observation?.error && (
        <p className="form-error" role="alert">
          {observation.error}
        </p>
      )}
    </li>
  );
}

const factLabels = {
  installed: {
    observed: "Observed",
    missing: "Not installed",
    unknown: "Not reported",
  },
  credentials: {
    verified: "Verified",
    missing: "Missing credentials",
    unknown: "Not reported",
  },
} as const;

type ResourceInput = {
  name: string;
  description: string;
  config: ExecutionConfig;
};

function ResourceForm({
  teamId,
  resource,
  onCancel,
  onSubmit,
}: {
  teamId: string;
  resource: ExecutionResource | null;
  onCancel: () => void;
  onSubmit: (input: ResourceInput) => Promise<void>;
}) {
  const { t } = useI18n();
  const harnessOptions = useHarnessCatalog((error) =>
    setSaveError(error.message),
  );
  const config = resource?.config;
  const [secret, setSecret] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [harness, setHarness] = useState(config?.harness ?? "codex");
  const [model, setModel] = useState(config?.model ?? "");
  const [provider, setProvider] = useState(config?.provider ?? "");
  const [baseUrl, setBaseUrl] = useState(config?.baseUrl ?? "");
  const [credentialEnv, setCredentialEnv] = useState(
    config?.credentialEnv ?? "",
  );
  const [effort, setEffort] = useState(config?.effort ?? "");
  const [maxOutputTokens, setMaxOutputTokens] = useState(
    config?.maxOutputTokens?.toString() ?? "",
  );
  const [contextWindowTokens, setContextWindowTokens] = useState(
    config?.contextWindowTokens?.toString() ?? "",
  );
  const [access, setAccess] = useState<"read-only" | "workspace-write">(
    config?.access ?? "workspace-write",
  );
  const [protocol, setProtocol] = useState(config?.protocol ?? "");
  const [thinkingFormat, setThinkingFormat] = useState(
    config?.thinkingFormat === "qwen",
  );
  const [name, setName] = useState(resource?.name ?? "");
  const [description, setDescription] = useState(resource?.description ?? "");
  const [inspection, setInspection] = useState<HarnessInspection | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [catalogError, setCatalogError] = useState("");
  const [catalogRevision, refreshCatalog] = useState(0);
  const [apiMode, setApiMode] = useState(
    !!(config?.baseUrl || config?.credentialEnv),
  );
  const subscriptionMode =
    (harness === "codex" || hasSubscription(harness)) &&
    !apiMode &&
    !baseUrl &&
    !credentialEnv;
  useEffect(() => {
    let live = true;
    setInspection(null);
    setInspecting(true);
    setCatalogError("");
    void api<HarnessInspection>(
      `/harnesses/${encodeURIComponent(harness)}/check`,
      {},
    )
      .then((value) => {
        if (live) setInspection(value);
      })
      .catch((error) => {
        if (live) setCatalogError(error.message);
      })
      .finally(() => {
        if (live) setInspecting(false);
      });
    return () => {
      live = false;
    };
  }, [harness, catalogRevision]);
  return (
    <form
      className="resource-form"
      onSubmit={async (event) => {
        event.preventDefault();
        if (saving) return;
        setSaving(true);
        setSaveError("");
        try {
          let reference = credentialEnv.trim() || null;
          if (!subscriptionMode && secret.trim()) {
            const result = await api<{ reference: string }>(
              `/product/teams/${teamId}/credential`,
              { secret: secret.trim() },
              "PUT",
            );
            reference = result.reference;
            setCredentialEnv(reference);
            setSecret("");
          }
          await onSubmit({
            name: name.trim(),
            description: description.trim(),
            config: {
              ...config,
              permissions: permissionsForAccess(
                {
                  harness,
                  access,
                  permissions: permissionsForHarness(config, harness),
                },
                access,
              ),
              harness,
              model: model.trim() || null,
              provider: provider.trim() || null,
              baseUrl: baseUrl.trim() || null,
              credentialEnv: reference,
              chatgptAccountId:
                !apiMode && harness === config?.harness
                  ? (config?.chatgptAccountId ?? null)
                  : null,
              effort: effort.trim() || null,
              access,
              protocol: (protocol || null) as ExecutionConfig["protocol"],
              thinkingFormat: thinkingFormat ? "qwen" : null,
              ...(harnessManifest(harness)?.models.outputBudget
                ? {
                    contextWindowTokens: contextWindowTokens.trim()
                      ? Number(contextWindowTokens)
                      : null,
                    maxOutputTokens: maxOutputTokens.trim()
                      ? Number(maxOutputTokens)
                      : null,
                  }
                : { contextWindowTokens: null, maxOutputTokens: null }),
            },
          });
        } catch (error) {
          setSaveError((error as Error).message);
        } finally {
          setSaving(false);
        }
      }}
    >
      <h3>{t(resource ? "Edit resource" : "Add resource")}</h3>
      <div className="form-pair">
        <label>
          {t("Name")}
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
            maxLength={100}
          />
        </label>
        <label>
          {t("Harness")}
          <FieldSelect
            value={harness}
            onValueChange={(value) => {
              setHarness(value);
              setMaxOutputTokens("");
              setContextWindowTokens("");
              setModel("");
              setEffort("");
              setProvider("");
              setBaseUrl("");
              setCredentialEnv("");
              setSecret("");
              setProtocol("");
              setThinkingFormat(false);
              setApiMode(false);
            }}
          >
            {harnessOptions.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </FieldSelect>
        </label>
      </div>
      <label>
        {t("Description")}
        <input
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          maxLength={2000}
        />
      </label>
      <HarnessInstallation
        key={harness}
        harness={harness}
        onInstalled={() => refreshCatalog((value) => value + 1)}
      />
      {(harness === "codex" || hasSubscription(harness)) && (
        <div
          className="account-mode"
          role="group"
          aria-label={t("Connection method")}
        >
          <button
            type="button"
            aria-pressed={subscriptionMode}
            onClick={() => {
              if (subscriptionMode) return;
              setApiMode(false);
              setProvider("");
              setBaseUrl("");
              setCredentialEnv("");
              setProtocol("");
              setThinkingFormat(false);
              setModel("");
              setEffort("");
            }}
          >
            {t("Subscription sign-in")}
          </button>
          {
            <button
              type="button"
              aria-pressed={!subscriptionMode}
              onClick={() => {
                if (!subscriptionMode) return;
                setModel("");
                setEffort("");
                setApiMode(true);
              }}
            >
              {t("API connection")}
            </button>
          }
        </div>
      )}
      <div className="form-pair">
        <div className="model-field">
          {t("Model")}
          <ModelPicker
            key={harness}
            value={model || null}
            models={
              !subscriptionMode
                ? model
                  ? [
                      {
                        model,
                        name: model,
                        provider: provider || "Custom provider",
                      },
                    ]
                  : []
                : inspection?.models
            }
            onChange={(value) => {
              setModel(value || "");
              setEffort("");
            }}
            loading={inspecting}
            error={catalogError}
          />
        </div>
        {!subscriptionMode && (
          <label>
            {t("Provider name")}
            <input
              value={provider}
              onChange={(event) => setProvider(event.target.value)}
              maxLength={100}
            />
          </label>
        )}
      </div>
      {subscriptionMode && hasSubscription(harness) && (
        <HarnessAccount
          key={"account:" + harness}
          harness={harness}
          model={model || null}
          revision={catalogRevision}
          onChanged={() => refreshCatalog((v) => v + 1)}
        />
      )}
      <div className="form-pair">
        {!subscriptionMode && (
          <label>
            {t("Protocol")}
            <FieldSelect
              value={protocol}
              onValueChange={(value) => setProtocol(value)}
            >
              <option value="">{t("Default")}</option>
              <option value="responses">Responses</option>
              <option value="chat-completions">Chat Completions</option>
              <option value="anthropic-messages">Anthropic Messages</option>
            </FieldSelect>
          </label>
        )}
        <label>
          {t("Effort")}
          {subscriptionMode ? (
            <FieldSelect
              value={effort}
              onValueChange={(value) => setEffort(value)}
            >
              <option value="">{t("Default")}</option>
              {supportedEfforts(inspection, model).map((option) => (
                <option
                  key={option.reasoningEffort}
                  value={option.reasoningEffort}
                >
                  {effortLabel(option.reasoningEffort)}
                </option>
              ))}
            </FieldSelect>
          ) : (
            <input
              value={effort}
              onChange={(event) => setEffort(event.target.value)}
              maxLength={64}
            />
          )}
          {!subscriptionMode && harness === "codex" && !effort && (
            <small>
              {t(
                "Without an explicit effort, Codex API access uses None and does not inherit subscription settings.",
              )}
            </small>
          )}
        </label>
      </div>
      {!subscriptionMode && (
        <>
          <div className="form-pair">
            <label>
              {t("API endpoint")}
              <input
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
                type="url"
                placeholder="https://api.openai.com/v1"
              />
            </label>
            <label>
              {t("Credential reference")}
              <input
                value={credentialEnv}
                onChange={(event) => setCredentialEnv(event.target.value)}
                placeholder="OPENAI_API_KEY"
                spellCheck={false}
              />
            </label>
          </div>
          <label>
            {t("API key")}
            <input
              type="password"
              autoComplete="new-password"
              value={secret}
              onChange={(event) => setSecret(event.target.value)}
              placeholder={t("Leave blank to keep the saved credential")}
              minLength={8}
              maxLength={16000}
            />
            <small>
              {t(
                "Stored securely on this device. Host can select this connection without seeing its API key.",
              )}
            </small>
          </label>
        </>
      )}
      {harnessManifest(harness)?.models.outputBudget && (
        <div className="form-pair">
          <label>
            {t("Context window tokens")}
            <input
              type="number"
              min={1024}
              max={2097152}
              step={1}
              value={contextWindowTokens}
              onChange={(event) => setContextWindowTokens(event.target.value)}
              placeholder="131072"
            />
          </label>
          <label>
            {t("Maximum output tokens")}
            <input
              type="number"
              min={1}
              max={131072}
              step={1}
              value={maxOutputTokens}
              onChange={(event) => setMaxOutputTokens(event.target.value)}
              placeholder="8192"
            />
          </label>
        </div>
      )}
      {saveError && (
        <p className="form-error" role="alert">
          {t(saveError)}
        </p>
      )}
      <div className="form-pair">
        <label>
          {t("Access")}
          <FieldSelect
            value={access}
            onValueChange={(value) =>
              setAccess(value as "read-only" | "workspace-write")
            }
          >
            <option value="workspace-write">
              {t("Project read and write")}
            </option>
            <option value="read-only">{t("Read only")}</option>
          </FieldSelect>
        </label>
      </div>
      {harness === "pi" && (
        <label className="resource-checkbox">
          <input
            type="checkbox"
            checked={thinkingFormat}
            onChange={(event) => setThinkingFormat(event.target.checked)}
          />
          {t("Pi Thinking format (qwen)")}
        </label>
      )}
      <div className="form-footer">
        <button type="button" className="secondary-button" onClick={onCancel}>
          {t("Cancel")}
        </button>
        <button className="primary-button" disabled={saving}>
          {saving ? t("Saving…") : t("Save")}
        </button>
      </div>
    </form>
  );
}

function HostAllocation({
  teamId,
  workspace,
  resources,
}: {
  teamId: string;
  workspace: Workspace;
  resources: ExecutionResource[];
}) {
  const { t } = useI18n();
  const team = workspace.teams.find((item) => item.id === teamId);
  const branchId =
    workspace.chats.find((chat) => chat.id === team?.lastChatId)?.branchId ??
    workspace.projectBranches?.find(
      (branch) => branch.teamId === teamId && !branch.baseNodeId,
    )?.id;
  const [value, setValue] = useState<{
    allocationRevision: number;
    selection: ResourceSelection | null;
    selectionCurrent: boolean;
  } | null>(null);
  const [selected, setSelected] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const endpoint = `/teams/${teamId}/branches/${branchId}/host-allocation`;
  const load = useCallback(async () => {
    if (!branchId) return;
    try {
      const next = await api<NonNullable<typeof value>>(endpoint);
      setValue(next);
      setSelected(next.selection?.resourceId ?? "");
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }, [branchId, endpoint]);
  useEffect(() => {
    setValue(null);
    void load();
  }, [load, resources]);
  if (!branchId) return null;
  return (
    <section
      className="allocation-section"
      aria-label={t("Host execution resource")}
    >
      <h3>{t("Host execution resource")}</h3>
      <p className="allocation-note">
        {t(
          "Applies to the Host's next turn in this branch. Other branches and running work keep their selections.",
        )}
      </p>
      {value && !value.selectionCurrent && (
        <p className="form-error" role="alert">
          {t(
            "The selected resource changed. Select its current version or return to Team default.",
          )}
        </p>
      )}
      {error && (
        <p className="form-error" role="alert">
          {t(error)}
        </p>
      )}
      <div className="allocation-picker">
        <FieldSelect
          aria-label={t("Host execution resource")}
          value={selected}
          onValueChange={(value) => setSelected(value)}
          disabled={busy || !value}
        >
          <option value="">{t("Team default")}</option>
          {resources
            .filter((resource) => resource.id !== reservedResourceId)
            .map((resource) => (
              <option key={resource.id} value={resource.id}>
                {resource.name} · {resource.config.harness} ·{" "}
                {resource.config.model ?? t("Choose model")}
              </option>
            ))}
        </FieldSelect>
        <button
          className="secondary-button"
          disabled={busy || !value}
          onClick={async () => {
            if (!value) return;
            setBusy(true);
            setError("");
            try {
              const resource = resources.find((item) => item.id === selected);
              await api(
                endpoint,
                {
                  expectedRevision: value.allocationRevision,
                  selection: resource
                    ? {
                        resourceId: resource.id,
                        resourceVersion: resource.version,
                        reason: "Selected by user",
                      }
                    : null,
                },
                "PUT",
              );
              await load();
              await product.refresh();
            } catch (e) {
              if (e instanceof ApiError && e.code === "version_conflict") {
                await load();
                setError(
                  "Host selection changed. The current choice has been loaded; select a resource and apply again.",
                );
              } else setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {t("Apply")}
        </button>
      </div>
    </section>
  );
}

type MemberAllocationView = {
  id: string;
  name: string;
  harness: string;
  status: string;
  selection?: ResourceSelection;
  allocationVersion?: number;
};

const workPriority: Record<string, number> = {
  running: 0,
  stopping: 1,
  recovery_required: 2,
  queued: 3,
  waiting: 4,
  yielded: 5,
  failed: 6,
  interrupted: 7,
  submitted: 8,
  self_checked: 9,
  accepted: 10,
  rejected: 11,
  superseded: 12,
};

function AllocationBoard({
  teamId,
  workspace,
  resources,
  onChanged,
}: {
  teamId: string;
  workspace: Workspace;
  resources: ExecutionResource[];
  onChanged: () => Promise<void>;
}) {
  const { t } = useI18n();
  const [overrides, setOverrides] = useState<
    Record<
      string,
      {
        selection?: ResourceSelection;
        allocationVersion?: number;
        known?: boolean;
      }
    >
  >({});
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [rowError, setRowError] = useState<Record<string, string>>({});
  const [busyRow, setBusyRow] = useState("");
  const members = workspace.members.filter(
    (member) =>
      member.teamId === teamId &&
      member.id !== `host:${teamId}` &&
      !member.removedAt,
  ) as unknown as MemberAllocationView[];
  const works = useMemo(() => {
    const list: Work[] = workspace.executions?.[teamId]?.works ?? [];
    return [...list]
      .filter((work) =>
        workspace.members.some(
          (member) =>
            member.teamId === teamId &&
            member.id === work.memberId &&
            !member.removedAt,
        ),
      )
      .sort(
        (left, right) =>
          (workPriority[left.status] ?? 20) -
            (workPriority[right.status] ?? 20) ||
          right.updatedAt.localeCompare(left.updatedAt),
      )
      .slice(0, 20);
  }, [workspace, teamId]);
  const memberIds = members.map((member) => member.id).join(",");
  const [loaded, setLoaded] = useState(false);
  const [reloadCount, setReloadCount] = useState(0);
  const [readState, setReadState] = useState<
    "loading" | "ready" | "unavailable"
  >("loading");
  useEffect(() => {
    if (!memberIds) {
      setLoaded(true);
      setReadState("ready");
      return;
    }
    let current = true;
    setReadState("loading");
    void Promise.all(
      memberIds.split(",").map(async (memberId) => {
        try {
          const result = await product.memberAllocation(teamId, memberId);
          return [
            memberId,
            {
              selection: result.selection ?? undefined,
              allocationVersion: result.allocationVersion,
              known: true,
            },
            true,
          ] as const;
        } catch {
          // Unknown, not a fabricated default: never invent a member resource.
          return [memberId, { known: false }, false] as const;
        }
      }),
    ).then((entries) => {
      if (!current) return;
      setOverrides((state) => ({
        ...state,
        ...Object.fromEntries(entries.map(([id, value]) => [id, value])),
      }));
      setReadState(
        entries.every((entry) => entry[2]) ? "ready" : "unavailable",
      );
      setLoaded(true);
    });
    return () => {
      current = false;
    };
  }, [teamId, memberIds, reloadCount]);

  const assign = async (
    rowKey: string,
    run: (selection: ResourceSelection) => Promise<unknown>,
    reason: string,
    onResult?: (result: unknown) => void,
  ) => {
    const resource = resources.find((item) => item.id === draft[rowKey]);
    setRowError((state) => ({ ...state, [rowKey]: "" }));
    if (!resource) return;
    setBusyRow(rowKey);
    try {
      const result = await run({
        resourceId: resource.id,
        resourceVersion: resource.version,
        reason,
      });
      onResult?.(result);
      await onChanged();
    } catch (e) {
      setRowError((state) => ({
        ...state,
        [rowKey]:
          e instanceof ApiError
            ? allocationMessage(e.code, e.message)
            : (e as Error).message,
      }));
      if (e instanceof ApiError && e.code === "version_conflict") {
        // Show the revision the server actually holds instead of the stale one.
        setReloadCount((value) => value + 1);
        await onChanged();
      }
    } finally {
      setBusyRow("");
    }
  };

  const memberDefault = (member: MemberAllocationView) =>
    overrides[member.id]?.selection ?? member.selection ?? null;
  const memberDefaultKnown = (member: MemberAllocationView) =>
    overrides[member.id]?.known === true;

  return (
    <section
      className="allocation-section"
      aria-label={t("Member and task allocation")}
    >
      <h3>{t("Member and task allocation")}</h3>
      <p className="allocation-note">
        {t(
          "A member default seeds future work; a task selection pins one work and always wins.",
        )}
      </p>
      {!resources.length ? (
        <p>{t("Add a resource before assigning it.")}</p>
      ) : (
        <>
          <h4>{t("Member defaults")}</h4>
          {readState === "unavailable" && (
            <p className="allocation-hint">
              {t(
                "The member's default resource could not be loaded. Reload to try again.",
              )}
            </p>
          )}
          {!members.length ? (
            <p>{t("No members yet.")}</p>
          ) : (
            <ul className="allocation-list">
              {members.map((member) => {
                const selection = memberDefault(member);
                const resource = resourceFor(resources, selection);
                const revision =
                  overrides[member.id]?.allocationVersion ??
                  member.allocationVersion;
                const rowKey = `member:${member.id}`;
                return (
                  <li key={member.id}>
                    <div className="allocation-row">
                      <div>
                        <strong>{member.name}</strong>
                        <small>
                          {member.harness} ·{" "}
                          {selection
                            ? `${resource?.name ?? selection.resourceId} · ${t("Version")} ${selection.resourceVersion}`
                            : t("No resource selected")}
                        </small>
                        <span className="scope-tag member-default">
                          {t("Member default")}
                        </span>
                      </div>
                      <div className="allocation-picker">
                        <FieldSelect
                          value={draft[rowKey] ?? ""}
                          onValueChange={(value) =>
                            setDraft((state) => ({
                              ...state,
                              [rowKey]: value,
                            }))
                          }
                          aria-label={t("Set member default")}
                        >
                          <option value="">{t("Choose resource")}</option>
                          {resources.map((item) => (
                            <option key={item.id} value={item.id}>
                              {item.name} · {t("Version")} {item.version}
                            </option>
                          ))}
                        </FieldSelect>
                        <button
                          type="button"
                          className="secondary-button"
                          disabled={busyRow === rowKey || !draft[rowKey]}
                          onClick={() =>
                            void assign(
                              rowKey,
                              (value) =>
                                product.setMemberAllocation(teamId, member.id, {
                                  expectedRevision: revision ?? 1,
                                  selection: value,
                                }),
                              `Member default set for ${member.name}`,
                              (result) => {
                                const updated = result as {
                                  selection?: ResourceSelection;
                                  allocationVersion?: number;
                                };
                                setOverrides((state) => ({
                                  ...state,
                                  [member.id]: {
                                    selection: updated.selection,
                                    allocationVersion:
                                      updated.allocationVersion,
                                    known: true,
                                  },
                                }));
                                setReadState("ready");
                              },
                            )
                          }
                        >
                          {busyRow === rowKey ? (
                            <LoaderCircle size={14} className="spinner" />
                          ) : (
                            <Check size={14} />
                          )}{" "}
                          {t("Apply")}
                        </button>
                      </div>
                    </div>
                    {!loaded ? (
                      <p className="allocation-hint">
                        <LoaderCircle size={13} className="spinner" />{" "}
                        {t("Loading…")}
                      </p>
                    ) : (
                      revision === undefined && (
                        <p className="allocation-hint">
                          {t(
                            "The server did not report this allocation version; saving may conflict.",
                          )}
                        </p>
                      )
                    )}
                    {loaded && revision !== undefined && (
                      <p className="allocation-hint">
                        {t("Allocation revision {revision}", {
                          revision,
                        })}
                      </p>
                    )}
                    {rowError[rowKey] && (
                      <p className="form-error" role="alert">
                        {t(rowError[rowKey])}
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          <h4>{t("Task resources")}</h4>
          {!works.length ? (
            <p>{t("No work to allocate yet.")}</p>
          ) : (
            <ul className="allocation-list">
              {works.map((work) => {
                const owner = members.find(
                  (member) => member.id === work.memberId,
                );
                const inherited = owner ? memberDefault(owner) : null;
                const inheritedKnown = owner
                  ? memberDefaultKnown(owner)
                  : false;
                const effective = effectiveSelection(
                  inherited,
                  work.selection ?? null,
                );
                const resource = resourceFor(resources, work.selection);
                const effectiveResource = resourceFor(
                  resources,
                  effective.selection,
                );
                const rowKey = `work:${work.id}`;
                return (
                  <li key={work.id}>
                    <div className="allocation-row">
                      <div>
                        <strong>{work.title}</strong>
                        <small>
                          {t(work.status)} · {t("Version")} {work.revision} ·{" "}
                          {work.selection
                            ? `${resource?.name ?? work.selection.resourceId} · ${t("Version")} ${work.selection.resourceVersion}`
                            : t("No task resource")}
                        </small>
                        <span className={`scope-tag ${effective.scope}`}>
                          {effective.scope === "task"
                            ? t("Task priority")
                            : inheritedKnown
                              ? t("Inherited from member default")
                              : t("Member default unknown")}
                          {effectiveResource
                            ? ` · ${effectiveResource.name}`
                            : ""}
                        </span>
                      </div>
                      <div className="allocation-picker">
                        <FieldSelect
                          value={draft[rowKey] ?? ""}
                          onValueChange={(value) =>
                            setDraft((state) => ({
                              ...state,
                              [rowKey]: value,
                            }))
                          }
                          aria-label={t("Set task resource")}
                        >
                          <option value="">{t("Choose resource")}</option>
                          {resources.map((item) => (
                            <option key={item.id} value={item.id}>
                              {item.name} · {t("Version")} {item.version}
                            </option>
                          ))}
                        </FieldSelect>
                        <button
                          type="button"
                          className="secondary-button"
                          disabled={busyRow === rowKey || !draft[rowKey]}
                          onClick={() =>
                            void assign(
                              rowKey,
                              (value) =>
                                product.setWorkAllocation(teamId, work.id, {
                                  expectedRevision: work.revision,
                                  selection: value,
                                }),
                              `Task resource set for ${work.title}`,
                            )
                          }
                        >
                          {busyRow === rowKey ? (
                            <LoaderCircle size={14} className="spinner" />
                          ) : (
                            <Check size={14} />
                          )}{" "}
                          {t("Apply")}
                        </button>
                      </div>
                    </div>
                    {rowError[rowKey] && (
                      <p className="form-error" role="alert">
                        {t(rowError[rowKey])}
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

function downloadJson(value: unknown, name: string) {
  const blob = new Blob([JSON.stringify(value, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function PortablePackagePanel({
  teamId,
  resources,
  onImported,
}: {
  teamId: string;
  resources: ExecutionResource[];
  onImported: () => Promise<void>;
}) {
  const { t } = useI18n();
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<PackagePreview | null>(null);
  const [serverPreview, setServerPreview] =
    useState<ServerPackagePreview | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [serverNote, setServerNote] = useState("");

  const failure = (e: unknown) =>
    e instanceof ApiError
      ? { code: e.code, status: e.status, message: e.message }
      : { code: "request_failed", status: 0, message: (e as Error).message };

  const exportPackage = async () => {
    setBusy("export");
    setError("");
    setNotice("");
    setServerNote("");
    try {
      const portablePackage = await product.exportPortablePackage(teamId);
      downloadJson(portablePackage, "teamswarm-execution-resources.json");
      setNotice("Package exported.");
    } catch (e) {
      const result = failure(e);
      setError(allocationMessage(result.code, result.message));
    } finally {
      setBusy("");
    }
  };

  const inspect = async (raw: string) => {
    setError("");
    setNotice("");
    setServerNote("");
    setServerPreview(null);
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      setPreview(null);
      setError("The file is not valid JSON.");
      return;
    }
    const local = previewPackage(value, resources);
    setPreview(local);
    try {
      const result = await product.previewPortableImport(teamId, value);
      setServerPreview(result);
      setServerNote(result.ok ? t("Server pre-check passed.") : "");
    } catch (e) {
      const result = failure(e);
      setServerNote(
        `${t("Server pre-check failed.")} ${t(allocationMessage(result.code, result.message))}`,
      );
    }
  };

  const runImport = async () => {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      setPreview(null);
      setError("The file is not valid JSON.");
      return;
    }
    // The local check only labels the shape; the server endpoint is authoritative
    // and reports the real result, so a rejection is never fabricated here.
    setPreview(previewPackage(value, resources));
    setBusy("import");
    setError("");
    setNotice("");
    try {
      await product.importPortablePackage(teamId, value);
      setNotice("Package imported.");
      setText("");
      setPreview(null);
      setServerPreview(null);
      setServerNote("");
      await onImported();
    } catch (e) {
      const result = failure(e);
      setError(allocationMessage(result.code, result.message));
    } finally {
      setBusy("");
    }
  };

  return (
    <section className="allocation-section" aria-label={t("Portable package")}>
      <h3>{t("Portable package")}</h3>
      <p className="allocation-note">
        {t(
          "Versioned JSON with the endpoint, model and Harness combinations. It carries credential references only, never secrets or local paths.",
        )}
      </p>
      <div className="allocation-actions">
        <button
          type="button"
          className="secondary-button"
          onClick={() => void exportPackage()}
          disabled={busy === "export"}
        >
          {busy === "export" ? (
            <LoaderCircle size={15} className="spinner" />
          ) : (
            <Download size={15} />
          )}{" "}
          {t("Export package")}
        </button>
        <label className="secondary-button file-button">
          <Upload size={15} />
          {t("Choose package file")}
          <input
            type="file"
            accept="application/json,.json"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (!file) return;
              void file
                .text()
                .then((content) => {
                  setText(content);
                  void inspect(content);
                })
                .catch(() => setError("The file could not be read."));
              event.target.value = "";
            }}
          />
        </label>
      </div>
      <label className="package-input">
        {t("Paste a package to preview")}
        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          rows={4}
          spellCheck={false}
          placeholder='{"format":"teamswarm-execution-resources","version":1,"resources":[],"selections":[]}'
        />
      </label>
      <div className="allocation-actions">
        <button
          type="button"
          className="secondary-button"
          onClick={() => void inspect(text)}
          disabled={!text.trim()}
        >
          {t("Preview package")}
        </button>
        <button
          type="button"
          className="primary-button"
          onClick={() => void runImport()}
          disabled={!text.trim() || busy === "import"}
        >
          {busy === "import" ? (
            <LoaderCircle size={15} className="spinner" />
          ) : (
            <Upload size={15} />
          )}{" "}
          {t("Import package")}
        </button>
      </div>
      {serverNote && <p className="allocation-hint">{serverNote}</p>}
      {preview && (
        <div className={`package-preview ${preview.ok ? "ok" : "invalid"}`}>
          <p role="status">
            {preview.ok ? <Check size={15} /> : <AlertCircle size={15} />}{" "}
            {preview.ok
              ? t("Local pre-check passed.")
              : t("Local pre-check failed.")}
          </p>
          {preview.errors.length > 0 && (
            <ul className="resource-issues">
              {preview.errors.map((entry, index) => (
                <li key={`${entry.path}:${index}`}>
                  <AlertCircle size={13} />{" "}
                  {t(issueLabels[entry.code] ?? entry.code)} · {entry.path}
                </li>
              ))}
            </ul>
          )}
          {preview.plan.length > 0 && (
            <ul className="package-plan">
              {preview.plan.map((entry) => (
                <li key={entry.id}>
                  {t(entry.kind)} · {entry.id} · {t("Version")} {entry.version}
                </li>
              ))}
            </ul>
          )}
          {preview.conflicts.length > 0 && (
            <p className="form-error" role="alert">
              <AlertCircle size={14} /> {t("Conflicts")}:{" "}
              {preview.conflicts
                .map((entry) => `${t(entry.kind)} ${entry.id}`)
                .join(", ")}
            </p>
          )}
          <p className="allocation-hint">
            {t(
              "All configurations will be checked again before importing. They will only be saved if every check passes.",
            )}
          </p>
        </div>
      )}
      {serverPreview && (
        <div
          className={`package-preview ${serverPreview.ok && !serverPreview.conflicts.length ? "ok" : "invalid"}`}
        >
          <p role="status">
            {serverPreview.ok && !serverPreview.conflicts.length ? (
              <Check size={15} />
            ) : (
              <AlertCircle size={15} />
            )}{" "}
            {serverPreview.ok && !serverPreview.conflicts.length
              ? t("Server pre-check passed.")
              : t("Server pre-check rejected the package")}
          </p>
          {serverPreview.errors.length > 0 && (
            <ul className="resource-issues">
              {serverPreview.errors.map((entry, index) => (
                <li key={`server-error:${index}`}>
                  <AlertCircle size={13} /> {entry}
                </li>
              ))}
            </ul>
          )}
          {serverPreview.conflicts.length > 0 && (
            <p className="form-error" role="alert">
              <AlertCircle size={14} /> {t("Conflicts")}:{" "}
              {serverPreview.conflicts.map((code) => t(code)).join("、")}
            </p>
          )}
          {serverPreview.plan.length > 0 && (
            <ul className="package-plan">
              {serverPreview.plan.map((entry) => (
                <li key={`server-plan:${entry.id}`}>
                  {t(entry.action)} · {entry.id} · {t("Version")}{" "}
                  {entry.fromVersion} → {entry.toVersion}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {notice && (
        <p className="allocation-success" role="status">
          <Check size={15} /> {t(notice)}
        </p>
      )}
      {error && (
        <p className="form-error" role="alert">
          <AlertCircle size={15} /> {t(error)}
        </p>
      )}
    </section>
  );
}
