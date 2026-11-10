import { randomUUID } from "node:crypto";
import { badRequest, conflict } from "../errors.js";
import { redact } from "./redact.js";
import type { RuntimeStore } from "./store.js";
import type { Attempt, ExecutionApproval, NativeQuestion, NativeQuestionRequest, Work } from "./types.js";

type Question = NativeQuestionRequest & { id: string; teamId: string; workId: string; attemptId: string; memberId: string;
  harness: string; createdAt: string; state: "pending" | "answered" | "declined" | "cancelled"; answers?: string[][] };

/** Returned to a Harness whose question nobody answered. It must not invent the user's choice. */
export const unansweredQuestion =
  "The user did not answer this question. Do not assume an answer: continue only with what does not depend on it, and state what is still undecided.";

const text = (value: unknown, limit: number) =>
  typeof value === "string" && value.trim() && value.length <= limit ? value : undefined;

/** Accept only the public shape of a native question. Anything else is not shown to the user. */
export function nativeQuestions(value: unknown): NativeQuestion[] {
  if (!Array.isArray(value) || !value.length || value.length > 8) return [];
  const questions: NativeQuestion[] = [];
  for (const raw of value) {
    const question = text(raw?.question, 2000);
    const options = Array.isArray(raw?.options) ? raw.options : [];
    if (!question || options.length > 12) return [];
    const parsed: NativeQuestion["options"] = [];
    for (const option of options) {
      const label = text(option?.label, 200), description = text(option?.description, 1000);
      if (!label || parsed.some(o => o.label === label)) return [];
      parsed.push({ label, ...(description ? { description } : {}) });
    }
    const id = text(raw.id, 200), header = text(raw.header, 80);
    questions.push({
      ...(id ? { id } : {}), question, ...(header ? { header } : {}),
      ...(raw.multiSelect === true && parsed.length > 1 ? { multiSelect: true } : {}),
      // A question without options can only be answered in the user's own words.
      ...(raw.allowOther === true || !parsed.length ? { allowOther: true } : {}),
      options: parsed,
    });
  }
  return questions;
}

function fits(question: NativeQuestion, answer: unknown): boolean {
  if (!Array.isArray(answer) || !answer.length || new Set(answer).size !== answer.length) return false;
  const custom = answer.filter(value => !question.options.some(o => o.label === value));
  return answer.every(value => !!text(value, 2000)) &&
    (question.multiSelect ? custom.length <= (question.allowOther ? 1 : 0) : answer.length === 1 && (!custom.length || !!question.allowOther));
}

/** Routes a question a native Harness asks the user to its exact live attempt and back. */
export class NativeQuestions {
  private waiting = new Map<string, (answers: string[][] | null) => void>();
  constructor(private store: RuntimeStore) {
    // A restarted service cannot answer a previous process's pending question.
    store.db.exec(`CREATE TABLE IF NOT EXISTS runtime_native_questions (
      id TEXT PRIMARY KEY, team_id TEXT NOT NULL, attempt_id TEXT NOT NULL, native_id TEXT NOT NULL,
      data TEXT NOT NULL CHECK(json_valid(data)), UNIQUE(attempt_id,native_id));
      UPDATE runtime_native_questions SET data=json_set(data,'$.state','cancelled') WHERE json_extract(data,'$.state')='pending';`);
  }
  private save(value: Question) {
    this.store.db.prepare("INSERT INTO runtime_native_questions VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data")
      .run(value.id, value.teamId, value.attemptId, value.nativeId, JSON.stringify(value));
  }
  private pending(teamId: string): Question[] {
    return this.store.db.prepare("SELECT data FROM runtime_native_questions WHERE team_id=? AND json_extract(data,'$.state')='pending' ORDER BY rowid")
      .all(teamId).map(row => JSON.parse(String(row.data)));
  }
  private approval(q: Question): ExecutionApproval {
    return { kind: "question", id: q.id, teamId: q.teamId, memberId: q.memberId, workId: q.workId, attemptId: q.attemptId,
      tool: q.tool, details: "", createdAt: q.createdAt, status: "pending", questions: q.questions };
  }
  approvals(teamId: string): ExecutionApproval[] {
    return this.pending(teamId).map(q => this.approval(q));
  }
  has(teamId: string, id: string) {
    return !!this.store.db.prepare("SELECT id FROM runtime_native_questions WHERE team_id=? AND id=?").get(teamId, id);
  }
  /** One answer list per question; null when nobody answers before the attempt ends. */
  async request(work: Work, attempt: Attempt, input: NativeQuestionRequest, signal?: AbortSignal): Promise<string[][] | null> {
    this.store.assertActive(work.teamId, work.id, attempt.id);
    const questions = nativeQuestions(input.questions);
    if (signal?.aborted || !input.nativeId || !questions.length) return null;
    // A repeated native request never reuses an earlier answer.
    if (this.store.db.prepare("SELECT id FROM runtime_native_questions WHERE attempt_id=? AND native_id=?").get(attempt.id, input.nativeId)) return null;
    const q: Question = { ...redact({ nativeId: input.nativeId, tool: input.tool, questions }, attempt.config.credentialEnv), id: randomUUID(),
      teamId: work.teamId, workId: work.id, attemptId: attempt.id, memberId: work.memberId, harness: attempt.config.harness,
      createdAt: new Date().toISOString(), state: "pending" };
    return new Promise(resolve => {
      const end = (answers: string[][] | null) => { signal?.removeEventListener("abort", cancel); this.waiting.delete(q.id); resolve(answers); };
      const cancel = () => this.settle(q, "cancelled");
      this.waiting.set(q.id, end);
      try {
        this.store.transaction(() => {
          this.save(q);
          this.store.event(work.teamId, "question.requested", { id: q.id, nativeId: q.nativeId, memberId: q.memberId, questions: q.questions }, work, attempt.id);
        });
        signal?.addEventListener("abort", cancel, { once: true });
        if (signal?.aborted) cancel();
      } catch (error) { end(null); throw error; }
    });
  }
  /** The authenticated product action is the user's own answer; null declines. */
  answerFromUI(teamId: string, id: string, answers: string[][] | null): ExecutionApproval {
    const q = this.pending(teamId).find(q => q.id === id);
    if (!q || !this.waiting.has(id)) throw conflict("question_expired", "This question has ended.");
    this.store.assertActive(q.teamId, q.workId, q.attemptId);
    if (answers && (answers.length !== q.questions.length || !q.questions.every((question, i) => fits(question, answers[i]))))
      throw badRequest("invalid_answers", "Answer every question before sending.");
    const approval = this.approval(q);
    this.settle(q, answers ? "answered" : "declined", answers ?? undefined);
    return { ...approval, status: answers ? "accepted" : "declined" };
  }
  private settle(q: Question, state: Question["state"], answers?: string[][]) {
    const work = this.store.get<Work>("works", q.teamId, q.workId);
    const attempt = this.store.get<Attempt>("attempts", q.teamId, q.attemptId);
    q.state = state;
    if (answers) q.answers = redact(answers, attempt.config.credentialEnv);
    this.save(q);
    this.store.event(q.teamId, "question.resolved", { id: q.id, nativeId: q.nativeId, state, ...(q.answers ? { answers: q.answers } : {}) }, work, q.attemptId);
    this.waiting.get(q.id)?.(q.answers ?? null);
  }
  cancelAttempt(attemptId: string) {
    for (const row of this.store.db.prepare("SELECT data FROM runtime_native_questions WHERE attempt_id=? AND json_extract(data,'$.state')='pending'").all(attemptId))
      this.settle(JSON.parse(String(row.data)), "cancelled");
  }
}
