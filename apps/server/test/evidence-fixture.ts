export const judgmentEvidence = (criteria: string[]) => criteria.map(criterion => ({
  criterion, evidenceType: "review_judgment" as const,
}));

export function withJudgmentEvidence(name: string, input: any) {
  return name === "team_delegate" && !input.reviewOf && input.acceptanceEvidence === undefined
    ? { ...input, acceptanceEvidence: judgmentEvidence(input.acceptanceCriteria) } : input;
}
/** Orchestration fixtures explicitly opt into Host-managed worker permissions.
 * Keep their synthetic model catalogs independent from real account setup.
 * Permission-policy tests use the unmodified capability store instead. */
export function autonomousWorkers(runtime: import("../src/runtime/engine.js").TeamRuntime) {
  const read = runtime.catalog.capabilities.read.bind(runtime.catalog.capabilities);
  runtime.catalog.capabilities.read = teamId => {
    const state = read(teamId);
    return { ...state, preferences: { ...state.preferences, workerPolicy: "autonomous" } };
  };
}
