import { isComposing } from "./design-system/motion";
import {
  forwardRef,
  useEffect,
  useRef,
  useState,
  useImperativeHandle,
} from "react";
import { Popover, Tooltip } from "radix-ui";
import {
  ChevronDown,
  Check,
  Plus,
  Puzzle,
  Sparkles,
  UserRound,
  Cpu,
  Settings2,
} from "lucide-react";
import type { Draft, RuntimeConfig, Team, Workspace } from "./store";
import { defaultRuntime } from "./store";
import { useI18n } from "./i18n";
import { ICON_SCALE, useTooltipContainer } from "./ui";
import { api } from "./service";
import { ModelPicker } from "./ModelPicker";
import {
  harnessId,
  supportedEfforts,
  effortLabel,
  type HarnessInspection,
} from "./harnessCatalog";

export function RuntimeControls({
  team,
  onChange,
  onSettings,
}: {
  team: Team;
  onChange: (config: RuntimeConfig) => void;
  onSettings: () => void;
}) {
  const { t: tr, locale } = useI18n();
  const config = team.runtime || defaultRuntime;
  const [edit, setEdit] = useState<string | null>(null);
  const [inspection, setInspection] = useState<HarnessInspection | null>(null);
  const efforts = supportedEfforts(inspection, config.model);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (edit !== "model" && edit !== "effort") return;
    let current = true;
    setChecking(true);
    setError("");
    setInspection(null);
    const id = harnessId(config.harness);
    void api<HarnessInspection>(
      `/harnesses/${encodeURIComponent(id)}/check`,
      {},
    )
      .then((result) => {
        if (current) setInspection(result);
      })
      .catch((e) => {
        if (current) setError(e.message);
      })
      .finally(() => {
        if (current) setChecking(false);
      });
    return () => {
      current = false;
    };
  }, [edit, config.harness]);
  const { trigger, container } = useTooltipContainer();
  const context = team.context;
  const known = context && context.limit > 0 && context.used >= 0;
  const fraction = known ? Math.min(1, context.used / context.limit) : 0;
  return (
    <div className="runtime-controls">
      {(["harness", "model", "effort"] as const).map((key) =>
        key === "model" ? (
          <ModelPicker
            key={`model-${config.harness}`}
            compact
            value={config.model === "Default model" ? null : config.model}
            models={inspection?.models}
            loading={checking}
            error={error}
            onOpenChange={(open) => setEdit(open ? "model" : null)}
            onChange={(model) =>
              onChange({
                ...config,
                model: model || "Default model",
                effort: "Default",
              })
            }
          />
        ) : (
          <Popover.Root
            key={key}
            open={edit === key}
            onOpenChange={(open) => setEdit(open ? key : null)}
          >
            <Popover.Trigger asChild>
              <button
                type="button"
                className="runtime-choice"
                aria-label={tr(`Choose ${key}`)}
              >
                <span>
                  {key === "effort" && config[key] !== "Default"
                    ? effortLabel(config[key])
                    : tr(config[key])}
                </span>
                <ChevronDown size={10 * ICON_SCALE} />
              </button>
            </Popover.Trigger>
            <Popover.Portal>
              <Popover.Content
                className="runtime-popover"
                side="top"
                align="start"
                sideOffset={12}
                aria-label={tr(key === "harness" ? "Harness" : "Effort")}
              >
                <div className="menu-heading">
                  {key === "harness" ? tr("Harness") : tr("Effort")}
                </div>
                {(key === "harness"
                  ? [
                      "Codex",
                      "Claude Code",
                      "Grok",
                      "pi",
                      "DeepSeek Harness",
                      "OpenCode",
                    ]
                  : ["Default", ...efforts.map((e) => e.reasoningEffort)]
                ).map((value) => (
                  <button
                    type="button"
                    className="menu-item"
                    key={value}
                    title={
                      key === "effort"
                        ? efforts.find((e) => e.reasoningEffort === value)
                            ?.description
                        : undefined
                    }
                    onClick={() => {
                      onChange(
                        key === "harness"
                          ? {
                              harness: value,
                              model: "Default model",
                              effort: "Default",
                            }
                          : {
                              ...config,
                              [key]: value,
                            },
                      );
                      setEdit(null);
                    }}
                  >
                    <span className="item-label">
                      {key === "effort" && value !== "Default"
                        ? effortLabel(value)
                        : tr(value)}
                    </span>
                    {config[key] === value && <Check size={13 * ICON_SCALE} />}
                  </button>
                ))}
                <div className="separator" />
                {key === "effort" && (
                  <div className="menu-note" role={error ? "alert" : "status"}>
                    {checking
                      ? tr("Loading harness options…")
                      : error
                        ? tr(error)
                        : !efforts.length
                          ? tr(
                              "This harness has not provided effort options for this model. Use its default.",
                            )
                          : tr(
                              "Options provided by the selected harness and model.",
                            )}
                  </div>
                )}
                <button
                  type="button"
                  className="menu-item"
                  onClick={() => {
                    setEdit(null);
                    onSettings();
                  }}
                >
                  <Settings2 size={14 * ICON_SCALE} />
                  {tr("Team capabilities")}
                </button>
              </Popover.Content>
            </Popover.Portal>
          </Popover.Root>
        ),
      )}
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <button
            type="button"
            className="context-ring"
            ref={trigger}
            aria-label={
              known
                ? tr("Context {percent}% used", {
                    percent: Math.round(fraction * 100),
                  })
                : tr("Context usage unavailable")
            }
          >
            <svg
              width={16 * ICON_SCALE}
              height={16 * ICON_SCALE}
              viewBox="0 0 20 20"
              aria-hidden="true"
            >
              <circle
                cx="10"
                cy="10"
                r="7"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                opacity=".18"
              />
              <circle
                cx="10"
                cy="10"
                r="7"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeDasharray={`${fraction * 43.982} 43.982`}
                transform="rotate(-90 10 10)"
              />
            </svg>
          </button>
        </Tooltip.Trigger>
        <Tooltip.Portal container={container}>
          <Tooltip.Content className="tooltip" side="top" sideOffset={8}>
            {known
              ? `${context.used.toLocaleString(locale)} / ${context.limit.toLocaleString(locale)} tokens · ${Math.round(fraction * 100)}%`
              : tr("Context · —")}
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </div>
  );
}

type Choice = { id: string; label: string; detail: string; kind: string };
export const ComposerInput = forwardRef<
  HTMLTextAreaElement,
  {
    value: string;
    references: NonNullable<Draft["references"]>;
    workspace: Workspace;
    team: Team;
    onChange: (change: Partial<Draft>) => void;
    onSend: () => void;
    onFiles: (files: File[]) => void;
    onCreateSkill: () => void;
    onPlugins: () => void;
  }
>(function ComposerInput(
  {
    value,
    references,
    workspace,
    team,
    onChange,
    onSend,
    onFiles,
    onCreateSkill,
    onPlugins,
  },
  ref,
) {
  const { t: tr } = useI18n();
  const input = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle(ref, () => input.current!);
  const [caret, setCaret] = useState(value.length);
  const [index, setIndex] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const fragment = value.slice(0, caret).match(/(?:^|\s)([@/])([^\s@/]*)$/);
  const prefix = fragment?.[1];
  const query = (fragment?.[2] || "").toLowerCase();
  const [native, setNative] = useState<Choice[]>([]);
  const [catalogError, setCatalogError] = useState("");
  useEffect(() => {
    if (!prefix) return;
    let current = true;
    void api<{ skills: { id: string; name: string; description: string }[] }>(
      `/product/teams/${team.id}/tools`,
    )
      .then((result) => {
        if (current) {
          setNative(
            result.skills.map((s) => ({
              id: s.id,
              label: s.name,
              detail: s.description,
              kind: "native-skill",
            })),
          );
          setCatalogError("");
        }
      })
      .catch((e) => {
        if (current) setCatalogError(e.message);
      });
    return () => {
      current = false;
    };
  }, [!!prefix, team.id, team.runtime?.harness]);
  const candidates: Choice[] =
    prefix === "@"
      ? [
          {
            id: `host:${team.id}`,
            label: "Host",
            detail: team.name,
            kind: "member",
          },
          ...workspace.members
            .filter((m) => m.teamId === team.id && !m.id.startsWith("host:"))
            .map((m) => ({
              id: m.id,
              label: m.name,
              detail: m.responsibility,
              kind: "member",
            })),
          ...workspace.plugins.map((p) => ({
            id: p.id,
            label: p.name,
            detail: p.description,
            kind: "plugin",
          })),
        ]
      : [
          ...native,
          ...workspace.skills
            .filter((s) => s.teamId === team.id)
            .map((s) => ({
              id: s.id,
              label: s.name,
              detail: s.instructions,
              kind: "skill",
            })),
          ...workspace.plugins.map((p) => ({
            id: p.id,
            label: p.command,
            detail: p.name,
            kind: "plugin",
          })),
          {
            id: "create-skill",
            label: tr("Create skill"),
            detail: "",
            kind: "action",
          },
          {
            id: "plugins",
            label: tr("Manage plugins"),
            detail: "",
            kind: "action",
          },
        ];
  const choices = candidates.filter((c) =>
    `${c.label} ${c.detail}`.toLowerCase().includes(query),
  );
  const open = !!fragment && !dismissed;
  useEffect(() => {
    setIndex(0);
    setDismissed(false);
  }, [value]);
  useEffect(() => {
    if (open)
      document
        .getElementById(`command-${index}`)
        ?.scrollIntoView({ block: "nearest" });
  }, [index, open]);
  const pick = (choice: Choice) => {
    const start = caret - (fragment?.[2].length || 0) - 1;
    const insertion =
      choice.kind === "member"
        ? `@${choice.label} `
        : choice.kind === "plugin"
          ? `${prefix}${choice.label} `
          : "";
    const text = value.slice(0, start) + insertion + value.slice(caret);
    const change: Partial<Draft> = { text };
    if (choice.kind === "skill") change.skillId = choice.id;
    else if (choice.kind !== "action")
      change.references = [
        ...references.filter((r) => r.id !== choice.id),
        { id: choice.id, kind: choice.kind, label: choice.label },
      ];
    onChange(change);
    setDismissed(true);
    if (choice.id === "create-skill") onCreateSkill();
    else if (choice.id === "plugins") onPlugins();
    else
      requestAnimationFrame(() => {
        input.current?.focus();
        input.current?.setSelectionRange(
          start + insertion.length,
          start + insertion.length,
        );
        setCaret(start + insertion.length);
      });
  };
  return (
    <>
      {open && (
        <div
          className="command-menu"
          role="listbox"
          id="composer-commands"
          aria-label={
            prefix === "@"
              ? tr("Members and plugins")
              : tr("Skills and commands")
          }
        >
          <div className="command-heading">
            {prefix === "@" ? tr("Members & plugins") : tr("Skills & commands")}
            <kbd>esc</kbd>
          </div>
          {catalogError && (
            <div className="menu-note" role="status">
              {tr(catalogError)}
            </div>
          )}
          {choices.length ? (
            choices.map((c, i) => (
              <button
                type="button"
                role="option"
                aria-selected={i === index}
                id={`command-${i}`}
                key={c.id}
                className={`command-option ${i === index ? "selected" : ""}`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(c)}
                onMouseEnter={() => setIndex(i)}
              >
                <span className="command-symbol">
                  {c.kind === "member" ? (
                    <UserRound size={16 * ICON_SCALE} />
                  ) : c.kind === "skill" ? (
                    <Sparkles size={16 * ICON_SCALE} />
                  ) : c.kind === "plugin" ? (
                    <Puzzle size={16 * ICON_SCALE} />
                  ) : (
                    <Plus size={16 * ICON_SCALE} />
                  )}
                </span>
                <span>
                  <strong>{c.label}</strong>
                  {c.detail && <small>{c.detail}</small>}
                </span>
                {i === index && <kbd>↵</kbd>}
              </button>
            ))
          ) : (
            <div className="menu-empty">{tr("No results")}</div>
          )}
        </div>
      )}
      <textarea
        ref={input}
        aria-label={tr("Message")}
        aria-controls={open ? "composer-commands" : undefined}
        aria-activedescendant={
          open && choices[index] ? `command-${index}` : undefined
        }
        placeholder={tr("Talk to Host…")}
        rows={2}
        value={value}
        onClick={(e) => setCaret(e.currentTarget.selectionStart)}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
        onChange={(e) => {
          setCaret(e.target.selectionStart);
          onChange({ text: e.target.value });
        }}
        onKeyDown={(e) => {
          if (isComposing(e.nativeEvent)) return;
          if (open) {
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              setDismissed(true);
              return;
            }
            if (["ArrowDown", "ArrowUp"].includes(e.key) && choices.length) {
              e.preventDefault();
              setIndex(
                (index + (e.key === "ArrowDown" ? 1 : -1) + choices.length) %
                  choices.length,
              );
              return;
            }
            if ((e.key === "Enter" || e.key === "Tab") && choices[index]) {
              e.preventDefault();
              pick(choices[index]);
              return;
            }
            if (e.key === "Enter") {
              e.preventDefault();
              return;
            }
          }
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            onSend();
          }
        }}
        onPaste={(e) => {
          if (e.clipboardData.files.length) {
            e.preventDefault();
            onFiles([...e.clipboardData.files]);
          }
        }}
      />
    </>
  );
});

export function HarnessBadge() {
  return <Cpu size={15 * ICON_SCALE} />;
}
