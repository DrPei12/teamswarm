import { useCallback, useEffect, useId, useRef, useState } from "react";
import { ArrowUp, Copy, Plus, Square, X } from "lucide-react";
import { useI18n } from "./i18n";
import { MessageContent } from "./MessageContent";
import { IconButton } from "./ui";

import {
  loadSideChats,
  maxSideAnswer,
  maxSideChats,
  maxSideQuestion,
  newSideChat,
  saveSideChats,
  sideChatKey,
  type SideChats,
  type SideChatTab,
} from "./sideChatStorage";

type Request = { tabId: string; controller: AbortController };

export function SideQuestion({
  teamId,
  chatId,
  initial,
  open,
  close,
}: {
  teamId: string;
  chatId: string;
  initial: { text: string } | null;
  open: boolean;
  close: () => void;
}) {
  const { t } = useI18n();
  const uid = useId();
  const key = sideChatKey(teamId, chatId);
  const [state, setState] = useState(() => loadSideChats(key));
  const stateRef = useRef(state);
  const { tabs, active } = state;
  const [running, setRunning] = useState<string>();
  const [notice, setNotice] = useState("");
  const current = useRef<Request | null>(null);
  const mounted = useRef(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const activeLabel = useRef<HTMLButtonElement>(null);
  const consumed = useRef<typeof initial>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const selected = tabs.find((tab) => tab.id === active) ?? tabs[0];
  const commit = useCallback(
    (next: SideChats, persist = true, requireSave = false) => {
      if (persist) {
        try {
          saveSideChats(key, next);
        } catch {
          setNotice("Side chats could not be saved on this device.");
          if (requireSave) return false;
        }
      }
      stateRef.current = next;
      setState(next);
      return true;
    },
    [key],
  );
  const patch = useCallback(
    (id: string, change: (tab: SideChatTab) => SideChatTab, persist = true) => {
      const before = stateRef.current;
      if (!mounted.current || !before.tabs.some((tab) => tab.id === id)) return;
      commit(
        {
          ...before,
          tabs: before.tabs.map((tab) => (tab.id === id ? change(tab) : tab)),
        },
        persist,
      );
    },
    [commit],
  );
  const addTab = useCallback(() => {
    const before = stateRef.current;
    const tab = newSideChat(before.tabs);
    if (!tab) return;
    setNotice("");
    commit({ active: tab.id, tabs: [...before.tabs, tab] });
  }, [commit]);

  const ask = useCallback(
    async (id: string, value: string, keepDraft = false) => {
      const question = value.trim();
      if (!question || current.current) return;
      const controller = new AbortController();
      const request = { tabId: id, controller };
      current.current = request;
      setRunning(id);
      setNotice("");
      patch(id, (tab) => ({
        ...tab,
        draft: keepDraft ? tab.draft : "",
        attempt: { question, text: "" },
      }));
      let text = "";
      try {
        const response = await fetch(
          `/api/product/conversations/${encodeURIComponent(chatId)}/btw`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "same-origin",
            body: JSON.stringify({ teamId, question }),
            signal: controller.signal,
          },
        );
        if (!response.ok || !response.body) {
          const failure = await response.json().catch(() => null);
          throw Error(
            failure?.error?.message ?? "Could not answer the side question.",
          );
        }
        const reader = response.body
          .pipeThrough(new TextDecoderStream())
          .getReader();
        let buffer = "";
        let ended = false;
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += value;
            if (buffer.length > 262144)
              throw Error("The side answer exceeded its response limit.");
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";
            for (const line of lines) {
              if (!line) continue;
              const event = JSON.parse(line);
              if (event.error) throw Error(event.error);
              if (typeof event.delta === "string") text += event.delta;
              if (event.done === true) ended = true;
            }
            if (text.length > maxSideAnswer)
              throw Error("The side answer exceeded its response limit.");
            const partial = text;
            patch(
              id,
              (tab) => ({
                ...tab,
                attempt: { question, text: partial },
              }),
              false,
            );
          }
          if (!ended)
            throw Error("The side question was interrupted. Try again.");
        } finally {
          await reader.cancel().catch(() => undefined);
        }
        const answer = { question, text };
        patch(id, (tab) => ({
          ...tab,
          attempt: undefined,
          answers: [...tab.answers, answer].slice(-5),
        }));
      } catch (e) {
        const cancelled = controller.signal.aborted;
        patch(id, (tab) => ({
          ...tab,
          draft: tab.draft || question,
          attempt: {
            question,
            text,
            cancelled,
            error: cancelled ? undefined : (e as Error).message,
          },
        }));
      } finally {
        if (current.current === request) {
          current.current = null;
          setRunning(undefined);
        }
      }
    },
    [chatId, patch, teamId],
  );

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const request = current.current;
      current.current = null;
      request?.controller.abort();
    };
  }, []);
  useEffect(() => {
    if (!open) return;
    if (!stateRef.current.tabs.length) addTab();
    activeLabel.current?.scrollIntoView({
      block: "nearest",
      inline: "nearest",
    });
    input.current?.focus();
  }, [active, addTab, open]);
  useEffect(() => {
    if (!open || !initial || initial === consumed.current) return;
    const id = stateRef.current.active;
    if (!id) return;
    consumed.current = initial;
    if (!initial.text) {
      input.current?.focus();
      return;
    }
    if (current.current) {
      patch(id, (tab) => ({ ...tab, draft: initial.text }));
      setNotice(
        "Another side question is running. Your question is ready to send when it finishes.",
      );
    } else {
      void ask(id, initial.text, true);
    }
  }, [active, ask, initial, open, patch]);
  useEffect(() => {
    if (open && scroll.current)
      scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [open, selected?.answers, selected?.attempt]);

  function removeTab(id: string) {
    const before = stateRef.current;
    const next = before.tabs.filter((tab) => tab.id !== id);
    const active =
      before.active !== id
        ? before.active
        : (next[
            Math.min(
              before.tabs.findIndex((tab) => tab.id === id),
              next.length - 1,
            )
          ]?.id ?? null);
    if (!commit({ active, tabs: next }, true, true)) return;
    if (current.current?.tabId === id) current.current.controller.abort();
    if (!next.length) close();
  }
  if (!selected) return null;
  const messages = selected.answers;
  const attempt = selected.attempt;
  const empty = !messages.length && !attempt;
  const ownRequest = running === selected.id;
  return (
    <aside
      className="side-question-panel"
      hidden={!open}
      aria-label={t("Side question")}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !e.defaultPrevented) {
          e.stopPropagation();
          close();
        }
      }}
    >
      <header className="side-question-head">
        <div className="side-question-tabs" aria-label={t("Side chats")}>
          {tabs.map((tab) => (
            <div
              key={tab.id}
              className="side-question-tab"
              data-active={tab.id === selected.id}
            >
              <button
                type="button"
                className="side-question-tab-label"
                ref={tab.id === selected.id ? activeLabel : undefined}
                aria-pressed={tab.id === selected.id}
                onClick={() => {
                  setNotice("");
                  commit({ ...stateRef.current, active: tab.id });
                }}
              >
                {t("Side chat {n}", { n: tab.number })}
              </button>
              <IconButton
                label={t("Close side chat {n}", { n: tab.number })}
                onClick={() => removeTab(tab.id)}
              >
                <X size={13} />
              </IconButton>
            </div>
          ))}
        </div>
        <IconButton
          label={t("New side chat")}
          disabled={tabs.length >= maxSideChats}
          onClick={addTab}
        >
          <Plus size={17} />
        </IconButton>
        <IconButton label={t("Close side panel")} onClick={close}>
          <X size={17} />
        </IconButton>
      </header>
      <div
        className="side-question-body"
        ref={scroll}
        aria-live="polite"
        id={uid}
      >
        {empty && <p className="side-question-empty">{t("No messages yet")}</p>}
        {messages.map((answer, i) => (
          <article className="side-question-exchange" key={i}>
            <p className="side-question-user">{answer.question}</p>
            <MessageContent text={answer.text} />
            <IconButton
              label={t("Copy answer")}
              onClick={() =>
                void navigator.clipboard
                  .writeText(answer.text)
                  .catch(() => setNotice("Copy failed"))
              }
            >
              <Copy size={14} />
            </IconButton>
          </article>
        ))}
        {attempt && (
          <article className="side-question-exchange">
            <p className="side-question-user">{attempt.question}</p>
            {attempt.text && (
              <MessageContent text={attempt.text} pending={ownRequest} />
            )}
            {ownRequest && !attempt.text && (
              <p role="status">{t("Waiting for the model…")}</p>
            )}
            {attempt.error && (
              <p className="form-error" role="alert">
                {t(attempt.error)}
              </p>
            )}
            {attempt.cancelled && (
              <p role="status">{t("Side question cancelled.")}</p>
            )}
          </article>
        )}
      </div>
      {notice && (
        <p className="side-question-notice" role="status">
          {t(notice)}
        </p>
      )}
      <form
        className="side-question-form"
        onSubmit={(e) => {
          e.preventDefault();
          void ask(selected.id, selected.draft);
        }}
      >
        <textarea
          ref={input}
          aria-label={t("Side question")}
          aria-controls={uid}
          maxLength={maxSideQuestion}
          placeholder={t("Ask a quick question")}
          value={selected.draft}
          onChange={(e) => {
            const draft = e.target.value;
            patch(selected.id, (tab) => ({ ...tab, draft }));
          }}
          onKeyDown={(e) => {
            if (
              e.key === "Enter" &&
              !e.shiftKey &&
              !e.nativeEvent.isComposing
            ) {
              e.preventDefault();
              if (running === undefined) void ask(selected.id, selected.draft);
            }
          }}
        />
        {ownRequest ? (
          <IconButton
            label={t("Cancel side question")}
            onClick={() => current.current?.controller.abort()}
          >
            <Square size={16} />
          </IconButton>
        ) : (
          <button
            className="icon-button"
            aria-label={t("Ask")}
            type="submit"
            disabled={!selected.draft.trim() || running !== undefined}
          >
            <ArrowUp size={17} />
          </button>
        )}
      </form>
    </aside>
  );
}
