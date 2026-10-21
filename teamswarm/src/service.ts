import { useSyncExternalStore } from "react";
import type {
  Workspace,
  Draft,
  Attachment,
  RuntimeConfig,
  Chat,
} from "./store";
import type { ExecutionConfig, RuntimeSettings } from "@team/contracts/runtime";
import type {
  ExecutionResource,
  PortableAllocationPackage,
  ResourceSelection,
} from "@team/contracts/allocation";
import type { ServerPackagePreview } from "./allocation";
const inputStorage = window.teamswarmDesktop?.storage ?? localStorage;
let snapshotCache: { tag: string; value: Workspace } | undefined;

export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
  }
}
export async function api<T>(
  url: string,
  body?: unknown,
  method = body === undefined ? "GET" : "POST",
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`/api${url}`, {
    method,
    credentials: "same-origin",
    signal: signal ?? AbortSignal.timeout(20000),
    headers:
      body === undefined
        ? url === "/product" && snapshotCache
          ? { "If-None-Match": snapshotCache.tag }
          : undefined
        : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).catch(() => {
    throw new ApiError("Connection lost. Try again.", "network_error", 0);
  });
  if (response.status === 304 && url === "/product" && snapshotCache)
    return snapshotCache.value as T;
  const payload = await response.json().catch(() => null);
  if (!response.ok)
    throw new ApiError(
      payload?.error?.message ?? `Request failed (${response.status}).`,
      payload?.error?.code ?? "request_failed",
      response.status,
    );
  if (url === "/product" && response.headers.get("etag"))
    snapshotCache = { tag: response.headers.get("etag")!, value: payload };
  return payload as T;
}
type State = {
  workspace: Workspace | null;
  loading: boolean;
  saving: boolean;
  error: string;
  connectionError: boolean;
  initialized: boolean;
};
const cacheKey = "teamswarm.workspace";
const outboxKey = "teamswarm.preferences.pending";
const requestKey = "teamswarm.messages.pending";
const harnessIds: Record<string, string> = {
  Codex: "codex",
  "Claude Code": "claude-code",
  Grok: "grok",
  pi: "pi",
  "DeepSeek Harness": "deepseek-harness",
  OpenCode: "opencode",
};
type PreferencesPatch = Record<string, unknown>;
function diffPreferences(old: Workspace, next: Workspace): PreferencesPatch {
  const patch: PreferencesPatch = {};
  for (const field of [
    "name",
    "theme",
    "language",
    "skills",
    "plugins",
  ] as const)
    if (JSON.stringify(old[field]) !== JSON.stringify(next[field]))
      patch[field] = next[field];
  const drafts: Record<string, Draft | null> = {};
  for (const id of new Set([
    ...Object.keys(old.drafts),
    ...Object.keys(next.drafts),
  ]))
    if (JSON.stringify(old.drafts[id]) !== JSON.stringify(next.drafts[id]))
      drafts[id] = next.drafts[id] ?? null;
  if (Object.keys(drafts).length) patch.drafts = drafts;
  const teams: Record<string, unknown> = {};
  for (const team of next.teams) {
    const previous = old.teams.find((t) => t.id === team.id);
    const values: Record<string, unknown> = {};
    for (const field of [
      "lastChatId",
      "color",
      "canvasViewports",
      "hostPosition",
    ] as const)
      if (JSON.stringify(previous?.[field]) !== JSON.stringify(team[field]))
        values[field] = team[field] ?? null;
    if (Object.keys(values).length) teams[team.id] = values;
  }
  if (Object.keys(teams).length) patch.teams = teams;
  const chats: Record<string, unknown> = {};
  for (const chat of next.chats) {
    const previous = old.chats.find((c) => c.id === chat.id);
    if (!previous) continue;
    const values: Record<string, unknown> = {};
    for (const field of ["title", "starred", "archived"] as const)
      if (previous[field] !== chat[field]) values[field] = chat[field] ?? false;
    if (Object.keys(values).length) chats[chat.id] = values;
  }
  // Removing a conversation archives it; the server keeps history and references intact.
  for (const chat of old.chats)
    if (!next.chats.some((c) => c.id === chat.id))
      chats[chat.id] = { archived: true };
  if (Object.keys(chats).length) patch.chats = chats;
  const positions: Record<string, unknown> = {};
  for (const member of next.members) {
    const previous = old.members.find((m) => m.id === member.id);
    if (
      previous &&
      (member.x !== previous.x || member.y !== previous.y) &&
      member.x !== undefined &&
      member.y !== undefined
    )
      positions[member.id] = { x: member.x, y: member.y };
  }
  if (Object.keys(positions).length) patch.positions = positions;
  if (
    JSON.stringify(old.deliveries.map((d) => d.read)) !==
    JSON.stringify(next.deliveries.map((d) => d.read))
  )
    patch.readDeliveries = next.deliveries
      .filter((d) => d.read)
      .map((d) => d.id);
  return patch;
}
function mergePatch(left: PreferencesPatch, right: PreferencesPatch) {
  const result = { ...left, ...right };
  if (left.drafts || right.drafts)
    result.drafts = {
      ...((left.drafts as object) ?? {}),
      ...((right.drafts as object) ?? {}),
    };
  for (const field of ["teams", "chats", "positions"]) {
    const a = (left[field] ?? {}) as Record<string, object>,
      b = (right[field] ?? {}) as Record<string, object>;
    if (Object.keys(a).length || Object.keys(b).length) {
      const values = { ...a };
      for (const [id, value] of Object.entries(b))
        values[id] = { ...values[id], ...value };
      result[field] = values;
    }
  }
  return result;
}
function applyPreferences(
  workspace: Workspace,
  patch: PreferencesPatch,
): Workspace {
  const result = { ...workspace, drafts: { ...workspace.drafts } };
  for (const field of [
    "name",
    "theme",
    "language",
    "skills",
    "plugins",
  ] as const)
    if (patch[field] !== undefined)
      Object.assign(result, { [field]: patch[field] });
  for (const [key, value] of Object.entries(
    (patch.drafts ?? {}) as Record<string, Draft | null>,
  )) {
    if (value === null) delete result.drafts[key];
    else result.drafts[key] = value;
  }
  const teams = (patch.teams ?? {}) as Record<
    string,
    Partial<Workspace["teams"][number]>
  >;
  result.teams = result.teams.map((team) => ({ ...team, ...teams[team.id] }));
  const chats = (patch.chats ?? {}) as Record<
    string,
    Partial<Workspace["chats"][number]>
  >;
  result.chats = result.chats.map((chat) => ({ ...chat, ...chats[chat.id] }));
  const positions = (patch.positions ?? {}) as Record<
    string,
    { x: number; y: number }
  >;
  result.members = result.members.map((member) => ({
    ...member,
    ...positions[member.id],
  }));
  if (patch.readDeliveries) {
    const read = new Set(patch.readDeliveries as string[]);
    result.deliveries = result.deliveries.map((d) => ({
      ...d,
      read: read.has(d.id),
    }));
  }
  return result;
}

class ProductClient {
  private state: State = {
    workspace: null,
    loading: true,
    saving: false,
    error: "",
    connectionError: false,
    initialized: false,
  };
  private listeners = new Set<() => void>();
  private starting?: Promise<void>;
  private refreshing?: Promise<void>;
  private pending: PreferencesPatch = {};
  private inFlight: PreferencesPatch = {};
  private acknowledgedRevision = 0;
  private saveTimer?: ReturnType<typeof setTimeout>;
  private refreshTimer?: ReturnType<typeof setTimeout>;
  private stream?: EventSource;
  private watchedTeam = "";
  private poll?: ReturnType<typeof setInterval>;
  private flushing?: Promise<void>;
  private historyPages = new Map<
    string,
    Pick<Chat, "messages" | "historyBefore">
  >();
  private loadingHistory = new Map<string, Promise<void>>();
  private withHistory(workspace: Workspace): Workspace {
    return {
      ...workspace,
      chats: workspace.chats.map((chat) => {
        const saved = this.historyPages.get(chat.id);
        if (!saved) return chat;
        const messages = [
          ...new Map(
            [...saved.messages.filter((m) => !m.pending), ...chat.messages].map(
              (m) => [m.id, m],
            ),
          ).values(),
        ].sort((a, b) => a.createdAt - b.createdAt);
        this.historyPages.set(chat.id, {
          messages,
          historyBefore: saved.historyBefore,
        });
        return { ...chat, messages, historyBefore: saved.historyBefore };
      }),
    };
  }
  async loadOlder(chatId: string): Promise<void> {
    const running = this.loadingHistory.get(chatId);
    if (running) return running;
    const chat = this.state.workspace?.chats.find((c) => c.id === chatId);
    if (!chat?.historyBefore) return;
    const pending = (async () => {
      const page = await api<Chat>(
        `/product/conversations/${encodeURIComponent(chatId)}/messages?before=${encodeURIComponent(chat.historyBefore!)}`,
      );
      const current = this.state.workspace;
      if (!current) return;
      const latest = current.chats.find((c) => c.id === chatId);
      if (!latest) return;
      const messages = [
        ...new Map(
          [...page.messages, ...latest.messages.filter((m) => !m.pending)].map(
            (m) => [m.id, m],
          ),
        ).values(),
      ];
      this.historyPages.set(chatId, {
        messages,
        historyBefore: page.historyBefore,
      });
      this.emit({ workspace: this.withHistory(current) });
    })();
    this.loadingHistory.set(chatId, pending);
    try {
      await pending;
    } finally {
      this.loadingHistory.delete(chatId);
    }
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  getSnapshot = () => this.state;
  private emit(patch: Partial<State>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  private cache(workspace: Workspace) {
    inputStorage.setItem(
      cacheKey,
      JSON.stringify({
        version: workspace.version,
        service: workspace.service,
      }),
    );
  }
  async start() {
    if (this.starting) return this.starting;
    this.starting = (async () => {
      this.emit({ loading: true, error: "" });
      try {
        const token = location.hash.match(
          /^#connect=([a-zA-Z0-9_-]{32,128})$/,
        )?.[1];
        if (token) {
          const result = await fetch("/api/control/session", {
            method: "POST",
            headers: { Authorization: `Bearer ${token}` },
          });
          if (!result.ok)
            throw new Error(
              "The connection link is no longer valid. Open TeamSwarm from its launcher.",
            );
          history.replaceState(null, "", location.pathname + location.search);
        }
        let workspace = await api<Workspace>("/product");
        const raw = inputStorage.getItem(cacheKey);
        if (raw) {
          const previous = JSON.parse(raw) as Workspace;
          if (!previous.service && previous.teams?.length) {
            if (!inputStorage.getItem("teamswarm.archive.browser-v1"))
              inputStorage.setItem("teamswarm.archive.browser-v1", raw);
            if (!workspace.teams.length) {
              const migrationId =
                inputStorage.getItem("teamswarm.migration.id") ??
                crypto.randomUUID();
              inputStorage.setItem("teamswarm.migration.id", migrationId);
              const files = new Map<string, Attachment>();
              for (const chat of previous.chats)
                for (const message of chat.messages)
                  for (const file of message.files) files.set(file.id, file);
              for (const draft of Object.values(previous.drafts))
                for (const file of draft.files) files.set(file.id, file);
              const { readBrowserFile } = await import("./store");
              for (const file of files.values())
                await this.uploadBytes(file, await readBrowserFile(file.id));
              await api("/product/import", {
                clientRequestId: migrationId,
                workspace: previous,
              });
              workspace = await api<Workspace>("/product");
            }
          }
        }
        const saved = inputStorage.getItem(outboxKey);
        if (saved) this.pending = JSON.parse(saved);
        workspace = applyPreferences(workspace, this.pending);
        this.cache(workspace);
        this.emit({
          workspace,
          loading: false,
          initialized: true,
          connectionError: false,
        });
        if (Object.keys(this.pending).length) await this.flush();
        if (!this.poll)
          this.poll = setInterval(() => {
            if (document.visibilityState === "visible") void this.refresh();
          }, 5000);
      } catch (error) {
        this.emit({
          loading: false,
          error: (error as Error).message,
          connectionError: error instanceof ApiError && error.status === 401,
        });
      } finally {
        this.starting = undefined;
      }
    })();
    return this.starting;
  }
  async refresh() {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      try {
        let snapshot = await api<Workspace>("/product");
        if ((snapshot.service?.revision ?? 0) < this.acknowledgedRevision)
          snapshot = await api<Workspace>("/product");
        if ((snapshot.service?.revision ?? 0) < this.acknowledgedRevision) {
          setTimeout(() => void this.refresh(), 50);
          return;
        }
        const workspace = this.withHistory(
          applyPreferences(snapshot, mergePatch(this.inFlight, this.pending)),
        );
        this.cache(workspace);
        this.emit({ workspace, error: "", connectionError: false });
      } catch (error) {
        this.emit({
          error: (error as Error).message,
          connectionError: error instanceof ApiError && error.status === 401,
        });
      } finally {
        this.refreshing = undefined;
      }
    })();
    return this.refreshing;
  }
  watch(teamId: string) {
    if (teamId === this.watchedTeam) return;
    this.stream?.close();
    this.watchedTeam = teamId;
    if (!teamId) return;
    const cursor = this.state.workspace?.executions?.[teamId]?.latestEvent ?? 0;
    this.stream = new EventSource(
      `/api/teams/${encodeURIComponent(teamId)}/events/stream?after=${cursor}`,
    );
    this.stream.addEventListener("team", () => {
      if (!this.refreshTimer)
        this.refreshTimer = setTimeout(() => {
          this.refreshTimer = undefined;
          void this.refresh();
        }, 180);
    });
  }
  update(change: (old: Workspace) => Workspace): boolean {
    const old = this.state.workspace;
    if (!old) return false;
    const next = change(old);
    const patch = diffPreferences(old, next);
    try {
      this.pending = mergePatch(this.pending, patch);
      inputStorage.setItem(
        outboxKey,
        JSON.stringify(mergePatch(this.inFlight, this.pending)),
      );
      this.cache(next);
      this.emit({
        workspace: next,
        saving: Object.keys(this.pending).length > 0,
      });
      clearTimeout(this.saveTimer);
      this.saveTimer = setTimeout(() => void this.flush().catch(() => {}), 350);
      return true;
    } catch (error) {
      this.emit({ error: (error as Error).message });
      return false;
    }
  }
  async flush() {
    if (this.flushing) return this.flushing;
    if (!Object.keys(this.pending).length) return;
    this.flushing = (async () => {
      try {
        while (Object.keys(this.pending).length) {
          const patch = this.pending;
          this.pending = {};
          this.inFlight = patch;
          try {
            const receipt = await api<{ revision: number }>(
              "/product/preferences",
              patch,
              "PATCH",
            );
            this.acknowledgedRevision = Math.max(
              this.acknowledgedRevision,
              receipt.revision,
            );
          } catch (error) {
            this.pending = mergePatch(patch, this.pending);
            throw error;
          } finally {
            this.inFlight = {};
          }
          inputStorage.setItem(outboxKey, JSON.stringify(this.pending));
        }
        this.emit({ saving: false });
      } catch (error) {
        inputStorage.setItem(outboxKey, JSON.stringify(this.pending));
        this.emit({ saving: false, error: (error as Error).message });
        throw error;
      } finally {
        this.flushing = undefined;
      }
    })();
    return this.flushing;
  }
  async command<T>(url: string, body?: unknown, method?: string) {
    await this.flush();
    const result = await api<T>(url, body, method);
    await this.refresh();
    return result;
  }
  async createTeam(name: string) {
    const key = "teamswarm.create-team.pending";
    const previous = JSON.parse(inputStorage.getItem(key) ?? "null");
    const input =
      previous?.name === name
        ? previous
        : { name, clientRequestId: crypto.randomUUID() };
    inputStorage.setItem(key, JSON.stringify(input));
    const result = await this.command<{ id: string }>("/product/teams", input);
    inputStorage.removeItem(key);
    return result;
  }
  async send(teamId: string, chatId: string | undefined, draft: Draft) {
    await this.flush();
    const signature = JSON.stringify({ teamId, chatId, draft });
    const previous = JSON.parse(inputStorage.getItem(requestKey) ?? "null");
    const request =
      previous?.signature === signature
        ? previous
        : {
            signature,
            clientRequestId: crypto.randomUUID(),
            conversationRequestId: crypto.randomUUID(),
            conversationId: chatId,
          };
    inputStorage.setItem(requestKey, JSON.stringify(request));
    if (!request.conversationId) {
      const conversation = await api<{ id: string }>("/product/conversations", {
        clientRequestId: request.conversationRequestId,
        teamId,
        title:
          draft.text
            .trim()
            .split(/[。！？.!?\n]/)[0]
            .slice(0, 48) ||
          draft.files[0]?.name ||
          "Host",
      });
      request.conversationId = conversation.id;
      inputStorage.setItem(requestKey, JSON.stringify(request));
    }
    const result = await api("/product/messages", {
      clientRequestId: request.clientRequestId,
      teamId,
      conversationId: request.conversationId,
      content: draft.text.trim(),
      files: draft.files,
      skillId: draft.skillId,
      references: draft.references ?? [],
    });
    await this.refresh();
    this.update((old) => {
      const drafts = { ...old.drafts };
      const key = chatId ?? `new:${teamId}`;
      if (JSON.stringify(drafts[key]) === JSON.stringify(draft))
        delete drafts[key];
      else if (!chatId && drafts[key]) {
        drafts[request.conversationId] = drafts[key];
        delete drafts[key];
      }
      return {
        ...old,
        drafts,
        teams: old.teams.map((t) =>
          t.id === teamId ? { ...t, lastChatId: request.conversationId } : t,
        ),
      };
    });
    await this.flush();
    inputStorage.removeItem(requestKey);
    return { chatId: request.conversationId as string, result };
  }
  async uploadBytes(file: Attachment, bytes: Blob) {
    const response = await fetch(
      `/api/product/files/${encodeURIComponent(file.id)}`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/octet-stream",
          "X-File-Name": encodeURIComponent(file.name),
          "X-File-Type": file.type,
          "X-File-Size": String(file.size),
        },
        body: bytes,
      },
    );
    if (!response.ok) {
      const result = await response.json();
      throw new Error(result.error?.message ?? "Could not upload the file.");
    }
    return file;
  }
  async sendWork(
    teamId: string,
    work: import("@team/contracts/runtime").Work,
    content: string,
    mode: "discuss" | "revise",
    draftKey: string,
  ) {
    const key = `teamswarm.work-input:${teamId}:${work.threadId ?? work.id}`;
    const signature = JSON.stringify({ content, mode });
    const previous = JSON.parse(inputStorage.getItem(key) ?? "null");
    const pending =
      previous?.signature === signature
        ? previous
        : {
            signature,
            workId: work.id,
            request: {
              clientRequestId: crypto.randomUUID(),
              content,
              mode,
              expectedRevision: work.revision,
            },
          };
    inputStorage.setItem(key, JSON.stringify(pending));
    let result: unknown;
    try {
      result = await this.command(
        `/product/teams/${encodeURIComponent(teamId)}/works/${encodeURIComponent(pending.workId ?? work.id)}/messages`,
        pending.request,
      );
    } catch (error) {
      if (
        error instanceof ApiError &&
        ["work_changed", "work_busy", "run_paused"].includes(error.code)
      ) {
        inputStorage.removeItem(key);
        await this.refresh();
      }
      throw error;
    }
    this.update((old) =>
      old.drafts[draftKey]?.text !== content
        ? old
        : {
            ...old,
            drafts: { ...old.drafts, [draftKey]: { text: "", files: [] } },
          },
    );
    await this.flush();
    if (
      JSON.parse(inputStorage.getItem(key) ?? "null")?.signature === signature
    )
      inputStorage.removeItem(key);
    return result;
  }
  async viewDelivery(delivery: import("@team/contracts/product").Delivery) {
    if (!delivery.hostDelivery) return;
    const key = `teamswarm.delivery-view:${delivery.teamId}:${delivery.id}`;
    const previous = JSON.parse(inputStorage.getItem(key) ?? "null");
    const request = previous ?? {
      clientRequestId: crypto.randomUUID(),
      expectedContextVersion: delivery.hostDelivery.contextVersion,
    };
    inputStorage.setItem(key, JSON.stringify(request));
    try {
      await this.command(
        `/product/teams/${encodeURIComponent(delivery.teamId)}/deliveries/${encodeURIComponent(delivery.id)}/view`,
        request,
      );
      inputStorage.removeItem(key);
    } catch (error) {
      if (error instanceof ApiError && error.code === "stale_delivery") {
        inputStorage.removeItem(key);
        await this.refresh();
      }
      throw error;
    }
  }
  async sendMember(teamId: string, memberId: string, content: string) {
    const key = `teamswarm.member-input:${teamId}:${memberId}`;
    const previous = JSON.parse(inputStorage.getItem(key) ?? "null");
    const request =
      previous?.content === content
        ? previous
        : { clientRequestId: crypto.randomUUID(), content };
    inputStorage.setItem(key, JSON.stringify(request));
    const result = await this.command(
      `/product/teams/${encodeURIComponent(teamId)}/members/${encodeURIComponent(memberId)}/messages`,
      request,
    );
    const draftKey = `member:${teamId}:${memberId}`;
    this.update((old) =>
      old.drafts[draftKey]?.text !== content
        ? old
        : {
            ...old,
            drafts: { ...old.drafts, [draftKey]: { text: "", files: [] } },
          },
    );
    await this.flush();
    if (
      JSON.parse(inputStorage.getItem(key) ?? "null")?.clientRequestId ===
      request.clientRequestId
    )
      inputStorage.removeItem(key);
    return result;
  }
  async upload(file: File) {
    return this.uploadBytes(
      {
        id: crypto.randomUUID(),
        name: file.name,
        size: file.size,
        type: file.type,
      },
      file,
    );
  }
  async configure(teamId: string, config: RuntimeConfig) {
    const settings = this.state.workspace?.executions?.[teamId]?.settings;
    if (!settings) throw new Error("Team settings are not available.");
    return this.saveSettings(teamId, {
      ...settings,
      config: {
        ...settings.config,
        harness: harnessIds[config.harness] ?? config.harness,
        model: config.model === "Default model" ? null : config.model,
        effort:
          config.effort === "Default" ? null : config.effort.toLowerCase(),
      },
    });
  }
  async resources(teamId: string) {
    return api<{ resources: ExecutionResource[] }>(
      `/teams/${encodeURIComponent(teamId)}/resources`,
    );
  }
  async createResource(
    teamId: string,
    input: { name: string; description: string; config: ExecutionConfig },
  ) {
    return this.command<ExecutionResource>(
      `/teams/${encodeURIComponent(teamId)}/resources`,
      input,
    );
  }
  async updateResource(
    teamId: string,
    resourceId: string,
    input: {
      expectedVersion: number;
      name: string;
      description: string;
      config: ExecutionConfig;
    },
  ) {
    return this.command<ExecutionResource>(
      `/teams/${encodeURIComponent(teamId)}/resources/${encodeURIComponent(resourceId)}`,
      input,
      "PUT",
    );
  }
  async deleteResource(teamId: string, resourceId: string) {
    return this.command<{ id: string; deleted: true }>(
      `/teams/${encodeURIComponent(teamId)}/resources/${encodeURIComponent(resourceId)}`,
      {},
      "DELETE",
    );
  }
  /** Read-only member default resource, agreed in exchange fc4eb8cc. The UI
   * treats a missing endpoint as unknown and never invents a default. */
  async memberAllocation(teamId: string, memberId: string) {
    return api<{
      selection: ResourceSelection | null;
      allocationVersion: number;
      access: "read-only" | "workspace-write";
      maximumAccess: "read-only" | "workspace-write";
    }>(
      `/teams/${encodeURIComponent(teamId)}/members/${encodeURIComponent(memberId)}/allocation`,
    );
  }
  async setMemberAllocation(
    teamId: string,
    memberId: string,
    input: { expectedRevision: number; selection: ResourceSelection },
  ) {
    return this.command<{
      selection?: ResourceSelection;
      allocationVersion?: number;
    }>(
      `/teams/${encodeURIComponent(teamId)}/members/${encodeURIComponent(memberId)}/allocation`,
      input,
      "PUT",
    );
  }
  async setWorkAllocation(
    teamId: string,
    workId: string,
    input: { expectedRevision: number; selection: ResourceSelection },
  ) {
    return this.command<{ revision: number; selection?: ResourceSelection }>(
      `/teams/${encodeURIComponent(teamId)}/works/${encodeURIComponent(workId)}/allocation`,
      input,
      "PUT",
    );
  }
  async exportPortablePackage(teamId: string) {
    return api<PortableAllocationPackage>(
      `/teams/${encodeURIComponent(teamId)}/allocation-package`,
    );
  }
  async previewPortableImport(teamId: string, portablePackage: unknown) {
    return this.command<ServerPackagePreview>(
      `/teams/${encodeURIComponent(teamId)}/allocation-package/preview`,
      { package: portablePackage },
    );
  }
  async importPortablePackage(teamId: string, portablePackage: unknown) {
    return this.command<{ resources: ExecutionResource[] }>(
      `/teams/${encodeURIComponent(teamId)}/allocation-package/import`,
      { package: portablePackage },
    );
  }
  async saveSettings(teamId: string, settings: RuntimeSettings) {
    return this.command(
      `/product/teams/${encodeURIComponent(teamId)}/runtime`,
      {
        expectedVersion: settings.version,
        workspace: settings.workspace,
        config: settings.config,
        maxConcurrent: settings.maxConcurrent,
      },
      "PUT",
    );
  }
}
export const product = new ProductClient();
export function useProduct() {
  return useSyncExternalStore(product.subscribe, product.getSnapshot);
}
