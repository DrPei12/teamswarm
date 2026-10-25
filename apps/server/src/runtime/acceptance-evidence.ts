import { createHash } from "node:crypto";
import { badRequest, conflict } from "../errors.js";
import type { AcceptanceEvidence, ExecutionRequirements, Work } from "./types.js";

export const MAX_ACCEPTANCE_CRITERIA = 100;

export function evidenceFor(work: Pick<Work, "acceptanceCriteria" | "acceptanceEvidence">): AcceptanceEvidence[] {
  return work.acceptanceCriteria.map((criterion, index) => ({
    criterion,
    evidenceType: work.acceptanceEvidence?.[index]?.criterion === criterion &&
      ["review_judgment", "native_check"].includes(work.acceptanceEvidence[index].evidenceType)
      ? work.acceptanceEvidence[index].evidenceType : "unresolved",
  }));
}

export function bindEvidence(criteria: string[], declared?: AcceptanceEvidence[], base?: Work): AcceptanceEvidence[] {
  if (new Set(criteria).size !== criteria.length || criteria.some(criterion => !criterion.trim()))
    throw badRequest("invalid_evidence_contract", "Acceptance criteria must be distinct, nonempty exact statements.");
  if (criteria.length > MAX_ACCEPTANCE_CRITERIA)
    throw badRequest("criteria_limit", "Split further acceptance criteria into explicitly assigned work.");
  if (declared && (declared.length !== criteria.length || declared.some((entry, index) =>
    entry.criterion !== criteria[index] || !["review_judgment", "native_check"].includes(entry.evidenceType))))
    throw badRequest("invalid_evidence_contract", "Declare review_judgment or native_check for every exact criterion, in order.");
  const prior = base ? evidenceFor(base) : [];
  const result = criteria.map((criterion, index) => ({ criterion,
    evidenceType: declared?.[index].evidenceType ?? prior.find(entry => entry.criterion === criterion)?.evidenceType ?? "unresolved",
  } as AcceptanceEvidence));
  for (const entry of prior) {
    const next = result.find(item => item.criterion === entry.criterion);
    if ((entry.evidenceType !== "review_judgment" && !next) ||
        (entry.evidenceType === "native_check" && next?.evidenceType !== "native_check"))
      throw conflict("evidence_contract_weakened", "Continue every pinned execution or unresolved criterion without weakening it. Changed requirements need explicitly replaced work.");
  }
  return result;
}

export function resolvedEvidence(work: Work): AcceptanceEvidence[] {
  const evidence = evidenceFor(work);
  if (evidence.some(entry => entry.evidenceType === "unresolved"))
    throw conflict("evidence_contract_unresolved", "The Host must classify each unresolved criterion with team_set_acceptance_evidence from the original requirements before verification can finish.");
  return evidence;
}

export function reviewRequirements(target: Work, requested?: ExecutionRequirements): ExecutionRequirements | undefined {
  if (!resolvedEvidence(target).some(entry => entry.evidenceType === "native_check")) return requested;
  if (requested?.nativeCommands === false)
    throw conflict("evidence_contract_weakened", "This work requires native command evidence; select a capable reviewer without disabling nativeCommands.");
  return { ...requested, nativeCommands: true };
}

export function reviewEvidenceContext(review: Work, target: Work): string {
  return createHash("sha256").update(JSON.stringify({
    reviewId: review.id, targetId: target.id, targetAttemptId: target.attemptId,
    artifactIds: target.artifactIds, acceptanceEvidence: evidenceFor(target),
    instructionsRevision: review.reviewInstructionsRevision ?? 1,
  })).digest("hex");
}
