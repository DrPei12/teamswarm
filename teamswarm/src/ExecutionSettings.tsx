import { FieldSelect } from "./FieldSelect";
import { lazy, Suspense, useEffect, useId, useState } from "react";
import { DeviceResourceSettings } from "./DeviceResourceSettings";
import { HostModelSettings } from "./HostModelSettings";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  AlertCircle,
  ArrowRight,
  ChevronDown,
  LoaderCircle,
  Pause,
  Play,
  RotateCcw,
  Settings2,
} from "lucide-react";
import type { RuntimeSettings } from "@team/contracts/runtime";
import type { Workspace } from "./store";
import { CapabilitySettings } from "./CapabilitySettings";
import { SwarmMark } from "./SwarmMark";
import { product } from "./service";
import { useI18n } from "./i18n";
import { Modal } from "./ui";

const AllocationSettings = lazy(() =>
  import("./AllocationSettings").then(({ AllocationSettings }) => ({
    default: AllocationSettings,
  })),
);

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
  const create = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const chat = await product.createIndependentChat(t("New chat"));
      location.hash = `/team/${chat.teamId}/chat/${chat.id}`;
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
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void create();
              }}
            >
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
                {t("New chat")}
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

type ExecutionSettingsProps = {
  open: boolean;
  onClose: () => void;
  teamId: string;
  workspace: Workspace;
  initialTab?: "harnesses" | "connections" | "runtime";
  scope?: "team" | "global";
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
    <CapabilitySettings {...props} initialTab={configurationTab} />
  );
}
export function ManualExecutionSettings({
  open,
  embedded = false,
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
  embedded?: boolean;
}) {
  const { t } = useI18n();
  const tabId = useId();
  const [settings, setSettings] = useState<RuntimeSettings | null>(null),
    [tab, setTab] = useState<"settings" | "device" | "resources">("settings"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [timeLimit, setTimeLimit] = useState("");
  const host = workspace.executions?.[teamId]?.host;
  const manualResources =
    workspace.service?.manualResourceConfiguration === true;
  const tabs = [
    { value: "settings", label: "Runtime" },
    { value: "device", label: "Device resources" },
    ...(manualResources
      ? [{ value: "resources", label: "Resources and allocation" } as const]
      : []),
  ] as const;
  const selectedTab =
    !manualResources && tab === "resources" ? "settings" : tab;
  const tabProps = (value: typeof selectedTab) => ({
    id: `${tabId}-${value}-panel`,
    "aria-labelledby": `${tabId}-${value}-tab`,
    role: "tabpanel" as const,
  });
  useEffect(() => {
    if (open) {
      setSettings(workspace.executions?.[teamId]?.settings ?? null);
      const seconds = workspace.executions?.[teamId]?.settings?.timeoutSeconds;
      setTimeLimit(seconds == null ? "" : String(seconds / 60));
      setTab("settings");
      setError("");
    }
  }, [open, teamId]);
  const body = (
    <>
      <div
        className="modal-tabs execution-modal-tabs"
        role="tablist"
        aria-label={t("Advanced settings")}
        onKeyDown={(event) => {
          const index = tabs.findIndex(({ value }) => value === selectedTab);
          const next =
            event.key === "ArrowRight"
              ? (index + 1) % tabs.length
              : event.key === "ArrowLeft"
                ? (index + tabs.length - 1) % tabs.length
                : event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? tabs.length - 1
                    : -1;
          if (next < 0) return;
          event.preventDefault();
          setTab(tabs[next].value);
          event.currentTarget
            .querySelectorAll<HTMLButtonElement>("[role=tab]")
            [next]?.focus();
        }}
      >
        {tabs.map(({ value, label }) => (
          <button
            key={value}
            id={`${tabId}-${value}-tab`}
            type="button"
            role="tab"
            aria-selected={selectedTab === value}
            aria-controls={`${tabId}-${value}-panel`}
            tabIndex={selectedTab === value ? 0 : -1}
            className={selectedTab === value ? "active" : ""}
            onClick={() => setTab(value)}
          >
            {t(label)}
          </button>
        ))}
      </div>
      {selectedTab === "resources" && (
        <div {...tabProps("resources")} className="execution-allocation-pane">
          <Suspense fallback={<p role="status">{t("Loading…")}</p>}>
            <AllocationSettings teamId={teamId} workspace={workspace} />
          </Suspense>
        </div>
      )}
      {selectedTab === "device" && (
        <div {...tabProps("device")} className="device-profile-pane">
          <DeviceResourceSettings />
        </div>
      )}
      {selectedTab === "settings" && (
        <div {...tabProps("settings")} className="execution-settings-pane">
          {host && (
            <HostModelSettings
              key={host.branchId}
              teamId={teamId}
              host={host}
              onConfigureModels={onConfigureModels}
            />
          )}
          {settings && (
            <form
              className="execution-form"
              onSubmit={async (e) => {
                e.preventDefault();
                if (busy) return;
                const seconds = Math.round(Number(timeLimit) * 60);
                if (
                  !timeLimit.trim() ||
                  !Number.isFinite(seconds) ||
                  seconds < 10 ||
                  seconds > 3600
                ) {
                  setError(
                    t("Enter a duration from 10 seconds to 60 minutes."),
                  );
                  return;
                }
                setBusy(true);
                setError("");
                try {
                  await product.saveSettings(teamId, {
                    ...settings,
                    timeoutSeconds: seconds,
                  });
                  onClose();
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              <div className="form-body">
                <h3>{t("Team runtime")}</h3>
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
                <label>
                  {t("Session mode")}
                  <FieldSelect
                    aria-label={t("Session mode")}
                    value={settings.sessionLongevityMode ?? "standard"}
                    disabled={busy}
                    onValueChange={(value) => {
                      if (value === "standard" || value === "high-efficiency")
                        setSettings(
                          (old) =>
                            old && { ...old, sessionLongevityMode: value },
                        );
                    }}
                  >
                    <option value="standard">{t("Standard mode")}</option>
                    <option value="high-efficiency">
                      {t("High-efficiency mode")}
                    </option>
                  </FieldSelect>
                  <small>
                    {t(
                      settings.sessionLongevityMode === "high-efficiency"
                        ? "Refresh sessions earlier during long-running work."
                        : "Keep the current session longer when work can continue.",
                    )}
                  </small>
                </label>
                <label>
                  {t("Time limit per turn (minutes)")}
                  <input
                    type="number"
                    inputMode="decimal"
                    min={10 / 60}
                    max={60}
                    step="any"
                    required
                    disabled={busy}
                    value={timeLimit}
                    onChange={(e) => {
                      e.currentTarget.setCustomValidity("");
                      setTimeLimit(e.target.value);
                    }}
                    onInvalid={(e) => {
                      e.currentTarget.setCustomValidity(
                        t("Enter a duration from 10 seconds to 60 minutes."),
                      );
                    }}
                  />
                  <small>
                    {t(
                      "A turn that runs longer is stopped and kept as interrupted. Applies to new requests; 10 seconds–60 minutes.",
                    )}
                  </small>
                </label>
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
        </div>
      )}
    </>
  );
  if (embedded)
    return (
      <section className="execution-modal embedded-settings">{body}</section>
    );
  return (
    <Modal
      open={open}
      onOpenChange={(value) => !value && onClose()}
      title={t("Advanced settings")}
      className="execution-modal"
    >
      {body}
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
  const issue =
    works.find((w) =>
      ["failed", "rejected", "recovery_required"].includes(w.status),
    ) ??
    (!active.length
      ? works.find((w) => w.status === "interrupted")
      : undefined);
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
    issue?.status === "recovery_required" || issue?.status === "interrupted"
      ? issue.status
      : run?.state === "paused"
        ? "Paused"
        : active.some((w) => w.status === "stopping")
          ? "Stopping…"
          : active.length
            ? active.every((work) => work.status === "queued")
              ? "Queued for execution"
              : "Working"
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
                    void action(`works/${issue.id}/retry`, {
                      expectedRevision: issue.revision,
                    })
                  }
                >
                  <RotateCcw size={14} />
                  {t("Retry")}
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
