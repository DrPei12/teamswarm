import {
  forwardRef,
  useEffect,
  useRef,
  useState,
  useImperativeHandle,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";
import { Dialog, DropdownMenu, Tooltip } from "radix-ui";
import {
  X,
  Search,
  SquarePen,
  Layers,
  History,
  CircleHelp,
  House,
  MessageSquare,
  Paperclip,
  ArrowUp,
} from "lucide-react";
import { useI18n } from "./i18n";
import { usePanelResize } from "./usePanelResize";
export const ICON_SCALE = 1;
const icons = {
  search: Search,
  compose: SquarePen,
  skills: Layers,
  history: History,
  help: CircleHelp,
  home: House,
  agent: MessageSquare,
  attach: Paperclip,
  send: ArrowUp,
};

export function useTooltipContainer() {
  const trigger = useRef<HTMLButtonElement>(null);
  const [container, setContainer] = useState<HTMLElement | undefined>();
  useEffect(() => {
    setContainer(
      trigger.current?.closest<HTMLElement>(
        '[role="dialog"], main, aside[aria-label], footer, section[aria-label]',
      ) || undefined,
    );
  }, []);
  return { trigger, container };
}

export function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const media = matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [query]);
  return matches;
}

export function DetailPanel({
  label,
  className,
  children,
  onClose,
  fallbackFocus,
  resizable = true,
}: {
  label: string;
  className: string;
  children: ReactNode;
  onClose: () => void;
  fallbackFocus: () => HTMLElement | null;
  resizable?: boolean;
}) {
  const { t } = useI18n();
  const overlay = useMediaQuery("(max-width: 1000px)");
  const origin = useRef<HTMLElement | null>(null);
  const content = useRef<HTMLDivElement>(null);
  const resize = usePanelResize(content, resizable && !overlay);
  return (
    <Dialog.Root
      open
      modal={overlay}
      onOpenChange={(open) => !open && onClose()}
    >
      <Dialog.Content
        ref={content}
        className={className}
        style={resize.style}
        aria-describedby={undefined}
        onKeyDownCapture={(event) => {
          if (
            event.key === "Escape" &&
            (event.target as HTMLElement).closest('[role="dialog"]') ===
              event.currentTarget
          ) {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          }
        }}
        onInteractOutside={(event) => event.preventDefault()}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          origin.current =
            document.activeElement instanceof HTMLElement
              ? document.activeElement
              : null;
          content.current?.focus({ preventScroll: true });
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          const target =
            origin.current?.isConnected && origin.current !== document.body
              ? origin.current
              : fallbackFocus();
          target?.focus({ preventScroll: true });
        }}
      >
        <Dialog.Title className="sr-only">{label}</Dialog.Title>
        {resizable && !overlay && (
          <div
            className="detail-resize-handle"
            role="separator"
            tabIndex={0}
            aria-label={t("Resize sidebar")}
            aria-orientation="vertical"
            {...resize.handle}
          />
        )}
        <aside className="detail-content" aria-label={label}>
          {children}
        </aside>
      </Dialog.Content>
    </Dialog.Root>
  );
}

export function Icon({
  name,
  className = "",
}: {
  name: keyof typeof icons;
  className?: string;
}) {
  const Glyph = icons[name];
  return (
    <span className={`source-icon ${className}`} aria-hidden="true">
      <Glyph />
    </span>
  );
}
export const IconButton = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & {
    label: string;
    children: ReactNode;
  }
>(function IconButton({ label, children, className = "", ...props }, ref) {
  const { trigger, container } = useTooltipContainer();
  useImperativeHandle(ref, () => trigger.current!);
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <button
          ref={trigger}
          type="button"
          className={`icon-button ${className}`}
          aria-label={label}
          {...props}
        >
          {children}
        </button>
      </Tooltip.Trigger>
      <Tooltip.Portal container={container}>
        <Tooltip.Content className="tooltip" role="tooltip" sideOffset={7}>
          {label}
          <Tooltip.Arrow className="tooltip-arrow" />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
});
export function Menu({
  trigger,
  children,
  align = "start",
  side = "bottom",
  className = "",
  label,
}: {
  trigger: ReactNode;
  children: ReactNode;
  align?: "start" | "end";
  side?: "top" | "right" | "bottom" | "left";
  className?: string;
  label?: string;
}) {
  const { t: tr } = useI18n();
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>{trigger}</DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <section aria-label={label || tr("Actions")}>
          <DropdownMenu.Content
            aria-label={label}
            className={`menu ${className}`}
            align={align}
            side={side}
            sideOffset={6}
            collisionPadding={8}
          >
            {children}
          </DropdownMenu.Content>
        </section>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
export function MenuItem({
  children,
  onSelect,
  shortcut,
  icon,
  danger = false,
  disabled = false,
}: {
  children: ReactNode;
  onSelect?: () => void;
  shortcut?: string;
  icon?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <DropdownMenu.Item
      className={`menu-item ${danger ? "danger" : ""}`}
      onSelect={onSelect}
      disabled={disabled}
    >
      {icon && <span className="menu-icon">{icon}</span>}
      <span className="item-label">{children}</span>
      {shortcut && <kbd>{shortcut}</kbd>}
    </DropdownMenu.Item>
  );
}
export const Separator = () => <DropdownMenu.Separator className="separator" />;
export function Modal({
  open,
  onOpenChange,
  title,
  children,
  className = "",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: ReactNode;
  className?: string;
}) {
  const { t: tr } = useI18n();
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="overlay" />
        <Dialog.Content
          aria-describedby={undefined}
          className={`modal ${className}`}
          onOpenAutoFocus={(event) => {
            if (!(event.target instanceof HTMLElement)) return;
            const field = event.target.querySelector<HTMLElement>(
              "input:not([disabled]), textarea:not([disabled])",
            );
            if (field) {
              event.preventDefault();
              field.focus();
            }
          }}
        >
          <header className="modal-header">
            <Dialog.Title>{title}</Dialog.Title>
            <Dialog.Close asChild>
              <button
                type="button"
                className="icon-button"
                aria-label={tr("Close")}
              >
                <X size={16 * ICON_SCALE} />
              </button>
            </Dialog.Close>
          </header>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
