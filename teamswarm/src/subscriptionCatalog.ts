import type { HarnessInspection } from "./harnessCatalog";
import { cachedCatalog } from "./modelCatalogCache";
import { api } from "./service";

export function readSubscriptionCatalog(
  id: string,
  refresh = false,
): Promise<HarnessInspection> {
  if (id.startsWith("chatgpt:")) {
    return cachedCatalog(
      id,
      async () => {
        const result = await api<{
          models: NonNullable<HarnessInspection["models"]>;
        }>(`/model-accounts/chatgpt/${encodeURIComponent(id.slice(8))}/models`);
        return {
          models: result.models.map((model) => ({
            ...model,
            provider: "OpenAI",
          })),
        };
      },
      refresh,
    );
  }
  return cachedCatalog(
    `harness:${id}`,
    () =>
      api<HarnessInspection>(`/harnesses/${encodeURIComponent(id)}/check`, {}),
    refresh,
  );
}
