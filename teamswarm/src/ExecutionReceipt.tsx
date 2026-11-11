import type { HostExecution } from "@team/contracts/product";
import { StatusDot, statusKind } from "./design-system/StatusIndicators";
import { useI18n } from "./i18n";

/** A system execution receipt. It reports persisted facts and never invents assistant speech. */
export function ExecutionReceipt({ execution }: { execution: HostExecution }) {
  const { t } = useI18n();
  const failed = ["failed", "interrupted", "recovery_required"].includes(
    execution.status,
  );
  return (
    <div
      className={`execution-receipt ${execution.status}`}
      role={failed ? "alert" : "status"}
    >
      <StatusDot
        kind={statusKind(execution.status)}
        label={t(execution.status)}
      />
      {execution.error && (
        <p className="execution-receipt-error">{t(execution.error)}</p>
      )}
      {execution.detail && execution.detail !== execution.error && (
        <p className="execution-receipt-detail">{execution.detail}</p>
      )}
    </div>
  );
}
