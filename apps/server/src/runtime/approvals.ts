import { randomUUID } from "node:crypto";
import { conflict, notFound } from "../errors.js";
import type { ExecutionApproval, Work } from "./types.js";
import type { RuntimeStore } from "./store.js";

export class ExecutionApprovals {
  private pending = new Map<string, (accepted: boolean) => void>();
  constructor(private store: RuntimeStore) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS runtime_approvals (
      id TEXT PRIMARY KEY, team_id TEXT NOT NULL REFERENCES teams(id), data TEXT NOT NULL CHECK(json_valid(data)));
      CREATE INDEX IF NOT EXISTS runtime_approvals_pending ON runtime_approvals(team_id, json_extract(data,'$.status'));`);
    // A restarted service cannot answer a previous process's pending request.
    store.db.prepare(`UPDATE runtime_approvals SET data=json_set(data,'$.status','cancelled') WHERE json_extract(data,'$.status')='pending'`).run();
  }
  list(teamId: string, pendingOnly = false): ExecutionApproval[] {
    return this.store.db.prepare(`SELECT data FROM runtime_approvals WHERE team_id=? ${pendingOnly ? "AND json_extract(data,'$.status')='pending'" : ""} ORDER BY rowid`).all(teamId).map(r => JSON.parse(String(r.data)));
  }
  private save(approval: ExecutionApproval) {
    this.store.db.prepare("INSERT INTO runtime_approvals VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data")
      .run(approval.id, approval.teamId, JSON.stringify(approval));
  }
  request(work: Work, attemptId: string, input: { tool: string; details: string }): Promise<boolean> {
    const current = this.store.get<Work>("works", work.teamId, work.id);
    if (current.status !== "running" || current.attemptId !== attemptId) return Promise.resolve(false);
    const approval: ExecutionApproval = {
      id: randomUUID(), teamId: work.teamId, memberId: work.memberId, workId: work.id, attemptId,
      tool: input.tool, details: input.details.slice(0, 24000), createdAt: new Date().toISOString(), status: "pending",
    };
    return new Promise(resolve => {
      this.store.transaction(() => {
        this.save(approval);
        this.store.event(work.teamId, "approval.requested", { approvalId: approval.id, tool: approval.tool }, work, attemptId);
      });
      this.pending.set(approval.id, resolve);
    });
  }
  answer(teamId: string, id: string, accepted: boolean): ExecutionApproval {
    const row = this.store.db.prepare("SELECT data FROM runtime_approvals WHERE team_id=? AND id=?").get(teamId, id);
    if (!row) throw notFound();
    const approval = JSON.parse(String(row.data)) as ExecutionApproval;
    if (approval.status !== "pending") {
      if (approval.status === (accepted ? "accepted" : "declined")) return approval;
      throw conflict("approval_closed", "This approval request has ended.");
    }
    const work = this.store.get<Work>("works", teamId, approval.workId);
    if (work.status !== "running" || work.attemptId !== approval.attemptId || !this.pending.has(id)) {
      this.cancel(approval.attemptId);
      throw conflict("approval_closed", "This approval request has ended.");
    }
    this.store.transaction(() => {
      approval.status = accepted ? "accepted" : "declined";
      this.save(approval);
      this.store.event(teamId, "approval.resolved", { approvalId: id, accepted }, work, approval.attemptId);
    });
    this.pending.get(id)?.(accepted);
    this.pending.delete(id);
    return approval;
  }
  cancel(attemptId: string) {
    const rows = this.store.db.prepare("SELECT data FROM runtime_approvals WHERE json_extract(data,'$.attemptId')=? AND json_extract(data,'$.status')='pending'").all(attemptId);
    for (const row of rows) {
      const approval = JSON.parse(String(row.data)) as ExecutionApproval;
      approval.status = "cancelled";
      this.save(approval);
      this.pending.get(approval.id)?.(false);
      this.pending.delete(approval.id);
    }
  }
}
