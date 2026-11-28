import { useState } from "react";
import { useI18n } from "./i18n";
import { api } from "./service";
import type { Chat } from "./store";
import { Modal } from "./ui";

export function MessageEditor({
  value,
  original,
  onChange,
  onSave,
  onCancel,
  busy,
}: {
  value: string;
  original: string;
  onChange: (value: string) => void;
  onSave: () => void;
  onCancel: () => void;
  busy: boolean;
}) {
  const { t } = useI18n();
  const disabled = busy || !value.trim() || value.trim() === original.trim();
  return (
    <form
      className="host-message-edit"
      onSubmit={(e) => {
        e.preventDefault();
        if (!disabled) onSave();
      }}
    >
      <textarea
        aria-label={t("Edit message")}
        value={value}
        autoFocus
        maxLength={20000}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && !busy) {
            e.stopPropagation();
            onCancel();
          }
          if (
            e.key === "Enter" &&
            (e.ctrlKey || e.metaKey) &&
            !e.nativeEvent.isComposing &&
            !disabled
          ) {
            e.preventDefault();
            onSave();
          }
        }}
      />
      <div className="host-edit-actions">
        <button
          className="text-button"
          type="button"
          disabled={busy}
          onClick={onCancel}
        >
          {t("Cancel")}
        </button>
        <button className="secondary-button" type="submit" disabled={disabled}>
          {t("Send")}
        </button>
      </div>
    </form>
  );
}

type Revision = { id: string; mode: string; anchor: string; createdAt: string };
type Entry = { id: string; role: string; content: string };
export function ConversationRevisionHistory({
  chat,
  close,
}: {
  chat: Chat;
  close: () => void;
}) {
  const { t } = useI18n();
  const [revisions, setRevisions] = useState<Revision[] | null>(null);
  const [messages, setMessages] = useState<Entry[]>([]);
  const [selected, setSelected] = useState<string>();
  const [before, setBefore] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const endpoint = `/product/conversations/${encodeURIComponent(chat.id)}/revisions?teamId=${encodeURIComponent(chat.teamId)}`;
  const read = async (revision?: string, cursor?: string) => {
    setError("");
    setBusy(true);
    try {
      if (!revision) {
        setRevisions(
          (await api<{ revisions: Revision[] }>(endpoint)).revisions,
        );
        return;
      }
      const page = await api<{ messages: Entry[]; before?: string }>(
        `${endpoint}&revision=${encodeURIComponent(revision)}${cursor ? `&before=${encodeURIComponent(cursor)}` : ""}`,
      );
      setSelected(revision);
      setMessages((old) =>
        cursor ? [...page.messages, ...old] : page.messages,
      );
      setBefore(page.before);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
      title={t("Earlier conversation versions")}
    >
      <div className="form-body revision-history">
        {!revisions && (
          <button
            className="secondary-button"
            disabled={busy}
            onClick={() => void read()}
          >
            {t("Load earlier versions")}
          </button>
        )}
        {error && <p role="alert">{t(error)}</p>}
        {revisions?.map((r) => (
          <button
            key={r.id}
            aria-pressed={r.id === selected}
            className="text-button"
            disabled={busy}
            onClick={() => void read(r.id)}
          >
            {r.anchor} · {new Date(r.createdAt).toLocaleString()}
          </button>
        ))}
        {selected && before && (
          <button
            className="text-button"
            disabled={busy}
            onClick={() => void read(selected, before)}
          >
            {t("Load earlier messages")}
          </button>
        )}
        {messages.map((m) => (
          <div key={m.id}>
            <strong>{m.role === "user" ? t("You") : "Host"}</strong>
            <p>{m.content}</p>
          </div>
        ))}
      </div>
    </Modal>
  );
}
