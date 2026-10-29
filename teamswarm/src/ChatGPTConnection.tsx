import { FieldSelect } from "./FieldSelect";
import { useEffect, useRef, useState } from "react";
import { api } from "./service";
import { useI18n } from "./i18n";

type Account = { id: string; email: string; connected: boolean };
export function ChatGPTConnection({
  value,
  onChange,
  onChanged,
}: {
  value?: string | null;
  onChange: (id: string) => void;
  onChanged: () => void;
}) {
  const { t } = useI18n();
  const [accounts, setAccounts] = useState<Account[]>([]),
    [error, setError] = useState("");
  const [login, setLogin] = useState<{ id: string; url: string } | null>(null),
    [busy, setBusy] = useState(false);
  const callbacks = useRef({ onChange, onChanged });
  callbacks.current = { onChange, onChanged };
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
          callbacks.current.onChanged();
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
      callbacks.current.onChanged();
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
  const connected = accounts.some(
    (account) => account.id === value && account.connected,
  );
  return (
    <div className="cap-account-panel">
      {!!accounts.length && (
        <label className="cap-field">
          <span>{t("ChatGPT account")}</span>
          <FieldSelect
            value={value ?? ""}
            disabled={busy || !!login}
            onValueChange={(value) => callbacks.current.onChange(value)}
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
          </FieldSelect>
        </label>
      )}
      <div className="cap-account-actions">
        {!connected && (
          <button
            type="button"
            className="secondary-button"
            disabled={busy || !!login}
            onClick={() => void start(value ?? undefined)}
          >
            {t("Continue with ChatGPT")}
          </button>
        )}
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
        {connected && (
          <button
            type="button"
            className="text-button"
            disabled={busy || !!login}
            onClick={() => void signOut()}
          >
            {t("Sign out")}
          </button>
        )}
      </div>
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
