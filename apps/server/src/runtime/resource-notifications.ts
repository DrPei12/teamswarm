import { randomUUID } from "node:crypto";
import type { RuntimeStore } from "./store.js";
import type { Run, Work, Attempt } from "./types.js";
import type { Admission, RuntimeResources } from "./resources.js";

type Waiting = { work: Work; decision: Admission };
type Episode = {
  id: string;
  run: Run;
  startedAt: string;
  works: { id: string; title: string; teamId: string }[];
  chinese: boolean;
  endedAt?: string;
};
const gib = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GiB`;

/** Persist notices with the queue. Resource pressure never needs a model call to notify the user. */
export class ResourceNotifications {
  private firstSeen = new Map<string, number>();
  private report(episode: Episode, content: string) {
    const receipt = `resource-wait:${episode.id}`;
    this.store.appendAssistant(episode.run, content, receipt);
    this.store.db
      .prepare(
        "UPDATE messages SET content=? WHERE conversation_id=? AND client_request_id=?",
      )
      .run(content, episode.run.conversationId, `runtime:${receipt}`);
  }
  constructor(private store: RuntimeStore) {
    store.db.exec(
      "CREATE TABLE IF NOT EXISTS runtime_resource_notices (conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE, data TEXT NOT NULL)",
    );
  }
  sync(waiting: Waiting[], snapshot: ReturnType<RuntimeResources["summary"]>) {
    const groups = new Map<string, Waiting[]>();
    for (const item of waiting) {
      const run = this.store.get<Run>(
        "runs",
        item.work.teamId,
        item.work.runId,
      );
      groups.set(run.conversationId, [
        ...(groups.get(run.conversationId) ?? []),
        item,
      ]);
    }
    this.store.transaction(() => {
      for (const [conversationId, items] of groups) {
        const row = this.store.db
          .prepare(
            "SELECT data FROM runtime_resource_notices WHERE conversation_id=?",
          )
          .get(conversationId);
        let previous: Episode | undefined = row
          ? JSON.parse(String(row.data))
          : undefined;
        if (
          previous?.endedAt &&
          Date.now() - Date.parse(previous.endedAt) > 60000
        )
          previous = undefined;
        const newWait = !previous || !!previous.endedAt;
        // A first sample is normal startup. A failed measurement is a user-visible wait.
        if (!this.firstSeen.has(conversationId))
          this.firstSeen.set(conversationId, Date.now());
        if (
          !previous &&
          items.every((i) =>
            ["sampling", "calibrating"].includes(i.decision.reason),
          ) &&
          !snapshot.error &&
          Date.now() - this.firstSeen.get(conversationId)! < 3000
        )
          continue;
        const run = this.store.get<Run>(
          "runs",
          items[0].work.teamId,
          items[0].work.runId,
        );
        const user = this.store.db
          .prepare(
            "SELECT content FROM messages WHERE conversation_id=? AND role='user' ORDER BY rowid DESC LIMIT 1",
          )
          .get(conversationId);
        const episode: Episode = previous ?? {
          id: randomUUID(),
          run,
          startedAt: new Date().toISOString(),
          works: [],
          chinese: /[\u3400-\u9fff]/.test(String(user?.content ?? "")),
        };
        if (episode.endedAt) {
          episode.startedAt = new Date().toISOString();
          episode.works = [];
          episode.run = run;
          delete episode.endedAt;
        }
        for (const { work } of items)
          if (!episode.works.some((w) => w.id === work.id))
            episode.works.push({
              id: work.id,
              title: work.title,
              teamId: work.teamId,
            });
        this.store.db
          .prepare(
            "INSERT INTO runtime_resource_notices VALUES(?,?) ON CONFLICT(conversation_id) DO UPDATE SET data=excluded.data",
          )
          .run(conversationId, JSON.stringify(episode));
        if (newWait) {
          const first = items[0].decision;
          const reserve = (snapshot.policy.reserveMemoryMiB ?? 0) * 1024 ** 2;
          const reason =
            first.reason === "cpu"
              ? episode.chinese
                ? `CPU 当前负载 ${snapshot.system.cpuBusyPercent?.toFixed(0) ?? "未知"}%，已运行和准备启动的任务暂时用满了 CPU 预算。`
                : `CPU load is ${snapshot.system.cpuBusyPercent?.toFixed(0) ?? "unknown"}%; active and starting work currently uses the CPU budget.`
              : first.reason === "commit_memory"
                ? episode.chinese
                  ? `Windows 可用提交余量为 ${gib(snapshot.system.availableCommit ?? 0)}。`
                  : `Windows available commit is ${gib(snapshot.system.availableCommit ?? 0)}.`
                : ["sampling", "calibrating"].includes(first.reason)
                  ? episode.chinese
                    ? "暂时无法取得新的设备资源数据。"
                    : "Fresh device resource measurements are temporarily unavailable."
                  : episode.chinese
                    ? `设备可用内存 ${gib(snapshot.system.availablePhysical)}，启动预计需要 ${gib(first.cost.physical)}。${reserve ? `用户设置预留 ${gib(reserve)}。` : ""}`
                    : `Available memory is ${gib(snapshot.system.availablePhysical)}; starting requires an estimated ${gib(first.cost.physical)}.${reserve ? ` User reserve: ${gib(reserve)}.` : ""}`;
          const text = episode.chinese
            ? `等待资源：${reason}`
            : `Waiting for resources: ${reason}`;
          this.report(episode, text);
          this.store.event(run.teamId, "runtime.resource_notice", {
            state: "waiting",
            conversationId,
            workIds: episode.works.map((w) => w.id),
            reason: first.reason,
          });
        }
      }
      for (const row of this.store.db
        .prepare("SELECT * FROM runtime_resource_notices")
        .all()) {
        if (groups.has(String(row.conversation_id))) continue;
        const episode: Episode = JSON.parse(String(row.data));
        if (episode.endedAt) continue;
        const works = episode.works.flatMap((w) => {
          try {
            return [this.store.get<Work>("works", w.teamId, w.id)];
          } catch {
            return [];
          }
        });
        if (works.some((w) => w.status === "queued")) continue;
        const attempts = works.map((w) => ({
          work: w,
          attempt: w.attemptId
            ? this.store.get<Attempt>("attempts", w.teamId, w.attemptId)
            : undefined,
        }));
        if (
          attempts.some(
            ({ work, attempt }) =>
              work.status === "running" &&
              attempt?.dispatch?.state !== "dispatched",
          )
        )
          continue;
        const current = attempts.filter(
          ({ attempt }) => attempt && attempt.startedAt >= episode.startedAt,
        );
        const started = current.filter(
          ({ attempt }) => attempt?.dispatch?.state === "dispatched",
        );
        const failed = current.filter(
          ({ work, attempt }) =>
            work.status === "failed" &&
            attempt?.dispatch?.state !== "dispatched",
        );
        const text = started.length
          ? episode.chinese
            ? `资源等待已结束，此前排队的 ${started.length} 项任务已继续执行。`
            : `Resource waiting has ended. ${started.length} queued tasks have resumed.`
          : failed.length
            ? episode.chinese
              ? "资源等待已结束。"
              : "Resource waiting has ended."
            : episode.chinese
              ? "资源等待已结束，相关排队任务已取消或调整。"
              : "Resource waiting has ended; the queued tasks were cancelled or changed.";
        const failure = failed.length
          ? episode.chinese
            ? ` ${failed.length} 项任务启动失败，请查看相应任务的错误信息。`
            : ` ${failed.length} tasks failed to start. See their task errors.`
          : "";
        this.report(episode, text + failure);
        episode.endedAt = new Date().toISOString();
        this.store.db
          .prepare(
            "UPDATE runtime_resource_notices SET data=? WHERE conversation_id=?",
          )
          .run(JSON.stringify(episode), row.conversation_id);
        this.store.event(episode.run.teamId, "runtime.resource_notice", {
          state: "ended",
          conversationId: row.conversation_id,
          resumedCount: started.length,
        });
      }
      for (const id of this.firstSeen.keys())
        if (!groups.has(id)) this.firstSeen.delete(id);
    });
  }
}
