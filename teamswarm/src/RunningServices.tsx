import { useCallback, useEffect, useRef, useState } from "react";
import {
  ExternalLink,
  LoaderCircle,
  Monitor,
  RotateCcw,
  Square,
  X,
} from "lucide-react";
import type {
  ManagedService,
  ServiceListing,
  ServicePolicy,
} from "@team/contracts/services";
import { api } from "./service";
import { useI18n } from "./i18n";
import { DetailPanel, IconButton } from "./ui";
import type { Workspace } from "./store";
import "./running-services.css";

const busyStatuses = new Set(["starting", "switching", "stopping"]);
const liveStatuses = new Set([
  "starting",
  "running",
  "switching",
  "stopping",
  "recovery_required",
]);

export function useRunningServices(teamId: string) {
  const [listing, setListing] = useState<ServiceListing | null>(null);
  const [error, setError] = useState("");
  const selected = useRef(teamId);
  selected.current = teamId;
  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const next = await api<ServiceListing>(
          `/teams/${teamId}/services`,
          undefined,
          undefined,
          signal,
        );
        if (selected.current === teamId && !signal?.aborted) {
          setListing(next);
          setError(next.error ?? "");
        }
      } catch (cause) {
        if (selected.current === teamId && !signal?.aborted)
          setError((cause as Error).message);
      }
    },
    [teamId],
  );
  useEffect(() => {
    setListing(null);
    setError("");
    const controller = new AbortController();
    let reading = false;
    const read = async () => {
      if (reading || document.hidden || controller.signal.aborted) return;
      reading = true;
      try {
        await refresh(controller.signal);
      } finally {
        reading = false;
      }
    };
    read();
    const timer = setInterval(read, 3000);
    document.addEventListener("visibilitychange", read);
    return () => {
      controller.abort();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", read);
    };
  }, [refresh]);
  const dismiss = async () => {
    const suggestion = listing?.suggestion;
    if (!suggestion) return;
    await api(
      `/teams/${teamId}/service-suggestions/${suggestion.id}/dismiss`,
      {},
    );
    if (selected.current === teamId)
      setListing((current) =>
        current ? { ...current, suggestion: null } : current,
      );
  };
  return {
    listing,
    error,
    refresh,
    dismiss,
    count:
      listing?.services.filter((service) => liveStatuses.has(service.status))
        .length ?? 0,
  };
}

export function ResourceReleaseSetting() {
  const { t } = useI18n();
  const [policy, setPolicy] = useState<ServicePolicy | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void api<ServicePolicy>(
      "/service-policy",
      undefined,
      undefined,
      controller.signal,
    )
      .then((value) => {
        if (!controller.signal.aborted) setPolicy(value);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(cause.message);
      });
    return () => controller.abort();
  }, []);
  async function change() {
    if (!policy || busy) return;
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      setPolicy(
        await api<ServicePolicy>(
          "/service-policy",
          { expectedVersion: policy.version, autoRelease: !policy.autoRelease },
          "PUT",
        ),
      );
      setSaved(true);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="resource-release-setting">
      <label>
        <span>
          <strong>{t("Automatically release idle resources")}</strong>
          <small>
            {t(
              "Release unused executors and previews when work ends. Applies to every team on this device.",
            )}
          </small>
        </span>
        <input
          type="checkbox"
          role="switch"
          checked={policy?.autoRelease ?? false}
          disabled={!policy || busy}
          onChange={() => void change()}
          aria-label={t("Automatically release idle resources")}
        />
      </label>
      {busy && (
        <span className="resource-setting-status" role="status">
          {t("Saving…")}
        </span>
      )}
      {!busy && saved && (
        <span className="resource-setting-status" role="status">
          {t("Saved on this device")}
        </span>
      )}
      {error && (
        <p className="error" role="alert">
          {t(error)}
        </p>
      )}
    </div>
  );
}

type Props = {
  teamId: string;
  workspace: Workspace;
  listing: ServiceListing | null;
  error: string;
  refresh: () => Promise<void>;
  onClose: () => void;
};

export function RunningServices({
  teamId,
  workspace,
  listing,
  error,
  refresh,
  onClose,
}: Props) {
  const { t } = useI18n();
  const [pending, setPending] = useState<string | null>(null);
  const [failure, setFailure] = useState("");
  const [history, setHistory] = useState(false);
  const name = (id: string) =>
    workspace.members.find((member) => member.id === id)?.name ??
    t("Team member");
  const active =
    listing?.services.filter((service) => liveStatuses.has(service.status)) ??
    [];
  const ended =
    listing?.services
      .filter((service) => !liveStatuses.has(service.status))
      .slice(0, 10) ?? [];
  const statusNames: Record<string, string> = {
    starting: "Starting",
    running: "Running",
    switching: "Handing over",
    stopping: "Stopping",
    stopped: "Stopped",
    failed: "Failed",
    recovery_required: "Needs reconciliation",
  };
  async function act(
    service: ManagedService,
    operation: "stop" | "restart" | "retention",
  ) {
    if (pending) return;
    setPending(service.id);
    setFailure("");
    try {
      await api(
        `/teams/${teamId}/services/${service.id}/${operation}`,
        {
          expectedVersion: service.version,
          ...(operation === "retention" ? { retained: !service.retained } : {}),
        },
        operation === "retention" ? "PUT" : "POST",
      );
      await refresh();
    } catch (cause) {
      setFailure((cause as Error).message);
      await refresh();
    } finally {
      setPending(null);
    }
  }
  const memory = (bytes?: number) =>
    bytes === undefined ? "—" : `${(bytes / 1048576).toFixed(1)} MiB`;
  const row = (service: ManagedService) => (
    <article className="running-service" key={service.id}>
      <div className="running-service-title">
        <Monitor size={16} />
        <strong>{service.name}</strong>
        <span className={`service-state state-${service.status}`}>
          {t(statusNames[service.status])}
        </span>
      </div>
      {service.url && service.status === "running" && (
        <a
          href={service.url}
          target="_blank"
          rel="noreferrer"
          className="running-service-url"
        >
          {service.url.replace("http://", "")}
          <ExternalLink size={13} />
        </a>
      )}
      <p className="running-service-owner">
        {service.usage === "project" && liveStatuses.has(service.status)
          ? t("Kept for this project")
          : `${t(liveStatuses.has(service.status) ? "In use by" : "Last used by")} ${name(service.ownerId)}`}
        {service.handoffWorkId && liveStatuses.has(service.status)
          ? ` · ${t("Handoff pending")}`
          : ""}
      </p>
      <details className="running-service-details">
        <summary>{t("Details")}</summary>
        <dl>
          <dt>{t("Working copy")}</dt>
          <dd>{service.workspace}</dd>
          <dt>{t("Preview folder")}</dt>
          <dd>{service.directory}</dd>
          {service.development && (
            <>
              <dt>{t("Framework")}</dt>
              <dd>
                {service.development.framework === "next" ? "Next.js" : "Vite"}
              </dd>
            </>
          )}
          {service.runtimeDirectory && (
            <>
              <dt>{t("Runtime copy")}</dt>
              <dd>{service.runtimeDirectory}</dd>
            </>
          )}
          {service.backendPid && (
            <>
              <dt>{t("Development process")}</dt>
              <dd>{service.backendPid}</dd>
            </>
          )}
          <dt>{t("Created by")}</dt>
          <dd>{name(service.creatorId)}</dd>
          <dt>{t("Process")}</dt>
          <dd>{service.nativePid ?? service.pid ?? "—"}</dd>
          <dt>{t("Working set")}</dt>
          <dd>{memory(service.workingSetBytes)}</dd>
          <dt>{t("Private commit")}</dt>
          <dd>{memory(service.privateBytes)}</dd>
        </dl>
        {service.error && <p className="error">{t(service.error)}</p>}
      </details>
      <div className="running-service-actions">
        {service.status === "running" && (
          <label>
            <input
              type="checkbox"
              checked={service.retained}
              disabled={pending !== null}
              onChange={() => void act(service, "retention")}
            />
            {t("Keep running")}
          </label>
        )}
        {liveStatuses.has(service.status) ? (
          <button
            type="button"
            className="service-stop-button"
            disabled={pending !== null}
            onClick={() => void act(service, "stop")}
            aria-label={t("Stop {name}", { name: service.name })}
          >
            {pending === service.id || busyStatuses.has(service.status) ? (
              <LoaderCircle size={13} className="spinner" />
            ) : (
              <Square size={12} />
            )}{" "}
            {t("Stop")}
          </button>
        ) : service.restartedAs ? (
          <span className="muted">{t("Reopened")}</span>
        ) : (
          <button
            type="button"
            className="service-stop-button"
            disabled={pending !== null}
            onClick={() => void act(service, "restart")}
          >
            <RotateCcw size={13} />
            {t("Reopen preview")}
          </button>
        )}
      </div>
    </article>
  );
  return (
    <DetailPanel
      label={t("Running services")}
      className="delivery-detail resource-detail"
      onClose={onClose}
      fallbackFocus={() =>
        document.querySelector<HTMLButtonElement>(".running-services-trigger")
      }
    >
      <header>
        <Monitor size={16} />
        <strong>{t("Running services")}</strong>
        <IconButton label={t("Close running services")} onClick={onClose}>
          <X size={16} />
        </IconButton>
      </header>
      <div className="detail-scroll running-services-scroll">
        {(failure || error) && (
          <p role="alert" className="error">
            {t(failure || error)}
          </p>
        )}
        {!listing ? (
          <p role="status" className="muted">
            {t("Loading…")}
          </p>
        ) : active.length ? (
          active.map(row)
        ) : (
          <p className="running-services-empty">
            {t("No services are running.")}
          </p>
        )}
        {ended.length > 0 && (
          <div className="running-services-history">
            <button
              className="text-button"
              type="button"
              aria-expanded={history}
              onClick={() => setHistory((value) => !value)}
            >
              {t("Recently stopped")} ({ended.length})
            </button>
            {history && ended.map(row)}
          </div>
        )}
      </div>
    </DetailPanel>
  );
}
