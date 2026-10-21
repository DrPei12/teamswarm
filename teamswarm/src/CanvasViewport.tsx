import { useEffect, useRef } from "react";
import {
  useReactFlow,
  useStore,
  useNodesInitialized,
  type Node,
} from "@xyflow/react";
import { useMediaQuery } from "./ui";
const FOCUS_DURATION = 280;
export function CanvasViewport({
  selectedId,
  relatedIds,
  restored,
}: {
  selectedId?: string;
  relatedIds?: readonly string[];
  restored: boolean;
}) {
  const flow = useReactFlow<Node>();
  const width = useStore((state) => state.width);
  const height = useStore((state) => state.height);
  const ready = useNodesInitialized();
  const flowElement = useStore((state) => state.domNode);
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const focusUntil = useRef(0);
  const transition = useRef(0);
  // Stable across streamed workspace updates, even when callers rebuild arrays.
  const selectionKey = selectedId || relatedIds?.join("\0") || "";
  useEffect(() => {
    const element = flowElement?.closest(".canvas-view");
    if (!element) return;
    const cancel = () => {
      focusUntil.current = 0;
    };
    element.addEventListener("pointerdown", cancel, true);
    element.addEventListener("keydown", cancel, true);
    element.addEventListener("wheel", cancel, { passive: true, capture: true });
    return () => {
      element.removeEventListener("pointerdown", cancel, true);
      element.removeEventListener("keydown", cancel, true);
      element.removeEventListener("wheel", cancel, true);
    };
  }, [flowElement]);
  const previous = useRef<{
    width: number;
    height: number;
    selectionKey: string;
  } | null>(null);
  useEffect(() => {
    if (!ready || !width || !height) return;
    // The detail panel changes the available width in the same render. Let its
    // layout settle before choosing one destination for the viewport animation.
    const frame = requestAnimationFrame(() => {
      const last = previous.current;
      previous.current = { width, height, selectionKey };
      const resized =
        !!last && (last.width !== width || last.height !== height);
      const selected = !!selectionKey && selectionKey !== last?.selectionKey;
      if (!selectionKey) focusUntil.current = 0;
      const focusSelected =
        selected || (resized && performance.now() < focusUntil.current);
      // XYFlow's interrupted transitions may never resolve. A bounded focus
      // window and direct user input both release the automatic recentering.
      if (focusSelected)
        focusUntil.current = performance.now() + FOCUS_DURATION;
      if (
        (!last && !restored && !selectionKey) ||
        (last && !resized && !selected)
      )
        return;
      const current = flow.getViewport();
      let next = { ...current };
      if (resized) {
        next.x += (width - last.width) / 2;
        next.y += (height - last.height) / 2;
      }
      const nodes = flow.getNodes();
      const distance = (node: Node) => {
        const x =
          (node.position.x + (node.measured?.width || 304) / 2) * next.zoom +
          next.x;
        const y =
          (node.position.y + (node.measured?.height || 96) / 2) * next.zoom +
          next.y;
        return Math.hypot(x - width / 2, y - height / 2);
      };
      const target =
        nodes.find((node) => node.id === selectedId) ||
        nodes.reduce<Node | undefined>(
          (closest, node) =>
            !closest || distance(node) < distance(closest) ? node : closest,
          undefined,
        );
      if (!target) return;
      // An exchange belongs to both endpoints. Fit their shared bounds when
      // opening/returning to the exchange list, then leave manual zoom alone.
      const related = focusSelected
        ? nodes.filter((node) => selectionKey.split("\0").includes(node.id))
        : [];
      const framed = related.length ? related : [target];
      const nodeX = Math.min(...framed.map((node) => node.position.x));
      const nodeY = Math.min(...framed.map((node) => node.position.y));
      const nodeWidth =
        Math.max(
          ...framed.map(
            (node) => node.position.x + (node.measured?.width || 304),
          ),
        ) - nodeX;
      const nodeHeight =
        Math.max(
          ...framed.map(
            (node) => node.position.y + (node.measured?.height || 96),
          ),
        ) - nodeY;
      if (focusSelected)
        next = {
          zoom: 1,
          x: width / 2 - (nodeX + nodeWidth / 2),
          y: height / 2 - (nodeY + nodeHeight / 2),
        };
      const zoom = focusSelected
        ? Math.min(
            next.zoom,
            Math.max(framed.length > 1 ? 0.05 : 0.25, (width - 48) / nodeWidth),
            Math.max(
              framed.length > 1 ? 0.05 : 0.25,
              (height - 152) / nodeHeight,
            ),
          )
        : next.zoom;
      if (zoom !== next.zoom) {
        next = {
          zoom,
          x: width / 2 - (nodeX + nodeWidth / 2) * zoom,
          y: height / 2 - (nodeY + nodeHeight / 2) * zoom,
        };
      }
      const left = nodeX * zoom + next.x;
      const top = nodeY * zoom + next.y;
      next.x +=
        left < 24
          ? 24 - left
          : Math.min(0, width - 24 - left - nodeWidth * zoom);
      next.y +=
        top < 72
          ? 72 - top
          : Math.min(0, height - 80 - top - nodeHeight * zoom);
      if (
        Math.abs(next.x - current.x) > 0.5 ||
        Math.abs(next.y - current.y) > 0.5 ||
        next.zoom !== current.zoom
      ) {
        const revision = ++transition.current;
        void flow
          .setViewport(next, {
            duration: focusSelected && !reducedMotion ? FOCUS_DURATION : 0,
          })
          .then(() => {
            if (revision === transition.current) focusUntil.current = 0;
          });
      } else {
        focusUntil.current = 0;
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [
    ready,
    width,
    height,
    selectedId,
    selectionKey,
    restored,
    reducedMotion,
    flow,
  ]);
  return null;
}
