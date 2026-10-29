import { MAX_ACCEPTANCE_CRITERIA } from "./acceptance-evidence.js";
import { adoptionContextInput, adoptionInput } from "./branch-adoption.js";
import { z } from "zod";
import { nativePermissions } from "./harness/permissions.js";
import { badRequest } from "../errors.js";
import { definitionInput } from "./project-history.js";
import { insightInput } from "./collaboration-records.js";

export const key = z.string().trim().min(1).max(200);
export const text = z.string().trim().min(1).max(20000);
export const executionRequirements = z.object({
  nativeCommands: z.boolean().optional(), childProcesses: z.boolean().optional(),
  scratchWrite: z.boolean().optional(), loopback: z.boolean().optional(), fileLinks: z.boolean().optional(),
}).strict();
const acceptanceEvidence = z.array(z.object({
  criterion: z.string().min(1).max(1000),
  evidenceType: z.enum(["review_judgment", "native_check"]),
}).strict()).max(MAX_ACCEPTANCE_CRITERIA);
const nullableName = z.string().trim().min(1).max(200).nullable().default(null);
export const executionConfig = z
  .object({
    harness: z.string().trim().min(1).max(64).default("codex"),
    chatgptAccountId: z.string().uuid().nullable().optional(),
    model: nullableName,
    provider: nullableName,
    baseUrl: z
      .string()
      .url()
      .max(2000)
      .refine((value) => {
        const u = new URL(value);
        return (
          ["http:", "https:"].includes(u.protocol) &&
          !u.username &&
          !u.password &&
          !u.search &&
          !u.hash
        );
      }, "Use an http(s) provider URL without credentials, query or fragment.")
      .nullable()
      .default(null),
    credentialEnv: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{1,127}$/)
      .nullable()
      .default(null),
    effort: z
      .string()
      .trim()
      .regex(/^[a-zA-Z0-9_-]{1,64}$/)
      .nullable()
      .default(null),
    access: z.enum(["read-only", "workspace-write"]).default("workspace-write"),
    permissions: nativePermissions.optional(),
    protocol: z
      .enum(["responses", "chat-completions", "anthropic-messages"])
      .nullable()
      .optional(),
    thinkingFormat: z.enum(["qwen"]).nullable().optional(),
    maxOutputTokens: z.number().int().min(1).max(131072).nullable().optional(),
    contextWindowTokens: z.number().int().min(1024).max(2097152).nullable().optional(),
  })
  .strict();
export const runtimeSettings = z
  .object({
    expectedVersion: z.number().int().min(0),
    workspace: z.string().trim().min(1).max(4096),
    config: executionConfig,
    maxConcurrent: z.number().int().positive().optional(),
    maxWorksPerRun: z.number().int().min(2).max(100).default(20),
    maxTurnsPerWork: z.number().int().min(1).max(100).default(20),
    timeoutSeconds: z.number().int().min(10).max(3600).default(600),
    hostContextMaxBytes: z.number().int().min(32000).max(524288).optional(),
    hostSessionMaxTurns: z.number().int().min(1).max(20).optional(),
    allowIsolatedWorkspaces: z.boolean().default(true),
  })
  .strict();
export const memberInput = z
  .object({
    name: z.string().trim().min(1).max(80),
    responsibility: text,
    config: executionConfig,
  })
  .strict();
export function parse<T extends z.ZodType>(
  schema: T,
  input: unknown,
): z.output<T> {
  const result = schema.safeParse(input);
  if (!result.success)
    throw badRequest(
      "invalid_input",
      result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; "),
    );
  return result.data;
}
export const tools = {
  team_device_resources: {
    description: "Host only. Read fresh device memory, Windows commit headroom, CPU load, process counts, shared reserve policy, per-Harness measured costs and estimated additional starts. This is device-wide across Teams. Forecasts change with load; use them when arranging parallel work.",
    schema: z.object({}).strict(),
  },
  team_set_device_reserve: {
    description: "Host dialogue only. Apply the user's explicit device memory reserve (MiB, 1024 MiB = 1 GiB), or null for automatic headroom. Optionally set the CPU utilization target. This affects all Teams on this device, including queued work; running work continues. Read team_device_resources for expectedVersion. Cite the latest user message and its complete verbatim content as authorizationQuote. Preserve the user's reserve until they change it. Explain the applied setting in the conversation.",
    schema: z.object({expectedVersion:z.number().int().nonnegative(),reserveMemoryMiB:z.number().int().nonnegative().nullable(),
      cpuTargetPercent:z.number().min(10).max(100).optional(),sourceMessageId:key,authorizationQuote:text}).strict(),
  },
  team_save_insight: {
    description:
      "Preserve a useful idea or decision with exact sourceMessageIds from the current input or team_state. Use a stable key and expectedRevision (0 for new). Proposed/rejected/superseded ideas are NOT effective requirements. Host records explicit user judgments as adopted, uncertainty as proposed. When adopting a branch into mainline, keep its ideas proposed until team_adopt_branch atomically publishes them; use that tool instead of simply changing the insight status. Members may only propose. Never invent source IDs or turn a tentative idea into a commitment.",
    schema: insightInput,
  },
  team_insight_sources: {
    description:
      "Read the original messages cited by a saved project idea or decision, including superseded reasoning.",
    schema: z.object({ insightId: key }).strict(),
  },
  team_message: {
    description:
      "Send an actual message to another Team member (including Host). The recipient receives it on their next inbox read or native turn boundary. Use replyTo when answering a received message. Sending does not transfer work ownership. Never poll or sleep waiting for replies; continue independent work.",
    schema: z
      .object({
        recipientId: key,
        content: text,
        replyTo: key.optional(),
        targetWorkId: key.optional(),
      })
      .strict(),
  },
  team_directory: {
    description:
      "Browse concise, paginated resources, models, harnesses, members or Runs (including failed requests without production work). Expand candidates with team_directory_detail. Consider existing member context before creating a new member.",
    schema: z
      .object({
        kind: z
          .enum(["resources", "models", "members", "harnesses", "runs"])
          .default("resources"),
        query: z.string().max(200).default(""),
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(30).default(10),
      })
      .strict(),
  },
  team_directory_detail: {
    description:
      "Read resource configuration and observed history, model combinations, harness capabilities, member responsibility and session compatibility, or a Run's original requirement and Host outcome. No quality ranking or quota is inferred.",
    schema: z
      .object({
        kind: z.enum(["resource", "model", "member", "harness", "run"]),
        id: key,
      })
      .strict(),
  },
  team_check_resource: {
    description: "Host only. Refresh a saved resource's installed Harness, native subscription login or API credential presence, supported native models and effort options. No generation request, login or installation is performed. Configured credentials and a listed model do not prove model availability or quota. Custom endpoints keep their own model catalog; never substitute the subscription model list for them.",
    schema: z.object({ resourceId: key, expectedResourceVersion: z.number().int().positive() }).strict(),
  },
  team_select_resource: {
    description: "Host only. Select a saved resource for an idle member, nonexecuting unfinished work, or your own FUTURE turns in this branch. Read exact resource version and target allocationRevision/work revision from team_directory_detail/team_read_work. For target=host omit targetId and use the Host's branch allocationRevision. Task choice overrides member default. Running Attempts never change. A configuration change starts a new native session with retained Team context. No credential, endpoint, access or account permission is granted by selecting a resource.",
    schema: z.object({ target: z.enum(["host", "member", "work"]), targetId: key.optional(), expectedRevision: z.number().int().positive(), resourceId: key, expectedResourceVersion: z.number().int().positive(), reason: text }).strict(),
  },
  team_derive_resource: {
    description: "Host only. Save another model/effort choice using an EXISTING user-configured resource. Copies its Harness, endpoint, credential reference and maximum access unchanged. Read the native model/effort catalog with team_check_resource for subscriptions; use only user-provided model IDs for custom APIs. Does not switch any execution or verify access. Cannot add credentials, log in or change endpoints.",
    schema: z.object({ sourceResourceId: key, expectedResourceVersion: z.number().int().positive(), name: z.string().trim().min(1).max(100), model: key, effort: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/).nullable().default(null), reason: z.string().trim().min(1).max(2000) }).strict(),
  },
  team_context_index: {
    description: "Find project definitions, working notes, decisions, members and work in this branch. Expand topics or search by task; use returned refs with team_context_read. Filter by workId or memberId for a handoff. sinceAttemptId lists changed and removed material since that attempt.",
    schema: z.object({ query: z.string().max(500).default(""), topic: z.string().max(200).optional(), workId: key.optional(), memberId: key.optional(), sinceAttemptId: key.optional(), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(50).default(20) }).strict(),
  },
  team_context_read: {
    description:
      "Read branch materials by refs, or search original messages and notes. Follow nextOffset for content and nextRefOffset for remaining batch refs; on continuation pass expectedRevisions from the preceding page. section=links/sources pages complete relationships and provenance when linkCount/sourceCount exceed the header preview. Use messageId for an original message, or document:<revision> for a historical definition in this branch. If a revision changes, restart at offset 0.",
    schema: z
      .object({
        kind: z.enum(["messages", "notes", "materials"]),
        refs: z.array(z.string().min(1).max(256)).min(1).max(20).optional(),
        messageId: key.optional(),
        expectedRevisions: z.record(z.string().min(1).max(256),key).optional(),
        section: z.enum(["body","links","sources"]).default("body"),
        maxChars: z.number().int().min(256).max(32000).default(12000),
        query: z.string().max(200).default(""),
        conversationId: key.optional(),
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(20).default(5),
      })
      .strict().refine(v => v.kind !== "materials" || !!v.refs?.length, "refs are required for materials"),
  },
  team_host_note: {
    description:
      "Host only. Maintain a sourced project overview, decision, reusable experience or working note under a stable key. Write project facts directly; keep process narration and update history out of content. Reference current definitions/work with sourceRefs and original discussion with sourceMessageIds. Use memberIds for member-specific material. Refresh notes when their sources change; resolve settled working notes. Requirements and permissions remain in the project definition.",
    schema: z
      .object({
        key,
        title: z.string().trim().min(1).max(160).optional(),
        kind: z.enum(["overview", "decision", "experience", "working"]).optional(),
        topic: z.string().regex(/^[\p{L}\p{N}_/-]+$/u).max(120).optional(),
        sourceRefs: z.array(key).max(30).default([]),
        sourcePaths: z.array(z.string().min(1).max(2000)).max(30).default([]),
        expectedSourceRevisions: z.record(key,key).optional().describe("Exact returned revision for each sourceRef."),
        expectedFileHashes: z.record(z.string().max(2000),z.string().regex(/^[a-f0-9]{64}$/)).optional().describe("sha256 returned by team_read_file for each sourcePath."),
        memberIds: z.array(key).max(30).default([]),
        expectedVersion: z.number().int().min(0),
        content: z.string().trim().min(1).max(3000),
        status: z.enum(["open", "resolved"]),
        sourceMessageIds: z.array(key).max(20).default([]),
      })
      .strict().refine(v => v.sourceRefs.length + v.sourceMessageIds.length + v.sourcePaths.length > 0, "Cite sourceRefs, sourcePaths or sourceMessageIds"),
  },
  team_inbox: {
    description:
      "Read newly delivered exact-thread messages and pending exchange headers at natural work boundaries. Reply to a direct message with team_message and replyTo; read exchange details with team_read_exchange before team_reply. Exchange registration or delivery is not a read receipt. No polling or receipt-only reply is needed.",
    schema: z.object({}).strict(),
  },
  team_read_exchange: {
    description:
      "Read a participant conversation or, during a formal review, exchanges originating from or containing messages by the exact reviewed Work. Returns messages, context, commitments and observed read sequences. Review access is read-only and branch-scoped. Records this attempt's actual receipt.",
    schema: z.object({ exchangeId: key }).strict(),
  },
  team_send: {
    description:
      "Contact another member directly while continuing independent work. Use a stable requestKey per work to prevent duplicate requests after retries. Do not send passwords or entire chats. Routine collaboration needs no Host relay.",
    schema: z
      .object({
        requestKey: key,
        recipientId: key,
        topic: z.string().trim().min(1).max(160),
        kind: z.enum(["request", "notice"]).default("request"),
        content: text,
        artifactIds: z.array(key).max(30).default([]),
      })
      .strict(),
  },
  team_reply: {
    description:
      "Reply with useful information, questions, a scoped commitment, or decline. An answer does not resolve the initiator's problem or accept any work. accept requires commitment with a due time; optionally name your own work after which to help. Late replies remain historical. Stable messageKey deduplicates across turns of this work.",
    schema: z
      .object({
        exchangeId: key,
        messageKey: key,
        kind: z.enum(["comment", "accept", "answer", "decline"]),
        content: text,
        artifactIds: z.array(key).max(30).default([]),
        commitment: z
          .object({
            text,
            afterWorkId: key.optional(),
            dueAt: z.iso.datetime(),
          })
          .strict()
          .optional(),
      })
      .strict(),
  },
  team_resolve: {
    description:
      "Initiator records resolution or cancellation with reasons. usedMessageIds are claims of application, not proof. This does not accept a production work.",
    schema: z
      .object({
        exchangeId: key,
        messageKey: key,
        outcome: z.enum(["resolved", "cancelled"]),
        content: text,
        usedMessageIds: z.array(key).max(30).default([]),
      })
      .strict(),
  },
  team_yield: {
    description:
      "Checkpoint unfinished responsibility and END this native turn. Work remains open and resumes in a later turn. Finish independent work before waiting; waitForExchangeIds waits for a useful reply, cancellation, or new inbound collaboration. Empty list continues at next scheduling boundary. Never sleep/poll; call this only before result submission. After team_submit_result succeeds, end with a final response instead of calling this tool or submitting again. A native turn ending alone does not checkpoint unfinished work.",
    schema: z
      .object({
        summary: text,
        waitForExchangeIds: z.array(key).max(30).default([]),
        waitSeconds: z.number().int().min(1).max(3600).default(300),
      })
      .strict(),
  },
  team_project_context: {
    description:
      "Read the complete shared project definition for your branch. Bodies contain the definition only; history is separate. Reading records receipt, not understanding.",
    schema: z.object({}).strict(),
  },
  team_acknowledge_context: {
    description:
      "After reading changed project context and reconsidering your work, acknowledge the node you are now using. This is your application claim, not independent proof.",
    schema: z.object({ nodeId: key }).strict(),
  },
  team_adoption_context: {
    description: "Host dialogue only. On an explicit user decision to adopt this branch, provide the complete verbatim current user message as authorizationQuote. Read source, base and current mainline documents plus current ideas for a bounded merge. Does not change documents.",
    schema: adoptionContextInput,
  },
  team_adopt_branch: {
    description: "Host dialogue only. Atomically integrate explicitly adopted source ideas into complete mainline documents with both observed heads. Preserve branch and provenance. Use only current proposed insight IDs. Re-read context on conflict. This does not merge code or authorize implementation.",
    schema: adoptionInput,
  },
  team_publish_definition: {
    description:
      "Host only. Maintain shared goal, requirement, understanding or design documents as COMPLETE coherent definitions. Submit only changed/new documents; omitted documents remain unchanged unless listed in removeKeys. Never put revision history, old/latest labels, or 'updated from' explanations in document bodies. Put change rationale in reason; source conversation is recorded automatically. Use stable document keys. expectedHeadId must equal nodeId from team_project_context (not branchId or contextVersion). Dependencies must be exact document IDs or key:<stable-key>, for example key:goal. Identify affected work. Ordinary ideas can be captured as understandings without delegating implementation. Cross-branch selection belongs to the user, not this tool.",
    schema: definitionInput,
  },
  team_state: {
    description:
      "Read a compact authoritative index of members, production/assistance work, exact IDs, status, blockers, verification and exchange headers. Host transcript and historical delivery bodies are omitted. Use team_read_work for full responsibility, exact criteria, self-checks and formal acceptance/rejection evidence; team_project_context for shared definitions. self_checked is producer verification, accepted is independent acceptance, and submitted alone satisfies neither. Queued is not running.",
    schema: z
      .object({
        query: z.string().max(200).default(""),
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(60).default(30),
        includeClosed: z.boolean().default(false),
      })
      .strict(),
  },
  team_read_work: {
    description:
      "Read complete instructions, result, exact acceptance criteria, bound requirement and full formal acceptance/rejection evidence for a Work in this branch. A review Work also includes the decisions recorded for its target. Use this when the compact state index is insufficient.",
    schema: z.object({ workId: key }).strict(),
  },
  team_define_requirements: {
    description:
      "Host only. Establish effective requirements from the current user request. Use only for an actual delegation or confirmed revision, never ordinary discussion. affectedWorkIds STOPS and SUPERSEDES those responsibilities; you must delegate replacement work. Use [] when existing work can continue and notify members through A2A instead. A requirement update does not itself create replacement tasks.",
    schema: z
      .object({ content: text, affectedWorkIds: z.array(key).max(100) })
      .strict(),
  },
  team_add_member: {
    description:
      "Host only. Add an independent member for a needed responsibility. Reuse suitable existing members. To select a resource provide resourceId and its expectedResourceVersion from directory details, with selectionReason; read it again after a version conflict. Omit resource and configuration to inherit Team defaults. A resource is reusable: multiple independent members may select the same resource or Harness. Choose based on the task, user preferences and observed capability/cost information; record the tradeoff in selectionReason. Access may be narrowed for a reviewer.",
    schema: z
      .object({
        name: z.string().trim().min(1).max(80),
        responsibility: text,
        config: executionConfig.optional(),
        resourceId: key.optional(),
        expectedResourceVersion: z.number().int().min(1).optional(),
        access: z.enum(["read-only", "workspace-write"]).optional(),
        selectionReason: z.string().max(1000).optional(),
      })
      .strict(),
  },
  team_remove_member: {
    description:
      "Host only. Delete a member from this branch's active roster, preserving its conversations, work and results. The member must have no unfinished work, pending review, open exchanges or pending messages. The Host cannot be deleted. Use after the user asks to remove that member.",
    schema: z.object({ memberId: key }).strict(),
  },
  team_continue_work: {
    description:
      "Host only. Explicitly bind an effective user request to existing production responsibilities in this branch when those works already carry its requirements. No duplicate work is created and verification policies remain. Omit runId for this Run, or select another Run in the same branch. A failed Run whose Host has since submitted a successful reply can resume coordination through this binding; paused Runs stay paused. The Run waits for every linked responsibility and shared integration to satisfy its required verification policy.",
    schema: z
      .object({
        runId: key.optional(),
        workIds: z.array(key).min(1).max(30),
        reason: text,
      })
      .strict(),
  },
  team_delegate: {
    description:
      "Host only. Declare acceptanceEvidence for every exact criterion: native_check for required execution, review_judgment for semantic inspection. Omitted declarations remain unresolved and cannot be accepted. Review and continuation inherit pinned expectations. Assign owned work with exact acceptance criteria, versioned input IDs and dependencies. Use one stable responsibilityKey per responsibility and reuse it on retries; declared writePaths also deduplicate repeated ownership. Reused work retains its original instructions: if delegationReuse.instructionsApplied=false, send necessary changes to that thread instead of assigning it again. Changed criteria, inputs or permissions require explicit continuation. Set verification=self-check for small reversible work; independent for complex/high-impact work or explicit independent review. Use continuationOf to continue the exact existing work thread. Production dependencies and input producers must satisfy their verification policy: self-check work must be self_checked and independent work must be ACCEPTED; submitted is insufficient. Stale inputs fail before creating work; read current files or continue the original responsibility rather than retrying stale versions. For independent review use team_review. Shared integration of isolated sources requires every deliverable source work ID in integratesWorkIds and dependsOn plus every source artifact in inputArtifactIds.",
    schema: z
      .object({
        memberId: key,
        title: z.string().min(1).max(160),
        instructions: text,
        acceptanceCriteria: z.array(z.string().min(1).max(1000)).max(MAX_ACCEPTANCE_CRITERIA),
        acceptanceEvidence: acceptanceEvidence.optional(),
        inputArtifactIds: z.array(key).max(128),
        contextRefs: z.array(z.string().min(1).max(256)).max(100).optional(),
        dependsOn: z.array(key).max(30),
        reviewOf: key.nullable().default(null),
        verification: z
          .enum(["self-check", "independent"])
          .default("independent"),
        continuationOf: key.optional(),
        responsibilityKey: key.optional(),
        writePaths: z.array(z.string().min(1).max(2000)).max(128).optional(),
        executionRequirements: executionRequirements.optional(),
        workspaceMode: z.enum(["shared", "isolated"]).default("shared"),
        integratesWorkIds: z.array(key).max(30).default([]),
      })
      .strict(),
  },
  team_set_acceptance_evidence: {
    description: "Host only. Classify unresolved acceptance criteria on unfinished production work from its original requirements, or strengthen judgment to native_check. Read the exact criteria and current revision first. Pinned native checks cannot be weakened. Existing acceptance history is immutable.",
    schema: z.object({ workId: key, expectedRevision: z.number().int().positive(), acceptanceEvidence, reason: text }).strict(),
  },
  team_review: {
    description:
      "Host only. Assign an independent read-only reviewer to a submitted production work. The service binds reviewOf, EVERY exact artifact version, target workspace, dependencies and original acceptance criteria and evidence requirements automatically. Native-check criteria require a capable executor even when executionRequirements is omitted. Reviewer must read the artifacts and call team_accept_work; an A2A answer is not acceptance. Use this for formal review instead of creating a generic production task.",
    schema: z
      .object({ workId: key, reviewerMemberId: key, instructions: text, executionRequirements: executionRequirements.optional() })
      .strict(),
  },
  team_execution_environment: {
    description: "Return a fresh prepared command prefix inside this attempt's existing native scratch grant. Use only when rerunning checks consumed the real link fixtures; ordinary checks already receive a prepared prefix at startup. No model call, source change or additional permission grant.",
    schema: z.object({}).strict(),
  },
  team_replace_work: {
    description:
      "Host only. Retire duplicate or failed unaccepted production responsibility in favor of explicit replacement work, without changing project requirements. Create viable replacements first. Active or uncertain native executions and accepted work cannot be retired this way. Retain history and artifacts; acceptance gates still apply to replacements.",
    schema: z
      .object({
        workId: key,
        expectedRevision: z.number().int().min(0),
        replacementWorkIds: z.array(key).min(1).max(30),
        reason: text,
      })
      .strict(),
  },
  team_read_artifact: {
    description:
      "Read an immutable submitted artifact version. This records actual delivery to this attempt, not a claim of understanding or use.",
    schema: z.object({ artifactId: key }).strict(),
  },
  team_read_file: {
    description: "Read a project UTF-8 file and its current hash. Read before editing; use offsets for large files. Private/runtime directories are excluded.",
    schema: z.object({ path: z.string().min(1).max(2000), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(64000).default(20000) }).strict(),
  },
  team_list_files: {
    description: "List a project directory without private/runtime directories. Paths are relative to the assigned workspace.",
    schema: z.object({ path: z.string().min(1).max(2000).optional() }).strict(),
  },
  team_write_file: {
    description: "Create a missing owned UTF-8 file with expectedSha256=null. Existing files cannot be replaced: read them and use team_edit_file with an exact fragment, preserving all other content. Paths outside writePaths are rejected.",
    schema: z.object({ path: z.string().min(1).max(2000), text: z.string().max(2 * 1024 * 1024), expectedSha256: z.null() }).strict(),
  },
  team_edit_file: {
    description: "Replace exactly one oldText occurrence in an owned UTF-8 file. Use its current hash from team_read_file and preserve unrelated content. Paths outside writePaths are rejected.",
    schema: z.object({ path: z.string().min(1).max(2000), oldText: z.string().min(1).max(200000), newText: z.string().max(200000), expectedSha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  },
  team_submit_result: {
    description:
      "Submit your result summary and relative UTF-8 project file paths. The service reads and hashes actual file bytes. Complete required checks before submission. Lightweight work must supply selfChecks for every exact acceptance criterion; these are producer checks, not independent acceptance. Do not change files after submission.",
    schema: z
      .object({
        summary: text,
        files: z.array(z.string().trim().min(1).max(2000)).max(127),
        usedArtifactIds: z.array(key).max(128),
        selfChecks: z
          .array(
            z
              .object({
                // Criteria are immutable identities, including any boundary whitespace.
                criterion: z.string().min(1).max(1000),
                evidence: text,
                evidenceEventIds: z.array(key).max(30).default([]),
              })
              .strict(),
          )
          .max(MAX_ACCEPTANCE_CRITERIA)
          .optional(),
      })
      .strict(),
  },
  team_review_evidence: {
    description:
      "List command execution evidence observed by the native harness in your current attempt. After running a check, retrieve its event ID for acceptance. Tool completion and reviewer judgment are different evidence types.",
    schema: z.object({}).strict(),
  },
  team_accept_work: {
    description:
      "Record independent acceptance or rejection. Each passed native_check criterion must cite successful current-attempt command events; review_judgment cannot satisfy a pinned native_check requirement. Read every target artifact and check every exact criterion. For actual executable checks use native_check with event IDs from team_review_evidence. For semantic inspection use review_judgment with an explicit reason and no event IDs. Never present a judgment as observed command execution.",
    schema: z
      .object({
        workId: key,
        verdict: z.enum(["accepted", "rejected"]),
        criteria: z
          .array(
            z
              .object({
                criterion: z.string().min(1).max(1000),
                passed: z.boolean(),
                evidence: text,
                evidenceType: z.enum(["native_check", "review_judgment"]),
                evidenceEventIds: z.array(key).max(30),
              })
              .strict(),
          )
          .max(MAX_ACCEPTANCE_CRITERIA),
      })
      .strict(),
  },
};
export const toolSpecs = Object.entries(tools).map(([name, value]) => ({
  name,
  description: value.description,
  inputSchema: z.toJSONSchema(value.schema, { io: "input" }) as Record<string, unknown>,
}));
