export type HarnessInspection = {
  id?: string;
  authenticated?: boolean;
  version?: string;
  available?: boolean;
  installed?: boolean;
  error?: string;
  capabilities?: { reasoningEffort?: boolean };
  models?: {
    model: string;
    name: string;
    provider?: string;
    isDefault?: boolean;
    reasoningEfforts?: { reasoningEffort: string; description?: string }[];
  }[];
};

export function harnessId(name: string) {
  return (
    (
      {
        Codex: "codex",
        "Claude Code": "claude-code",
        Grok: "grok",
        "DeepSeek Harness": "deepseek-harness",
        OpenCode: "opencode",
      } as Record<string, string>
    )[name] ?? name
  );
}

export function harnessLabel(id: string) {
  return (
    ["Codex", "Claude Code", "Grok", "pi", "DeepSeek Harness", "OpenCode"].find(
      (name) => harnessId(name) === id,
    ) ?? id
  );
}

export function supportedEfforts(
  inspection: HarnessInspection | null,
  model?: string | null,
) {
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

export function effortLabel(value: string) {
  return value ? value[0].toUpperCase() + value.slice(1) : "Default";
}
