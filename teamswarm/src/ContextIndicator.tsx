import { useEffect, useRef, useState } from "react";
import { Tooltip } from "radix-ui";
import type { ContextWindowUsage } from "@team/contracts/product";
import { useI18n } from "./i18n";
import { ICON_SCALE, useTooltipContainer } from "./ui";

function tokens(value: number, locale: string) {
  const scale = value >= 1_000_000 ? 1_000_000 : value >= 1_000 ? 1_000 : 1;
  return (
    (value / scale).toLocaleString(locale, {
      maximumFractionDigits: scale > 1 && value / scale < 10 ? 1 : 0,
    }) + (scale === 1_000_000 ? "M" : scale === 1_000 ? "k" : "")
  );
}
export function ContextIndicator({ usage }: { usage?: ContextWindowUsage }) {
  const { t, locale } = useI18n();
  const { trigger, container } = useTooltipContainer();
  const content = useRef<HTMLDivElement>(null);
  const [hovered, setHovered] = useState(false),
    [pinned, setPinned] = useState(false);
  useEffect(() => {
    if (!pinned) return;
    const dismiss = (e: PointerEvent) => {
      if (
        e.target instanceof Node &&
        !trigger.current?.contains(e.target) &&
        !content.current?.contains(e.target)
      ) {
        setPinned(false);
        setHovered(false);
      }
    };
    document.addEventListener("pointerdown", dismiss, true);
    return () => document.removeEventListener("pointerdown", dismiss, true);
  }, [pinned, trigger]);
  const used = usage?.used,
    limit = usage?.limit;
  const hasUsed =
    typeof used === "number" && Number.isFinite(used) && used >= 0;
  const hasLimit =
    typeof limit === "number" && Number.isFinite(limit) && limit > 0;
  const fraction = hasUsed && hasLimit ? Math.min(1, used / limit) : null;
  const percent = fraction === null ? null : Math.floor(fraction * 100);
  const approximate = usage?.estimated || usage?.limitSource === "estimate";
  const summary =
    percent !== null
      ? t(
          approximate
            ? "About {used}% used ({remaining}% left)"
            : "{used}% used ({remaining}% left)",
          { used: percent, remaining: 100 - percent },
        )
      : hasUsed
        ? t("Window size unavailable")
        : t("No usage for this model yet");
  const detail =
    hasUsed && hasLimit
      ? t("{used} of {total} tokens used", {
          used: tokens(used, locale),
          total: tokens(limit, locale),
        })
      : hasLimit
        ? t("Window: {total} tokens", { total: tokens(limit, locale) })
        : hasUsed
          ? t("{used} tokens used", { used: tokens(used, locale) })
          : t("Usage appears when the Harness reports it.");
  const source =
    usage?.limitSource === "estimate"
      ? t("Estimated window")
      : usage?.limitSource === "configured"
        ? t("Configured window")
        : null;
  return (
    <Tooltip.Root
      delayDuration={160}
      open={hovered || pinned}
      onOpenChange={setHovered}
    >
      <Tooltip.Trigger asChild>
        <button
          type="button"
          className="context-ring"
          ref={trigger}
          aria-label={t("Context window")}
          onClick={(event) => {
            event.preventDefault();
            setPinned(!pinned);
            setHovered(false);
          }}
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
              opacity=".22"
            />
            {fraction !== null && (
              <circle
                cx="10"
                cy="10"
                r="7"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                pathLength="100"
                strokeDasharray={String(fraction * 100) + " 100"}
                transform="rotate(-90 10 10)"
              />
            )}
          </svg>
        </button>
      </Tooltip.Trigger>
      <Tooltip.Portal container={container}>
        <Tooltip.Content
          ref={content}
          className="context-details"
          side="top"
          align="center"
          sideOffset={9}
          collisionPadding={10}
          onEscapeKeyDown={() => {
            setPinned(false);
            setHovered(false);
          }}
        >
          <span className="context-details-heading">{t("Context window")}</span>
          <strong>{summary}</strong>
          <span>{detail}</span>
          {source && <small>{source}</small>}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
