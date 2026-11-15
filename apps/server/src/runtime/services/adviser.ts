import { randomUUID } from "node:crypto";
import type {
  ManagedService,
  ServiceSuggestion,
} from "@team/contracts/services";
import type { RuntimeStore } from "../store.js";

export type SuggestionInference = (
  teamId: string,
  prompt: string,
  signal: AbortSignal,
) => Promise<{ text: string; model: string; usage?: unknown }>;

/** Event-triggered, short model calls. Suggestions only fill a user draft. */
export class ServiceAdviser {
  private active = new Map<string, AbortController>();
  private tasks = new Set<Promise<void>>();
  private closing = false;
  constructor(
    private store: RuntimeStore,
    private infer: SuggestionInference,
    private current: (teamId: string, id: string) => ManagedService | undefined,
  ) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS runtime_service_suggestions (
      id TEXT PRIMARY KEY, team_id TEXT NOT NULL REFERENCES teams(id), event_id TEXT NOT NULL UNIQUE,
      data TEXT NOT NULL CHECK(json_valid(data)));
      UPDATE runtime_service_suggestions SET data=json_set(data,'$.status','failed') WHERE json_extract(data,'$.status')='pending';`);
    store.changes.track(
      "runtime_service_suggestions",
      "execution",
      "team_id",
      true,
      "data",
    );
  }

  latest(teamId: string): ServiceSuggestion | null {
    const row = this.store.db
      .prepare(
        "SELECT data FROM runtime_service_suggestions WHERE team_id=? ORDER BY rowid DESC LIMIT 1",
      )
      .get(teamId);
    if (!row) return null;
    const value = JSON.parse(String(row.data)) as ServiceSuggestion;
    const service = this.current(teamId, value.serviceId);
    return value.status === "ready" &&
      service?.status === "running" &&
      service.version === value.serviceVersion
      ? value
      : null;
  }

  dismiss(teamId: string, id: string) {
    this.store.db
      .prepare(
        "UPDATE runtime_service_suggestions SET data=json_set(data,'$.status','dismissed') WHERE id=? AND team_id=?",
      )
      .run(id, teamId);
  }

  request(service: ManagedService, eventId: string) {
    if (this.closing || this.active.has(service.teamId)) return;
    const latest = this.store.db
      .prepare(
        "SELECT data FROM runtime_service_suggestions WHERE team_id=? ORDER BY rowid DESC LIMIT 1",
      )
      .get(service.teamId);
    if (
      latest &&
      Date.now() - Date.parse(JSON.parse(String(latest.data)).createdAt) < 60000
    )
      return;
    const suggestion: ServiceSuggestion = {
      id: randomUUID(),
      teamId: service.teamId,
      serviceId: service.id,
      serviceVersion: service.version,
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    const inserted = this.store.db
      .prepare(
        "INSERT OR IGNORE INTO runtime_service_suggestions VALUES(?,?,?,?)",
      )
      .run(suggestion.id, service.teamId, eventId, JSON.stringify(suggestion));
    if (!inserted.changes) return;
    const controller = new AbortController();
    this.active.set(service.teamId, controller);
    const task = this.generate(service, suggestion, controller).finally(() => {
      this.active.delete(service.teamId);
      this.tasks.delete(task);
    });
    this.tasks.add(task);
  }

  private async generate(
    service: ManagedService,
    suggestion: ServiceSuggestion,
    controller: AbortController,
  ) {
    try {
      const work = this.store.get<any>("works", service.teamId, service.workId);
      const run = this.store.get<any>("runs", service.teamId, work.runId);
      const source = this.store.teams
        .getConversationDetail(service.teamId, run.conversationId)
        ?.messages.find((m) => m.id === run.sourceMessageId);
      const chinese = /[\u3400-\u9fff]/.test(source?.content ?? "");
      const previous = Number(
        this.store.db
          .prepare(
            "SELECT count(*) n FROM runtime_service_suggestions WHERE team_id=?",
          )
          .get(service.teamId)?.n ?? 0,
      );
      const context = JSON.stringify({
        language: chinese ? "zh-CN" : "en",
        event: "preview handed to the next worker",
        preview: service.name,
        status: service.status,
        previousSuggestions: previous - 1,
        instruction:
          "Suggest a short next user prompt to inspect the current working copy or continue the frontend task. Keep policy explanations out of the prompt.",
      });
      const result = await this.infer(
        service.teamId,
        context,
        AbortSignal.any([controller.signal, AbortSignal.timeout(25000)]),
      );
      const match = result.text.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
      const parsed = JSON.parse(match);
      if (
        typeof parsed.text !== "string" ||
        !parsed.text.trim() ||
        parsed.text.length > 90 ||
        /[\r\n<>]/.test(parsed.text)
      )
        throw new Error("Invalid suggestion.");
      if (
        chinese
          ? parsed.text.length > 24
          : parsed.text.trim().split(/\s+/).length > 12
      )
        throw new Error("Suggestion is too long.");
      const current = this.current(service.teamId, service.id);
      if (
        !current ||
        current.version !== suggestion.serviceVersion ||
        current.status !== "running"
      )
        throw new Error("Preview changed during suggestion generation.");
      suggestion.status = "ready";
      suggestion.text = parsed.text.trim();
      suggestion.model = result.model;
      this.store.event(service.teamId, "service.suggestion_generated", {
        suggestionId: suggestion.id,
        serviceId: service.id,
        model: result.model,
        usage: result.usage ?? null,
        modelRequests: 1,
      });
    } catch {
      suggestion.status = "failed";
      this.store.event(service.teamId, "service.suggestion_unavailable", {
        suggestionId: suggestion.id,
        serviceId: service.id,
      });
    }
    this.store.db
      .prepare("UPDATE runtime_service_suggestions SET data=? WHERE id=?")
      .run(JSON.stringify(suggestion), suggestion.id);
    this.store.changes.signal();
  }

  async close() {
    this.closing = true;
    for (const controller of this.active.values()) controller.abort();
    await Promise.allSettled(this.tasks);
  }
}
