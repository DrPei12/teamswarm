import { randomUUID } from "node:crypto";
import { badRequest, conflict, notFound } from "./errors.js";
import { conversationMessageSql } from "./runtime/resource-notifications.js";
import type { TeamRuntime } from "./runtime/engine.js";
import type { Run } from "./runtime/types.js";

export function conversationHead(runtime: TeamRuntime, id: string) {
  return String(runtime.store.db.prepare(`SELECT id FROM messages WHERE conversation_id=? AND ${conversationMessageSql} ORDER BY rowid DESC LIMIT 1`).get(id)?.id ?? "") || null;
}

export function reviseConversation(runtime: TeamRuntime, teamId: string, id: string, input: {
  anchor: string; expectedHead: string; mode: "edit" | "rewind"; content?: string; clientRequestId: string;
}) {
  const { db, teams } = runtime.store;
  return runtime.store.once(`conversation-revise:${teamId}:${id}`, input.clientRequestId, input, () => {
    const anchor = db.prepare(`SELECT m.rowid AS seq,m.content FROM messages m JOIN conversations c ON c.id=m.conversation_id
      WHERE m.id=? AND c.id=? AND c.team_id=? AND m.role='user' AND m.delivery='recorded' AND m.retired_by IS NULL`).get(input.anchor,id,teamId);
    if (!anchor) throw notFound();
    if (conversationHead(runtime,id) !== input.expectedHead)
      throw conflict("conversation_changed", "The conversation changed. Review the current messages and try again.");
    if (input.mode === "edit" && (!input.content || input.content === anchor.content))
      throw badRequest("invalid_input", "Enter a different message before saving.");
    if (input.mode === "edit" && db.prepare("SELECT 1 FROM messages WHERE conversation_id=? AND client_request_id=?").get(id,input.clientRequestId))
      throw conflict("idempotency_conflict", "Request identity was already used with different input.");
    // The cut changes conversational intent, not project history. Do not change
    // authority while a run in this conversation could still produce effects.
    const runs = runtime.store.list<Run>("runs",teamId).filter(run => run.conversationId === id);
    const ids = new Set(runs.map(run => run.id));
    if (runtime.store.workQuery(teamId, {statuses:["queued","running","waiting","stopping","recovery_required"]}).some(work => ids.has(work.runId)))
      throw conflict("conversation_busy", "Finish or stop this conversation’s active work before changing its history.");
    const affected = new Set(db.prepare("SELECT id FROM messages WHERE conversation_id=? AND rowid>=? AND retired_by IS NULL").all(id, Number(anchor.seq)).map(row => row.id));
    const revision = randomUUID();
    const cutoff = Number(db.prepare("SELECT max(rowid) AS n FROM messages WHERE conversation_id=?").get(id)?.n);
    const at = new Date().toISOString();
    db.prepare("INSERT INTO conversation_revisions VALUES(?,?,?,?,?,?)").run(revision,id,input.anchor,input.mode,cutoff,at);
    db.prepare("UPDATE messages SET retired_by=? WHERE conversation_id=? AND rowid>=? AND retired_by IS NULL").run(revision,id,Number(anchor.seq));
    for (const run of runs) if (affected.has(run.sourceMessageId) && run.state === "active") {
      run.state = "paused";
      runtime.store.save("runs",run);
    }
    db.prepare("UPDATE conversations SET updated_at=? WHERE id=?").run(at,id);
    let messageId: string | undefined;
    if (input.mode === "edit") {
      const replacement = teams.recordMessage(teamId,id,input.content!,input.clientRequestId, message => {
        const metadata = db.prepare("SELECT data FROM product_message_details WHERE message_id=?").get(input.anchor);
        if (metadata) {
          const details = JSON.parse(String(metadata.data));
          delete details.legacyId;
          db.prepare("INSERT INTO product_message_details VALUES(?,?)").run(message.id,JSON.stringify(details));
        }
        runtime.store.enqueueHost(teamId,id,message.id,true,false);
      });
      messageId = replacement?.message.id;
    }
    return { revision, messageId, ...(input.mode === "rewind" ? { draft: String(anchor.content) } : {}) };
  });
}

export function conversationRevisions(runtime: TeamRuntime, teamId: string, id: string, revision?: string, before?: string) {
  const { db } = runtime.store;
  if (!db.prepare("SELECT 1 FROM conversations WHERE id=? AND team_id=?").get(id,teamId)) throw notFound();
  if (!revision) return { revisions: db.prepare(`SELECT r.id, r.mode, r.created_at AS createdAt, substr(m.content,1,160) AS anchor
    FROM conversation_revisions r JOIN messages m ON m.id=r.anchor_id WHERE r.conversation_id=? ORDER BY r.rowid DESC`).all(id) };
  if (!db.prepare("SELECT 1 FROM conversation_revisions WHERE id=? AND conversation_id=?").get(revision,id)) throw notFound();
  const previous = before ? db.prepare("SELECT rowid AS seq FROM messages WHERE id=? AND conversation_id=? AND retired_by=?").get(before,id,revision) : null;
  if (before && !previous) throw notFound();
  const rows = db.prepare(`SELECT id,role,content,created_at AS createdAt FROM messages
    WHERE conversation_id=? AND retired_by=? AND (? IS NULL OR rowid<?) ORDER BY rowid DESC LIMIT 51`).all(id,revision,previous?.seq ?? null,previous?.seq ?? null);
  return { messages: rows.slice(0,50).reverse(), before: rows.length>50 ? rows[49]?.id : undefined };
}
