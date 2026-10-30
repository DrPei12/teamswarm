import { randomUUID } from "node:crypto";
import { conflict } from "../errors.js";
import { redact } from "./redact.js";
import type { RuntimeStore } from "./store.js";
import type { Attempt, Member, NativePermissionRequest, Run, Work, ExecutionApproval } from "./types.js";

type Permission = NativePermissionRequest & { id: string; teamId: string; conversationId: string; workId: string; attemptId: string;
  memberId: string; harness: string; createdAt: string; state: "pending" | "allow" | "deny" | "cancelled"; sourceMessageId?: string };

/** Routes one native permission request to its conversation and exact live attempt. */
export class NativePermissions {
  private waiting = new Map<string, (decision: "allow" | "deny") => void>();
  constructor(private store: RuntimeStore) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS runtime_native_permissions (
      id TEXT PRIMARY KEY, team_id TEXT NOT NULL, attempt_id TEXT NOT NULL, native_id TEXT NOT NULL,
      data TEXT NOT NULL CHECK(json_valid(data)), UNIQUE(attempt_id,native_id));
      UPDATE runtime_native_permissions SET data=json_set(data,'$.state','cancelled') WHERE json_extract(data,'$.state')='pending';`);
  }
  private save(value: Permission) {
    this.store.db.prepare("INSERT INTO runtime_native_permissions VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data")
      .run(value.id, value.teamId, value.attemptId, value.nativeId, JSON.stringify(value));
  }
  list(teamId: string, conversationId?: string): Permission[] {
    return this.store.db.prepare("SELECT data FROM runtime_native_permissions WHERE team_id=? AND json_extract(data,'$.state')='pending' ORDER BY rowid")
      .all(teamId).map(row => JSON.parse(String(row.data))).filter(p => !conversationId || p.conversationId === conversationId);
  }
  approvals(teamId: string): ExecutionApproval[] {
    return this.list(teamId).map(p => ({ id: p.id, teamId, memberId: p.memberId,
      workId: p.workId, attemptId: p.attemptId, tool: p.tool,
      details: [p.reason, JSON.stringify(p.input, null, 2)].filter(Boolean).join("\n"),
      createdAt: p.createdAt, status: "pending" }));
  }
  has(teamId: string, id: string) {
    return !!this.store.db.prepare("SELECT id FROM runtime_native_permissions WHERE team_id=? AND id=?").get(teamId, id);
  }
  /** The authenticated product action is a direct user decision, not a Host inference. */
  answerFromUI(teamId: string, id: string, accepted: boolean): ExecutionApproval {
    const p = this.list(teamId).find(p => p.id === id);
    if (!p || !this.waiting.has(id)) throw conflict("permission_expired", "This approval request has ended.");
    this.store.assertActive(p.teamId, p.workId, p.attemptId);
    const approval = this.approvals(teamId).find(a => a.id === id)!;
    this.settle(p, accepted ? "allow" : "deny");
    return { ...approval, status: accepted ? "accepted" : "declined" };
  }
  async request(work: Work, attempt: Attempt, input: NativePermissionRequest, signal?: AbortSignal): Promise<"allow" | "deny"> {
    this.store.assertActive(work.teamId, work.id, attempt.id);
    if (signal?.aborted || !input.nativeId || !input.tool) return "deny";
    const prior = this.store.db.prepare("SELECT data FROM runtime_native_permissions WHERE attempt_id=? AND native_id=?").get(attempt.id, input.nativeId);
    // A repeated native request never reuses a one-time grant.
    if (prior) return "deny";
    const run = this.store.get<Run>("runs", work.teamId, work.runId), member = this.store.get<Member>("members", work.teamId, work.memberId);
    const p: Permission = { ...redact(input, attempt.config.credentialEnv), id: randomUUID(), teamId: work.teamId, conversationId: run.conversationId,
      workId: work.id, attemptId: attempt.id, memberId: member.id, harness: attempt.config.harness, createdAt: new Date().toISOString(), state: "pending" };
    const body = JSON.stringify(p.input);
    if (Buffer.byteLength(body) > 65536) return "deny";
    return new Promise(resolve => {
      const end = (decision: "allow" | "deny") => { signal?.removeEventListener("abort", cancel); this.waiting.delete(p.id); resolve(decision); };
      const cancel = () => this.settle(p, "cancelled");
      this.waiting.set(p.id, end);
      try {
        this.store.transaction(() => {
          this.save(p);
          this.store.event(work.teamId, "permission.requested", { ...p }, work, attempt.id);
          this.store.appendAssistant(run, `成员 ${member.name}（${attempt.config.harness}）请求执行 ${p.tool}。\n\n${p.reason ?? ""}\n${body}\n\n请求编号：${p.id}\n回复允许或拒绝这次操作。未回复时，该操作保持等待；取消任务或达到任务时限后，请求失效。`, `permission:${p.id}`);
        });
        signal?.addEventListener("abort", cancel, { once: true });
        if (signal?.aborted) cancel();
      } catch (error) { end("deny"); throw error; }
    });
  }
  answer(run: Run, id: string, decision: "allow" | "deny", sourceMessageId: string, quote: string) {
    const row = this.store.db.prepare("SELECT data FROM runtime_native_permissions WHERE id=? AND team_id=?").get(id, run.teamId);
    const p: Permission | undefined = row ? JSON.parse(String(row.data)) : undefined;
    if (!p || p.conversationId !== run.conversationId || p.state !== "pending" || !this.waiting.has(id))
      throw conflict("permission_expired", "This native permission request is no longer waiting in this conversation.");
    const source = this.store.db.prepare("SELECT id,content,created_at FROM messages WHERE conversation_id=? AND role='user' ORDER BY rowid DESC LIMIT 1").get(run.conversationId);
    if (!source || source.id !== sourceMessageId || String(source.content).trim() !== quote.trim() || String(source.created_at) < p.createdAt)
      throw conflict("user_request_required", "Use the user's reply to this permission request, including its exact message ID and complete text.");
    this.store.assertActive(p.teamId, p.workId, p.attemptId);
    p.sourceMessageId = sourceMessageId;
    this.settle(p, decision);
    return { id, state: decision, memberId: p.memberId, workId: p.workId };
  }
  private settle(p: Permission, state: Permission["state"]) {
    p.state = state; this.save(p);
    const work = this.store.get<Work>("works", p.teamId, p.workId);
    this.store.event(p.teamId, "permission.resolved", { id: p.id, nativeId: p.nativeId, state, sourceMessageId: p.sourceMessageId }, work, p.attemptId);
    this.waiting.get(p.id)?.(state === "allow" ? "allow" : "deny");
  }
  cancelAttempt(attemptId: string) {
    for (const row of this.store.db.prepare("SELECT data FROM runtime_native_permissions WHERE attempt_id=? AND json_extract(data,'$.state')='pending'").all(attemptId))
      this.settle(JSON.parse(String(row.data)), "cancelled");
  }
}
