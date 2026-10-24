import { useEffect, useState } from "react";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  Cpu,
  KeyRound,
  Layers,
  LoaderCircle,
  Plus,
  SlidersHorizontal,
  X,
} from "lucide-react";
import type {
  ConnectionProtocol,
  ModelAccess,
  TeamCapabilities,
} from "@team/contracts/allocation";
import type { Workspace } from "./store";
import { api } from "./service";
import { Modal } from "./ui";
import { useI18n } from "./i18n";
import { Disclosure } from "./Disclosure";
import { HarnessInstallation } from "./HarnessInstallation";
import { HarnessAccount } from "./HarnessAccount";
import { ModelPicker, modelProvider } from "./ModelPicker";
import type { HarnessInspection } from "./harnessCatalog";
import "./capabilities.css";

const harnesses = [
  { id: "codex", name: "Codex", mark: "C" },
  { id: "claude-code", name: "Claude Code", mark: "✳" },
  { id: "grok", name: "Grok", mark: "G" },
  { id: "pi", name: "Pi", mark: "π" },
  { id: "opencode", name: "OpenCode", mark: "O" },
  { id: "deepseek-harness", name: "DeepSeek Harness", mark: "D" },
];
const protocols: ConnectionProtocol[] = [
  "chat-completions",
  "responses",
  "anthropic-messages",
];
const protocolNames = {
  "chat-completions": "Chat Completions",
  responses: "Responses",
  "anthropic-messages": "Anthropic Messages",
};
const compatible = (c: ModelAccess, id: string) =>
  c.kind === "subscription"
    ? c.subscriptionHarness === id
    : id === "codex"
      ? !!c.endpoints.responses
      : ["claude-code", "deepseek-harness"].includes(id)
        ? !!c.endpoints["anthropic-messages"]
        : Object.keys(c.endpoints).length > 0;
type Installation = { installed: boolean; version: string | null };
type Tab = "harnesses" | "connections" | "preferences";

export function CapabilitySettings({
  open,
  onClose,
  teamId,
  workspace,
  onAdvanced,
}: {
  open: boolean;
  onClose: () => void;
  teamId: string;
  workspace: Workspace;
  onAdvanced: () => void;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<TeamCapabilities | null>(null),
    [saved, setSaved] = useState("");
  const [tab, setTab] = useState<Tab>("harnesses"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [editor, setEditor] = useState<ModelAccess | "new" | null>(null),
    [manage, setManage] = useState<string | null>(null);
  const [installations, setInstallations] = useState<
      Record<string, Installation>
    >({}),
    [revision, refresh] = useState(0),
    [notice, setNotice] = useState("");
  useEffect(() => {
    if (!open) return;
    let live = true;
    setDraft(null);
    setError("");
    setNotice("");
    setEditor(null);
    setTab("harnesses");
    void api<TeamCapabilities>(`/teams/${teamId}/capabilities`)
      .then((v) => {
        if (live) {
          setDraft(v);
          setSaved(JSON.stringify(v));
        }
      })
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [open, teamId]);
  useEffect(() => {
    if (!open) return;
    let live = true;
    void Promise.all(
      harnesses.map(async (h) => {
        try {
          const status = await api<Installation>(
            `/harnesses/${h.id}/installation?updates=false`,
          );
          if (live) setInstallations((v) => ({ ...v, [h.id]: status }));
        } catch {
          /* A failed observation stays unknown. */
        }
      }),
    );
    return () => {
      live = false;
    };
  }, [open, revision]);
  const dirty = !!draft && JSON.stringify(draft) !== saved;
  async function save() {
    if (!draft || busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const { version, ...body } = draft;
      const next = await api<TeamCapabilities>(
        `/teams/${teamId}/capabilities`,
        { expectedVersion: version, ...body },
        "PUT",
      );
      setDraft(next);
      setSaved(JSON.stringify(next));
      setNotice(
        t("Team choices saved. Host will use them when planning new work."),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function toggle(id: string) {
    if (!draft) return;
    setNotice("");
    setDraft({
      ...draft,
      enabledHarnesses: draft.enabledHarnesses.includes(id)
        ? draft.enabledHarnesses.filter((v) => v !== id)
        : [...draft.enabledHarnesses, id],
    });
  }
  const current = workspace.executions?.[teamId]?.settings?.config;
  return (
    <Modal
      open={open}
      onOpenChange={(v) => !v && !busy && onClose()}
      title={t("Team capabilities")}
      className="capability-modal"
    >
      {!editor && (
        <div
          className="cap-tabs"
          inert={busy}
          role="tablist"
          aria-label={t("Team capabilities")}
        >
          {(
            [
              ["harnesses", "Harness"],
              ["connections", "Models and connections"],
              ["preferences", "Team preferences"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              role="tab"
              aria-selected={tab === id}
              tabIndex={tab === id ? 0 : -1}
              id={`cap-tab-${id}`}
              aria-controls={`cap-panel-${id}`}
              onKeyDown={(e) => {
                const ids: Tab[] = ["harnesses", "connections", "preferences"];
                if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key))
                  return;
                e.preventDefault();
                const next =
                  e.key === "Home"
                    ? ids[0]
                    : e.key === "End"
                      ? ids[2]
                      : ids[
                          (ids.indexOf(tab) +
                            (e.key === "ArrowRight" ? 1 : 2)) %
                            3
                        ];
                setTab(next);
                document.getElementById(`cap-tab-${next}`)?.focus();
              }}
              onClick={() => {
                setTab(id);
                setNotice("");
              }}
            >
              {t(label)}
            </button>
          ))}
        </div>
      )}
      {!draft ? (
        <div className="cap-loading" role="status">
          {error || t("Loading…")}
        </div>
      ) : editor ? (
        <ConnectionEditor
          key={editor === "new" ? "new" : editor.id}
          teamId={teamId}
          initial={editor === "new" ? null : editor}
          enabledHarnesses={draft.enabledHarnesses}
          onCancel={() => setEditor(null)}
          onSave={(connection) => {
            setDraft({
              ...draft,
              connections: [
                ...draft.connections.filter((c) => c.id !== connection.id),
                connection,
              ],
            });
            setEditor(null);
            setNotice("");
          }}
        />
      ) : (
        <>
          <div
            className="cap-body"
            inert={busy}
            role="tabpanel"
            id={`cap-panel-${tab}`}
            aria-labelledby={`cap-tab-${tab}`}
          >
            {tab === "harnesses" && (
              <>
                <div className="cap-intro">
                  <h3>{t("Choose the tools your team can use")}</h3>
                  <p>
                    {t(
                      "Select any number of Harnesses. Host chooses how to use them for each task.",
                    )}
                  </p>
                </div>
                <div className="cap-harness-grid">
                  {harnesses.map((h) => {
                    const selected = draft.enabledHarnesses.includes(h.id),
                      status = installations[h.id];
                    return (
                      <div
                        key={h.id}
                        className={`cap-harness ${selected ? "selected" : ""}`}
                      >
                        <button
                          className="cap-harness-select"
                          aria-pressed={selected}
                          onClick={() => toggle(h.id)}
                          aria-label={t("Allow {name}", { name: h.name })}
                        >
                          <span className="cap-harness-mark" aria-hidden>
                            {h.mark}
                          </span>
                          <span className="cap-harness-check" aria-hidden>
                            {selected && <Check size={13} />}
                          </span>
                          <strong>{h.name}</strong>
                          <span className="cap-install-status">
                            {!status ? (
                              t("Checking…")
                            ) : status.installed ? (
                              <>
                                <i />
                                {t("Installed")}
                                {status.version && ` · ${status.version}`}
                              </>
                            ) : (
                              t("Not installed")
                            )}
                          </span>
                        </button>
                        <button
                          className="cap-manage"
                          aria-expanded={manage === h.id}
                          onClick={() =>
                            setManage(manage === h.id ? null : h.id)
                          }
                        >
                          {t(
                            status?.installed
                              ? "Manage installation"
                              : "Install on device",
                          )}
                          <ChevronDown size={12} />
                        </button>
                      </div>
                    );
                  })}
                </div>
                <Disclosure open={!!manage}>
                  <div className="cap-install-detail">
                    {manage && (
                      <HarnessInstallation
                        key={manage}
                        harness={manage}
                        onInstalled={() => refresh((v) => v + 1)}
                      />
                    )}
                  </div>
                </Disclosure>
                <div className="cap-footnote">
                  <Cpu size={16} />
                  <p>
                    {t(
                      "Harnesses run on this device. Add subscriptions and API models separately in Models and connections.",
                    )}
                  </p>
                </div>
                {!draft.enabledHarnesses.length && (
                  <p role="alert" className="form-error">
                    {t("Choose at least one Harness.")}
                  </p>
                )}
              </>
            )}
            {tab === "connections" && (
              <>
                <div className="cap-intro cap-intro-row">
                  <div>
                    <h3>{t("Give your team access to models")}</h3>
                    <p>
                      {t(
                        "Add subscriptions or your own API connections. One connection can include several models.",
                      )}
                    </p>
                  </div>
                  <button
                    className="primary-button"
                    onClick={() => setEditor("new")}
                  >
                    <Plus size={15} />
                    {t("Add connection")}
                  </button>
                </div>
                <div className="cap-connections">
                  {draft.connections.map((c) => (
                    <article
                      className={`cap-connection ${!c.enabled ? "disabled" : ""}`}
                      key={c.id}
                    >
                      <div className="cap-connection-header">
                        <span className="cap-connection-icon">
                          {c.kind === "api" ? (
                            <KeyRound size={18} />
                          ) : (
                            <Layers size={18} />
                          )}
                        </span>
                        <div>
                          <h4>{c.name}</h4>
                          <span>
                            {t(
                              c.kind === "api"
                                ? "API connection"
                                : "Subscription account",
                            )}
                          </span>
                        </div>
                        <button
                          className="secondary-button"
                          onClick={() => setEditor(c)}
                        >
                          {t("Edit")}
                        </button>
                      </div>
                      <div className="cap-model-chips">
                        {c.models.length ? (
                          c.models.map((m) => <span key={m}>{m}</span>)
                        ) : (
                          <span>{t("Account default model")}</span>
                        )}
                      </div>
                      <div className="cap-connection-footer">
                        <span>
                          {t("Works with")}:{" "}
                          {harnesses
                            .filter((h) => compatible(c, h.id))
                            .map((h) => h.name)
                            .join(" · ") || t("Add a compatible endpoint")}
                        </span>
                        <label className="cap-enable">
                          <input
                            type="checkbox"
                            checked={c.enabled}
                            onChange={() =>
                              setDraft({
                                ...draft,
                                connections: draft.connections.map((item) =>
                                  item.id === c.id
                                    ? { ...item, enabled: !item.enabled }
                                    : item,
                                ),
                              })
                            }
                          />
                          {t("Allow team to use")}
                        </label>
                      </div>
                    </article>
                  ))}
                </div>
                {!draft.connections.length && (
                  <div className="cap-empty">
                    <KeyRound size={28} />
                    <h4>{t("Connect your first models")}</h4>
                    <p>
                      {t(
                        "Use an existing subscription or add an API key from your provider.",
                      )}
                    </p>
                    <button
                      className="secondary-button"
                      onClick={() => setEditor("new")}
                    >
                      {t("Add connection")}
                    </button>
                  </div>
                )}
                <p className="cap-footnote">
                  {t(
                    "API keys stay encrypted on this device. Host sees available models and connections, never the key.",
                  )}
                </p>
              </>
            )}
            {tab === "preferences" && (
              <>
                <div className="cap-intro">
                  <h3>{t("Tell Host what matters to you")}</h3>
                  <p>
                    {t(
                      "These preferences guide each decision. Host still considers task complexity, context and available tools.",
                    )}
                  </p>
                </div>
                <fieldset className="cap-priority">
                  <legend>{t("When choosing models")}</legend>
                  <div>
                    {(
                      [
                        [
                          "economy",
                          "Keep costs down",
                          "Prefer lighter options when they can do the job.",
                        ],
                        [
                          "balanced",
                          "Balance cost and quality",
                          "Choose according to the task.",
                        ],
                        [
                          "quality",
                          "Prioritize quality",
                          "Use stronger options when they improve the result.",
                        ],
                      ] as const
                    ).map(([value, label, help]) => (
                      <label
                        className={
                          draft.preferences.priority === value ? "selected" : ""
                        }
                        key={value}
                      >
                        <input
                          type="radio"
                          name="cap-priority"
                          value={value}
                          checked={draft.preferences.priority === value}
                          onChange={() =>
                            setDraft({
                              ...draft,
                              preferences: {
                                ...draft.preferences,
                                priority: value,
                              },
                            })
                          }
                        />
                        <strong>{t(label)}</strong>
                        <span>{t(help)}</span>
                      </label>
                    ))}
                  </div>
                </fieldset>
                <label className="cap-preference-toggle">
                  <span>
                    <strong>{t("Prefer existing subscriptions")}</strong>
                    <small>
                      {t(
                        "When suitable, use subscribed models before metered API access.",
                      )}
                    </small>
                  </span>
                  <input
                    type="checkbox"
                    checked={draft.preferences.preferSubscription}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        preferences: {
                          ...draft.preferences,
                          preferSubscription: e.target.checked,
                        },
                      })
                    }
                  />
                </label>
                <label className="cap-freeform">
                  <span>{t("Anything else Host should consider?")}</span>
                  <textarea
                    maxLength={3000}
                    rows={3}
                    value={draft.preferences.instructions}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        preferences: {
                          ...draft.preferences,
                          instructions: e.target.value,
                        },
                      })
                    }
                    placeholder={t(
                      "For example: keep routine changes lightweight; spend more effort on difficult debugging.",
                    )}
                  />
                </label>
                <div className="cap-current">
                  <SlidersHorizontal size={17} />
                  <div>
                    <strong>{t("Host starting configuration")}</strong>
                    <p>
                      {harnesses.find((h) => h.id === current?.harness)?.name ??
                        current?.harness}{" "}
                      · {current?.model ?? t("Account default model")}
                    </p>
                  </div>
                  <button
                    className="text-button"
                    disabled={dirty}
                    title={
                      dirty
                        ? t(
                            "Save your changes before opening advanced settings.",
                          )
                        : undefined
                    }
                    onClick={onAdvanced}
                  >
                    {t("Advanced settings")} →
                  </button>
                </div>
                <p className="cap-footnote">
                  {t(
                    "Manual Host, member and task choices are in Advanced settings. Running work keeps its current configuration.",
                  )}
                </p>
              </>
            )}
          </div>
          <footer className="cap-footer">
            <div aria-live="polite">
              {error ? (
                <span className="form-error">{t(error)}</span>
              ) : notice ? (
                <span className="cap-success">
                  <Check size={14} />
                  {notice}
                </span>
              ) : (
                <span>
                  {dirty
                    ? t("Unsaved changes")
                    : t(
                        "Host combines enabled tools and models for each task.",
                      )}
                </span>
              )}
            </div>
            <button
              className="primary-button"
              onClick={() => void save()}
              disabled={busy || !dirty || !draft.enabledHarnesses.length}
            >
              {busy ? <LoaderCircle className="spinner" size={15} /> : null}
              {t(busy ? "Saving…" : "Save settings")}
            </button>
          </footer>
        </>
      )}
    </Modal>
  );
}

function ConnectionEditor({
  teamId,
  initial,
  enabledHarnesses,
  onCancel,
  onSave,
}: {
  teamId: string;
  initial: ModelAccess | null;
  enabledHarnesses: string[];
  onCancel: () => void;
  onSave: (c: ModelAccess) => void;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<ModelAccess>(() =>
    initial
      ? structuredClone(initial)
      : {
          id: crypto.randomUUID(),
          name: "",
          kind: "api",
          enabled: true,
          subscriptionHarness: null,
          endpoints: { "chat-completions": "" },
          credentialEnv: null,
          models: [],
        },
  );
  const [secret, setSecret] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [advanced, setAdvanced] = useState(false),
    [catalog, setCatalog] = useState<NonNullable<HarnessInspection["models"]>>(
      [],
    ),
    [inspection, setInspection] = useState<HarnessInspection | null>(null),
    [revision, refresh] = useState(0);
  const primary = (Object.keys(draft.endpoints)[0] ??
    "chat-completions") as ConnectionProtocol;
  useEffect(() => {
    if (draft.kind !== "subscription" || !draft.subscriptionHarness) return;
    let live = true;
    setCatalog([]);
    setInspection(null);
    void api<HarnessInspection>(
      `/harnesses/${draft.subscriptionHarness}/check`,
      {},
    )
      .then((r) => {
        if (live) {
          setCatalog(r.models ?? []);
          setInspection(r);
        }
      })
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [draft.kind, draft.subscriptionHarness, revision]);
  async function credential() {
    if (!secret.trim()) return draft.credentialEnv;
    const r = await api<{ reference: string }>(
      `/product/teams/${teamId}/credential`,
      { secret: secret.trim() },
      "PUT",
    );
    setSecret("");
    setDraft((v) => ({ ...v, credentialEnv: r.reference }));
    return r.reference;
  }
  async function loadModels() {
    setBusy(true);
    setError("");
    try {
      const reference = await credential();
      if (!reference) throw new Error(t("Enter an API key first."));
      const result = await api<{ models: string[] }>(
        `/teams/${teamId}/model-catalog`,
        {
          endpoints: Object.fromEntries(
            Object.entries(draft.endpoints).filter(([, url]) => url.trim()),
          ),
          credentialEnv: reference,
        },
      );
      setCatalog(
        result.models.map((model) => ({
          model,
          name: model,
          provider:
            modelProvider({ model, name: model }) === "Other providers"
              ? draft.name || t("API connection")
              : modelProvider({ model, name: model }),
        })),
      );
      if (!result.models.length)
        setError(
          t("No model list returned. You can enter model IDs directly."),
        );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function submit() {
    if (busy) return;
    setError("");
    setBusy(true);
    try {
      if (!draft.name.trim())
        throw new Error(t("Give this connection a name."));
      if (draft.kind === "api" && !draft.models.length)
        throw new Error(t("Add at least one model."));
      const ref = draft.kind === "api" ? await credential() : null;
      if (draft.kind === "api" && !ref)
        throw new Error(t("Enter an API key first."));
      const endpoints = Object.fromEntries(
        Object.entries(draft.endpoints).filter(([, url]) => url.trim()),
      );
      if (draft.kind === "api" && !Object.keys(endpoints).length)
        throw new Error(t("Enter the API address."));
      onSave({
        ...draft,
        name: draft.name.trim(),
        credentialEnv: ref,
        endpoints,
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="cap-editor-heading">
        <button
          className="icon-button"
          onClick={onCancel}
          aria-label={t("Back to connections")}
        >
          <ArrowLeft size={18} />
        </button>
        <h3>{t(initial ? "Edit connection" : "Add connection")}</h3>
      </div>
      <form
        className="cap-body cap-editor"
        inert={busy}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        id="cap-connection-form"
      >
        <div
          className="cap-connection-type"
          role="group"
          aria-label={t("Connection method")}
        >
          {(["api", "subscription"] as const).map((kind) => (
            <button
              type="button"
              aria-pressed={draft.kind === kind}
              key={kind}
              onClick={() => {
                if (draft.kind === kind) return;
                setDraft({
                  ...draft,
                  kind,
                  models: [],
                  endpoints: kind === "api" ? { "chat-completions": "" } : {},
                  credentialEnv: null,
                  subscriptionHarness: kind === "subscription" ? "codex" : null,
                });
                setCatalog([]);
                setSecret("");
                setError("");
              }}
            >
              {kind === "api" ? <KeyRound size={15} /> : <Layers size={15} />}{" "}
              {t(kind === "api" ? "API connection" : "Subscription account")}
            </button>
          ))}
        </div>
        <label className="cap-field">
          <span>{t("Connection name")}</span>
          <input
            required
            maxLength={100}
            value={draft.name}
            placeholder={t("For example: My models")}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
        </label>
        {draft.kind === "api" ? (
          <>
            <label className="cap-field">
              <span>{t("API address")}</span>
              <input
                type="url"
                required
                value={draft.endpoints[primary] ?? ""}
                placeholder="https://provider.example/v1"
                onChange={(e) => {
                  setDraft({
                    ...draft,
                    endpoints: {
                      ...draft.endpoints,
                      [primary]: e.target.value,
                    },
                  });
                  setCatalog([]);
                }}
              />
            </label>
            <label className="cap-field">
              <span>
                API Key{" "}
                {draft.credentialEnv && (
                  <small>{t("Saved on this device")}</small>
                )}
              </span>
              <input
                type="password"
                autoComplete="new-password"
                value={secret}
                placeholder={t(
                  draft.credentialEnv
                    ? "Leave blank to keep the saved credential"
                    : "Paste your API key",
                )}
                onChange={(e) => setSecret(e.target.value)}
              />
            </label>
            <button
              className="cap-disclosure-trigger"
              type="button"
              aria-expanded={advanced}
              onClick={() => setAdvanced(!advanced)}
            >
              <ChevronDown
                size={14}
                style={{ transform: advanced ? "rotate(180deg)" : undefined }}
              />
              {t("API compatibility settings")}
            </button>
            <Disclosure open={advanced}>
              <div className="cap-api-options">
                <label className="cap-field">
                  <span>{t("Primary API format")}</span>
                  <select
                    value={primary}
                    onChange={(e) => {
                      const p = e.target.value as ConnectionProtocol;
                      setDraft({
                        ...draft,
                        endpoints: { [p]: draft.endpoints[primary] ?? "" },
                      });
                      setCatalog([]);
                    }}
                  >
                    {protocols.map((p) => (
                      <option key={p} value={p}>
                        {protocolNames[p]}
                      </option>
                    ))}
                  </select>
                </label>
                <p>
                  {t(
                    "Add another endpoint only if this provider supports it. Host can then use more compatible Harnesses.",
                  )}
                </p>
                {protocols
                  .filter((p) => p !== primary)
                  .map((p) => (
                    <label className="cap-field" key={p}>
                      <span>
                        {protocolNames[p]} <small>{t("Optional")}</small>
                      </span>
                      <input
                        type="url"
                        value={draft.endpoints[p] ?? ""}
                        placeholder="https://provider.example/v1"
                        onChange={(e) => {
                          const endpoints = { ...draft.endpoints };
                          if (e.target.value) endpoints[p] = e.target.value;
                          else delete endpoints[p];
                          setDraft({ ...draft, endpoints });
                        }}
                      />
                    </label>
                  ))}
              </div>
            </Disclosure>
          </>
        ) : (
          <>
            <div className="cap-account-options">
              {[
                { id: "codex", name: "ChatGPT" },
                { id: "claude-code", name: "Claude" },
                { id: "grok", name: "Grok" },
              ].map((a) => (
                <button
                  type="button"
                  key={a.id}
                  aria-pressed={draft.subscriptionHarness === a.id}
                  onClick={() => {
                    setDraft({
                      ...draft,
                      subscriptionHarness: a.id,
                      models: [],
                    });
                    setError("");
                  }}
                >
                  {a.name}
                  {draft.subscriptionHarness === a.id && <Check size={14} />}
                </button>
              ))}
            </div>
            <p className="cap-footnote">
              {t(
                "Subscriptions use their official Harness login. API connections can be shared across compatible Harnesses.",
              )}
            </p>
            {draft.subscriptionHarness === "codex" ? (
              <CodexAccount
                inspection={inspection}
                onChanged={() => refresh((v) => v + 1)}
              />
            ) : (
              draft.subscriptionHarness && (
                <HarnessAccount
                  harness={draft.subscriptionHarness}
                  model={draft.models[0] ?? null}
                  onChanged={() => refresh((v) => v + 1)}
                />
              )
            )}
          </>
        )}
        <div className="cap-model-section">
          <div>
            <h4>{t("Models available to Host")}</h4>
            {draft.kind === "api" && (
              <button
                className="text-button"
                type="button"
                disabled={busy}
                onClick={() => void loadModels()}
              >
                {busy ? <LoaderCircle size={13} className="spinner" /> : null}
                {t("Load model list")}
              </button>
            )}
          </div>
          <p>
            {t(
              draft.kind === "api"
                ? "Choose models from the provider, or enter their model IDs."
                : "Choose specific models, or let Host use the account's available models.",
            )}
          </p>
          <div className="cap-model-chips">
            {draft.models.map((m) => (
              <span key={m}>
                {m}
                <button
                  type="button"
                  aria-label={t("Remove {name}", { name: m })}
                  onClick={() =>
                    setDraft({
                      ...draft,
                      models: draft.models.filter((v) => v !== m),
                    })
                  }
                >
                  <X size={12} />
                </button>
              </span>
            ))}
          </div>
          <ModelPicker
            label={t("Add model…")}
            allowDefault={false}
            value={null}
            models={catalog}
            onChange={(model) => {
              if (model && !draft.models.includes(model))
                setDraft({ ...draft, models: [...draft.models, model] });
            }}
          />
        </div>
        <p className="cap-compatibility">
          <Check size={14} />
          {t("Enabled compatible Harnesses")}:{" "}
          {harnesses
            .filter(
              (h) => enabledHarnesses.includes(h.id) && compatible(draft, h.id),
            )
            .map((h) => h.name)
            .join(" · ") || t("Select a compatible Harness in the Harness tab")}
        </p>
      </form>
      <footer className="cap-footer">
        <div role={error ? "alert" : undefined}>
          {error ? (
            <span className="form-error">{t(error)}</span>
          ) : (
            t("Add the connection, then save your team settings.")
          )}
        </div>
        <button
          type="button"
          className="secondary-button"
          onClick={onCancel}
          disabled={busy}
        >
          {t("Cancel")}
        </button>
        <button
          type="submit"
          form="cap-connection-form"
          className="primary-button"
          disabled={busy}
        >
          {t(initial ? "Apply changes" : "Add connection")}
        </button>
      </footer>
    </>
  );
}

function CodexAccount({
  inspection,
  onChanged,
}: {
  inspection: HarnessInspection | null;
  onChanged: () => void;
}) {
  const { t } = useI18n();
  const [login, setLogin] = useState<{ loginId: string; url: string } | null>(
      null,
    ),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!login) return;
    const timer = setInterval(onChanged, 3000);
    return () => clearInterval(timer);
  }, [login, onChanged]);
  useEffect(() => {
    if (inspection?.authenticated) setLogin(null);
  }, [inspection?.authenticated]);
  return (
    <div className="cap-codex-account">
      <span>
        {inspection
          ? t(
              inspection.authenticated
                ? "Signed in"
                : inspection.installed === false
                  ? "Not installed"
                  : "Not signed in",
            )
          : t("Checking…")}
      </span>
      <button
        type="button"
        className="secondary-button"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setError("");
          void api<{ loginId: string; url: string }>(
            "/product/harnesses/codex/login",
            {},
          )
            .then(setLogin)
            .catch((e) => setError(e.message))
            .finally(() => setBusy(false));
        }}
      >
        {t(
          inspection?.authenticated ? "Sign in to another account" : "Sign in",
        )}
      </button>
      {login && (
        <a href={login.url} target="_blank" rel="noreferrer">
          {t("Continue in browser")} ↗
        </a>
      )}
      {error && <p role="alert">{t(error)}</p>}
    </div>
  );
}
