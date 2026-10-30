import { FieldSelect } from "./FieldSelect";
import { useEffect, useRef, useState } from "react";
import { api } from "./service";
import { useI18n } from "./i18n";
import { chatGPTSignInChannel } from "./chatgpt-return";

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
  const { t, language } = useI18n();
  const [accounts, setAccounts] = useState<Account[]>([]),
    [error, setError] = useState("");
  const [login, setLogin] = useState<{
      id: string;
      url: string;
      callbackOrigin: string;
    } | null>(null),
    [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(false);
  const [loadingAccounts, setLoadingAccounts] = useState(true);
  const popup = useRef<Window | null>(null);
  const callbacks = useRef({ onChange, onChanged });
  callbacks.current = { onChange, onChanged };
  useEffect(() => {
    let live = true;
    void api<{ accounts: Account[] }>("/model-accounts/chatgpt")
      .then((v) => {
        if (!live) return;
        setAccounts(v.accounts);
        const connected = v.accounts.filter((a) => a.connected);
        if (!value && connected.length === 1)
          callbacks.current.onChange(connected[0].id);
      })
      .catch((e) => live && setError(e.message))
      .finally(() => live && setLoadingAccounts(false));
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => {
    if (!login) return;
    let live = true;
    let settled = false;
    let checking: Promise<boolean> | undefined;
    let timer: ReturnType<typeof setTimeout>;
    const poll = (): Promise<boolean> => {
      if (settled) return Promise.resolve(true);
      if (checking) return checking;
      clearTimeout(timer);
      checking = (async () => {
        try {
          const state = await api<{
            state: string;
            accountId?: string;
            error?: string;
          }>(`/model-accounts/chatgpt/sign-in/${login.id}`);
          if (!live) return false;
          if (state.state === "complete" && state.accountId) {
            const list = await api<{ accounts: Account[] }>(
              "/model-accounts/chatgpt",
            );
            if (!live) return false;
            setAccounts(list.accounts);
            callbacks.current.onChange(state.accountId);
            callbacks.current.onChanged();
            setPending(false);
            settled = true;
            return true;
          }
          if (state.state === "failed") {
            setError(state.error ?? t("Sign-in failed. Try again."));
            setPending(false);
            settled = true;
            return true;
          }
        } catch (e) {
          if (live) setError((e as Error).message);
        }
        if (live) timer = setTimeout(poll, 2000);
        return false;
      })().finally(() => {
        checking = undefined;
      });
      return checking;
    };
    const receive = async (event: MessageEvent) => {
      if (
        event.origin !== login.callbackOrigin ||
        event.data?.type !== "teamswarm:chatgpt-login" ||
        event.data.id !== login.id ||
        (popup.current &&
          !popup.current.closed &&
          event.source !== popup.current)
      )
        return;
      if ((await poll()) && live) {
        (event.source as Window | null)?.postMessage(
          { type: "teamswarm:chatgpt-login-received", id: login.id },
          login.callbackOrigin,
        );
        window.focus();
      }
    };
    window.addEventListener("message", receive);
    const channel =
      typeof BroadcastChannel === "undefined"
        ? undefined
        : new BroadcastChannel(chatGPTSignInChannel);
    if (channel)
      channel.onmessage = async (event) => {
        if (
          event.data?.type !== "teamswarm:chatgpt-login" ||
          event.data.id !== login.id
        )
          return;
        if ((await poll()) && live) {
          channel.postMessage({
            type: "teamswarm:chatgpt-login-received",
            id: login.id,
          });
          window.focus();
        }
      };
    const events = new EventSource(
      `/api/model-accounts/chatgpt/sign-in/${login.id}/events`,
    );
    events.addEventListener("sign-in", async (event: MessageEvent) => {
      if (event.data === "close") {
        events.close();
        return;
      }
      if ((await poll()) && live && event.data === "return")
        window.teamswarmDesktop?.returnFromChatGPT();
    });
    void poll();
    return () => {
      live = false;
      clearTimeout(timer);
      window.removeEventListener("message", receive);
      channel?.close();
      events.close();
    };
  }, [login, t]);
  async function start(accountId?: string) {
    setBusy(true);
    setError("");
    setLogin(null);
    setPending(true);
    const name = "teamswarm-chatgpt-" + crypto.randomUUID();
    const opened = window.teamswarmDesktop
      ? null
      : window.open("about:blank", name, "popup,width=540,height=740");
    popup.current = opened;
    try {
      const returnUrl = new URL(location.href);
      returnUrl.searchParams.delete("chatgpt_sign_in");
      const next = await api<{
        id: string;
        url: string;
        callbackOrigin: string;
      }>("/model-accounts/chatgpt/sign-in", {
        ...(accountId ? { accountId } : {}),
        language,
        theme:
          document.documentElement.dataset.theme === "dark" ? "dark" : "light",
        client: window.teamswarmDesktop ? "desktop" : "web",
        returnPath: returnUrl.pathname + returnUrl.search + returnUrl.hash,
      });
      setLogin(next);
      if (opened && !opened.closed) opened.location.href = next.url;
      else if (window.teamswarmDesktop) window.open(next.url, "_blank");
    } catch (e) {
      opened?.close();
      setPending(false);
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
      setPending(false);
      popup.current?.close();
      popup.current = null;
      setError("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const connected = accounts.some((a) => a.id === value && a.connected);
  return (
    <div className="cap-account-panel">
      {value && accounts.some((a) => a.id === value && a.connected) && (
        <div>
          <button
            type="button"
            className="text-button"
            disabled={busy || pending}
            onClick={() => void signOut()}
          >
            {t("Sign out")}
          </button>
        </div>
      )}
      {!!accounts.length && (
        <label className="cap-field">
          <span>{t("ChatGPT account")}</span>
          <FieldSelect
            value={value ?? ""}
            disabled={busy || pending}
            onValueChange={(id) => callbacks.current.onChange(id)}
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
      {!loadingAccounts &&
        !error &&
        !connected &&
        (value || !accounts.some((a) => a.connected)) && (
          <button
            type="button"
            className="secondary-button"
            disabled={busy || pending}
            onClick={() => void start(value ?? undefined)}
          >
            {t("Continue with ChatGPT")}
          </button>
        )}
      {!!accounts.length && (
        <button
          type="button"
          className="text-button"
          disabled={busy || pending}
          onClick={() => void start()}
        >
          {t("Add account")}
        </button>
      )}
      {login && pending && (
        <p>
          <a
            href={login.url}
            onClick={(event) => {
              event.preventDefault();
              if (popup.current && !popup.current.closed) popup.current.focus();
              else
                popup.current = window.open(
                  login.url,
                  "teamswarm-chatgpt-" + login.id,
                  "popup,width=540,height=740",
                );
            }}
          >
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
          {t(error)}
        </p>
      )}
    </div>
  );
}
