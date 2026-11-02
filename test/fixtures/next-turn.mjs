// Local execution double for UI timing checks. No provider or native model calls.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp } from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import { pathToFileURL } from "node:url";

export async function openNextTurnFixture(directory, productRoot = path.resolve(".")) {
  const { createApp } = await import(pathToFileURL(path.join(productRoot, "apps/server/dist/app.js")));
  const { codexPermissionOptions } = await import(pathToFileURL(path.join(productRoot, "apps/server/dist/runtime/permission-options.js")));
  await mkdir(path.resolve(".local"), { recursive: true });
  const root = directory ?? await mkdtemp(path.resolve(".local/next-turn-ui-"));
  await mkdir(path.join(root, "project"), { recursive: true });
  const requests = [], pending = new Set();
  const harness = {
    id: "codex",
    capabilities: { sessions: true, resume: true, fixture: true },
    permissionOptions: () => codexPermissionOptions,
    async inspect() {
      return { installed: true, available: true, authenticated: true, models: [{
        model: "fixture-model", name: "Fixture model", provider: "OpenAI", isDefault: true,
        reasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }],
      }] };
    },
    validateConfig() {},
    async execute(request) {
      requests.push({ config: structuredClone(request.config), sessionId: request.sessionId });
      request.onSession(request.sessionId ?? randomUUID());
      request.onTurn(randomUUID());
      await new Promise(resolve => pending.add(resolve));
      return { status: "completed", text: "本地交互测试完成。" };
    },
    async interrupt() { release(); },
    async close() { release(); },
  };
  function release() { for (const resolve of pending) resolve(); pending.clear(); }
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const service = createApp({ apiPort: port, dataDir: path.join(root, "data"),
    webDistDir: path.join(productRoot, "teamswarm/dist"), harnesses: [harness] });
  const server = service.app.listen(port, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${port}`;
  const request = async (route, body, method = body ? "POST" : "GET") => {
    const response = await fetch(`${base}/api${route}`, { method,
      headers: { authorization: `Bearer ${service.controlToken}`, "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const result = await response.json();
    assert(response.ok, JSON.stringify(result));
    return result;
  };
  const team = await request("/teams", { name: "下一轮配置 · 本地交互测试" });
  const chat = await request(`/teams/${team.id}/conversations`, { title: "Host" });
  await request(`/teams/${team.id}/runtime`, { expectedVersion: 0,
    workspace: path.join(root, "project"), config: { harness: "codex", model: "fixture-model", effort: "low", access: "workspace-write" },
  }, "PUT");
  const branch = service.runtime.history.forConversation(team.id, chat.id);
  return { root, base, service, team, chat, branch, request, requests, release,
    async close() { release(); await service.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); },
  };
}
