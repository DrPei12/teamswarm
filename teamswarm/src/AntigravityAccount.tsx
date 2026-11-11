import { useEffect, useRef, useState } from "react";
import { LoaderCircle, LogIn, RotateCcw } from "lucide-react";
import { api } from "./service";
import { useI18n } from "./i18n";

type Login = {
  id: string;
  state: "waiting" | "complete" | "failed" | "cancelled";
  error?: string;
};
type Status = {
  installed: boolean;
  available: boolean;
  login: Login | null;
  error?: string;
};
const endpoint = "/harnesses/antigravity/subscription/";
export function AntigravityAccount({ onChanged }: { onChanged: () => void }) {
  const { t } = useI18n();
  const changed = useRef(onChanged);
  changed.current = onChanged;
  const [status, setStatus] = useState<Status | null>(null);
  const [login, setLogin] = useState<Login | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [revision, refresh] = useState(0);
  useEffect(() => {
    let live = true;
    setBusy(true);
    void api<Status>(endpoint + "status", {})
      .then((value) => {
        if (live) {
          setStatus(value);
          setLogin(value.login);
          setError(value.error ?? "");
        }
      })
      .catch((e) => {
        if (live) setError(e.message);
      })
      .finally(() => {
        if (live) setBusy(false);
      });
    return () => {
      live = false;
    };
  }, [revision]);
  useEffect(() => {
    if (login?.state !== "waiting") return;
    let live = true;
    const timer = setInterval(() => {
      void api<Login | null>(endpoint + "poll", {})
        .then((value) => {
          if (!live) return;
          setLogin(value);
          if (value?.state === "complete") {
            changed.current();
            refresh((n) => n + 1);
          }
        })
        .catch((e) => {
          if (live) setError(e.message);
        });
    }, 1000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [login?.state]);
  const waiting = login?.state === "waiting";
  return (
    <div className="harness-account">
      <p className="form-hint">
        {t("Antigravity uses the Google account signed in on this device.")}
      </p>
      <div className="account-model-action">
        <button
          type="button"
          className="secondary-button"
          disabled={busy || !status?.installed}
          onClick={async () => {
            setBusy(true);
            setError("");
            try {
              setLogin(
                await api<Login>(
                  endpoint + (waiting ? "cancel" : "start"),
                  waiting ? { loginId: login.id } : {},
                ),
              );
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? (
            <LoaderCircle size={14} className="spinner" />
          ) : (
            <LogIn size={14} />
          )}
          {t(waiting ? "Cancel sign-in" : "Sign in with Google")}
        </button>
        <button
          type="button"
          className="text-button"
          disabled={busy || waiting}
          onClick={() => {
            refresh((n) => n + 1);
            onChanged();
          }}
        >
          <RotateCcw size={14} />
          {t("Refresh models")}
        </button>
      </div>
      {waiting && (
        <p role="status" className="form-hint">
          {t("Complete sign-in in the browser opened by Antigravity.")}
        </p>
      )}
      {login?.state === "complete" && (
        <p role="status" className="form-hint">
          {t("Signed in")}
        </p>
      )}
      {(error || login?.error) && (
        <p className="form-error" role="alert">
          {t(error || login!.error!)}
        </p>
      )}
    </div>
  );
}
