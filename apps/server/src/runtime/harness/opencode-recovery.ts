import { readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { HarnessResult } from "../types.js";

// Older adapters persisted an unknown receipt for a native `length` finish.
// Recover only a closed, exactly bound turn; never rewrite the original receipt.
export function recoverOpenCodeTruncation(
  home: string,
  receipt: { updatedAt?: string; result?: HarnessResult },
  expected: { workId: string; attemptId: string; startedAt: string },
): HarnessResult | undefined {
  if (
    receipt.result?.status !== "unknown" ||
    receipt.result.error?.trim() !==
      "Native process exited (0) without a completion receipt."
  )
    return;
  const start = Date.parse(expected.startedAt),
    end = Date.parse(receipt.updatedAt ?? "");
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return;
  let db: DatabaseSync | undefined;
  try {
    const session = JSON.parse(
      readFileSync(path.join(home, "native-session.json"), "utf8"),
    );
    if (typeof session !== "string" || !/^ses_[a-zA-Z0-9]+$/.test(session))
      return;
    db = new DatabaseSync(path.join(home, "data", "opencode", "opencode.db"), {
      readOnly: true,
    });
    const messages = db
      .prepare(
        "SELECT id, data FROM message WHERE session_id=? ORDER BY time_created, id",
      )
      .all(session)
      .map((row) => ({
        id: String(row.id),
        data: JSON.parse(String(row.data)),
      }));
    const parts = db
      .prepare(
        "SELECT id, message_id, data FROM part WHERE session_id=? ORDER BY time_created, id",
      )
      .all(session)
      .map((row) => ({
        id: String(row.id),
        messageId: String(row.message_id),
        data: JSON.parse(String(row.data)),
      }));
    const users = messages.filter(
      (m) =>
        m.data.role === "user" &&
        parts.some((p) => {
          if (p.messageId !== m.id || p.data.type !== "text") return false;
          try {
            // OpenCode may persist the CLI's JSON prompt as a JSON string.
            let input = JSON.parse(p.data.text);
            if (typeof input === "string") input = JSON.parse(input);
            return (
              input.work?.id === expected.workId &&
              input.work?.attemptId === expected.attemptId
            );
          } catch {
            return false;
          }
        }),
    );
    if (users.length !== 1) return;
    const user = users[0]!;
    const turn = messages.slice(messages.indexOf(user) + 1);
    if (
      !turn.length ||
      !Number.isFinite(user.data.time?.created) ||
      user.data.time.created < start ||
      user.data.time.created > end
    )
      return;
    for (const message of turn) {
      const info = message.data;
      if (
        info.role !== "assistant" ||
        info.parentID !== user.id ||
        !Number.isFinite(info.time?.created) ||
        !Number.isFinite(info.time?.completed) ||
        info.time.created < start ||
        info.time.completed < info.time.created ||
        info.time.completed > end
      )
        return;
      if (
        parts.some(
          (p) =>
            p.messageId === message.id &&
            p.data.type === "tool" &&
            !["completed", "error"].includes(p.data.state?.status),
        )
      )
        return;
    }
    const last = turn.at(-1)!;
    if (last.data.finish !== "length") return;
    const finishes = parts.filter(
      (p) => p.messageId === last.id && p.data.type === "step-finish",
    );
    if (finishes.length !== 1 || finishes[0]!.data.reason !== "length") return;
    return {
      status: "failed",
      text: receipt.result.text,
      error: `OpenCode reached the model output limit. Confirmed by native session ${session}, message ${last.id}, part ${finishes[0]!.id}, bound to attempt ${expected.attemptId}; original receipt preserved.`,
    };
  } catch {
    // Missing, incompatible or ambiguous native history cannot release ownership.
    return;
  } finally {
    db?.close();
  }
}
