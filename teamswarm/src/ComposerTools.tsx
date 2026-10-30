import { PermissionSelect } from "./PermissionSelect";
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
import type { ExecutionConfig } from "@team/contracts/runtime";
import { selectedModelChoice, type ModelChoice } from "./modelCatalog";
import { useModelCatalog } from "./useModelCatalog";
import { clipboardFiles } from "./AttachmentChip";
import {
  harnessId,
  supportedEfforts,
  effortLabel,
  useHarnessCatalog,
} from "./harnessCatalog";

export function RuntimeControls({
  team,
  executionConfig,
  config: runtimeConfig,
  showContext = true,
  disabled = false,
  running = false,
  onPermissionChange,
  onChange,
  onSettings,
}: {
  team: Team;
  executionConfig?: ExecutionConfig;
  config?: RuntimeConfig;
  showContext?: boolean;
  disabled?: boolean;
  running?: boolean;
  onPermissionChange?: (
    permissions: NonNullable<ExecutionConfig["permissions"]>,
  ) => Promise<unknown>;
  onChange: (
    config: RuntimeConfig,
    choice?: ModelChoice,
  ) => Promise<unknown> | void;
  onSettings: (tab?: "harnesses" | "connections" | "runtime") => void;
}) {
  const { t: tr, locale } = useI18n();
  const config = runtimeConfig ?? team.runtime ?? defaultRuntime;
  const hasModel = !!config.model && config.model !== "Default model";
  const [edit, setEdit] = useState<string | null>(null);
  const activeMenu = useRef(edit);
  activeMenu.current = edit;
  const catalog = useModelCatalog(team.id, harnessId(config.harness));
  const selected = executionConfig
    ? selectedModelChoice(catalog.models, executionConfig)
    : undefined;
  const efforts =
    executionConfig?.baseUrl || executionConfig?.credentialEnv
      ? []
      : supportedEfforts(catalog.inspection, config.model);
  const [saveError, setSaveError] = useState("");
  const [saving, setSaving] = useState(false);
  const harnesses = useHarnessCatalog((error) => setSaveError(error.message));
  async function select(next: RuntimeConfig, choice?: ModelChoice) {
    if (saving) return;
    setSaving(true);
    setSaveError("");
    try {
      await onChange(next, choice);
      setEdit(null);
    } catch (e) {
      setSaveError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  const checking = catalog.loading;
  const error =
    saveError ||
    catalog.error ||
    (!executionConfig?.baseUrl && !executionConfig?.credentialEnv
      ? (catalog.inspection?.error ?? "")
      : "");
  const { trigger, container } = useTooltipContainer();
  const context = team.context;
  const known = context && context.limit > 0 && context.used >= 0;
  const fraction = known ? Math.min(1, context.used / context.limit) : 0;
  return (
    <div className="runtime-controls">
      {(["harness", "model", "effort"] as const).map((key) =>
        key === "model" ? (
          <ModelPicker
            key="model"
            compact
            disabled={disabled || saving}
            value={config.model === "Default model" ? null : config.model}
            models={catalog.models}
            selectedKey={selected?.key}
            loading={checking}
            error={error}
            onRetry={catalog.retry}
            open={!disabled && edit === "model"}
            onConfigure={() => onSettings("connections")}
            onCloseAutoFocus={(event) => {
              if (activeMenu.current && activeMenu.current !== "model")
                event.preventDefault();
            }}
            onOpenChange={(open) =>
              setEdit((current) =>
                open ? "model" : current === "model" ? null : current,
              )
            }
            onChange={(model, choice) =>
              void select(
                {
                  ...config,
                  model: model || "",
                  effort: "Default",
                },
                choice,
              )
            }
          />
        ) : (
          <Popover.Root
            key={key}
            open={!disabled && edit === key && (key !== "effort" || hasModel)}
            onOpenChange={(open) =>
              setEdit((current) =>
                open ? key : current === key ? null : current,
              )
            }
          >
            <Popover.Trigger asChild>
              <button
                type="button"
                className={`runtime-choice ${key === "effort" ? "effort-choice" : ""}`}
                aria-label={tr(`Choose ${key}`)}
                disabled={disabled || (key === "effort" && !hasModel)}
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
                onInteractOutside={(event) => {
                  if ((event.target as Element).closest?.(".runtime-choice"))
                    event.preventDefault();
                }}
                onCloseAutoFocus={(event) => {
                  if (activeMenu.current && activeMenu.current !== key)
                    event.preventDefault();
                }}
              >
                <div className="menu-heading">
                  {key === "harness" ? tr("Harness") : tr("Effort")}
                </div>
                {key === "harness" && <div className="separator" />}
                {key === "harness" && saveError && (
                  <div className="menu-note" role="alert">
                    {tr(saveError)}
                  </div>
                )}
                {(key === "harness"
                  ? harnesses.map((h) => h.name)
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
                      void select(
                        key === "harness"
                          ? {
                              ...config,
                              harness: value,
                              effort: "Default",
                            }
                          : {
                              ...config,
                              [key]: value,
                            },
                      );
                    }}
                  >
                    <span className="item-label">
                      {key === "effort" && value !== "Default"
                        ? effortLabel(value)
                        : tr(value)}
                    </span>
                    {(key === "harness"
                      ? harnessId(config.harness) === harnessId(value)
                      : config[key] === value) && (
                      <Check size={13 * ICON_SCALE} />
                    )}
                  </button>
                ))}
                <div className="separator" />
                {key === "effort" &&
                  (error || (checking && !catalog.inspection)) && (
                    <div
                      className="menu-note"
                      role={error ? "alert" : "status"}
                    >
                      {error && !checking
                        ? tr(error)
                        : tr("Loading harness options…")}
                      {error && !checking && (
                        <button
                          type="button"
                          className="model-picker-link"
                          onClick={catalog.retry}
                        >
                          {tr("Retry")}
                        </button>
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
      {executionConfig && (
        <PermissionSelect
          compact
          config={executionConfig}
          disabled={disabled}
          running={running}
          open={!disabled && edit === "permissions"}
          onOpenChange={(open) =>
            setEdit((current) =>
              open ? "permissions" : current === "permissions" ? null : current,
            )
          }
          onChange={(permissions) =>
            onPermissionChange
              ? onPermissionChange(permissions)
              : onChange({ ...config, permissions })
          }
          onAdvanced={() => onSettings("runtime")}
        />
      )}
      {showContext && (
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
      )}
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
            .filter(
              (m) =>
                m.teamId === team.id &&
                !m.id.startsWith("host:") &&
                !m.removedAt,
            )
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
          const files = clipboardFiles(e.clipboardData);
          if (files.length) {
            e.preventDefault();
            onFiles(files);
          }
        }}
      />
    </>
  );
});

export function HarnessBadge() {
  return <Cpu size={15 * ICON_SCALE} />;
}
