import {
  BookOpen,
  ChevronDown,
  ChevronRight,
  Globe,
  Info,
  Keyboard,
  List,
  Settings,
  SlidersHorizontal,
} from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { Menu, MenuItem, Separator } from "./ui";
import { SwarmMark } from "./SwarmMark";
import { useI18n, type Language } from "./i18n";
import { product } from "./service";

export function ApplicationMenu({
  language,
  settings,
  team,
  changelog,
  about,
  shortcuts,
  onError,
}: {
  language: Language;
  settings: () => void;
  team: () => void;
  changelog: () => void;
  about: () => void;
  shortcuts: () => void;
  onError: (message: string) => void;
}) {
  const { t } = useI18n();
  return (
    <Menu
      side="top"
      align="start"
      className="application-menu"
      label={t("Application menu")}
      trigger={
        <button
          type="button"
          className="application-menu-trigger"
          aria-label={t("Application menu")}
        >
          <SwarmMark size={24} />
          <span>TeamSwarm</span>
          <ChevronDown size={14} aria-hidden="true" />
        </button>
      }
    >
      <MenuItem icon={<Settings size={16} />} onSelect={settings}>
        {t("Settings")}
      </MenuItem>
      <DropdownMenu.Sub>
        <DropdownMenu.SubTrigger className="menu-item app-menu-sub">
          <Globe size={16} />
          <span>{t("Language")}</span>
          <ChevronRight size={14} />
        </DropdownMenu.SubTrigger>
        <DropdownMenu.Portal>
          <DropdownMenu.SubContent
            className="menu"
            sideOffset={6}
            collisionPadding={10}
          >
            <DropdownMenu.RadioGroup
              value={language}
              onValueChange={(value) =>
                void product
                  .saveGeneralSettings({ language: value as Language })
                  .catch((e) => onError(e.message))
              }
            >
              <DropdownMenu.RadioItem className="menu-item" value="en">
                <DropdownMenu.ItemIndicator>✓ </DropdownMenu.ItemIndicator>
                English
              </DropdownMenu.RadioItem>
              <DropdownMenu.RadioItem className="menu-item" value="zh-CN">
                <DropdownMenu.ItemIndicator>✓ </DropdownMenu.ItemIndicator>
                简体中文
              </DropdownMenu.RadioItem>
            </DropdownMenu.RadioGroup>
          </DropdownMenu.SubContent>
        </DropdownMenu.Portal>
      </DropdownMenu.Sub>
      <MenuItem icon={<SlidersHorizontal size={16} />} onSelect={team}>
        {t("Team configuration")}
      </MenuItem>
      <Separator />
      <MenuItem icon={<List size={16} />} onSelect={changelog}>
        {t("View changelogs")}
      </MenuItem>
      <DropdownMenu.Sub>
        <DropdownMenu.SubTrigger className="menu-item app-menu-sub">
          <Info size={16} />
          <span>{t("Learn more")}</span>
          <ChevronRight size={14} />
        </DropdownMenu.SubTrigger>
        <DropdownMenu.Portal>
          <DropdownMenu.SubContent
            className="menu"
            sideOffset={6}
            collisionPadding={10}
          >
            <MenuItem icon={<Info size={16} />} onSelect={about}>
              {t("About TeamSwarm")}
            </MenuItem>
            <DropdownMenu.Item className="menu-item" asChild>
              <a
                target="_blank"
                rel="noreferrer"
                href={`https://github.com/DrPei12/teamswarm/blob/main/${language === "zh-CN" ? "README.zh-CN.md" : "README.md"}`}
              >
                <BookOpen size={16} /> {t("Docs")}
              </a>
            </DropdownMenu.Item>
            <MenuItem icon={<Keyboard size={16} />} onSelect={shortcuts}>
              {t("Keyboard shortcuts")}
            </MenuItem>
          </DropdownMenu.SubContent>
        </DropdownMenu.Portal>
      </DropdownMenu.Sub>
    </Menu>
  );
}
