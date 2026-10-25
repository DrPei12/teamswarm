export const judgmentEvidence = (criteria: string[]) => criteria.map(criterion => ({
  criterion, evidenceType: "review_judgment" as const,
}));

export function withJudgmentEvidence(name: string, input: any) {
  return name === "team_delegate" && !input.reviewOf && input.acceptanceEvidence === undefined
    ? { ...input, acceptanceEvidence: judgmentEvidence(input.acceptanceCriteria) } : input;
}
