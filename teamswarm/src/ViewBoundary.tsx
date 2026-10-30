import { Component, type ErrorInfo, type ReactNode } from "react";
import { useI18n } from "./i18n";

class Boundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("TeamSwarm view failed", error, info.componentStack);
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

export function ViewBoundary({
  children,
  onBack,
}: {
  children: ReactNode;
  onBack?: () => void;
}) {
  const { t } = useI18n();
  return (
    <Boundary
      fallback={
        <div className="view-feedback" role="alert">
          <p>{t("This page could not be loaded.")}</p>
          <div className="view-feedback-actions">
            <button
              className="secondary-button"
              onClick={() => location.reload()}
            >
              {t("Reload")}
            </button>
            {onBack && (
              <button className="text-button" onClick={onBack}>
                {t("Back to conversation")}
              </button>
            )}
          </div>
        </div>
      }
    >
      {children}
    </Boundary>
  );
}

export function installPreloadRecovery() {
  window.addEventListener("vite:preloadError", () => {
    // Draft edits are persisted synchronously by PreferencesOutbox. Recover a
    // stale chunk once, then leave the error UI available if loading still fails.
    try {
      const key = "teamswarm.preload-recovery";
      const now = Date.now();
      if (now - Number(sessionStorage.getItem(key) || 0) < 60000) return;
      sessionStorage.setItem(key, String(now));
      location.reload();
    } catch {
      // Storage may be unavailable; the boundary still offers manual recovery.
    }
  });
}
