import type { ProjectInsight } from "@team/contracts/runtime";
import { useI18n } from "./i18n";

export function InsightStatus({
  status,
}: {
  status: ProjectInsight["status"];
}) {
  const { t } = useI18n();
  return (
    <span data-insight-status={status} style={{ opacity: 1 }}>
      {t(`insight.${status}`)}
    </span>
  );
}
