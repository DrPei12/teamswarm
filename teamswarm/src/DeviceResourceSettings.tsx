import { useEffect, useId, useRef, useState } from "react";
import { FieldSelect } from "./FieldSelect";
import { useI18n } from "./i18n";
import { api, ApiError } from "./service";
import "./device-resource-settings.css";

const tiers = {
  compact: "Compact",
  standard: "Standard",
  workstation: "Workstation",
} as const;
type Tier = keyof typeof tiers;
type Profile = "auto" | Tier;
type Policy = { version: number; cpuTargetPercent: number; profile?: Profile };
type DeviceResources = {
  policy: Policy;
  stale: boolean;
  deviceProfile: {
    configured: Profile;
    detected: Tier;
    effective: Tier;
    pressure: boolean;
  };
  system: { availablePhysical: number; totalPhysical: number };
};
type Draft = { profile?: Profile; cpu?: string };
const endpoint = "/device-resources";
const pressureLabel = "Memory pressure is limiting idle reuse.";

export function DeviceResourceSettings() {
  const { t, locale } = useI18n();
  const uid = useId();
  const request = useRef<AbortController | null>(null);
  const [state, setState] = useState<DeviceResources | null>(null);
  const [draft, setDraft] = useState<Draft>({});
  const [pending, setPending] = useState<"read" | "save" | null>(null);
  const [readError, setReadError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [saved, setSaved] = useState(false);

  const begin = (kind: "read" | "save" = "read") => {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setPending(kind);
    return controller;
  };
  const end = (controller: AbortController) => {
    if (request.current !== controller) return;
    request.current = null;
    setPending(null);
  };
  const read = async (controller: AbortController) => {
    setReadError("");
    try {
      const result = await api<DeviceResources>(
        endpoint,
        undefined,
        "GET",
        AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]),
      );
      if (!controller.signal.aborted)
        setState((previous) =>
          previous && previous.policy.version > result.policy.version
            ? previous
            : result,
        );
    } catch (error) {
      if (!controller.signal.aborted) setReadError((error as Error).message);
    }
  };
  const refresh = async () => {
    const controller = begin();
    if (!controller) return;
    try {
      await read(controller);
    } finally {
      end(controller);
    }
  };
  useEffect(() => {
    void refresh();
    return () => {
      request.current?.abort();
      request.current = null;
    };
  }, []);

  const profile = draft.profile ?? state?.policy.profile ?? "auto";
  const cpu = draft.cpu ?? String(state?.policy.cpuTargetPercent ?? "");
  const percent = Number(cpu);
  const valid = cpu.trim() !== "" && percent >= 10 && percent <= 100;
  const changed =
    !!state &&
    (profile !== (state.policy.profile ?? "auto") ||
      percent !== state.policy.cpuTargetPercent);
  const save = async () => {
    if (!state || !valid || !changed) return;
    const controller = begin("save");
    if (!controller) return;
    setSaveError("");
    setSaved(false);
    try {
      const policy = await api<Policy>(
        endpoint + "/policy",
        {
          expectedVersion: state.policy.version,
          cpuTargetPercent: percent,
          profile,
        },
        "PUT",
        AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]),
      );
      if (controller.signal.aborted) return;
      setState((previous) => previous && { ...previous, policy, stale: true });
      setDraft({});
      setSaved(true);
      await read(controller);
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof ApiError && error.code === "version_conflict") {
        setSaveError(
          "Device settings changed elsewhere. Review your edits before saving again.",
        );
        await read(controller);
      } else {
        setSaveError((error as Error).message);
      }
    } finally {
      end(controller);
    }
  };

  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
  const gib = (bytes: number) => `${number.format(bytes / 1024 ** 3)} GiB`;
  return (
    <section
      className="device-profile-settings"
      aria-labelledby={`${uid}-title`}
    >
      <header className="device-profile-heading">
        <h3 id={`${uid}-title`}>{t("Device resources")}</h3>
        <button
          type="button"
          className="text-button"
          disabled={!!pending}
          onClick={() => void refresh()}
        >
          {t("Refresh readings")}
        </button>
      </header>
      {!state && pending && <p role="status">{t("Loading…")}</p>}
      {readError && (
        <p className="form-error" role="alert">
          {t(readError)}
        </p>
      )}
      {state && (
        <>
          <dl className="device-profile-readings">
            <dt>{t("Detected profile")}</dt>
            <dd>{t(tiers[state.deviceProfile.detected])}</dd>
            <dt>
              {t(
                state.stale || readError
                  ? "Last effective profile"
                  : "Effective profile",
              )}
            </dt>
            <dd>{t(tiers[state.deviceProfile.effective])}</dd>
            <dt>{t("Available memory")}</dt>
            <dd>
              {t("{available} of {total}", {
                available: gib(state.system.availablePhysical),
                total: gib(state.system.totalPhysical),
              })}
            </dd>
          </dl>
          {state.deviceProfile.pressure && (
            <p className="device-profile-pressure">{t(pressureLabel)}</p>
          )}
          {(state.stale || readError) && (
            <p>{t("Resource readings are out of date.")}</p>
          )}
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <div className="device-profile-fields">
              <label htmlFor={`${uid}-profile`}>
                {t("Device profile")}
                <FieldSelect
                  id={`${uid}-profile`}
                  aria-label={t("Device profile")}
                  value={profile}
                  disabled={!!pending}
                  onValueChange={(value) => {
                    if (value !== "auto" && !Object.hasOwn(tiers, value))
                      return;
                    setDraft((previous) => ({
                      ...previous,
                      profile:
                        value === (state.policy.profile ?? "auto")
                          ? undefined
                          : (value as Profile),
                    }));
                    setSaved(false);
                  }}
                >
                  <option value="auto">{t("Automatic (recommended)")}</option>
                  {Object.entries(tiers).map(([value, label]) => (
                    <option key={value} value={value}>
                      {t(label)}
                    </option>
                  ))}
                </FieldSelect>
              </label>
              <label htmlFor={`${uid}-cpu`}>
                {t("CPU target (%)")}
                <input
                  id={`${uid}-cpu`}
                  type="number"
                  min={10}
                  max={100}
                  step="any"
                  required
                  value={cpu}
                  disabled={!!pending}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    setDraft((previous) => ({
                      ...previous,
                      cpu:
                        value.trim() &&
                        Number(value) === state.policy.cpuTargetPercent
                          ? undefined
                          : value,
                    }));
                    setSaved(false);
                  }}
                />
              </label>
            </div>
            <p>
              {t(
                "The profile controls how long idle execution processes stay available. Automatic follows the device’s memory.",
              )}
            </p>
            {saveError && (
              <p className="form-error" role="alert">
                {t(saveError)}
              </p>
            )}
            <div className="device-profile-actions">
              <button
                type="submit"
                className="primary-button"
                disabled={!!pending || !changed || !valid}
              >
                {t(pending === "save" ? "Saving…" : "Save device settings")}
              </button>
              {saved && (
                <span role="status">{t("Device settings saved.")}</span>
              )}
            </div>
          </form>
        </>
      )}
    </section>
  );
}
