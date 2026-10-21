import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent, RefObject } from "react";

function savedWidth(key: string, min: number, max: number) {
  try {
    const value = Number(localStorage.getItem(key));
    return value >= min && value <= max ? value : undefined;
  } catch {
    return undefined;
  }
}

function saveWidth(key: string, width?: number) {
  try {
    if (width === undefined) localStorage.removeItem(key);
    else localStorage.setItem(key, String(width));
  } catch {
    // Resizing remains available when browser storage is unavailable.
  }
}

export function usePanelResize(
  panel: RefObject<HTMLElement | null>,
  enabled: boolean,
  {
    side = "right",
    key = "teamswarm.detail-width",
    min = 360,
    max = 960,
    reserve = 260,
  }: {
    side?: "left" | "right";
    key?: string;
    min?: number;
    max?: number;
    reserve?: number;
  } = {},
) {
  const [preferredWidth, setPreferredWidth] = useState(() =>
    savedWidth(key, min, max),
  );
  const [bounds, setBounds] = useState({
    max,
    natural: side === "left" ? 260 : 500,
  });
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{
    pointerId: number;
    x: number;
    width: number;
    original?: number;
    moved: boolean;
  } | null>(null);
  const pendingWidth = useRef<number | undefined>(undefined);
  const clamp = (value: number) =>
    Math.round(Math.min(bounds.max, Math.max(min, value)));
  const width =
    preferredWidth === undefined ? undefined : clamp(preferredWidth);

  useLayoutEffect(() => {
    if (!enabled || preferredWidth !== undefined || !panel.current) return;
    const natural = Math.round(panel.current.getBoundingClientRect().width);
    setBounds((current) =>
      current.natural === natural ? current : { ...current, natural },
    );
  }, [enabled, preferredWidth, panel]);

  useLayoutEffect(() => {
    const element = panel.current;
    if (!enabled || !element?.parentElement) return;
    const parent = element.parentElement;
    const measure = () => {
      setBounds({
        max: Math.max(min, Math.min(max, parent.clientWidth - reserve)),
        natural: Math.round(element.getBoundingClientRect().width),
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(parent);
    observer.observe(element);
    return () => observer.disconnect();
  }, [enabled, panel, min, max, reserve]);

  const finish = () => {
    if (!drag.current) return;
    if (drag.current.moved) saveWidth(key, pendingWidth.current);
    drag.current = null;
    setDragging(false);
  };
  const cancel = () => {
    if (!drag.current) return;
    setPreferredWidth(drag.current.original);
    drag.current = null;
    setDragging(false);
  };
  useEffect(() => {
    if (!dragging) return;
    document.documentElement.dataset.paneDragging = "true";
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      cancel();
    };
    window.addEventListener("keydown", escape, true);
    window.addEventListener("blur", finish);
    return () => {
      delete document.documentElement.dataset.paneDragging;
      window.removeEventListener("keydown", escape, true);
      window.removeEventListener("blur", finish);
    };
  }, [dragging]);

  useEffect(() => {
    if (!enabled) finish();
  }, [enabled]);

  return {
    expandedWidth: width ?? clamp(side === "left" ? 260 : 500),
    style: enabled
      ? {
          minWidth: min,
          maxWidth: bounds.max,
          ...(width !== undefined ? { width, flexBasis: width } : {}),
        }
      : undefined,
    handle: {
      "aria-valuemin": min,
      "aria-valuemax": bounds.max,
      "aria-valuenow": width ?? bounds.natural,
      "data-dragging": dragging || undefined,
      onPointerDown: (event: PointerEvent<HTMLDivElement>) => {
        if (event.button !== 0 || !event.isPrimary || !panel.current) return;
        event.preventDefault();
        event.currentTarget.focus({ preventScroll: true });
        event.currentTarget.setPointerCapture(event.pointerId);
        const currentWidth = panel.current.getBoundingClientRect().width;
        pendingWidth.current = currentWidth;
        drag.current = {
          pointerId: event.pointerId,
          x: event.clientX,
          width: currentWidth,
          original: preferredWidth,
          moved: false,
        };
      },
      onPointerMove: (event: PointerEvent<HTMLDivElement>) => {
        if (!drag.current || event.pointerId !== drag.current.pointerId) return;
        // The reference's 4px dead zone prevents a click from becoming a resize.
        if (!drag.current.moved && Math.abs(event.clientX - drag.current.x) < 4)
          return;
        drag.current.moved = true;
        setDragging(true);
        const next = clamp(
          drag.current.width +
            (drag.current.x - event.clientX) * (side === "left" ? -1 : 1),
        );
        pendingWidth.current = next;
        setPreferredWidth(next);
      },
      onPointerUp: (event: PointerEvent<HTMLDivElement>) => {
        if (event.pointerId !== drag.current?.pointerId) return;
        finish();
        event.currentTarget.releasePointerCapture(event.pointerId);
      },
      onPointerCancel: cancel,
      onLostPointerCapture: finish,
      onDoubleClick: () => {
        saveWidth(key);
        setPreferredWidth(undefined);
      },
      onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => {
        const currentWidth = panel.current?.getBoundingClientRect().width;
        if (!currentWidth) return;
        const next = {
          ArrowLeft: currentWidth + (side === "left" ? -24 : 24),
          ArrowRight: currentWidth + (side === "left" ? 24 : -24),
          Home: min,
          End: bounds.max,
        }[event.key];
        if (next === undefined) return;
        event.preventDefault();
        event.stopPropagation();
        const value = clamp(next);
        saveWidth(key, value);
        setPreferredWidth(value);
      },
    },
  };
}
