export function harnessId(name) {
  return (
    {
      Codex: "codex",
      "Claude Code": "claude-code",
      Grok: "grok",
      "DeepSeek Harness": "deepseek-harness",
      OpenCode: "opencode",
    }[name] ?? name
  );
}
export function supportedEfforts(inspection, model) {
  if (!inspection || inspection.capabilities?.reasoningEffort === false)
    return [];
  const selected =
    !model || model === "Default model"
      ? inspection.models?.find((m) => m.isDefault)
      : inspection.models?.find((m) => m.model === model);
  return [
    ...new Map(
      (selected?.reasoningEfforts ?? [])
        .filter(
          (e) =>
            typeof e.reasoningEffort === "string" && e.reasoningEffort.trim(),
        )
        .map((e) => [e.reasoningEffort, e]),
    ).values(),
  ];
}
export function effortLabel(value) {
  return value ? value[0].toUpperCase() + value.slice(1) : "Default";
}
