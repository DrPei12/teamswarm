import { createHash } from "node:crypto";
import { WorkspaceAccess } from "./workspace-access.js";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const set = (values: string[] = []) => [...new Set(values)].sort();
/** Compare responsibility, evidence and authority separately from presentation text. */
export function delegationIdentity(input: Record<string, any>) {
  const paths = input.writePaths?.map((p: string) => {
    const relative = WorkspaceAccess.relative(p, true);
    return process.platform === "win32" ? relative.toLowerCase() : relative;
  });
  const contract = {
    memberId: input.memberId, acceptanceCriteria: set(input.acceptanceCriteria),
    acceptanceEvidence: input.acceptanceEvidence?.slice().sort((a: any, b: any) => a.criterion.localeCompare(b.criterion)) ?? null,
    contextRefs: set(input.contextRefs),
    inputs: set(input.inputArtifactIds), dependsOn: set(input.dependsOn),
    reviewOf: input.reviewOf ?? null, verification: input.verification ?? "independent",
    continuationOf: input.continuationOf ?? null, writePaths: paths ? set(paths) : null,
    executionRequirements: Object.fromEntries(Object.entries(input.executionRequirements ?? {}).filter(([,v]) => v).sort()),
    workspaceMode: input.workspaceMode ?? "isolated", publicationMode: input.publicationMode ?? "automatic", integratesWorkIds: set(input.integratesWorkIds), permissions: input.permissions ?? null,
  };
  return {
    key: input.responsibilityKey ?? (paths?.length
      ? `owned:${digest({ paths: set(paths), continuationOf: contract.continuationOf })}` : undefined),
    contract: digest(contract),
    fingerprint: digest({ ...contract, title: input.title.trim(), instructions: input.instructions.trim() }),
  };
}
