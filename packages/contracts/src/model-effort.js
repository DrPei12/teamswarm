/** DeepSeek's published /models effort metadata and per-protocol thinking controls.
 * https://api-docs.deepseek.com/api/list-models/ · https://api-docs.deepseek.com/guides/thinking_mode/
 * Scope by both actual origin and model ID. A connection label or a third-party proxy is not a provider contract.
 */
const deepseek = Object.freeze({
  provider: "DeepSeek",
  supported: Object.freeze(["none", "low", "high", "max"]),
  defaultEffort: "high",
  source: "provider_contract",
});
const deepseekModels = new Set(["deepseek-flash", "deepseek-v4-pro"]);
export function apiEffortPolicy(config) {
  if (
    !config?.baseUrl ||
    config.chatgptAccountId ||
    !deepseekModels.has(config.model)
  )
    return null;
  try {
    const url = new URL(config.baseUrl);
    if (
      url.origin === "https://api.deepseek.com" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      /^\/(?:v1\/?|anthropic(?:\/v1)?\/?)?$/.test(url.pathname)
    )
      return deepseek;
  } catch {
    /* Invalid endpoints are rejected when the connection is saved. */
  }
  return null;
}
const aliases = new Map([
  ["minimal", "low"],
  ["medium", "high"],
  ["xhigh", "high"],
  ["ultra", "max"],
]);
export function canonicalApiEffort(policy, value) {
  if (!policy || !value) return null;
  const normalized = aliases.get(value) ?? value;
  return policy.supported.includes(normalized) ? normalized : null;
}
