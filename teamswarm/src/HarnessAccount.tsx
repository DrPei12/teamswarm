import { useEffect, useRef, useState } from "react";
import {
  Check,
  ExternalLink,
  LoaderCircle,
  LogIn,
  RotateCcw,
  ShieldCheck,
} from "lucide-react";
import { api } from "./service";
import { useI18n } from "./i18n";
import { Disclosure } from "./Disclosure";

export const hasSubscription = (harness: string) =>
  harness === "claude-code" || harness === "grok";
type Login = {
  id: string;
  state:
    "starting" | "waiting" | "verifying" | "complete" | "failed" | "cancelled";
  url?: string;
  code?: string;
  error?: string;
};
type ModelCheck = {
  model: string | null;
  state: "not_checked" | "available" | "unavailable";
  error?: string;
};
type Account = {
  installed: boolean;
  authenticated: boolean | null;
  account?: string;
  login: Login | null;
  modelCheck: ModelCheck;
};

/** Account checks and model execution are deliberately separate observations. */
export function HarnessAccount({
  harness,
  model,
  revision = 0,
  onChanged,
}: {
  harness: string;
  model: string | null;
  revision?: number;
  onChanged: () => void;
}) {
  const { t } = useI18n();
  const [account, setAccount] = useState<Account | null>(null);
  const [login, setLogin] = useState<Login | null>(null);
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [code, setCode] = useState("");
  const [manual, setManual] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const changed = useRef(onChanged);
  changed.current = onChanged;
  const mounted = useRef(true);
  const epoch = useRef(0);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const endpoint = `/harnesses/${encodeURIComponent(harness)}/subscription/`;
  useEffect(() => {
    let live = true;
    const generation = ++epoch.current;
    setChecking(true);
    setError("");
    setBusy("");
    setAccount((old) =>
      old ? { ...old, modelCheck: { model, state: "not_checked" } } : null,
    );
    void api<Account>(endpoint + "status", { model })
      .then((value) => {
        if (!live || generation !== epoch.current) return;
        setAccount(value);
        setLogin(value.login);
      })
      .catch((e) => {
        if (live) setError(e.message);
      })
      .finally(() => {
        if (live) setChecking(false);
      });
    return () => {
      live = false;
    };
  }, [endpoint, model, revision, refresh]);
  const active =
    !!login && ["starting", "waiting", "verifying"].includes(login.state);
  useEffect(() => {
    if (!active) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await api<Login | null>(endpoint + "poll", {});
        if (!live) return;
        setLogin(next);
        if (next && ["complete", "failed", "cancelled"].includes(next.state)) {
          setCode("");
          setManual(false);
          setRefresh((v) => v + 1);
          if (next.state === "complete") changed.current();
          return;
        }
      } catch (e) {
        if (live) setError((e as Error).message);
      }
      if (live) timer = setTimeout(poll, 1000);
    };
    timer = setTimeout(poll, 500);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [active, endpoint]);
  async function action(kind: string) {
    if (busy) return;
    const generation = epoch.current;
    setBusy(kind);
    setError("");
    try {
      const body =
        kind === "check-model"
          ? { model }
          : kind === "cancel"
            ? { loginId: login?.id }
            : kind === "code"
              ? { loginId: login?.id, code: code.trim() }
              : {};
      const result = await api<Login | ModelCheck>(endpoint + kind, body);
      if (!mounted.current || generation !== epoch.current) return;
      if (kind === "check-model")
        setAccount((old) =>
          old ? { ...old, modelCheck: result as ModelCheck } : old,
        );
      else {
        setLogin(result as Login);
        setCode("");
      }
    } catch (e) {
      if (mounted.current && generation === epoch.current)
        setError((e as Error).message);
    } finally {
      if (mounted.current && generation === epoch.current) setBusy("");
    }
  }
  const signedIn = account?.authenticated === true;
  const modelAvailable = account?.modelCheck.state === "available";
  return (
    <section className="harness-account" aria-label={t("Subscription account")}>
      <div className="account-status-row">
        <span className="account-status-label">
          <LogIn size={16} />
          {t("Subscription account")}
        </span>
        <span
          className={signedIn ? "account-positive" : "account-muted"}
          role="status"
        >
          {checking ? (
            <LoaderCircle size={14} className="spinner" />
          ) : signedIn ? (
            <Check size={14} />
          ) : null}
          {t(
            checking
              ? "Checking sign-in…"
              : !account
                ? "Status unavailable"
                : !account.installed
                  ? "Install to sign in"
                  : account.authenticated === null
                    ? "Sign-in status unknown"
                    : signedIn
                      ? "Signed in"
                      : "Not signed in",
          )}
        </span>
        <button
          type="button"
          className="icon-button"
          aria-label={t("Refresh account status")}
          title={t("Refresh account status")}
          disabled={checking || active || !!busy}
          onClick={() => setRefresh((v) => v + 1)}
        >
          <RotateCcw size={14} />
        </button>
      </div>
      {account?.account && <p className="account-email">{account.account}</p>}
      {!active && account?.installed && (
        <button
          type="button"
          className="secondary-button account-sign-in"
          disabled={checking || !!busy}
          onClick={() => void action("start")}
        >
          {busy === "start" ? (
            <LoaderCircle size={14} className="spinner" />
          ) : (
            <LogIn size={14} />
          )}
          {t(
            signedIn
              ? "Sign in to another account"
              : harness === "grok"
                ? "Sign in with Grok"
                : "Sign in with Claude",
          )}
        </button>
      )}
      <Disclosure open={active} className="account-login-details">
        <div className="account-login-content">
          <p role="status">
            {t(
              login?.state === "verifying"
                ? "Verifying sign-in…"
                : login?.url
                  ? "Complete sign-in in your browser, then return here."
                  : "Preparing sign-in…",
            )}
          </p>
          {login?.code && (
            <div className="device-code">
              <span>{t("Device code")}</span>
              <strong>{login.code}</strong>
              <small>
                {t("Make sure this matches the code shown by Grok.")}
              </small>
            </div>
          )}
          <div className="account-actions">
            {login?.url && (
              <a
                className="primary-button"
                href={login.url}
                target="_blank"
                rel="noopener noreferrer"
              >
                <ExternalLink size={14} />
                {t("Open sign-in page")}
              </a>
            )}
            <button
              type="button"
              className="text-button"
              disabled={!!busy}
              onClick={() => void action("cancel")}
            >
              {t("Cancel sign-in")}
            </button>
          </div>
          {harness === "claude-code" && login?.state === "waiting" && (
            <>
              <button
                type="button"
                className="text-button account-code-toggle"
                aria-expanded={manual}
                onClick={() => setManual(!manual)}
              >
                {t("Browser gave you a code?")}
              </button>
              <Disclosure open={manual}>
                <label>
                  {t("Sign-in code")}
                  <input
                    type="password"
                    autoComplete="off"
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    placeholder={t(
                      "Paste the code from the official sign-in page.",
                    )}
                  />
                </label>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={!code.trim() || !!busy}
                  onClick={() => void action("code")}
                >
                  {t("Complete sign-in")}
                </button>
              </Disclosure>
            </>
          )}
        </div>
      </Disclosure>
      {login?.state === "failed" && login.error && (
        <p className="form-error" role="alert">
          {t(login.error)}
        </p>
      )}
      <div className="account-model-section">
        <div className="account-status-row">
          <span className="account-status-label">
            <ShieldCheck size={16} />
            {t("Selected model")}
          </span>
          <span
            role="status"
            className={modelAvailable ? "account-positive" : "account-muted"}
          >
            {busy === "check-model" && (
              <LoaderCircle size={14} className="spinner" />
            )}
            {t(
              busy === "check-model"
                ? "Checking model…"
                : modelAvailable
                  ? "Model available"
                  : account?.modelCheck.state === "unavailable"
                    ? "Model check failed"
                    : "Not checked",
            )}
          </span>
        </div>
        <div className="account-model-action">
          <span className="account-model-name">
            {model || t("Default model")}
          </span>
          <button
            type="button"
            className="secondary-button"
            disabled={!signedIn || active || checking || !!busy}
            onClick={() => void action("check-model")}
          >
            {t("Check model")}
          </button>
        </div>
        <p className="account-hint">
          {t("Sends one short request using your subscription quota.")}
        </p>
        {account?.modelCheck.error && (
          <p className="form-error" role="alert">
            {t(account.modelCheck.error)}
          </p>
        )}
      </div>
      <p className="account-hint">
        {t(
          "The official harness manages sign-in and credentials on this device.",
        )}
      </p>
      {error && (
        <p className="form-error" role="alert">
          {t(error)}
        </p>
      )}
    </section>
  );
}
