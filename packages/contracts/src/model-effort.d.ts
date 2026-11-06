export interface ApiEffortPolicy {
  readonly provider: "DeepSeek";
  readonly supported: readonly string[];
  readonly defaultEffort: "high";
  readonly source: "provider_contract";
}
export function apiEffortPolicy(
  config?: {
    baseUrl?: string | null;
    model?: string | null;
    chatgptAccountId?: string | null;
  } | null,
): ApiEffortPolicy | null;
export function canonicalApiEffort(
  policy: ApiEffortPolicy | null,
  value?: string | null,
): string | null;
