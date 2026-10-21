import { memo } from "react";
import {
  BaseEdge,
  getBezierPath,
  useViewport,
  type Edge,
  type EdgeProps,
  type Node,
} from "@xyflow/react";

/** Choose facing ports from current positions, including during a node drag. */
export function connectionPorts(edge: Edge, nodes: Node[]) {
  const source = nodes.find((node) => node.id === edge.source);
  const target = nodes.find((node) => node.id === edge.target);
  if (!source || !target) return {};
  const dx = target.position.x - source.position.x;
  const dy = target.position.y - source.position.y;
  return Math.abs(dx) < 220 && Math.abs(dy) > 120
    ? {
        sourceHandle: dy > 0 ? "bottom" : "top",
        targetHandle: dy > 0 ? "top" : "bottom",
      }
    : {
        sourceHandle: dx >= 0 ? "right" : "left",
        targetHandle: dx >= 0 ? "left" : "right",
      };
}

export type SignalEdge = Edge<{
  active?: boolean;
  emphasized?: boolean;
  muted?: boolean;
  label?: string;
  lastEvent?: unknown;
  directions?: number[];
}>;

/** The moving segment is mounted only while a real handoff is active. */
export const CollaborationEdge = memo(function CollaborationEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  selected,
  markerEnd,
}: EdgeProps<SignalEdge>) {
  const { zoom } = useViewport();
  const [path] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    curvature: 0.38,
  });
  return (
    <g
      className={`swarm-connection ${data?.active ? "is-active" : ""} ${selected || data?.emphasized ? "is-emphasized" : ""} ${data?.muted ? "is-muted" : ""}`}
    >
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        interactionWidth={40 / zoom}
        className="connection-track"
      />
      {data?.active &&
        (data.directions?.length ? data.directions : [1]).map((direction) => (
          <path
            key={direction}
            d={path}
            pathLength={100}
            className="connection-signal"
            fill="none"
            aria-hidden="true"
            style={{ animationDirection: direction < 0 ? "reverse" : "normal" }}
          />
        ))}
      <circle cx={sourceX} cy={sourceY} r={3.5} className="connection-port" />
      <circle cx={targetX} cy={targetY} r={3.5} className="connection-port" />
    </g>
  );
});

export const collaborationEdgeTypes = { signal: CollaborationEdge };
