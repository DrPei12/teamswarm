import type { RuntimeStore } from "./store.js";

/** Remove generated notices and stored decisions for the retired admission rule. */
export function clearRetiredResourceNotices(store: RuntimeStore) {
  store.transaction(() => {
    const hasNoticeTable = Boolean(store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='runtime_resource_notices'").get());
    const devicePolicy = store.db
      .prepare("SELECT data FROM runtime_device_policy WHERE id=1")
      .get();
    if (devicePolicy) {
      const value = JSON.parse(String(devicePolicy.data));
      store.db
        .prepare("UPDATE runtime_device_policy SET data=? WHERE id=1")
        .run(
          JSON.stringify({
            version: value.version,
            cpuTargetPercent: value.cpuTargetPercent ?? 85,
            ...(value.updatedAt ? { updatedAt: value.updatedAt } : {}),
          }),
        );
    }
    const notices = store.db
      .prepare(
        "SELECT id,conversation_id,client_request_id,content,created_at FROM messages WHERE role='assistant' AND client_request_id LIKE 'runtime:resource-wait:%'",
      )
      .all();
    for (const notice of notices) {
      if (
        !/设备可用内存|可用提交余量|新的设备资源数据|Available memory|available commit|Fresh device resource/i.test(
          String(notice.content),
        )
      )
        continue;
      const episode = String(notice.client_request_id).slice(
        "runtime:resource-wait:".length,
      );
      const resumed = store.db
        .prepare(
          "SELECT id,created_at FROM messages WHERE conversation_id=? AND client_request_id=?",
        )
        .get(notice.conversation_id, `runtime:resource-resumed:${episode}`);
      store.db
        .prepare("DELETE FROM messages WHERE id=? OR id=?")
        .run(notice.id, resumed?.id ?? "");
      if (hasNoticeTable)
        store.db.prepare("DELETE FROM runtime_resource_notices WHERE json_extract(data,'$.id')=?").run(episode);
      store.db
        .prepare(
          "DELETE FROM runtime_events WHERE type='runtime.resource_notice' AND json_extract(data,'$.conversationId')=? AND created_at>=? AND created_at<=?",
        )
        .run(
          notice.conversation_id,
          notice.created_at,
          resumed?.created_at ?? new Date().toISOString(),
        );
    }
    store.db
      .prepare(
        "DELETE FROM runtime_events WHERE type='work.resource_wait' AND json_extract(data,'$.reason') IN ('physical_memory','commit_memory','sampling','calibrating')",
      )
      .run();
    const policies = store.db
      .prepare(
        "SELECT sequence,data FROM runtime_events WHERE type='runtime.device_policy_changed'",
      )
      .all();
    for (const row of policies) {
      const data = JSON.parse(String(row.data));
      if (data.policy) {
        data.policy = {
          version: data.policy.version,
          cpuTargetPercent: data.policy.cpuTargetPercent ?? 85,
          ...(data.policy.updatedAt
            ? { updatedAt: data.policy.updatedAt }
            : {}),
        };
        store.db
          .prepare("UPDATE runtime_events SET data=? WHERE sequence=?")
          .run(JSON.stringify(data), row.sequence);
      }
    }
    // These are generated tool/prompt receipts; the original user messages and
    // source files stay in their own tables and are not selected here.
    store.db
      .prepare(
        "DELETE FROM runtime_events WHERE type='native.event' AND (data LIKE '%reserveMemoryMiB%' OR data LIKE '%team_set_device_reserve%')",
      )
      .run();
    store.db
      .prepare(
        "DELETE FROM runtime_receipts WHERE json_extract(result,'$.reserveMemoryMiB') IS NOT NULL OR json_extract(result,'$.policy.reserveMemoryMiB') IS NOT NULL",
      )
      .run();
  });
}
