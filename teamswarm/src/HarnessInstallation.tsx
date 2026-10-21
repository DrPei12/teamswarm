import { useEffect, useRef, useState } from "react";
import {
  Bell,
  Download,
  ExternalLink,
  LoaderCircle,
  RotateCcw,
} from "lucide-react";
import { api } from "./service";
import { useI18n } from "./i18n";

type Installation = {
  id: string;
  installed: boolean;
  version: string | null;
  latestVersion: string | null;
  updateAvailable: boolean | null;
  updateError: string | null;
  releaseUrl: string;
  canInstall: boolean;
  restartRequired?: boolean;
  installVersion: string;
  scope: "device" | "configured" | null;
  job: { state: "installing" | "complete" | "failed"; error?: string } | null;
};
type Preference = { muted?: boolean; ignored?: string };
const preferenceStorage = () =>
  window.teamswarmDesktop?.storage ?? localStorage;
const preferenceKey = (harness: string) =>
  `teamswarm:harness-updates:${harness}`;
function readPreference(harness: string): Preference {
  try {
    const parsed = JSON.parse(
      preferenceStorage().getItem(preferenceKey(harness)) || "{}",
    );
    return {
      muted: parsed?.muted === true,
      ignored: typeof parsed?.ignored === "string" ? parsed.ignored : undefined,
    };
  } catch {
    return {};
  }
}
export function HarnessInstallation({
  harness,
  onInstalled,
}: {
  harness: string;
  onInstalled: () => void;
}) {
  const { t } = useI18n();
  const [preference, setPreference] = useState(() => readPreference(harness));
  const [status, setStatus] = useState<Installation | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [revision, refresh] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const manualCheck = useRef(false);
  const [showManualResult, setShowManualResult] = useState(false);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    setBusy(true);
    setError("");
    const forceUpdate = manualCheck.current;
    const checkUpdates = forceUpdate || !readPreference(harness).muted;
    manualCheck.current = false;
    const load = async () => {
      try {
        const next = await api<Installation>(
          `/harnesses/${encodeURIComponent(harness)}/installation?updates=${checkUpdates}&refresh=${forceUpdate}`,
        );
        if (!live) return;
        setStatus(next);
        if (next.job?.state === "installing") timer = setTimeout(load, 1500);
        if (next.job?.state === "complete") onInstalled();
      } catch (e) {
        if (live) setError((e as Error).message);
      } finally {
        if (live) setBusy(false);
      }
    };
    void load();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [harness, revision]);
  const savePreference = (next: Preference) => {
    try {
      preferenceStorage().setItem(preferenceKey(harness), JSON.stringify(next));
      setPreference(next);
      setShowManualResult(false);
    } catch {
      setError(t("Couldn’t save reminder preferences."));
    }
  };
  const installing = submitting || status?.job?.state === "installing";
  return (
    <section
      className="harness-installation"
      aria-label={t("Harness installation")}
    >
      <div className="harness-version-row">
        <div>
          <strong>
            {t(
              status?.installed
                ? "Installed version"
                : busy
                  ? "Checking installation…"
                  : "Not installed",
            )}
          </strong>
          {status?.installed && (
            <span>
              {status.version ?? t("Version unavailable")}
              {" · "}
              {t(
                status.scope === "device"
                  ? "Device installation"
                  : "Configured installation",
              )}
            </span>
          )}
        </div>
        {status && (!status.installed || status.canInstall) && (
          <button
            type="button"
            className="secondary-button"
            disabled={!status.canInstall || installing}
            onClick={async () => {
              setSubmitting(true);
              setError("");
              try {
                await api(
                  `/harnesses/${encodeURIComponent(harness)}/install`,
                  {},
                );
                refresh((value) => value + 1);
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setSubmitting(false);
              }
            }}
          >
            {installing ? (
              <LoaderCircle size={14} className="spinner" />
            ) : (
              <Download size={14} />
            )}
            {t(installing ? "Installing on device…" : "Install on device")}
          </button>
        )}
        {status?.installed && (
          <button
            type="button"
            className="icon-button"
            aria-label={t("Check for updates")}
            disabled={busy || installing}
            onClick={() => {
              manualCheck.current = true;
              setShowManualResult(true);
              refresh((value) => value + 1);
            }}
          >
            <RotateCcw size={14} className={busy ? "spinner" : ""} />
          </button>
        )}
      </div>
      {status && (!status.installed || status.canInstall) && (
        <p className="form-hint">
          {t(
            status.canInstall
              ? "Installs globally on this device, available to other applications and projects."
              : "Install Node.js and npm, or check your configured harness path, then check again.",
          )}
        </p>
      )}
      {status?.restartRequired && (
        <p className="form-hint">
          {t(
            "Installed globally. Reopen TeamSwarm to use this Codex installation.",
          )}
        </p>
      )}
      {status?.updateAvailable &&
        (showManualResult ||
          (!preference.muted &&
            preference.ignored !== status.latestVersion)) && (
          <div className="harness-update">
            <span>
              {t("Version {version} is available", {
                version: status.latestVersion!,
              })}
            </span>
            <a
              href={status.releaseUrl}
              target="_blank"
              rel="noreferrer noopener"
            >
              {t("View update")}
              <ExternalLink size={12} />
            </a>
            <button
              type="button"
              className="text-button"
              onClick={() =>
                savePreference({
                  ...preference,
                  ignored: status.latestVersion!,
                })
              }
            >
              {t("Skip this version")}
            </button>
          </div>
        )}
      {showManualResult && !busy && status?.updateAvailable === false && (
        <p className="form-hint" role="status">
          {t("This harness is up to date.")}
        </p>
      )}
      {status?.installed && (
        <label className="harness-reminders">
          <Bell size={13} />
          <input
            type="checkbox"
            checked={!preference.muted}
            onChange={(event) => {
              savePreference({ ...preference, muted: !event.target.checked });
              if (event.target.checked) refresh((value) => value + 1);
            }}
          />
          {t("Notify me about harness updates")}
        </label>
      )}
      {(error ||
        status?.job?.error ||
        ((!preference.muted || showManualResult) && status?.updateError)) && (
        <p className="form-error" role="alert">
          {t(error || status?.job?.error || status?.updateError || "")}
        </p>
      )}
    </section>
  );
}
