import { PermissionSelect } from "./PermissionSelect";
import { permissionsForAccess } from "./permissions";
import { FieldSelect } from "./FieldSelect";
import { Disclosure } from "./Disclosure";
import { useEffect, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  AlertCircle,
  ArrowRight,
  Check,
  ChevronDown,
  LoaderCircle,
  Pause,
  Play,
  RotateCcw,
  Settings2,
} from "lucide-react";
import type { RuntimeSettings } from "@team/contracts/runtime";
import type { Workspace } from "./store";
import { AllocationSettings } from "./AllocationSettings";
import { CapabilitySettings } from "./CapabilitySettings";
import { ModelPicker } from "./ModelPicker";
import { SwarmMark } from "./SwarmMark";
import {
  chooseModel,
  selectedModelChoice,
  switchHarness,
} from "./modelCatalog";
import { useModelCatalog } from "./useModelCatalog";
import { cachedCatalog, invalidateModelCatalog } from "./modelCatalogCache";
import type { TeamCapabilities } from "@team/contracts/allocation";
import { HarnessInstallation } from "./HarnessInstallation";
import { HarnessAccount, hasSubscription } from "./HarnessAccount";
import { api, product, resolveModelConnection } from "./service";
import { useI18n } from "./i18n";
import { Modal } from "./ui";
import { isCustomProvider } from "./allocation";
import {
  supportedEfforts,
  effortLabel,
  type HarnessInspection,
} from "./harnessCatalog";

export function Startup({
  state,
}: {
  state: {
    workspace: Workspace | null;
    loading: boolean;
    error: string;
    connectionError: boolean;
  };
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const create = async (form: HTMLFormElement) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const team = await product.createTeam(
        String(new FormData(form).get("name")).trim(),
      );
      location.hash = `/team/${team.id}/agent`;
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="startup">
      <div className="startup-brand">
        <SwarmMark />
        TeamSwarm
      </div>
      <section className="startup-content" aria-label={t("Workspace")}>
        {state.loading ? (
          <div className="startup-loading" role="status">
            <LoaderCircle className="spinner" size={24} />
            <span>{t("Opening workspace…")}</span>
          </div>
        ) : state.error ? (
          <>
            <h1>
              {t(
                state.connectionError
                  ? "Open your workspace"
                  : "Couldn’t open workspace",
              )}
            </h1>
            <p role="alert">{t(state.error)}</p>
            {state.connectionError && (
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  const code = String(
                    new FormData(e.currentTarget).get("code"),
                  ).trim();
                  location.hash = `connect=${code}`;
                  await product.start();
                }}
              >
                <label>
                  {t("Connection code")}
                  <input
                    name="code"
                    type="password"
                    autoComplete="off"
                    required
                  />
                </label>
                <button className="primary-button">{t("Connect")}</button>
              </form>
            )}
            <button
              className="secondary-button"
              onClick={() => void product.start()}
            >
              {t("Try again")}
            </button>
          </>
        ) : (
          <>
            <h1>{t("Create your first Team")}</h1>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void create(e.currentTarget);
              }}
            >
              <label>
                {t("Team name")}
                <input
                  autoFocus
                  name="name"
                  placeholder={t("e.g. Design")}
                  required
                  maxLength={80}
                  autoComplete="off"
                />
              </label>
              {error && (
                <p role="alert" className="form-error">
                  {t(error)}
                </p>
              )}
              <button className="primary-button" disabled={busy}>
                {busy ? (
                  <LoaderCircle className="spinner" size={17} />
                ) : (
                  <ArrowRight size={17} />
                )}{" "}
                {t("Create team")}
              </button>
            </form>
            <div className="startup-language">
              <button
                onClick={() =>
                  product.update((w) => ({ ...w, language: "en" }))
                }
              >
                English
              </button>
              <span>·</span>
              <button
                onClick={() =>
                  product.update((w) => ({ ...w, language: "zh-CN" }))
                }
              >
                简体中文
              </button>
            </div>
          </>
        )}
      </section>
    </main>
  );
}

type Inspection = HarnessInspection;
type ExecutionSettingsProps = {
  open: boolean;
  onClose: () => void;
  teamId: string;
  workspace: Workspace;
  initialTab?: "harnesses" | "connections" | "runtime";
};
export function ExecutionSettings(props: ExecutionSettingsProps) {
  return props.open ? <ExecutionSettingsContent {...props} /> : null;
}
function ExecutionSettingsContent(props: ExecutionSettingsProps) {
  const [manual, setManual] = useState(props.initialTab === "runtime");
  const [configurationTab, setConfigurationTab] = useState<
    "harnesses" | "connections"
  >(props.initialTab === "connections" ? "connections" : "harnesses");
  return manual ? (
    <ManualExecutionSettings
      {...props}
      onClose={() =>
        props.initialTab === "runtime" ? props.onClose() : setManual(false)
      }
      onConfigureModels={() => {
        setConfigurationTab("connections");
        setManual(false);
      }}
    />
  ) : (
    <CapabilitySettings
      {...props}
      initialTab={configurationTab}
      onAdvanced={() => setManual(true)}
    />
  );
}
function ManualExecutionSettings({
  open,
  onClose,
  teamId,
  workspace,
  onConfigureModels,
}: {
  open: boolean;
  onClose: () => void;
  teamId: string;
  workspace: Workspace;
  onConfigureModels: () => void;
}) {
  const { t } = useI18n();
  const [settings, setSettings] = useState<RuntimeSettings | null>(null),
    [tab, setTab] = useState<"settings" | "resources">("settings"),
    [busy, setBusy] = useState(false),
    [checking, setChecking] = useState(false),
    [error, setError] = useState(""),
    [inspection, setInspection] = useState<Inspection | null>(null);
  const [inspectionRevision, refreshInspection] = useState(0);
  const [advanced, setAdvanced] = useState(false);
  const modelCatalog = useModelCatalog(
    teamId,
    settings?.config.harness ?? "codex",
    open,
  );
  useEffect(() => {
    if (open) {
      setSettings(workspace.executions?.[teamId]?.settings ?? null);
      setTab("settings");
      setError("");
      setInspection(null);
    }
  }, [open, teamId]);
  useEffect(() => {
    if (!open || !settings) return;
    let current = true;
    setChecking(true);
    setError("");
    void cachedCatalog(`harness:${settings.config.harness}`, () =>
      api<Inspection>(
        `/harnesses/${encodeURIComponent(settings.config.harness)}/check`,
        {},
      ),
    )
      .then((value) => {
        if (current) setInspection(value);
      })
      .catch((e) => {
        if (current) setError(e.message);
      })
      .finally(() => {
        if (current) setChecking(false);
      });
    return () => {
      current = false;
    };
  }, [open, settings?.config.harness, inspectionRevision]);
  // A connection with its own endpoint or credential reference is not the native
  // ChatGPT account the harness check probes. Its credential and reasoning-offer
  // facts must come from that configuration, never from an empty native catalog.
  const configuredProvider = isCustomProvider(settings?.config);
  const subscriptionHarness =
    settings?.config.harness === "codex" ||
    hasSubscription(settings?.config.harness ?? "");
  const [apiMode, setApiMode] = useState(false);
  useEffect(() => {
    setApiMode(configuredProvider);
  }, [open, settings?.config.harness, configuredProvider]);
  const customProvider = configuredProvider || apiMode || !subscriptionHarness;
  const subscriptionMode = subscriptionHarness && !customProvider && !apiMode;
  const efforts = supportedEfforts(inspection, settings?.config.model);
  const configuredEffort = settings?.config.effort ?? "";
  const effortChoices = customProvider
    ? configuredEffort
      ? [configuredEffort]
      : []
    : efforts.map((option) => option.reasoningEffort);
  const effortUnavailable =
    !customProvider &&
    !!configuredEffort &&
    !efforts.some((option) => option.reasoningEffort === configuredEffort);
  const customCredential = customProvider && !!settings?.config.credentialEnv;
  const connectionNeedsAction = Boolean(
    inspection &&
    (inspection.available === false ||
      (!customProvider && inspection.authenticated === false) ||
      (customProvider && !settings?.config.credentialEnv)),
  );
  const inspect = () => {
    invalidateModelCatalog();
    refreshInspection((value) => value + 1);
  };
  const [secret, setSecret] = useState("");
  useEffect(() => {
    if (!open) setSecret("");
  }, [open]);
  const [login, setLogin] = useState<{ loginId: string; url: string } | null>(
    null,
  );
  const [catalog, setCatalog] = useState<{ id: string }[]>([]);
  useEffect(() => {
    if (open)
      void api<{ harnesses: { id: string }[] }>("/harnesses")
        .then((r) => setCatalog(r.harnesses))
        .catch((e) => setError(e.message));
  }, [open]);
  useEffect(() => {
    if (!open || !login || settings?.config.harness !== "codex") return;
    let current = true;
    const timer = setInterval(() => {
      void api<Inspection>("/harnesses/codex/check", {})
        .then((result) => {
          if (current && result.authenticated) {
            setInspection(result);
            setLogin(null);
          }
        })
        .catch((e) => current && setError(e.message));
    }, 3000);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [open, login, settings?.config.harness]);
  const signIn = async () => {
    setChecking(true);
    setError("");
    try {
      setLogin(
        await api<{ loginId: string; url: string }>(
          "/product/harnesses/codex/login",
          {},
        ),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setChecking(false);
    }
  };
  const config = (patch: Partial<RuntimeSettings["config"]>) =>
    setSettings((old) =>
      old ? { ...old, config: { ...old.config, ...patch } } : old,
    );
  return (
    <Modal
      open={open}
      onOpenChange={(value) => !value && onClose()}
      title={t("Advanced settings")}
      className="execution-modal"
    >
      <div
        className="modal-tabs"
        role="tablist"
        aria-label={t("Advanced settings")}
      >
        <button
          type="button"
          role="tab"
          aria-selected={tab === "settings"}
          className={tab === "settings" ? "active" : ""}
          onClick={() => setTab("settings")}
        >
          {t("Runtime")}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "resources"}
          className={tab === "resources" ? "active" : ""}
          onClick={() => setTab("resources")}
        >
          {t("Resources and allocation")}
        </button>
      </div>
      {tab === "resources" && (
        <AllocationSettings teamId={teamId} workspace={workspace} />
      )}
      {tab === "settings" && settings && (
        <form
          className="execution-form"
          onSubmit={async (e) => {
            e.preventDefault();
            if (busy) return;
            setBusy(true);
            setError("");
            try {
              let next = settings;
              if (secret.trim()) {
                const result = await api<{ reference: string }>(
                  `/product/teams/${teamId}/credential`,
                  { secret: secret.trim() },
                  "PUT",
                );
                next = {
                  ...settings,
                  config: {
                    ...settings.config,
                    credentialEnv: result.reference,
                  },
                };
                setSettings(next);
                setSecret("");
              }
              await product.saveSettings(teamId, next);
              onClose();
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <div className="form-body">
            <div className="form-pair">
              <label>
                {t("Harness")}
                <FieldSelect
                  value={settings.config.harness}
                  disabled={busy}
                  onValueChange={async (value) => {
                    const harness = value;
                    setBusy(true);
                    setError("");
                    try {
                      const capabilities = await api<TeamCapabilities>(
                        `/teams/${encodeURIComponent(teamId)}/capabilities`,
                      );
                      const next = await switchHarness(
                        settings.config,
                        harness,
                        capabilities.connections,
                        resolveModelConnection,
                      );
                      setInspection(null);
                      setLogin(null);
                      config(next);
                      setSecret("");
                      setApiMode(isCustomProvider(next));
                    } catch (e) {
                      setError((e as Error).message);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  {catalog.map(({ id }) => (
                    <option key={id} value={id}>
                      {(
                        {
                          codex: "Codex",
                          grok: "Grok",
                          "claude-code": "Claude Code",
                          "deepseek-harness": "DeepSeek Harness",
                          opencode: "OpenCode",
                        } as Record<string, string>
                      )[id] ?? id}
                    </option>
                  ))}
                </FieldSelect>
              </label>
              <div className="model-field">
                {t("Model")}
                <ModelPicker
                  value={settings.config.model}
                  models={modelCatalog.models}
                  selectedKey={
                    selectedModelChoice(modelCatalog.models, settings.config)
                      ?.key
                  }
                  onConfigure={onConfigureModels}
                  onRetry={modelCatalog.retry}
                  onChange={async (model, choice) => {
                    setBusy(true);
                    setError("");
                    try {
                      const next = await chooseModel(
                        settings.config,
                        model,
                        choice,
                        resolveModelConnection,
                      );
                      config(next);
                      setSecret("");
                      setApiMode(isCustomProvider(next));
                    } catch (e) {
                      setError((e as Error).message);
                    } finally {
                      setBusy(false);
                    }
                  }}
                  loading={modelCatalog.loading}
                  error={modelCatalog.error}
                />
              </div>
            </div>
            <HarnessInstallation
              key={settings.config.harness}
              harness={settings.config.harness}
              onInstalled={inspect}
            />
            {subscriptionHarness && (
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
                    config({
                      provider: null,
                      baseUrl: null,
                      credentialEnv: null,
                      protocol: null,
                      model: null,
                      effort: null,
                      thinkingFormat: null,
                    });
                    setSecret("");
                    setApiMode(false);
                    setAdvanced(false);
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
                      config({ model: null, effort: null });
                      setApiMode(true);
                      setAdvanced(true);
                    }}
                  >
                    {t("API connection")}
                  </button>
                }
              </div>
            )}
            {subscriptionMode && hasSubscription(settings.config.harness) && (
              <HarnessAccount
                key={"account:" + settings.config.harness}
                harness={settings.config.harness}
                model={settings.config.model}
                revision={inspectionRevision}
                onChanged={inspect}
              />
            )}
            {(!subscriptionMode || settings.config.harness === "codex") && (
              <div className="connection-inspection">
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => void inspect()}
                  disabled={checking}
                >
                  {checking ? (
                    <LoaderCircle size={16} className="spinner" />
                  ) : (
                    <RotateCcw size={16} />
                  )}{" "}
                  {t("Check connection")}
                </button>
                {inspection && (
                  <span
                    className={
                      connectionNeedsAction
                        ? "connection-needs-action"
                        : "connection-ready"
                    }
                  >
                    {connectionNeedsAction ? (
                      <AlertCircle size={16} />
                    ) : (
                      <Check size={16} />
                    )}{" "}
                    {t(
                      inspection.available === false
                        ? "Not installed"
                        : customProvider
                          ? customCredential
                            ? "Configured · request not yet verified"
                            : "Configure the endpoint and credential reference"
                          : inspection.authenticated === false
                            ? "Sign in to your harness"
                            : "Available",
                    )}
                  </span>
                )}
              </div>
            )}
            {inspection?.available === false && (
              <p className="form-error" role="alert">
                {t(
                  "Install the harness on this device, then check the connection again.",
                )}
              </p>
            )}
            {settings.config.harness === "codex" &&
              !customProvider &&
              inspection?.authenticated === false && (
                <div className="harness-login">
                  {login ? (
                    <>
                      <a
                        className="primary-button"
                        href={login.url}
                        target="_blank"
                        rel="noreferrer noopener"
                      >
                        {t("Open sign-in page")}
                      </a>
                      <button
                        type="button"
                        className="text-button"
                        onClick={() =>
                          void api("/product/harnesses/codex/login/cancel", {
                            loginId: login.loginId,
                          })
                            .then(() => setLogin(null))
                            .catch((e) => setError(e.message))
                        }
                      >
                        {t("Cancel")}
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={checking}
                      onClick={() => void signIn()}
                    >
                      {t("Sign in with ChatGPT")}
                    </button>
                  )}
                </div>
              )}
            <div className="directory-field">
              <div className="directory-label">
                <label htmlFor="execution-workspace">
                  {t("Project folder")}
                </label>
                {window.teamswarmDesktop && (
                  <button
                    type="button"
                    className="directory-picker"
                    onClick={async () => {
                      const directory =
                        await window.teamswarmDesktop!.chooseDirectory();
                      if (directory)
                        setSettings({ ...settings, workspace: directory });
                    }}
                  >
                    {t("Browse…")}
                  </button>
                )}
              </div>
              <input
                id="execution-workspace"
                value={settings.workspace}
                onChange={(e) =>
                  setSettings({ ...settings, workspace: e.target.value })
                }
                required
                spellCheck={false}
              />
            </div>
            <div className="form-pair">
              <label>
                {t("Effort")}
                <FieldSelect
                  value={settings.config.effort ?? ""}
                  disabled={!settings.config.model}
                  onValueChange={(value) => config({ effort: value || null })}
                >
                  {settings.config.effort && effortUnavailable && (
                    <option value={settings.config.effort} disabled>
                      {effortLabel(settings.config.effort)} · {t("Unavailable")}
                    </option>
                  )}
                  {["", ...effortChoices].map((v) => (
                    <option key={v} value={v}>
                      {v ? effortLabel(v) : t("Default")}
                    </option>
                  ))}
                </FieldSelect>
              </label>
              <label>
                {t("File access")}
                <FieldSelect
                  value={settings.config.access}
                  onValueChange={(value) =>
                    config({
                      access: value as "read-only" | "workspace-write",
                      permissions: permissionsForAccess(
                        settings.config,
                        value as "read-only" | "workspace-write",
                      ),
                    })
                  }
                >
                  <option value="workspace-write">
                    {t("Project read and write")}
                  </option>
                  <option value="read-only">{t("Read only")}</option>
                </FieldSelect>
              </label>
            </div>
            <label>
              {t("Default execution permissions")}
              <PermissionSelect
                config={settings.config}
                disabled={busy}
                onChange={(permissions) => config({ permissions })}
              />
            </label>
            {!subscriptionMode && (
              <div
                className="advanced-settings"
                onInvalidCapture={(event) => {
                  event.preventDefault();
                  const input = event.target as HTMLInputElement;
                  setAdvanced(true);
                  setError(input.validationMessage);
                  requestAnimationFrame(() => input.focus());
                }}
              >
                <button
                  type="button"
                  className="advanced-toggle"
                  aria-expanded={advanced}
                  onClick={() => setAdvanced(!advanced)}
                >
                  {t("Model connection")}
                  <ChevronDown size={16} />
                </button>
                <Disclosure open={advanced} className="advanced-fields">
                  <label>
                    {t("Provider name")}
                    <input
                      value={settings.config.provider ?? ""}
                      onChange={(e) =>
                        config({ provider: e.target.value || null })
                      }
                      maxLength={100}
                    />
                  </label>
                  <label>
                    {t("API endpoint")}
                    <input
                      value={settings.config.baseUrl ?? ""}
                      onChange={(e) =>
                        config({ baseUrl: e.target.value || null })
                      }
                      type="url"
                      placeholder="https://api.openai.com/v1"
                    />
                  </label>
                  <label>
                    {t("Protocol")}
                    <FieldSelect
                      value={settings.config.protocol ?? ""}
                      onValueChange={(value) =>
                        config({
                          protocol: (value ||
                            null) as RuntimeSettings["config"]["protocol"],
                        })
                      }
                    >
                      <option value="">{t("Default")}</option>
                      <option value="responses">Responses</option>
                      <option value="chat-completions">Chat Completions</option>
                      <option value="anthropic-messages">
                        Anthropic Messages
                      </option>
                    </FieldSelect>
                  </label>
                  <label>
                    {t("API key")}
                    <input
                      type="password"
                      value={secret}
                      onChange={(e) => setSecret(e.target.value)}
                      autoComplete="new-password"
                      placeholder={t("Enter a key to save")}
                      spellCheck={false}
                    />
                  </label>
                  <label>
                    {t("Credential reference")}
                    <input
                      value={settings.config.credentialEnv ?? ""}
                      onChange={(e) =>
                        config({ credentialEnv: e.target.value || null })
                      }
                      placeholder="OPENAI_API_KEY"
                      spellCheck={false}
                    />
                  </label>
                </Disclosure>
              </div>
            )}
            {error && (
              <p role="alert" className="form-error">
                {t(error)}
              </p>
            )}
          </div>
          <div className="form-footer">
            <button
              type="button"
              className="secondary-button"
              onClick={onClose}
            >
              {t("Cancel")}
            </button>
            <button className="primary-button" disabled={busy}>
              {busy && <LoaderCircle size={16} className="spinner" />}
              {t("Save changes")}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}

export function ExecutionActivity({
  workspace,
  teamId,
  chatId,
  onSettings,
}: {
  workspace: Workspace;
  teamId: string;
  chatId?: string;
  onSettings: () => void;
}) {
  const { t } = useI18n();
  const reduced = useReducedMotion();
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [expanded, setExpanded] = useState(false);
  const execution = workspace.executions?.[teamId];
  const runs =
    execution?.runs.filter((r) => !chatId || r.conversationId === chatId) ?? [];
  const latest = runs.at(-1);
  const run =
    latest && ["active", "paused", "failed"].includes(latest.state)
      ? latest
      : undefined;
  const works = execution?.works.filter((w) => w.runId === run?.id) ?? [];
  const active = works.filter((w) =>
    ["queued", "running", "stopping"].includes(w.status),
  );
  const issue = works.find((w) =>
    ["failed", "rejected", "recovery_required"].includes(w.status),
  );
  const action = async (path: string, body: unknown = {}) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await product.command(`/teams/${teamId}/${path}`, body);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const status =
    issue?.status === "recovery_required"
      ? "Check interrupted execution"
      : run?.state === "paused"
        ? "Paused"
        : active.some((w) => w.status === "stopping")
          ? "Stopping…"
          : active.length
            ? "Working"
            : issue
              ? "Needs attention"
              : "";
  return (
    <AnimatePresence initial={false}>
      {status && run && (
        <motion.div
          key={run.id}
          className={`execution-activity ${issue ? "has-error" : ""}`}
          initial={reduced ? false : { height: 0, opacity: 0, y: 8 }}
          animate={{ height: "auto", opacity: 1, y: 0 }}
          exit={reduced ? { opacity: 0 } : { height: 0, opacity: 0, y: 4 }}
          transition={{ duration: reduced ? 0 : 0.2, ease: [0.2, 0.8, 0.2, 1] }}
        >
          <div className="execution-status-row">
            <button
              className="execution-status"
              type="button"
              onClick={() => setExpanded(!expanded)}
              aria-expanded={expanded}
            >
              {issue ? (
                <AlertCircle size={15} />
              ) : active.length ? (
                <span className="activity-pulse" />
              ) : (
                <Pause size={15} />
              )}
              <span>{t(status)}</span>
              {active.length > 1 && (
                <span className="activity-count">{active.length}</span>
              )}
              <ChevronDown size={13} />
            </button>
            <div className="execution-actions">
              {active.length > 0 && (
                <button
                  disabled={busy}
                  onClick={() => void action(`runs/${run.id}/pause`)}
                >
                  <Pause size={14} />
                  {t("Pause")}
                </button>
              )}
              {run.state === "paused" && (
                <button
                  disabled={busy}
                  onClick={() => void action(`runs/${run.id}/resume`)}
                >
                  <Play size={14} />
                  {t("Continue")}
                </button>
              )}
              {issue && run.state !== "paused" && (
                <button
                  disabled={busy}
                  onClick={() =>
                    void action(
                      `works/${issue.id}/${issue.status === "recovery_required" ? "reconcile" : "retry"}`,
                      issue.status === "recovery_required"
                        ? {}
                        : { expectedRevision: issue.revision },
                    )
                  }
                >
                  <RotateCcw size={14} />
                  {t(
                    issue.status === "recovery_required"
                      ? "Check status"
                      : "Retry",
                  )}
                </button>
              )}
            </div>
          </div>
          <AnimatePresence initial={false}>
            {expanded && (
              <motion.div
                className="execution-expanded"
                initial={reduced ? false : { height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: reduced ? 0 : 0.16 }}
              >
                {works.map((w) => (
                  <div key={w.id}>
                    <span>{w.title}</span>
                    <small>{t(w.status)}</small>
                  </div>
                ))}
                {issue?.error && <p>{t(issue.error)}</p>}
                <button onClick={onSettings}>
                  <Settings2 size={14} />
                  {t("Team capabilities")}
                </button>
              </motion.div>
            )}
          </AnimatePresence>
          {error && (
            <p className="form-error" role="alert">
              {t(error)}
            </p>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
