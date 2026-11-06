/**
 * Status vocabulary adapted from Caho1/open-claude-ui (MIT):
 * docs/v4.16336.0 status indicators. See licenses/open-claude-ui-MIT.txt.
 */
export type StatusKind =
  "idle" | "running" | "waiting" | "done" | "error" | "clay";

const statusLabels: Record<StatusKind, string> = {
  idle: "Idle",
  running: "Running",
  waiting: "Waiting",
  done: "Done",
  error: "Error",
  clay: "Ready",
};

export function StatusDot({
  kind = "idle",
  label,
  className = "",
}: {
  kind?: StatusKind;
  label?: string;
  className?: string;
}) {
  return (
    <span className={`status-indicator ${className}`} data-kind={kind}>
      <span className="status-dot" aria-hidden="true" />
      {label && <span className="status-label">{label}</span>}
    </span>
  );
}

/** Three-dot quiet wave for running reasoning and member activity. */
export function QuietDots({
  label,
  className = "",
}: {
  label?: string;
  className?: string;
}) {
  return (
    <span
      className={`status-indicator quiet-dots ${className}`}
      role="status"
      aria-label={label ?? statusLabels.running}
    >
      <span className="quiet-dots-track" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      {label && <span className="status-label">{label}</span>}
    </span>
  );
}

/** Map workspace status strings onto the shared indicator vocabulary. */
export function statusKind(status?: string): StatusKind {
  switch (status) {
    case "running":
    case "working":
    case "processing":
      return "running";
    case "waiting":
    case "queued":
    case "pending":
      return "waiting";
    case "done":
    case "completed":
    case "complete":
    case "ready":
      return "done";
    case "error":
    case "failed":
    case "interrupted":
      return "error";
    default:
      return "idle";
  }
}
