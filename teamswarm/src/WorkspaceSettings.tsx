import { useRef, useState } from "react";
import { Popover, Tabs } from "radix-ui";
import {
  Check,
  ChevronDown,
  FolderOpen,
  Monitor,
  Moon,
  RefreshCw,
  Search,
  Sun,
  Type,
} from "lucide-react";
import type { Workspace } from "./store";
import { useI18n, type Language } from "./i18n";
import { Modal } from "./ui";
import { FieldSelect } from "./FieldSelect";
import {
  bundled,
  defaults,
  fontLabel,
  fontSizes,
  importFont,
  installedFonts,
  palettes,
  textRoles,
  useAppearance,
  type TextRole,
} from "./appearance";

const labels = {
  ui: "Interface",
  content: "Conversation text",
  code: "Code and plain text",
};
const defaultNames = {
  ui: "Default · Inter",
  content: "Default · Source Serif 4",
  code: "Default · Monospace",
};

function FontPicker({
  role,
  value,
  imports,
  families,
  scan,
  scanning,
  change,
  add,
}: {
  role: TextRole;
  value: string;
  imports: Record<string, string>;
  families: string[] | null;
  scan: () => Promise<void>;
  scanning: boolean;
  change: (value: string) => void;
  add: (id: string, name: string) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false),
    [filter, setFilter] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null),
    search = useRef<HTMLInputElement>(null);
  const query = filter.trim().toLocaleLowerCase();
  const groups = [
    {
      name: "Bundled fonts",
      items: [
        ["", t(defaultNames[role])],
        ...Object.entries(bundled).map(([key, f]) => [key, f.name]),
      ],
    },
    {
      name: "Imported fonts",
      items: Object.entries(imports).map(([id, name]) => ["file:" + id, name]),
    },
    {
      name: "Installed fonts",
      items: (
        families ?? (value.startsWith("local:") ? [value.slice(6)] : [])
      ).map((name) => ["local:" + name, name]),
    },
  ]
    .map((group) => ({
      ...group,
      items: group.items.filter(([, name]) =>
        name.toLocaleLowerCase().includes(query),
      ),
    }))
    .filter((group) => group.items.length);
  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setFilter("");
          setError("");
        }
      }}
    >
      <Popover.Trigger asChild>
        <button
          type="button"
          className="appearance-font-trigger"
          aria-label={t("{section} font", { section: t(labels[role]) })}
        >
          <span>{fontLabel(value, imports) || t(defaultNames[role])}</span>
          <ChevronDown size={15} />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className="appearance-font-menu"
          sideOffset={5}
          align="end"
          collisionPadding={12}
          aria-label={t("Choose font")}
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            search.current?.focus();
          }}
        >
          <label className="appearance-search">
            <Search size={15} />
            <input
              type="search"
              ref={search}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              aria-label={t("Search fonts")}
              placeholder={t("Search fonts")}
            />
          </label>
          <div className="appearance-font-list">
            {groups.map((group) => (
              <div key={group.name}>
                <p>{t(group.name)}</p>
                {group.items.map(([id, name]) => (
                  <button
                    type="button"
                    key={id}
                    aria-pressed={value === id}
                    onClick={() => {
                      change(id);
                      setOpen(false);
                    }}
                  >
                    <span>{name}</span>
                    {value === id && <Check size={15} />}
                  </button>
                ))}
              </div>
            ))}
            {!groups.length && <p role="status">{t("No matching fonts")}</p>}
          </div>
          <div className="appearance-font-tools">
            <button
              type="button"
              disabled={scanning || busy}
              onClick={async () => {
                setError("");
                try {
                  await scan();
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              <RefreshCw size={14} />
              {t(
                scanning
                  ? "Reading fonts…"
                  : families
                    ? "Refresh installed fonts"
                    : "Find installed fonts",
              )}
            </button>
            <button
              type="button"
              disabled={busy || scanning}
              onClick={() => file.current?.click()}
            >
              <FolderOpen size={14} />
              {t(busy ? "Importing…" : "Import font file")}
            </button>
            <input
              ref={file}
              type="file"
              aria-label={t("Import font file")}
              accept=".ttf,.otf,.woff,.woff2"
              hidden
              onChange={async (e) => {
                const selected = e.currentTarget.files?.[0];
                e.currentTarget.value = "";
                if (!selected) return;
                setBusy(true);
                setError("");
                try {
                  const face = await importFont(selected);
                  add(face.id, face.name);
                  setOpen(false);
                } catch (e) {
                  setError(
                    (e as Error).message ===
                      "Choose a TTF, OTF, WOFF or WOFF2 font up to 32 MB."
                      ? (e as Error).message
                      : "Font import failed. Check the file and try again.",
                  );
                } finally {
                  setBusy(false);
                }
              }}
            />
          </div>
          {families && (
            <p className="appearance-font-count" role="status">
              {t("{count} installed font families", { count: families.length })}
            </p>
          )}
          {error && (
            <p className="form-error" role="alert">
              {t(error)}
            </p>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

export function WorkspaceSettings({
  workspace,
  appearance,
  close,
  update,
}: {
  workspace: Workspace;
  appearance: ReturnType<typeof useAppearance>;
  close: () => void;
  update: (change: (old: Workspace) => Workspace) => boolean;
}) {
  const { t } = useI18n();
  const { value, save, error } = appearance;
  const [families, setFamilies] = useState<string[] | null>(null),
    [scanning, setScanning] = useState(false);
  const scan = async () => {
    setScanning(true);
    try {
      setFamilies(await installedFonts());
    } catch (e) {
      throw new Error(
        (e as Error).name === "NotAllowedError"
          ? "Font access was denied. Try again or import a font file."
          : "Could not list installed fonts. Try again or import a font file.",
      );
    } finally {
      setScanning(false);
    }
  };
  const changeStyle = (
    role: TextRole,
    patch: Partial<typeof value.styles.ui>,
  ) =>
    save((current) => ({
      ...current,
      styles: {
        ...current.styles,
        [role]: { ...current.styles[role], ...patch },
      },
    }));
  return (
    <Modal
      open
      onOpenChange={(next) => {
        if (!next) close();
      }}
      title={t("Settings")}
      className="workspace-settings"
    >
      <Tabs.Root defaultValue="general" className="workspace-settings-body">
        <Tabs.List className="settings-tabs" aria-label={t("Settings")}>
          <Tabs.Trigger value="general">{t("General")}</Tabs.Trigger>
          <Tabs.Trigger value="appearance">{t("Appearance")}</Tabs.Trigger>
        </Tabs.List>
        <Tabs.Content value="general" forceMount className="settings-pane">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const name = String(
                new FormData(e.currentTarget).get("name") || "",
              ).trim();
              if (update((old) => ({ ...old, name: name || old.name })))
                close();
            }}
          >
            <div className="form-body">
              <label>
                {t("Workspace name")}
                <input
                  name="name"
                  defaultValue={workspace.name}
                  required
                  maxLength={60}
                />
              </label>
              <label>
                {t("Language")}
                <FieldSelect
                  name="language"
                  value={workspace.language}
                  onValueChange={(v) =>
                    update((old) => ({ ...old, language: v as Language }))
                  }
                >
                  <option value="en">English</option>
                  <option value="zh-CN">简体中文</option>
                </FieldSelect>
              </label>
            </div>
            <div className="form-footer">
              <button
                type="button"
                className="secondary-button"
                onClick={close}
              >
                {t("Cancel")}
              </button>
              <button className="primary-button">{t("Save changes")}</button>
            </div>
          </form>
        </Tabs.Content>
        <Tabs.Content
          value="appearance"
          className="settings-pane appearance-pane"
        >
          <div className="appearance-scroll">
            <section aria-labelledby="appearance-style">
              <h3 id="appearance-style">{t("Visual style")}</h3>
              <div className="appearance-card">
                <div className="appearance-row">
                  <strong>{t("Mode")}</strong>
                  <div
                    className="appearance-modes"
                    role="group"
                    aria-label={t("Mode")}
                  >
                    {(["system", "light", "dark"] as const).map((mode) => {
                      const Icon =
                        mode === "system"
                          ? Monitor
                          : mode === "light"
                            ? Sun
                            : Moon;
                      return (
                        <button
                          key={mode}
                          type="button"
                          aria-pressed={workspace.theme === mode}
                          onClick={() =>
                            update((old) => ({ ...old, theme: mode }))
                          }
                        >
                          <Icon size={15} />
                          {t(mode.charAt(0).toUpperCase() + mode.slice(1))}
                        </button>
                      );
                    })}
                  </div>
                </div>
                <div className="appearance-palette">
                  <strong>{t("Light background")}</strong>
                  <div
                    className="appearance-swatches"
                    role="group"
                    aria-label={t("Light background")}
                  >
                    {palettes.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        aria-pressed={value.palette === c.id}
                        onClick={() =>
                          save((current) => ({ ...current, palette: c.id }))
                        }
                      >
                        <i
                          aria-hidden="true"
                          style={{ background: c.background }}
                        >
                          {value.palette === c.id && <Check size={13} />}
                        </i>
                        {t(c.name)}
                      </button>
                    ))}
                  </div>
                  <small className="dark-palette-note">
                    {t("This background is used in light mode.")}
                  </small>
                </div>
              </div>
            </section>
            <section aria-labelledby="appearance-type">
              <h3 id="appearance-type">{t("Typography")}</h3>
              <div className="appearance-card appearance-type">
                {textRoles.map((role) => {
                  const size = fontSizes[role];
                  return (
                    <div className="appearance-type-row" key={role}>
                      <strong>{t(labels[role])}</strong>
                      <FontPicker
                        role={role}
                        value={value.styles[role].font}
                        imports={value.imports}
                        families={families}
                        scanning={scanning}
                        scan={scan}
                        change={(font) => changeStyle(role, { font })}
                        add={(id, name) =>
                          save((current) => ({
                            ...current,
                            imports: { ...current.imports, [id]: name },
                            styles: {
                              ...current.styles,
                              [role]: {
                                ...current.styles[role],
                                font: "file:" + id,
                              },
                            },
                          }))
                        }
                      />
                      <FieldSelect
                        className="appearance-size"
                        aria-label={t("{section} size", {
                          section: t(labels[role]),
                        })}
                        value={String(value.styles[role].size)}
                        onValueChange={(v) =>
                          changeStyle(role, { size: Number(v) })
                        }
                      >
                        {Array.from(
                          { length: size.max - size.min + 1 },
                          (_, i) => size.min + i,
                        ).map((n) => (
                          <option key={n} value={String(n)}>
                            {n} px
                          </option>
                        ))}
                      </FieldSelect>
                    </div>
                  );
                })}
              </div>
            </section>
            <section className="appearance-preview" aria-label={t("Preview")}>
              <div>
                <Type size={15} />
                {t("Preview")}
              </div>
              <p>{t("The first line of your next conversation.")}</p>
              <code>const team = "TeamSwarm";</code>
            </section>
            {error && (
              <p role="alert" className="form-error">
                {t(error)}
              </p>
            )}
          </div>
          <div className="form-footer">
            <button
              type="button"
              className="text-button"
              onClick={() =>
                save((current) => ({ ...defaults(), imports: current.imports }))
              }
            >
              {t("Reset fonts and background")}
            </button>
            <button type="button" className="secondary-button" onClick={close}>
              {t("Done")}
            </button>
          </div>
        </Tabs.Content>
      </Tabs.Root>
    </Modal>
  );
}
