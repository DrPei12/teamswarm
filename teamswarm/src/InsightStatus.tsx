import type { ProjectInsight } from "@team/contracts/runtime";
import { useI18n } from "./i18n";

export function InsightStatus({
  insight,
}: {
  insight: Pick<ProjectInsight, "status" | "author">;
}) {
  const { t } = useI18n();
  const status =
    insight.status === "adopted" && insight.author !== "user"
      ? "hostAdopted"
      : insight.status;
  return (
    <span data-insight-status={status} style={{ opacity: 1 }}>
      {t(`insight.${status}`)}
    </span>
  );
}
