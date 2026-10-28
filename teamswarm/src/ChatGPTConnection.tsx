import { useEffect, useRef, useState } from "react";
import { api } from "./service";
import { useI18n } from "./i18n";

type Account = { id: string; email: string; connected: boolean };
export function ChatGPTConnection({
  value,
  onChange,
  onModels,
}: {
  value?: string | null;
  onChange: (id: string) => void;
  onModels: (models: { model: string; name: string }[]) => void;
}) {
  const { t } = useI18n();
  const [accounts, setAccounts] = useState<Account[]>([]),
    [error, setError] = useState("");
  const [login, setLogin] = useState<{ id: string; url: string } | null>(null),
    [busy, setBusy] = useState(false);
  const [revision, refresh] = useState(0);
  const callbacks = useRef({ onChange, onModels });
  callbacks.current = { onChange, onModels };
  useEffect(() => {
    let live = true;
    void api<{ accounts: Account[] }>("/model-accounts/chatgpt")
      .then((v) => live && setAccounts(v.accounts))
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => {
    if (!value) return;
    let live = true;
    setError("");
    void api<{ models: { model: string; name: string }[] }>(
      `/model-accounts/chatgpt/${value}/models`,
    )
      .then((v) => {
        if (live) callbacks.current.onModels(v.models);
      })
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [value, revision]);
  useEffect(() => {
    if (!login) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const state = await api<{
          state: string;
          accountId?: string;
          error?: string;
        }>(`/model-accounts/chatgpt/sign-in/${login.id}`);
        if (!live) return;
        if (state.state === "complete" && state.accountId) {
          const list = await api<{ accounts: Account[] }>(
            "/model-accounts/chatgpt",
          );
          if (!live) return;
          setAccounts(list.accounts);
          callbacks.current.onChange(state.accountId);
          refresh((v) => v + 1);
          setLogin(null);
          return;
        }
        if (state.state === "failed") {
          setError(state.error ?? t("Sign-in failed. Try again."));
          setLogin(null);
          return;
        }
      } catch (e) {
        if (live) setError((e as Error).message);
      }
      if (live) timer = setTimeout(poll, 2000);
    };
    void poll();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [login, t]);
  async function start(accountId?: string) {
    setBusy(true);
    setError("");
    try {
      setLogin(
        await api(
          "/model-accounts/chatgpt/sign-in",
          accountId ? { accountId } : {},
        ),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function signOut() {
    if (!value) return;
    setBusy(true);
    setError("");
    try {
      const result = await api<{ revoked: boolean }>(
        `/model-accounts/chatgpt/${value}/sign-out`,
        {},
      );
      setAccounts((v) =>
        v.map((a) => (a.id === value ? { ...a, connected: false } : a)),
      );
      if (!result.revoked)
        setError(
          t(
            "Signed out on this device. Disconnect TeamSwarm in ChatGPT Settings to end remote access.",
          ),
        );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function cancel() {
    if (!login) return;
    setBusy(true);
    try {
      await api(`/model-accounts/chatgpt/sign-in/${login.id}`, {}, "DELETE");
      setLogin(null);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="cap-account-panel">
      <p className="cap-footnote">
        {t("Use your ChatGPT models with any enabled Harness.")}
      </p>
      {value && accounts.some((a) => a.id === value && a.connected) && (
        <div>
          <button
            type="button"
            className="text-button"
            disabled={busy || !!login}
            onClick={() => refresh((v) => v + 1)}
          >
            {t("Load model list")}
          </button>
          <button
            type="button"
            className="text-button"
            disabled={busy || !!login}
            onClick={() => void signOut()}
          >
            {t("Sign out")}
          </button>
        </div>
      )}
      {!!accounts.length && (
        <label className="cap-field">
          <span>{t("ChatGPT account")}</span>
          <select
            value={value ?? ""}
            disabled={busy || !!login}
            onChange={(e) => callbacks.current.onChange(e.target.value)}
          >
            <option value="" disabled>
              {t("Choose an account")}
            </option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.email}
                {a.connected ? "" : " · " + t("Sign in")}
              </option>
            ))}
          </select>
        </label>
      )}
      <button
        type="button"
        className="secondary-button"
        disabled={busy || !!login}
        onClick={() => void start(value ?? undefined)}
      >
        {t("Continue with ChatGPT")}
      </button>
      {value && (
        <button
          type="button"
          className="text-button"
          disabled={busy || !!login}
          onClick={() => void start()}
        >
          {t("Add account")}
        </button>
      )}
      {login && (
        <p>
          <a href={login.url} target="_blank" rel="noreferrer">
            {t("Open ChatGPT sign-in")}
          </a>{" "}
          · {t("Waiting for sign-in…")}
          <button
            type="button"
            className="text-button"
            disabled={busy}
            onClick={() => void cancel()}
          >
            {t("Cancel sign-in")}
          </button>
        </p>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
