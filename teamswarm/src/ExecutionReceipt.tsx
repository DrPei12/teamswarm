import type { HostExecution } from "@team/contracts/product";
import { StatusDot, statusKind } from "./design-system/StatusIndicators";
import { useI18n } from "./i18n";

const infrastructureLabel = {
  provider_access: "The model provider denied access.",
  provider_quota:
    "The model provider requires available credits or a payment method.",
  provider_rate_limit: "The model provider rate or quota limit was reached.",
  provider_unavailable: "The model provider could not serve the request.",
  provider_network: "Model provider connection failed.",
} satisfies Record<NonNullable<HostExecution["infrastructureFault"]>, string>;

/** Displays the work outcome and the associated execution state. */
export function ExecutionReceipt({ execution }: { execution: HostExecution }) {
  const { t } = useI18n();
  const failed = ["failed", "interrupted", "recovery_required"].includes(
    execution.status,
  );
  const cause =
    execution.infrastructureFault &&
    infrastructureLabel[execution.infrastructureFault];
  return (
    <div
      className={`execution-receipt ${execution.status}`}
      data-execution-status={execution.executionStatus}
      role={failed ? "alert" : "status"}
    >
      <StatusDot
        kind={statusKind(execution.status)}
        label={t(execution.status)}
      />
      {failed && execution.executionStatus === "completed" && (
        <p className="execution-receipt-detail">{t("Execution completed")}</p>
      )}
      {cause && cause !== execution.error && (
        <p className="execution-receipt-detail">{t(cause)}</p>
      )}
      {execution.error && (
        <p className="execution-receipt-error">{t(execution.error)}</p>
      )}
      {execution.detail && execution.detail !== execution.error && (
        <p className="execution-receipt-detail">{execution.detail}</p>
      )}
    </div>
  );
}
