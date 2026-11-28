import { MAX_ACCEPTANCE_CRITERIA } from "./acceptance-evidence.js";
import { adoptionContextInput, adoptionInput } from "./branch-adoption.js";
import { z } from "zod";
import { memberPermissionPreset } from "./member-permissions.js";
import { badRequest } from "../errors.js";
import { definitionInput } from "./project-history.js";
import { insightInput } from "./collaboration-records.js";
import { nativePermissions } from "./harness/permissions.js";
import { supportsNativeReadProbes } from "@team/contracts/harness-catalog";

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
    nativeReadProbes: z.boolean().optional(),
  })
  .strict().refine(config => !config.nativeReadProbes || supportsNativeReadProbes(config),
    { path: ["nativeReadProbes"], message: "Native probes require a supported read-only model configuration." });
export const runtimeSettings = z
  .object({
    expectedVersion: z.number().int().min(0),
    workspace: z.string().trim().min(1).max(4096),
    config: executionConfig,
    maxConcurrent: z.number().int().positive().optional(),
    // Accepted for older clients; work admission is not limited by a Run counter.
    maxWorksPerRun: z.number().int().positive().optional(),
    maxTurnsPerWork: z.number().int().min(1).max(100).default(20),
    timeoutSeconds: z.number().int().min(10).max(3600).default(600),
    hostContextMaxBytes: z.number().int().min(32000).max(524288).optional(),
    hostSessionMaxTurns: z.number().int().min(1).max(20).optional(),
    sessionLongevityMode: z.enum(["standard", "high-efficiency"]).optional(),
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
export const globalSkillPin = z.object({ source: z.literal("global"), skillId: z.uuid(),
  revision: z.number().int().positive(), generation: z.number().int().positive() }).strict();
const skillCursor = z.string().regex(/^[a-f0-9]{64}:[0-9]{1,12}$/).optional();
export const mcpMountInput = z.object({
  serviceId: z.uuid(), revision: z.number().int().positive(), tool: z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/),
  generation: z.number().int().positive(),
}).strict();
const memoryTarget = z.object({ kind: z.enum(["note", "insight"]), key,
  expectedRevision: z.number().int().positive(), expectedVersion: z.number().int().nonnegative(),
}).strict();
export const memoryChangeInput = memoryTarget.extend({
  active: z.boolean().optional(),
  correction: z.object({ title: z.string().trim().min(1).max(200), content: text }).strict().optional(),
}).superRefine((input, context) => {
  if ((input.active !== undefined) === (input.correction !== undefined) || input.correction && input.kind !== "note")
    context.addIssue({ code: "custom", message: "Select one memory action. Corrections apply to project notes." });
});
export type MemoryChange = z.infer<typeof memoryChangeInput>;

export const tools = {
  team_skill_list: {
    description: "List granted global text skills in this Host turn. Pass an exact mount to team_skill_read or team_delegate.mountSkills.",
    schema: z.object({ cursor: skillCursor, limit: z.number().int().min(1).max(30).default(10) }).strict(),
  },
  team_skill_read: {
    description: "Read a page of the exact authorized skill body. Continue with its nextCursor.",
    schema: z.object({ mount: globalSkillPin, cursor: skillCursor, limit: z.number().int().min(1).max(8000).default(4000) }).strict(),
  },
  team_mcp_list: {
    description: "List the authorized MCP services and tool revisions mounted in this turn.",
    schema: z.object({ offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(30).default(10) }).strict(),
  },
  team_mcp_schema: {
    description: "Read the exact input schema of an MCP tool mounted in this turn.",
    schema: mcpMountInput,
  },
  team_mcp_call: {
    description: "Call an authorized read-only MCP tool with arguments matching its pinned schema.",
    schema: z.object({ mount: mcpMountInput, arguments: z.record(z.string(), z.unknown()) }).strict(),
  },
  team_preview_prepare: {
    description: "Prepare a project-owned Vite or Next.js development server. Run the returned commandPrefix through your own native command tool; preparing starts no process. A stable runtime copy preserves the framework CLI, compiler and hot reload across compatible handoffs. Requires writable production work and an adapter-verified execution policy. Currently Pi requires an explicit bash or powershell tool; other adapters without a verified launcher are refused. Use a plain vite or next dev script, with a local readiness path and expected text. Read-only work cannot launch services.",
    schema: z.object({ name: z.string().trim().min(1).max(80), directory: z.string().min(1).max(500).default("."), development: z.object({ framework: z.enum(["vite", "next"]), script: z.string().regex(/^[\w.-]+$/).default("dev"), ready: z.object({ path: z.string().regex(/^\/($|[^/])/).max(500), contains: z.string().min(1).max(500) }).strict() }).strict() }).strict(),
  },
  team_preview_start: {
    description: "Start a loopback frontend preview from this work's static files or built output. directory is relative to this work's actual working copy and must contain index.html. The project owns the preview process separately from the Harness. Read its service ID and version for handoff. A preview explicitly stopped by the user must be reopened by the user.",
    schema: z.object({ name: z.string().trim().min(1).max(80).default("Frontend preview"), directory: z.string().min(1).max(500).default(".") }).strict(),
  },
  team_preview_status: {
    description: "Read running preview services in this project branch, including current owner, working copy, pending handoff, endpoint and version.",
    schema: z.object({}).strict(),
  },
  team_preview_handoff: {
    description: "Reserve an existing preview for a receiving work in this branch. Only the current owner or Host can offer a handoff. The recipient must call team_preview_accept after its working copy is ready. The same process and endpoint switch to the recipient's files.",
    schema: z.object({ serviceId: key, targetWorkId: key, expectedVersion: z.number().int().positive() }).strict(),
  },
  team_preview_accept: {
    description: "Accept a preview explicitly handed to this work. Switch the existing preview process to this work's actual source. For a development server, ready is required: a local path and expected text from the receiving copy. Compatible dependencies and startup configuration preserve the actual CLI, compiler, and endpoint. A configuration mismatch requires a new instance and leaves the existing service intact.",
    schema: z.object({ serviceId: key, expectedVersion: z.number().int().positive(), ready: z.object({ path: z.string().regex(/^\/($|[^/])/).max(500), contains: z.string().min(1).max(500) }).strict().optional() }).strict(),
  },
  team_pending_permissions: {
    description: "Host only. Read native operation approvals for this conversation and worker-permission changes for this branch. Each request identifies its target and requested action. Native grants are one-time; worker defaults affect future Attempts.",
    schema: z.object({}).strict(),
  },
  team_answer_permission: {
    description: "Host dialogue only. Relay the user's explicit allow/deny decision for a pending native or worker-permission request. Cite the latest user message ID and complete verbatim content. Do not infer consent, reuse a grant or approve from a background follow-up.",
    schema: z.object({ requestId: key, decision: z.enum(["allow", "deny"]), sourceMessageId: key, authorizationQuote: text }).strict(),
  },
  team_device_resources: {
    description: "Host only. Read fresh device memory, Windows commit, CPU load, process counts, CPU target and per-Harness measured costs. Additional start estimates use CPU capacity. This is device-wide across Teams. Forecasts change with load; use them when arranging parallel work.",
    schema: z.object({}).strict(),
  },
  team_save_insight: {
    description:
      "Record an idea or decision with exact sourceMessageIds from the current input or team_state. Use a stable key and expectedRevision (0 for new). Only user-adopted revisions enter the branch's continuing decision context. Record Host findings as proposed for adoption in project records. Use team_adopt_branch for an authorized merge into mainline. Members may propose ideas.",
    schema: insightInput,
  },
  team_insight_sources: {
    description:
      "Read the original messages cited by a saved project idea or decision, including superseded reasoning.",
    schema: z.object({ insightId: key }).strict(),
  },
  team_message: {
    description:
      "Send an actual message to another member (including Host), delivered at its next inbox read/turn. Use replyTo for a requested answer. Set replyExpected=false for greetings, notices and completion receipts; replies default to false and need no acknowledgement. Use this for communication-only requests instead of production delegation. Sending does not transfer ownership. Never poll/wait for replies; continue useful work.",
    schema: z
      .object({
        recipientId: key,
        content: text,
        replyTo: key.optional(),
        targetWorkId: key.optional(),
        replyExpected: z.boolean().optional(),
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
      "Read resource/model/Harness details or a Run's requirement and outcome. Member details include responsibility, currentExecution, historical lastExecution, future nextExecution, Harness/model/effort, modelRequest and session compatibility. No quality ranking or quota is inferred.",
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
    description: "Host only. Select a saved resource for a member's FUTURE Attempts, nonexecuting unfinished work, or your own FUTURE turns in this branch. Member defaults may change while running; active Attempts keep their frozen configuration. Read exact resource version and target allocationRevision/work revision from team_directory_detail/team_read_work. For target=host omit targetId and use the Host's branch allocationRevision. Task choice overrides member default. Running Attempts never change. A configuration change starts a new native session with retained Team context. No credential, endpoint, access or account permission is granted by selecting a resource.",
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
      "Read branch materials by refs, or search original messages and notes. Follow nextOffset for content and nextRefOffset for remaining batch refs; on continuation pass expectedRevisions from the preceding page. section=links/sources pages relationships and provenance. kind=handoff pages captured dialogue, worktree changes or check receipts by handoffSection. Use messageId to read an original message or document:<revision> for a historical definition.",
    schema: z
      .object({
        kind: z.enum(["messages", "notes", "materials", "handoff"]),
        handoffSection: z.enum(["dialogue", "worktree", "checks"]).optional(),
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
  team_save_handoff_memo: {
    description: "Save a brief handoff memo for the current turn. Pin exact relative paths, file hashes and original 1-based line ranges. Host spans require verified team_read_file receipts. The first memo uses expectedRevision=0.",
    schema: z.object({
      expectedRevision: z.number().int().nonnegative(),
      nextImmediateCut: z.string().trim().min(1).max(1200),
      rejectedHypotheses: z.array(z.string().trim().min(1).max(600)).max(5),
      hotFileSpans: z.array(z.object({ path: key, sha256: z.string().regex(/^[a-f0-9]{64}$/),
        startLine: z.number().int().positive(), endLine: z.number().int().positive(),
      }).strict()).max(3),
    }).strict(),
  },
  team_host_note: {
    description:
      "Host only. Maintain a sourced project overview, decision, reusable experience or working note under a stable key. Write project facts directly; keep process narration and update history out of content. Reference current definitions/work with sourceRefs and original discussion with sourceMessageIds. Use memberIds for member-specific material. Refresh notes when their sources change; resolve settled working notes. Requirements and permissions remain in the project definition.",
    schema: z
      .object({
        key,
        title: z.string().trim().min(1).max(160).optional(),
        kind: z.enum(["overview", "decision", "experience", "working"]).optional(),
        // JSON Schema has no regex flags; model providers do not all accept JS
        // Unicode property escapes. Keep the exact check at tool execution.
        topic: z.string().min(1).max(120)
          .refine(value => /^[\p{L}\p{N}_/-]+$/u.test(value), "Use letters, numbers, underscores, slashes or hyphens.")
          .describe("Letters and numbers in any language, underscores, slashes or hyphens only.").optional(),
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
      "Checkpoint unfinished responsibility and END this native turn. Finish independent work before waiting. waitForExchangeIds waits for a useful reply, cancellation, or new inbound collaboration. To wait for an interface decision, supply interfaceConflict from an owned file and a pinned predecessor artifact you have read. Use reason=session_rotation only after the runtime requests a session change and you saved the handoff memo; do not wait for any exchange in that case. An empty exchange list without interfaceConflict continues at the next scheduling boundary. Use this tool before result submission.",
    schema: z
      .object({
        summary: text,
        reason: z.literal("session_rotation").optional(),
        waitForExchangeIds: z.array(key).max(30).default([]),
        waitSeconds: z.number().int().min(1).max(3600).default(300),
        interfaceConflict: z.object({
          contractKey: z.string().regex(/^contracts\/[a-zA-Z0-9][a-zA-Z0-9_/-]{0,109}$/),
          upstreamArtifactId: key,
          localPath: z.string().min(1).max(2000),
          expected: z.string().trim().min(1).max(2000),
          observed: z.string().trim().min(1).max(2000),
        }).strict().optional(),
      })
      .strict(),
  },
  team_project_context: {
    description:
      "Read the project definition for the current work. With a selected definition scope, the result contains the pinned documents, their dependencies and branch goals and requirements.",
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
      "Read branch-scoped self and members: currentExecution is frozen, nextExecution is a future default, lastExecution is history; each includes Harness/model/effort and modelRequest. Also returns work IDs/status/blockers and exchanges. Use team_read_work for full instructions and acceptance evidence; team_project_context for definitions. Queued is not running; submitted is unverified; self_checked is producer verification; accepted is independent acceptance. Host transcripts and delivery bodies are omitted.",
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
      "Read full instructions, result, criteria, requirement and acceptance/rejection evidence, including review-target decisions. currentExecution is frozen, lastExecution is history, nextExecution follows task selection then member default. Includes Harness/model/effort and captured modelRequest. Work must be in this branch.",
    schema: z.object({ workId: key }).strict(),
  },
  team_define_requirements: {
    description:
      "Host only. Establish the current user's production requirements. Use outcome to record the agreed value goal, invariants, user-visible criteria and non-goals. Read the current outcome and supply its requirement ID, or null for the first revision. List the existing responsibilities affected by this request in affectedWorkIds.",
    schema: z
      .object({
        content: text,
        affectedWorkIds: z.array(key).max(100),
        outcome: z.object({
          expectedRequirementId: key.nullable(),
          specification: z.object({
            valueGoal: z.string().trim().min(1).max(600),
            invariants: z.array(z.string().trim().min(1).max(400)).max(12),
            criteria: z.array(z.object({
              key: z.string().trim().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/),
              text: z.string().trim().min(1).max(500),
            }).strict()).min(1).max(16),
            nonGoals: z.array(z.string().trim().min(1).max(400)).max(12),
          }).strict().refine(value => new Set(value.criteria.map(criterion => criterion.key)).size === value.criteria.length,
            "Each outcome criterion needs a distinct key."),
        }).strict().optional(),
      })
      .strict(),
  },
  team_plan_workflow: {
    description: "Host only. Revise this Run's dependency graph against its effective outcome. Set expectedRevision to 0 for a new plan. Use assigneeMemberId to plan a member before dispatch, null to clear the planned member, and renew to give an ended assignment a new generation. Read team_state for ready nodes and assign them with workflowNodeKey and expectedWorkflowRevision.",
    schema: z.object({
      expectedRevision: z.number().int().min(0),
      upsert: z.array(z.object({
        key, title: z.string().trim().min(1).max(160),
        assigneeMemberId: key.nullable().optional(),
        dependsOn: z.array(key).max(30),
        outcomeCriteria: z.array(key).max(16),
      }).strict()).max(100),
      remove: z.array(key).max(100),
      renew: z.array(key).max(100).default([]),
    }).strict(),
  },
  team_host_inline_edit: {
    description: "Host only. Ask for approval and apply one or two small replacements in existing project text files. Use the current user message ID, the exact file hashes from team_read_file, and one literal matching fragment per file.",
    schema: z.object({
      sourceMessageId: key,
      edits: z.array(z.object({
        path: z.string().min(1).max(1000),
        expectedSha256: z.string().regex(/^[a-f0-9]{64}$/),
        oldText: z.string().min(1).max(4000),
        newText: z.string().max(4000),
      }).strict()).min(1).max(2),
    }).strict(),
  },
  team_memory_list: {
    description: "Read branch memory keys, revisions and archive state to select the exact entry for a user decision.",
    schema: z.object({ offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(40).default(20) }).strict(),
  },
  team_memory_change: {
    description: "Ask the user to archive or restore the exact memory revision, or approve corrected title and content for a project note.",
    schema: memoryChangeInput,
  },
  team_subspace_prepare: {
    description: "Prepare a snapshot for a current direct child. Use the task name returned by spawn_agent or the native thread ID from team_state. Assign exact files within this Work.",
    schema: z.object({ threadId: key, paths: z.array(z.string().min(1).max(1000)).min(1).max(128) }).strict(),
  },
  team_subspace_submit: {
    description: "Freeze the current child turn's file changes and finish the child turn.",
    schema: z.object({}).strict(),
  },
  team_subspace_commit: {
    description: "Apply a completed child's submitted files to the parent working copy and verify the resulting hashes.",
    schema: z.object({ id: key }).strict(),
  },
  team_subspace_abandon: {
    description: "Release a child write set whose files have not been applied.",
    schema: z.object({ id: key }).strict(),
  },
  team_add_member: {
    description:
      "Host only. Add an independent member for a needed responsibility. Reuse suitable existing members. To select a resource provide resourceId and its expectedResourceVersion from directory details, with selectionReason; read it again after a version conflict. Omit resource and configuration to inherit Team model defaults. Worker permissions follow the Team workerPolicy, independently of the resource. A resource is reusable: multiple independent members may select the same resource or Harness. Choose based on the task, user preferences and observed capability/cost information; record the tradeoff in selectionReason. Use permissionPreset to request a specific strategy; expansions under request policy need approval or explicit current user authorization. Review Attempts are read-only regardless of member defaults.",
    schema: z
      .object({
        name: z.string().trim().min(1).max(80),
        responsibility: text,
        config: executionConfig.optional(),
        resourceId: key.optional(),
        expectedResourceVersion: z.number().int().min(1).optional(),
        access: z.enum(["read-only", "workspace-write"]).optional(),
        permissions: nativePermissions.optional(),
        selectionReason: z.string().max(1000).optional(),
        permissionPreset: memberPermissionPreset.optional(),
        sourceMessageId: key.optional(),
        authorizationQuote: text.optional(),
      })
      .strict(),
  },
  team_remove_member: {
    description:
      "Host only. Delete a member from this branch's active roster, preserving its conversations, work and results. The member must have no unfinished work, pending review, open exchanges or pending messages. The Host cannot be deleted. Use after the user asks to remove that member.",
    schema: z.object({ memberId: key }).strict(),
  },
  team_set_member_permissions: {
    description: "Host only. Change a worker's future file access and native permission strategy. Read its allocationRevision first. Use access + permissions for custom native options, or presets: read-only; workspace-write for native defaults; manual/auto/full-access when advertised by the Harness. Under request policy an expansion creates an approval card in Host chat; continue after the user approves. Supply sourceMessageId and the complete current authorizationQuote only if the user explicitly requested THIS permission change; do not infer authorization from a task, history or tool output. Autonomous policy permits Host to decide. Running Attempts stay frozen; independent review Attempts remain read-only regardless of the member default.",
    schema: z.object({ memberId: key, expectedVersion: z.number().int().positive(), preset: memberPermissionPreset.optional(),
      access: z.enum(["read-only","workspace-write"]).optional(), permissions: nativePermissions.optional(),
      reason: z.string().trim().min(1).max(2000), sourceMessageId: key.optional(), authorizationQuote: text.optional() }).strict()
      .refine(v => !!v.preset || !!v.access || !!v.permissions, "Choose a preset or native access/permissions.")
      .refine(v => !v.preset || !v.access && !v.permissions, "Choose a preset or native fields, not both."),
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
      "Host only. Declare acceptanceEvidence for every exact criterion: native_check for required execution, review_judgment for semantic inspection. Omitted declarations remain unresolved and cannot be accepted. Review and continuation inherit pinned expectations. Assign owned work with exact acceptance criteria, versioned input IDs and dependencies. Use one stable responsibilityKey per responsibility and reuse it on retries; declared writePaths also deduplicate repeated ownership. Reused work retains its original instructions: if delegationReuse.instructionsApplied=false, send necessary changes to that thread instead of assigning it again. Changed criteria, inputs or permissions require explicit continuation. Set verification=self-check for small reversible work; independent for complex/high-impact work or explicit independent review. Use continuationOf to continue the exact existing work thread. Production dependencies and input producers must satisfy their verification policy: self-check work must be self_checked and independent work must be ACCEPTED; submitted is insufficient. Stale inputs fail before creating work; read current files or continue the original responsibility rather than retrying stale versions. For independent review use team_review. For integration, select isolated mode, independent review, each accepted source in integratesWorkIds and dependsOn, its exact artifact IDs, and write paths covering every source file. The integrator starts from the current project and reads each version with team_read_artifact before submitting the resolution.",
    schema: z
      .object({
        memberId: key,
        title: z.string().min(1).max(160),
        instructions: text,
        acceptanceCriteria: z.array(z.string().min(1).max(1000)).max(MAX_ACCEPTANCE_CRITERIA),
        acceptanceEvidence: acceptanceEvidence.optional(),
        inputArtifactIds: z.array(key).max(128),
        contextRefs: z.array(z.string().min(1).max(256)).max(100).optional(),
        definitionScope: z.enum(["branch", "selected"]).optional().describe("Select authoritative document refs for a task, including their dependencies and the branch goals and requirements. Branch scope includes the complete definition."),
        outcomeCriteria: z.array(key).max(16).optional().describe("Keys of the agreed outcome criteria this work verifies. Include their exact text in acceptanceCriteria."),
        workflowNodeKey: key.optional(),
        expectedWorkflowRevision: z.number().int().positive().optional(),
        isolatedSubspaces: z.boolean().optional().describe("Use separate snapshots for writing children within an isolated Work. Select bounded Codex or a writable Pi 1.3.0 member on the supported DeepSeek Chat Completions connection. Provide exact owned writePaths. Isolated Pi has no commands; assign executable checks to an independent reviewer."),
        mountSkills: z.array(z.union([globalSkillPin, z.object({
          skillId: key, revision: z.string().regex(/^[a-f0-9]{64}$/),
        }).strict()])).max(16).optional().describe("Mount exact global skills listed in this Host turn or team skill versions selected in the user message."),
        mountMcp: z.array(mcpMountInput).max(16).optional().describe("Mount exact team-authorized MCP tool revisions for this work."),
        dependsOn: z.array(key).max(30),
        reviewOf: key.nullable().default(null),
        verification: z
          .enum(["self-check", "independent"])
          .default("independent"),
        continuationOf: key.optional(),
        responsibilityKey: key.optional(),
        writePaths: z.array(z.string().min(1).max(2000)).max(128).optional(),
        executionRequirements: executionRequirements.optional(),
        permissions: nativePermissions.optional(),
        workspaceMode: z.enum(["shared", "isolated"]).default("isolated"),
        publicationMode: z.enum(["automatic", "integration"]).optional().describe("Private copies publish checked files by default. Choose integration to retain a candidate for a separately assigned integration work."),
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
      "Host only. Assign a different member to review submitted production work. This review Attempt runs read-only regardless of the member default. The service binds reviewOf, exact artifacts, target workspace, dependencies, original criteria and evidence requirements. Native-check criteria require a capable executor. The reviewer reads artifacts and calls team_accept_work; an A2A answer is not acceptance.",
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
      "Read an immutable submitted artifact. Integration reads include the source baseline, prepared mainline and candidate hashes. Use view=base or view=current to read that snapshot file as it existed at preparation.",
    schema: z.object({ artifactId: key, view: z.enum(["base", "current", "candidate"]).default("candidate") }).strict(),
  },
  team_read_artifacts: {
    description: "Read several exact immutable artifact versions in one call. The combined result must fit 64 KiB. Use single artifact reads for larger results.",
    schema: z.object({ artifactIds: z.array(key).min(1).max(16)
      .refine(ids => new Set(ids).size === ids.length, "Provide distinct artifact IDs.") }).strict(),
  },
  team_read_file: {
    description: "Read a UTF-8 file in the assigned workspace and its current hash. Omit offset and limit to read from the beginning. Pagination uses character positions, not line numbers. When truncated is true, read the remaining content before quoting the full file. Private/runtime directories are excluded.",
    schema: z.object({
      path: z.string().min(1).max(2000).describe("File path relative to the assigned workspace."),
      offset: z.number().int().min(0).default(0).describe("Zero-based character offset, not a line number. Omit or use 0 to include the first character."),
      limit: z.number().int().min(1).max(64000).default(20000).describe("Maximum characters to read, not lines. Omit for 20000 characters. For pagination, advance offset by the length of the returned text."),
    }).strict(),
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
      "Record independent acceptance or rejection with a result for each exact criterion. Read every target artifact and cite current command events for native checks. When an integration check demonstrates an interface conflict, cite the two upstream artifact IDs, failed criterion and failed command in semanticConflicts.",
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
        semanticConflicts: z.array(z.object({
          contractKey: z.string().regex(/^contracts\/[a-zA-Z0-9][a-zA-Z0-9_/-]{0,99}$/),
          providerArtifactId: key, consumerArtifactId: key,
          criterion: z.string().min(1).max(1000), evidenceEventId: key,
          expected: z.string().trim().min(1).max(1000), observed: z.string().trim().min(1).max(1000),
        }).strict()).max(4).optional(),
      })
      .strict(),
  },
};
/** The full native policy schemas live in the Harness section, not every Host tool declaration. */
function progressivePermissions(schema: any): any {
  if (Array.isArray(schema)) return schema.map(progressivePermissions);
  if (!schema || typeof schema !== "object") return schema;
  return Object.fromEntries(Object.entries(schema).map(([key, value]) => [key,
    key === "properties" ? Object.fromEntries(Object.entries(value as object).map(([name, field]) => [name,
      name === "permissions" ? { type: "object", properties: { harness: { type: "string" } }, required: ["harness"], additionalProperties: true,
        description: "Harness-native policy. Read harness:<id>/permissions for its exact fields and supported values before selecting. Server validates that native schema." } : progressivePermissions(field)])) : progressivePermissions(value)]));
}
export const toolSpecs = Object.entries(tools).map(([name, value]) => {
  // The provider receives a function-parameter schema, not a standalone schema
  // document. Repeating the dialect URL for every tool spends input capacity
  // without adding a constraint; server validation remains the original Zod schema.
  const { $schema: _dialect, ...inputSchema } = progressivePermissions(z.toJSONSchema(value.schema, { io: "input" }));
  return { name, description: value.description, inputSchema: inputSchema as Record<string, unknown> };
});
